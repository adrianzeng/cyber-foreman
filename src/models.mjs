import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectCliCommand } from "./fsutil.mjs";

/**
 * 模型清单（按员工类型 kind 严格隔离，绝不跨 CLI 串台）。
 *
 * 一条硬规矩：**只读各 CLI 自己的配置**，不去读路由工具（cc-switch）的后台数据：
 *   - claude-cli：~/.claude/settings.json 的 ANTHROPIC_MODEL 与 ANTHROPIC_DEFAULT_*_MODEL（及进程 ANTHROPIC_* 环境变量兜底）
 *   - codex-cli ：~/.codex/config.toml 的 model、model_reasoning_effort
 *   - agy-cli   ：~/.gemini/antigravity-cli/settings.json 的 model + 可选 `agy models` 实时探针
 *   - kimi-cli  ：~/.kimi/config.json 或 ~/.kimi/config.toml 的 model（及 KIMI_MODEL 环境变量兜底）
 *   - doubao-cli：~/.doubao/config.json 或 ~/.doubao/config.toml 的 model（及 DOUBAO_MODEL 环境变量兜底）
 *
 * 读不到就返回空，面板退化成可手填，不影响使用。
 */

const AGY_PROBE_TTL_MS = 60_000;
let agyProbeCache = { at: 0, models: null };

export function clearModelCache() {
  agyProbeCache = { at: 0, models: null };
}

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 从简单 TOML 里抠单行字符串配置，不引入 TOML 解析依赖。 */
function readTomlFields(file, keys) {
  try {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    const result = {};
    for (const key of keys) {
      const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m").exec(text);
      result[key] = match?.[1] || null;
    }
    return result;
  } catch {
    return null;
  }
}

/** Claude 的别名映射：别名 → 它实际指向的模型。 */
const CLAUDE_ALIASES = ["sonnet", "opus", "haiku", "fable"];

function readClaudeSettings(file, procEnv = null) {
  const data = readJson(file);
  const fileEnv = data && typeof data === "object" && data.env && typeof data.env === "object" ? data.env : {};
  // 合并顺序：settings.json 优先，进程环境兜底（单元测试传入假 home 时不混入宿主机环境变量）。
  const pickEnv = (key) => fileEnv[key] || (procEnv ? procEnv[key] : null) || null;

  const aliases = [];
  for (const alias of CLAUDE_ALIASES) {
    const key = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;
    const target = pickEnv(key);
    if (!target) continue;
    aliases.push({
      alias,
      model: target,
      displayName: pickEnv(`${key}_NAME`) || target,
    });
  }

  const model = pickEnv("ANTHROPIC_MODEL") || data?.model || null;
  const baseUrl = pickEnv("ANTHROPIC_BASE_URL") || null;
  const subagentModel = pickEnv("CLAUDE_CODE_SUBAGENT_MODEL") || null;
  if (!model && !baseUrl && !subagentModel && !aliases.length) return null;

  return { model, baseUrl, subagentModel, aliases };
}

function readCodexConfig(file) {
  const fields = readTomlFields(file, ["model", "model_reasoning_effort", "model_provider"]);
  if (!fields) return null;
  return {
    model: fields.model,
    effort: fields.model_reasoning_effort,
    provider: fields.model_provider,
  };
}

/** 解析 `agy models` 输出的制表符行：`gemini-4-neon-high\tGemini 4 Neon (High)`。 */
export function parseAgyModelsOutput(stdout) {
  const result = [];
  const seen = new Set();
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes("\t")) continue;
    const [idPart, ...rest] = line.split("\t");
    const id = idPart.trim();
    const displayName = rest.join("\t").trim();
    if (!id || !/^[A-Za-z0-9._:/-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      displayName: displayName || id,
      label: displayName && displayName !== id ? `${id} · ${displayName}` : id,
    });
  }
  return result;
}

