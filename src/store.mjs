import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const ACTIVE_STATUSES = new Set(["queued", "running", "retrying", "cancelling"]);

/**
 * 工单阶段：面板只按这四个阶段展示，比原始 status 更接近“我现在要不要动手”。
 *   running —— 机器在干（含重试等待、停止收尾）
 *   waiting —— 卡在人身上：失败、重试耗尽、Hub 中断、员工求助
 *   queued  —— 排队里，还没轮到
 *   done    —— 已结束（完成、主动取消、人工标记已处理）
 */
export const STAGES = ["running", "waiting", "queued", "done"];

export function stageOf(task) {
  if (!task) return "done";
  if (task.acknowledgedAt) return "done";
  switch (task.status) {
    case "queued":
      return "queued";
    case "running":
    case "retrying":
    case "cancelling":
      return "running";
    case "waiting":
    case "failed":
    case "interrupted":
      return "waiting";
    default:
      return "done";
  }
}

function nowIso() {
  return new Date().toISOString();
}

/** 本地时区的今天零点。 */
export function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/**
 * 取出任务的用量。旧任务存的是 Claude 原始对象，字段名不一样，这里顺手兼容，
 * 免得升级之后历史统计全变成 0。
 */
export function pickUsage(task) {
  const usage = task?.usage;
  if (!usage || typeof usage !== "object") return null;
  if (Number.isFinite(Number(usage.inputTokens)) || Number.isFinite(Number(usage.outputTokens))) {
    return usage;
  }
  const input = Number(usage.input_tokens);
  const output = Number(usage.output_tokens);
  const cacheRead = Number(usage.cache_read_input_tokens);
  if (!Number.isFinite(input) && !Number.isFinite(output) && !Number.isFinite(cacheRead)) return null;
  return {
    inputTokens: Number.isFinite(input) ? input : null,
    outputTokens: Number.isFinite(output) ? output : null,
    cacheReadTokens: Number.isFinite(cacheRead) ? cacheRead : null,
    thinkingTokens: Number(usage.output_tokens_details?.thinking_tokens) || null,
    turns: null,
    costUsd: Number.isFinite(Number(task.costUsd)) ? Number(task.costUsd) : null,
    costBasis: "estimate",
  };
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function taskId() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `task_${stamp}_${randomBytes(3).toString("hex")}`;
}

