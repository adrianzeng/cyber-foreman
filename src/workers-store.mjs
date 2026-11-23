import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { getAdapter } from "./adapters/index.mjs";
import { commandExists, detectCliCommand, isDirectory } from "./fsutil.mjs";

const MAX_WORKERS = 50;

function fail(message) {
  throw new Error(message);
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** node / python 这类解释器，光有命令、没有脚本参数，启动不了任何 Agent。 */
function isBareInterpreter(command, argsPrefix) {
  if (Array.isArray(argsPrefix) && argsPrefix.length) return false;
  const base = String(command || "").trim().toLowerCase().replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/, "");
  return ["node", "npx", "python", "python3", "py", "deno", "bun", "sh", "bash"].includes(base);
}

/**
 * 修掉“类型和启动命令对不上”的配置。
 * 典型来源：先选 Codex（自动填了 node），再改成 Claude，命令却留着 node。
 * 这种员工在面板上显示可用，一派活就失败，必须自愈。
 */
function repairLaunch(worker, others) {
  if (!isBareInterpreter(worker.command, worker.argsPrefix)) return worker;
  const donor = Object.values(others || {}).find(
    (other) =>
      other &&
      other !== worker &&
      other.id !== worker.id &&
      other.kind === worker.kind &&
      !isBareInterpreter(other.command, other.argsPrefix),
  );
  if (!donor) return worker;
  return { ...worker, command: donor.command, argsPrefix: Array.isArray(donor.argsPrefix) ? donor.argsPrefix : [] };
}

/**
 * 把一条员工配置校验并整理成规范形态。
 * 所有错误都写成用户能看懂的一句话，面板上直接显示。
 */