function probeAgyModels({ refresh = false, runner = null } = {}) {
  const now = Date.now();
  if (!refresh && !runner && agyProbeCache.models && now - agyProbeCache.at < AGY_PROBE_TTL_MS) {
    return agyProbeCache.models;
  }
  let output = "";
  try {
    if (typeof runner === "function") {
      output = runner();
    } else {
      const detected = detectCliCommand("agy-cli");
      if (!detected.found || !detected.command) return [];
      output = execFileSync(detected.command, [...(detected.argsPrefix || []), "models"], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    }
  } catch {
    return agyProbeCache.models || [];
  }
  const parsed = parseAgyModelsOutput(output);
  if (!runner) agyProbeCache = { at: now, models: parsed };
  return parsed;
}

function readAgySettings(home, options = {}) {
  const data = readJson(join(home, ".gemini", "antigravity-cli", "settings.json"));
  const rawModel = typeof data?.model === "string" && data.model.trim() ? data.model.trim() : null;
  // 只有显式请求 agy 模型列表（probeAgy: true）时才执行 `agy models` 子进程探针，
  // 避免 /api/health、/api/overview 轮询被 3 秒外部进程阻塞。
  const shouldProbe = options.probeAgy === true;
  const probed = shouldProbe
    ? probeAgyModels({ refresh: options.refresh === true, runner: options.agyModelsRunner })
    : (home === homedir() && Array.isArray(agyProbeCache.models) ? agyProbeCache.models : []);

  // settings.json 里可能是展示名（如 "Gemini 4 Neon (Medium)"），尽量对齐到 CLI 实际 ID。
  let resolvedModel = rawModel;
  if (rawModel && probed.length) {
    const matched = probed.find(
      (item) => item.id === rawModel || item.displayName.toLowerCase() === rawModel.toLowerCase(),
    );
    if (matched) resolvedModel = matched.id;
  }

  return {
    model: resolvedModel,
    rawModel,
    aliases: [],
    probed,
  };
}

function readSimpleCliModel(home, dirName, envKey, procEnv = null) {
  const jsonCfg = readJson(join(home, dirName, "config.json"));
  const tomlCfg = readTomlFields(join(home, dirName, "config.toml"), ["model", "default_model"]);
  const model = jsonCfg?.model
    || jsonCfg?.default_model
    || tomlCfg?.model
    || tomlCfg?.default_model
    || (procEnv ? procEnv[envKey] : null)
    || null;
  const models = Array.isArray(jsonCfg?.models)
    ? jsonCfg.models.map((item) => (typeof item === "string" ? item : item?.id)).filter(Boolean)
    : [];
  return { model, models, aliases: [] };
}

/** 每种员工当前真正会用到的模型（各自只读自己的本地配置）。 */
export function currentModels(home = homedir(), options = {}) {
  const procEnv = options.env !== undefined ? options.env : (home === homedir() ? process.env : null);
  const claude = readClaudeSettings(join(home, ".claude", "settings.json"), procEnv);
  const codex = readCodexConfig(join(home, ".codex", "config.toml"));
  const agy = readAgySettings(home, options);
  const kimi = readSimpleCliModel(home, ".kimi", "KIMI_MODEL", procEnv);
  const doubao = readSimpleCliModel(home, ".doubao", "DOUBAO_MODEL", procEnv);

  return {
    "claude-cli": {
      model: claude?.model || null,
      baseUrl: claude?.baseUrl || null,
      subagentModel: claude?.subagentModel || null,
      aliases: claude?.aliases || [],
    },
    "codex-cli": {
      model: codex?.model || null,
      effort: codex?.effort || null,
      provider: codex?.provider || null,
    },
    "agy-cli": {
      model: agy.model || null,
      rawModel: agy.rawModel || null,
      aliases: [],
      probed: agy.probed || [],
    },
    "kimi-cli": {
      model: kimi.model || null,
      models: kimi.models || [],
      aliases: [],
    },
    "doubao-cli": {
      model: doubao.model || null,
      models: doubao.models || [],
      aliases: [],
    },
  };
}

/**
 * 本机已知的模型名（每条都严格带归属 kind，防止不同 CLI 之间串台）。
 */
export function listModels(home = homedir(), options = {}) {
  const byKind = {
    "claude-cli": new Map(),
    "codex-cli": new Map(),
    "agy-cli": new Map(),
    "kimi-cli": new Map(),
    "doubao-cli": new Map(),
  };

  const add = (kind, id, label, source, extra = {}) => {
    const key = String(id || "").trim();
    if (!key || !byKind[kind]) return;
    const bucket = byKind[kind];
    const existing = bucket.get(key);
    if (existing) {
      if (!existing.label && label) existing.label = label;
      if (source && !existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    bucket.set(key, {
      id: key,
      kind,
      label: label || key,
      sources: source ? [source] : [],
      ...extra,
    });
  };

  const current = currentModels(home, options);

  // 1. Claude 专属：别名 + ANTHROPIC_MODEL + 别名目标 + subagent
  const claude = current["claude-cli"];
  for (const item of claude.aliases || []) {
    add("claude-cli", item.alias, `${item.alias} → ${item.displayName}`, "claude-alias", { claudeOnly: true });
  }
  add("claude-cli", claude.model, null, "claude");
  for (const item of claude.aliases || []) {
    add("claude-cli", item.model, item.displayName, "claude-alias");
  }
  if (claude.subagentModel) add("claude-cli", claude.subagentModel, null, "claude-subagent");

  // 2. Codex 专属：只来自 ~/.codex/config.toml
  const codex = current["codex-cli"];
  add("codex-cli", codex.model, null, "codex");

  // 3. Antigravity 专属：只来自 ~/.gemini/antigravity-cli/settings.json 与 `agy models`
  const agy = current["agy-cli"];
  for (const item of agy.probed || []) {
    add("agy-cli", item.id, item.label, "agy-cli");
  }
  add("agy-cli", agy.model, null, "agy-settings");

  // 4. Kimi / Doubao 专属
  const kimi = current["kimi-cli"];
  add("kimi-cli", kimi.model, null, "kimi");
  for (const m of kimi.models || []) add("kimi-cli", m, null, "kimi");

  const doubao = current["doubao-cli"];
  add("doubao-cli", doubao.model, null, "doubao");
  for (const m of doubao.models || []) add("doubao-cli", m, null, "doubao");

  const models = Object.values(byKind)
    .flatMap((bucket) => [...bucket.values()])
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  return { current, models, byKind };
}

/** 面板下拉用的形态：按员工类型严格隔离，绝不把别的 CLI 的模型串进来。 */
export function modelOptionsFor(kind, workerModel, home = homedir(), options = {}) {
  const effectiveOptions = kind === "agy-cli" && options.probeAgy === undefined && home === homedir()
    ? { ...options, probeAgy: true }
    : options;
  const { current, byKind } = listModels(home, effectiveOptions);
  const info = current[kind] || { model: null };
  const effective = workerModel || info.model || null;
  const bucket = byKind[kind] || new Map();

  const candidates = [...bucket.values()].map((item) => ({
    id: item.id,
    label: item.label || item.id,
    active: item.id === effective,
  }));

  // 若员工自己指定了自定义模型且不在候选里，也排在第一位方便用户看见。
  if (workerModel && !candidates.some((item) => item.id === workerModel)) {
    candidates.unshift({ id: workerModel, label: `${workerModel}（员工指定）`, active: true });
  }

  candidates.sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id));

  return {
    kind,
    current: effective,
    currentSource: workerModel ? "worker" : info.model ? "cli" : "unknown",
    baseUrl: info.baseUrl || null,
    effort: info.effort || null,
    provider: info.provider || null,
    aliases: info.aliases || [],
    models: candidates,
    refreshedAt: new Date().toISOString(),
  };
}