export class TaskStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.tasksDir = join(dataDir, "tasks");
    this.logsDir = join(dataDir, "logs");
    this.eventsFile = join(dataDir, "events.jsonl");
    this.stateFile = join(dataDir, "state.json");
    this.tasks = new Map();
    this.state = { sessions: {} };
    /** 任务事件订阅者（通道层用）。 */
    this.listeners = new Set();
    /** 每个任务上次通知出去的 `status|stage`，用来判重。 */
    this.notified = new Map();
  }

  init() {
    mkdirSync(this.tasksDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    this.state = readJson(this.stateFile, { sessions: {} });
    if (!this.state.sessions || typeof this.state.sessions !== "object") {
      this.state.sessions = {};
    }

    for (const name of readdirSync(this.tasksDir)) {
      if (!name.endsWith(".json")) continue;
      const task = readJson(join(this.tasksDir, name), null);
      if (!task || !task.id) continue;
      if (task.status === "running" || task.status === "cancelling" || task.status === "retrying") {
        task.status = "interrupted";
        task.error = "Hub 上次退出时任务仍在运行，已标记为中断";
        task.finishedAt = nowIso();
        task.updatedAt = task.finishedAt;
        task.pid = null;
        task.nextRetryAt = null;
        this.#save(task);
        this.#event(task.id, "interrupted", { error: task.error });
      }
      this.tasks.set(task.id, task);
    }
    // 历史任务先记下当前签名，别让"进度更新"被当成状态变化推出去。
    for (const task of this.tasks.values()) this.notified.set(task.id, this.#signature(task));
    this.#migrateSessions();
    return this;
  }

  #taskFile(id) {
    return join(this.tasksDir, `${id}.json`);
  }

  #save(task) {
    task.updatedAt = nowIso();
    writeJsonAtomic(this.#taskFile(task.id), task);
    this.tasks.set(task.id, task);
    this.#emit(task);
  }

  #signature(task) {
    return `${task.status}|${stageOf(task)}`;
  }

  /**
   * 任务事件唯一出口。
   *
   * 只有 status 或 stage 变了才回调 —— 进度更新一次就推一次 IM 会把人烦死，
   * 通道层只需要知道「进终态了」「第一次进等你了」。
   * 单个订阅者抛错绝不影响落盘：通道挂了不能让任务记录写不进去。
   */
  #emit(task) {
    const signature = this.#signature(task);
    const changed = this.notified.get(task.id) !== signature;
    this.notified.set(task.id, signature);
    if (!changed || !this.listeners.size) return;
    const event = {
      type: "task",
      taskId: task.id,
      workerId: task.workerId,
      role: task.role || "main",
      status: task.status,
      stage: stageOf(task),
      title: task.title,
      at: nowIso(),
    };
    for (const listener of [...this.listeners]) {
      try {
        const result = listener(event);
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch {
        // 订阅者自己的问题，不影响任务。
      }
    }
  }

  /**
   * 订阅任务状态事件。
   * @param {(event:{type:string, taskId:string, workerId:string, role:string,
   *   status:string, stage:string, title:string, at:string}) => void} listener
   * @returns {() => void} 取消订阅
   */
  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #event(taskIdValue, type, data = {}) {
    appendFileSync(
      this.eventsFile,
      `${JSON.stringify({ time: nowIso(), taskId: taskIdValue, type, ...data })}\n`,
      "utf8",
    );
  }

  createTask(input) {
    const time = nowIso();
    const role = input.role === "side" ? "side" : "main";
    const task = {
      id: taskId(),
      workerId: input.workerId,
      kind: input.kind,
      title: input.title,
      prompt: input.prompt,
      cwd: input.cwd,
      requestedModel: input.model || null,
      requestedEffort: input.effort || null,
      newSession: input.newSession === true,
      resumeSessionId: input.resumeSessionId || null,
      status: "queued",
      createdAt: time,
      updatedAt: time,
      startedAt: null,
      finishedAt: null,
      pid: null,
      sessionId: null,
      result: null,
      error: null,
      exitCode: null,
      costUsd: null,
      usage: null,
      attempts: 0,
      maxAttempts: Number(input.maxAttempts) > 1 ? Number(input.maxAttempts) : 1,
      maxBudgetUsd: Number(input.maxBudgetUsd) > 0 ? Number(input.maxBudgetUsd) : null,
      manualRetries: 0,
      nextRetryAt: null,
      acknowledgedAt: null,
      progress: [],
      /** 主任务 / 侧问。旧任务没有这个字段，一律按 main 处理。 */
      role,
      parentTaskId: input.parentTaskId || null,
      /** 插话记录（最多 50 条 FIFO），面板右栏的对话气泡就靠它。 */
      steers: [],
      steerCount: 0,
      lastSteerAt: null,
      sideQuestion: input.sideQuestion || null,
      /** 侧问为 true：adapter 据此降到只读权限。 */
      readOnly: input.readOnly === true,
    };
    this.#save(task);
    this.#event(task.id, "queued", { workerId: task.workerId, role });
    return this.clone(task);
  }

  getTask(id) {
    const task = this.tasks.get(id);
    return task ? this.clone(task) : null;
  }

  updateTask(id, patch) {
    const task = this.tasks.get(id);
    if (!task) return null;
    Object.assign(task, patch);
    this.#save(task);
    return this.clone(task);
  }

  addProgress(id, message, type = "progress", data = {}) {
    const task = this.tasks.get(id);
    if (!task) return null;
    const text = String(message || "").trim();
    if (text) {
      task.progress.push({ time: nowIso(), message: text.slice(0, 1000) });
      if (task.progress.length > 120) {
        task.progress = task.progress.slice(-120);
      }
    }
    this.#save(task);
    this.#event(id, type, { message: text.slice(0, 1000), ...data });
    return this.clone(task);
  }

  /**
   * 记一条插话。
   *
   * 三处都写（冗余是有意的）：task.steers[] 给面板气泡、progress 给时间线对齐、
   * events.jsonl 给事后 grep「谁在什么时候说了什么」。
   * 插话不改 status、不改 attempts —— 它不是重试。
   */
  addSteer(id, steer) {
    const task = this.tasks.get(id);
    if (!task) return null;
    const entry = {
      at: steer?.at || nowIso(),
      text: String(steer?.text || "").slice(0, 4000),
      parts: Array.isArray(steer?.parts) && steer.parts.length > 1 ? steer.parts.map((part) => String(part).slice(0, 2000)) : undefined,
      source: steer?.source || "panel",
      actor: steer?.actor && typeof steer.actor === "object" ? { ...steer.actor } : undefined,
      delivered: steer?.delivered !== false,
      error: steer?.error ? String(steer.error).slice(0, 500) : undefined,
    };
    if (!Array.isArray(task.steers)) task.steers = [];
    task.steers.push(entry);
    if (task.steers.length > 50) task.steers = task.steers.slice(-50);
    task.steerCount = Number(task.steerCount || 0) + 1;
    task.lastSteerAt = entry.at;
    this.#save(task);
    this.#event(id, "steer", {
      text: entry.text.slice(0, 1000),
      source: entry.source,
      chatId: entry.actor?.chatId || null,
    });
    return this.clone(task);
  }

  /**
   * 写日志。必须按行切：一个 chunk 里可能挤着好几条 JSON，
   * 整段直接追加会让整个会话变成一行，事后既搜不了也解析不了。
   */
  appendLog(id, stream, chunk) {
    const text = String(chunk ?? "");
    if (!text) return;
    try {
      const time = nowIso();
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      if (!lines.length) return;
      const body = lines.map((line) => `[${time}] ${stream} ${line}`).join("\n");
      appendFileSync(join(this.logsDir, `${id}.log`), `${body}\n`, "utf8");
    } catch {
      // 日志写失败不能影响任务本身。
    }
  }

  /**
   * 会话按「员工 + 工作目录」记，不是只按员工。
   * 否则换一个项目目录后，员工会带着上一个项目的对话继续干，很容易串味，
   * 而且这种错很难看出来——表现只是“它怎么知道那些事”。
   */
  #sessionKey(workerId, cwd) {
    return cwd ? `${workerId}::${cwd}` : workerId;
  }

  getWorkerSession(workerId, cwd = null) {
    const key = this.#sessionKey(workerId, cwd);
    const value = this.state.sessions[key];
    return typeof value === "string" && value ? value : null;
  }

  setWorkerSession(workerId, cwd, sessionId) {
    if (!sessionId) return;
    this.state.sessions[this.#sessionKey(workerId, cwd)] = sessionId;
    writeJsonAtomic(this.stateFile, this.state);
  }

  /** 旧数据里会话只按员工存；按该员工最近一次任务的目录归位，避免丢记忆。 */
  #migrateSessions() {
    let changed = false;
    for (const [key, value] of Object.entries(this.state.sessions)) {
      if (key.includes("::")) continue;
      if (typeof value !== "string" || !value) {
        delete this.state.sessions[key];
        changed = true;
        continue;
      }
      const latest = [...this.tasks.values()]
        .filter((task) => task.workerId === key && task.cwd)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      delete this.state.sessions[key];
      changed = true;
      if (latest) this.state.sessions[`${key}::${latest.cwd}`] = value;
    }
    if (changed) writeJsonAtomic(this.stateFile, this.state);
  }

  /**
   * 按员工汇总用量。默认只算今天（本地时区零点起）。
   * 直接从任务记录现算，不额外存一份汇总，免得两处数字对不上。
   *
   * 注意：这里**不汇总金额**。CLI 报的 cost 是整个会话的累计值，
   * 续接会话的任务会把它重复算进去，加总出来只会虚高，不如不给。
   */
  usageStats({ workerId = null, since = startOfToday() } = {}) {
    const sinceMs = Date.parse(since);
    const result = {
      workerId: workerId || "all",
      since,
      tasks: 0,
      completed: 0,
      failed: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      durationMs: 0,
    };

    for (const task of this.tasks.values()) {
      if (workerId && task.workerId !== workerId) continue;
      const created = Date.parse(task.createdAt || "");
      if (!Number.isFinite(created) || created < sinceMs) continue;

      result.tasks += 1;
      if (task.status === "completed") result.completed += 1;
      if (task.status === "failed" || task.status === "interrupted") result.failed += 1;

      const usage = pickUsage(task);
      if (usage) {
        result.turns += Number(usage.turns) || 0;
        result.inputTokens += Number(usage.inputTokens) || 0;
        result.outputTokens += Number(usage.outputTokens) || 0;
        result.cacheReadTokens += Number(usage.cacheReadTokens) || 0;
        result.thinkingTokens += Number(usage.thinkingTokens) || 0;
      }

      if (task.startedAt && task.finishedAt) {
        const span = Date.parse(task.finishedAt) - Date.parse(task.startedAt);
        if (Number.isFinite(span) && span > 0) result.durationMs += span;
      }
    }

    return result;
  }

  /** 面板展示用：某个员工在各目录下各有一段记忆。 */
  listWorkerSessions() {
    return Object.entries(this.state.sessions)
      .filter(([key, value]) => key.includes("::") && typeof value === "string" && value)
      .map(([key, value]) => {
        const [workerId, ...rest] = key.split("::");
        return { workerId, cwd: rest.join("::"), sessionId: value };
      });
  }

  forgetWorkerSession(workerId, cwd) {
    const key = this.#sessionKey(workerId, cwd);
    if (!this.state.sessions[key]) return false;
    delete this.state.sessions[key];
    writeJsonAtomic(this.stateFile, this.state);
    return true;
  }

  /**
   * 列任务。
   * @param {{status?:string|null, stage?:string|null, role?:"main"|"side"|"all"|null,
   *   limit?:number}} filter
   * role 省略 = 不过滤（内部调用保持老行为）；HTTP 层默认 main。
   */
  listTasks({ status = null, stage = null, role = null, limit = 50 } = {}) {
    let values = [...this.tasks.values()];
    if (status) values = values.filter((task) => task.status === status);
    if (role === "main" || role === "side") {
      values = values.filter((task) => (task.role === "side" ? "side" : "main") === role);
    }
    if (stage && STAGES.includes(stage)) {
      values = values.filter((task) => stageOf(task) === stage);
    }
    values.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return values.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200))).map((task) => this.summary(task));
  }

  counts() {
    const result = {
      total: this.tasks.size,
      side: 0,
      queued: 0,
      running: 0,
      retrying: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      stages: { running: 0, waiting: 0, queued: 0, done: 0 },
    };
    for (const task of this.tasks.values()) {
      // 侧问单独计数：它不该把「等你 / 在跑」这些格子撑起来，
      // 否则用户会以为有 3 个任务在排队，其实只有 1 个主任务 + 2 个答疑。
      if (task.role === "side") {
        result.side += 1;
        continue;
      }
      if (Object.hasOwn(result, task.status)) result[task.status] += 1;
      result.stages[stageOf(task)] += 1;
    }
    return result;
  }

  queuedFor(workerId) {
    return [...this.tasks.values()]
      .filter((task) => task.workerId === workerId && task.status === "queued")
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  summary(task) {
    return {
      id: task.id,
      workerId: task.workerId,
      kind: task.kind,
      title: task.title,
      status: task.status,
      stage: stageOf(task),
      cwd: task.cwd,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      sessionId: task.sessionId,
      error: task.error,
      costUsd: task.costUsd,
      attempts: task.attempts || 0,
      maxAttempts: task.maxAttempts || 1,
      nextRetryAt: task.nextRetryAt || null,
      acknowledgedAt: task.acknowledgedAt || null,
      progress: task.progress.slice(-1),
      hasResult: Boolean(task.result),
      resultPreview: task.result ? String(task.result).slice(0, 240) : null,
      role: task.role === "side" ? "side" : "main",
      parentTaskId: task.parentTaskId || null,
      sideQuestion: task.sideQuestion || null,
      readOnly: task.readOnly === true,
      steerCount: Number(task.steerCount || 0),
      lastSteerAt: task.lastSteerAt || null,
    };
  }

  clone(task) {
    return { ...structuredClone(task), stage: stageOf(task) };
  }

  hasActiveTasks() {
    return [...this.tasks.values()].some((task) => ACTIVE_STATUSES.has(task.status));
  }

  isTerminal(status) {
    return TERMINAL_STATUSES.has(status);
  }
}