export function normalizeWorker(input, { id, all = {} } = {}) {
  const name = cleanText(input.name, 40);
  if (!name) fail("员工名字不能为空");

  const kind = cleanText(input.kind, 40) || "claude-cli";
  const adapter = getAdapter(kind);
  if (!adapter) fail(`不支持的员工类型：${kind}`);

  let command = cleanText(input.command, 400);
  let argsPrefix = Array.isArray(input.argsPrefix)
    ? input.argsPrefix.map((part) => String(part)).filter(Boolean).slice(0, 20)
    : [];
  if (!command) fail("启动命令不能为空");
  if (isAbsolute(command)) {
    if (!existsSync(command)) fail(`这个路径下没有程序：${command}`);
  } else if (!commandExists(command)) {
    // 允许像 "agy" 这类默认命令名通过自动探测找到本机已知安装路径。
    const detected = detectCliCommand(kind);
    if (detected.found && adapter.defaultCommand && command.toLowerCase() === adapter.defaultCommand.toLowerCase()) {
      command = detected.command;
      if (!argsPrefix.length && detected.argsPrefix.length) argsPrefix = detected.argsPrefix;
    } else {
      fail(`系统里找不到命令：${command}`);
    }
  }

  const rawCwd = cleanText(input.cwd, 400);
  if (!rawCwd) fail("项目目录不能为空");
  if (!isAbsolute(rawCwd)) fail("项目目录要填绝对路径，例如 E:\\项目\\xxx");
  if (!isDirectory(rawCwd)) fail(`这个目录不存在：${rawCwd}`);
  const cwd = resolve(rawCwd);

  const permitted = (adapter.permissionModes || []).map((mode) => mode.value);
  let permissionMode = cleanText(input.permissionMode, 40) || adapter.defaultPermissionMode;
  if (permitted.length && !permitted.includes(permissionMode)) {
    permissionMode = adapter.defaultPermissionMode;
  }

  const extraDirs = [];
  for (const raw of Array.isArray(input.addDirs) ? input.addDirs : []) {
    const dir = cleanText(raw, 400);
    if (!dir) continue;
    if (!isAbsolute(dir)) fail(`附加目录要填绝对路径：${dir}`);
    if (!isDirectory(dir)) fail(`附加目录不存在：${dir}`);
    const resolved = resolve(dir);
    if (resolved === cwd || extraDirs.includes(resolved)) continue;
    extraDirs.push(resolved);
  }

  const retryInput = input.retry && typeof input.retry === "object" ? input.retry : null;
  const worker = {
    id,
    name,
    kind,
    command,
    argsPrefix,
    cwd,
    addDirs: extraDirs,
    permissionMode,
    model: cleanText(input.model, 120),
    effort: cleanText(input.effort, 20),
    disabled: input.disabled === "auto"
      ? !detectCliCommand(kind).found
      : input.disabled === true,
    note: cleanText(input.note, 200),
  };
  // 单任务花费上限；只有一个上限，0 或留空表示不限。
  const budget = Number(input.maxBudgetUsd);
  if (Number.isFinite(budget) && budget > 0) {
    worker.maxBudgetUsd = Math.min(budget, 1000);
  }
  // 只有真的给了 retry 才写进配置：手写配置不写就表示“不自动重试”。
  if (retryInput) {
    const retry = {
      maxAttempts: clampInt(retryInput.maxAttempts, 3, 1, 10),
      baseDelayMs: clampInt(retryInput.baseDelayMs, 3000, 0, 600_000),
      maxDelayMs: clampInt(retryInput.maxDelayMs, 60_000, 0, 600_000),
    };
    if (retry.maxDelayMs < retry.baseDelayMs) retry.maxDelayMs = retry.baseDelayMs;
    worker.retry = retry;
  }
  // 插话相关：只对"类型本身支持插话"的员工落盘，别的类型存了也没用，
  // 反而会让面板长出一个永远点不动的开关。
  if (adapter.supportsSteer === true && input.streamInput === true) {
    worker.streamInput = true;
  }
  const steerIdleMs = Number(input.steerIdleMs);
  if (adapter.supportsSteer === true && Number.isFinite(steerIdleMs) && steerIdleMs > 0) {
    worker.steerIdleMs = clampInt(steerIdleMs, 3000, 500, 60_000);
  }
  const sideTimeoutMs = Number(input.sideTimeoutMs);
  if (Number.isFinite(sideTimeoutMs) && sideTimeoutMs > 0) {
    worker.sideTimeoutMs = clampInt(sideTimeoutMs, 180_000, 1_000, 900_000);
  }
  if (kind === "codex-cli") worker.autoApprove = input.autoApprove !== false;
  if (input.env && typeof input.env === "object") worker.env = input.env;

  // 同一个目录下不允许重名，避免面板上两张一样的卡。
  for (const [otherId, other] of Object.entries(all)) {
    if (otherId === id) continue;
    if (other.name === name && resolve(other.cwd || "") === cwd) {
      fail(`这个项目里已经有一个叫「${name}」的员工了，换个名字`);
    }
  }

  return worker;
}

/**
 * 员工的“真配置”仓库：面板改的都写在这里，不在源码目录里。
 * config/workers.json 只当首次安装的种子模板，升级不会覆盖你配好的员工。
 */
export class WorkerStore {
  constructor({ file, seed = {} }) {
    this.file = file;
    this.seed = seed && typeof seed === "object" ? seed : {};
    this.workers = {};
    this.updatedAt = null;
  }

  /** 把一份员工表整理成规范形态；整理失败的那条原样保留，别让 Hub 起不来。 */
  normalizeAll(source) {
    // 先修“命令是裸解释器”这类坏配置，再统一校验。
    const repaired = {};
    for (const [id, raw] of Object.entries(source || {})) {
      repaired[id] = raw && typeof raw === "object" ? repairLaunch({ ...raw, id }, source) : raw;
    }

    const result = {};
    let changed = false;
    for (const [id, raw] of Object.entries(repaired)) {
      try {
        const next = normalizeWorker({ ...raw, id }, { id, all: result });
        result[id] = next;
        if (JSON.stringify(next) !== JSON.stringify(source[id])) changed = true;
      } catch {
        // 种子里启用了自动探测的 CLI（如 agy）在本机未安装时，保持停用以免阻塞启动。
        if (raw && typeof raw === "object" && (raw.disabled === "auto" || (raw.disabled === undefined && raw.kind === "agy-cli"))) {
          result[id] = { ...raw, disabled: true };
        } else {
          result[id] = raw;
        }
      }
    }
    return { workers: result, changed };
  }

  load() {
    if (existsSync(this.file)) {
      const data = readJson(this.file, null);
      if (data && data.workers && typeof data.workers === "object") {
        const { workers, changed } = this.normalizeAll(data.workers);
        this.workers = workers;
        this.updatedAt = data.updatedAt || null;
        // 老版本留下的配置缺字段时，顺手补齐并落盘一次。
        if (changed) this.persist();
        return this;
      }
    }
    // 首次安装：把种子模板整理成规范形态再落盘，缺 retry 之类的字段会被补齐。
    const { workers } = this.normalizeAll(structuredClone(this.seed));
    this.workers = workers;
    this.persist();
    return this;
  }

  snapshot() {
    return structuredClone(this.workers);
  }

  persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      workers: this.workers,
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    if (existsSync(this.file)) {
      try {
        copyFileSync(this.file, `${this.file}.bak`);
      } catch {
        // 备份失败不影响正常写入。
      }
    }
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, text, "utf8");
    renameSync(temporary, this.file);
    this.updatedAt = payload.updatedAt;
  }

  nextId(kind) {
    const prefix = String(kind || "worker").replace(/-cli$/, "");
    let index = 1;
    while (this.workers[`${prefix}-${index}`]) index += 1;
    return `${prefix}-${index}`;
  }

  create(input) {
    if (Object.keys(this.workers).length >= MAX_WORKERS) fail(`员工数量上限是 ${MAX_WORKERS} 个`);
    const kind = cleanText(input.kind, 40) || "claude-cli";
    const template = this.commandTemplateFor(kind);

    // 同类型员工已经配好的启动命令/参数直接复用，免得用户手填 argsPrefix。
    const merged = {
      ...input,
      kind,
      command: cleanText(input.command, 400) || template.command || "",
      argsPrefix: Array.isArray(input.argsPrefix) && input.argsPrefix.length
        ? input.argsPrefix
        : template.argsPrefix || [],
      // 面板/API 新建时默认给 3 次重试；手写配置文件不写就不重试。
      retry: input.retry && typeof input.retry === "object"
        ? input.retry
        : { maxAttempts: 3, baseDelayMs: 3000, maxDelayMs: 60_000 },
    };

    const id = this.nextId(kind);
    const worker = normalizeWorker(repairLaunch({ ...merged, id }, this.workers), { id, all: this.workers });
    this.workers[id] = worker;
    this.persist();
    return worker;
  }

  update(id, patch) {
    const existing = this.workers[id];
    if (!existing) fail(`没有员工 ${id}`);
    const kind = cleanText(patch.kind, 40) || existing.kind;
    const merged = { ...existing, ...patch, id, kind };
    if (kind !== existing.kind && !cleanText(patch.command, 400)) {
      // 换了类型却没显式给命令：必须换成新类型那套，不能沿用旧类型的 node/claude.exe。
      const template = this.commandTemplateFor(kind, id);
      merged.command = template.command || "";
      merged.argsPrefix = template.argsPrefix || [];
    }
    const worker = normalizeWorker(repairLaunch(merged, this.workers), { id, all: this.workers });
    this.workers[id] = worker;
    this.persist();
    return worker;
  }

  remove(id) {
    if (!this.workers[id]) fail(`没有员工 ${id}`);
    delete this.workers[id];
    this.persist();
  }

  get(id) {
    return this.workers[id] || null;
  }

  /** 供面板表单预填：优先复用同类型已有员工的命令，否则走本机 CLI 自动探测。 */
  commandTemplateFor(kind, excludeId = null) {
    const same = Object.values(this.workers).find(
      (worker) =>
        worker.kind === kind &&
        worker.id !== excludeId &&
        !isBareInterpreter(worker.command, worker.argsPrefix),
    );
    if (same) return { command: same.command, argsPrefix: same.argsPrefix || [] };
    const detected = detectCliCommand(kind);
    if (detected.found) return { command: detected.command, argsPrefix: detected.argsPrefix || [] };
    return { command: "", argsPrefix: [] };
  }
}
