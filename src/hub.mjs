import { readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { adapterKinds, DEFAULT_KIND, getAdapter, listAdapters } from "./adapters/index.mjs";
import { commandExists } from "./fsutil.mjs";
import { readTail, usageFromLog } from "./log-usage.mjs";
import { currentModels, listModels, modelOptionsFor } from "./models.mjs";
import { isBudgetExhausted } from "./usage.mjs";
import { pickUsage, stageOf } from "./store.mjs";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const MAX_STEER_CHARS = 4000;
const MAX_SIDE_CHARS = 4000;
const DEFAULT_SIDE_TIMEOUT_MS = 180_000;
const MIN_SIDE_TIMEOUT_MS = 1_000;
const MAX_SIDE_TIMEOUT_MS = 900_000;
const DEFAULT_STEER_WATCHDOG_MS = 90_000;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** 带错误码的错误：HTTP 层与通道层都靠 code 决定文案与状态码。 */
function codedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function taskTitle(prompt) {
  const line = String(prompt).trim().split(/\r?\n/).find(Boolean) || "未命名任务";
  return line.length > 72 ? `${line.slice(0, 72)}...` : line;
}

function childProcessAlive(child) {
  return Boolean(child && child.exitCode === null && !child.killed);
}

/**
 * 侧问的 prompt 模板（设计 §3.7）。
 * 关键在"只答疑、不改文件、不写回主任务"这三句：侧问是一个新进程，
 * 没有主任务的上下文，不给它交代清楚，它就会自己乱翻文件甚至动手改。
 */
function buildSidePrompt({ parent, question, cwd }) {
  const title = parent?.title || "（没有主任务，独立提问）";
  const goal = parent?.prompt ? String(parent.prompt).slice(0, 800) : "（无）";
  const recent = Array.isArray(parent?.progress)
    ? parent.progress.slice(-5).map((item) => `- ${String(item.message || "").slice(0, 120)}`)
    : [];
  return [
    "【侧问】主任务正在跑。这条问题只用于答疑，不要修改任何文件，也不要把结论写回主任务。",
    `主任务：${title}`,
    `工作目录：${cwd}`,
    `主任务目标（摘要）：${goal}`,
    "最近进度：",
    ...(recent.length ? recent : ["- （没有进度记录）"]),
    `问题：${question}`,
    "回答要求：简洁中文，先给结论，再给依据（引用具体文件/行号）；不确定就直说不确定。",
  ].join("\n");
}

export class AgentHub {
  constructor({ store, workers, steerWatchdogMs = DEFAULT_STEER_WATCHDOG_MS }) {
    this.store = store;
    this.workers = workers;
    this.processes = new Map();
    this.runPromises = new Map();
    this.activeByWorker = new Map();
    this.cancelRequested = new Set();
    this.retryTimers = new Map();
    /** 每个员工最多 1 个侧问在跑（不占 activeByWorker，主任务照跑）。 */
    this.activeSideByWorker = new Map();
    this.sideTimers = new Map();
    this.sideTimedOut = new Set();
    /** taskId → { steer, child, usage }：只有开了流式输入的 Claude 任务会在这里。 */
    this.steerables = new Map();
    /** taskId → 已经跑完的轮数（用于"插话后有没有新输出"的判断）。 */
    this.turnCounts = new Map();
    /** 插话后 90 秒无新输出就提示一次（不自动杀）。 */
    this.steerWatchdogs = new Map();
    this.steerWatchdogMs = Number(steerWatchdogMs) >= 0 ? Number(steerWatchdogMs) : DEFAULT_STEER_WATCHDOG_MS;
  }

  /** 每个员工的重试策略；配置里没写 retry 就不自动重试。 */
  retryPolicy(worker) {
    const raw = worker && typeof worker.retry === "object" && worker.retry ? worker.retry : {};
    const maxAttempts = Math.min(Math.max(Math.trunc(Number(raw.maxAttempts) || 1), 1), 10);
    const baseDelayMs = Math.min(Math.max(Math.trunc(Number(raw.baseDelayMs) || 2000), 0), 600_000);
    const maxDelayMs = Math.min(Math.max(Math.trunc(Number(raw.maxDelayMs) || 60_000), baseDelayMs), 600_000);
    return { maxAttempts, baseDelayMs, maxDelayMs };
  }

  workerEntries() {
    return Object.entries(this.workers);
  }

  defaultWorkerId() {
    return this.workerEntries().find(([, worker]) => !worker.disabled)?.[0] || null;
  }

  listWorkers() {
    // 当前 CLI 实际会用哪个模型，只在员工没单独指定时生效。
    const current = currentModels();
    return this.workerEntries().map(([id, worker]) => {
      const activeTaskId = this.activeByWorker.get(id) || null;
      const activeTask = activeTaskId ? this.store.getTask(activeTaskId) : null;
      const adapter = getAdapter(worker.kind);
      const kind = worker.kind || DEFAULT_KIND;
      const info = current[kind] || {};
      return {
        id,
        name: worker.name || id,
        kind,
        kindLabel: adapter?.label || worker.kind || "Claude",
        enabled: !worker.disabled,
        available: !worker.disabled && commandExists(worker.command),
        command: worker.command ? basename(worker.command) : null,
        commandPath: worker.command || null,
        argsPrefix: Array.isArray(worker.argsPrefix) ? worker.argsPrefix : [],
        cwd: worker.cwd || null,
        extraDirs: Array.isArray(worker.addDirs) ? worker.addDirs : [],
        permissionMode: worker.permissionMode || adapter?.defaultPermissionMode || "acceptEdits",
        model: worker.model || null,
        /** 员工没指定时，这里就是 CLI 配置里那个真正在用的模型。 */
        effectiveModel: worker.model || info.model || null,
        modelSource: worker.model ? "worker" : info.model ? "cli" : "unknown",
        baseUrl: info.baseUrl || null,
        /** 这个员工在当前工作目录下是否已有对话记忆。 */
        hasSession: Boolean(this.store.getWorkerSession(id, worker.cwd || null)),
        effort: worker.effort || null,
        autoApprove: worker.autoApprove !== false,
        retryMaxAttempts: Number(worker.retry?.maxAttempts) || 1,
        maxBudgetUsd: Number(worker.maxBudgetUsd) > 0 ? Number(worker.maxBudgetUsd) : null,
        /** 今日用量：任务数、token、牌价估算，直接从任务记录现算。 */
        today: this.store.usageStats({ workerId: id }),
        note: worker.note || null,
        /** 能不能中途插话：类型支持 + 员工开了「允许插话」两件事都要满足。 */
        supportsSteer: adapter?.supportsSteer === true,
        streamInput: worker.streamInput === true,
        steerable: Boolean(adapter?.supportsSteer === true && worker.streamInput === true),
        steerHint: this.#steerHint(adapter, worker),
        activeTaskId,
        activeTaskTitle: activeTask?.title || null,
        queued: this.store.queuedFor(id).length,
      };
    });
  }

  #steerHint(adapter, worker) {
    if (!adapter) return "不认识这个员工类型，插话不可用。";
    if (adapter.supportsSteer !== true) {
      return adapter.steerHint || "这个类型不支持插话；可以改用侧问，或停掉任务重新派。";
    }
    if (worker.streamInput !== true) {
      return `${adapter.label} 支持插话，但这个员工还没打开「允许插话」。打开后才能中途追加要求。`;
    }
    return `${adapter.label} 可以插话：任务在跑时直接追加要求即可。`;
  }

  /** 面板下拉用：某类员工能选哪些模型，当前生效的是哪个。 */
  modelOptions(kind, workerId = null) {
    const worker = workerId ? this.workers[workerId] : null;
    return modelOptionsFor(kind || worker?.kind || DEFAULT_KIND, worker?.model || null);
  }

  modelCatalog() {
    return listModels();
  }

  /** 面板改完员工后热替换，不重启进程。 */
  replaceWorkers(next) {
    const incoming = next && typeof next === "object" ? next : {};
    for (const id of Object.keys(this.workers)) delete this.workers[id];
    Object.assign(this.workers, incoming);
    // 被删掉的员工如果还有排队任务，这些任务没有归属了，直接标失败，避免永远卡在队列里。
    for (const task of this.store.listTasks({ stage: "queued", limit: 200 })) {
      if (!this.workers[task.workerId]) {
        this.store.updateTask(task.id, {
          status: "failed",
          error: `员工 ${task.workerId} 已被删除，任务没有执行者`,
          finishedAt: new Date().toISOString(),
        });
        this.store.addProgress(task.id, "员工已被删除，任务转入「等你」", "error");
      }
    }
  }

  dispatch(input) {
    const workerId = input.workerId || this.defaultWorkerId();
    if (!workerId) throw new Error("还没有可用的员工：在面板顶部点「+ 新增员工」先加一个");
    const worker = this.workers[workerId];
    if (!worker) throw new Error(`没有员工 ${workerId}`);
    if (worker.disabled) throw new Error(`员工「${worker.name || workerId}」已停用`);

    const prompt = String(input.prompt || input.task || "").trim();
    if (!prompt) throw new Error("任务内容不能为空");
    if (prompt.length > 200_000) throw new Error("任务内容超过 200000 字符");

    const cwd = resolve(input.cwd || worker.cwd || process.cwd());
    let stat;
    try {
      stat = statSync(cwd);
    } catch {
      throw new Error(`工作目录不存在：${cwd}`);
    }
    if (!stat.isDirectory()) throw new Error(`工作目录不是文件夹：${cwd}`);

    const newSession = input.newSession === true;
    const resumeSessionId = newSession ? null : this.store.getWorkerSession(workerId, cwd);
    const task = this.store.createTask({
      workerId,
      kind: worker.kind || DEFAULT_KIND,
      title: taskTitle(prompt),
      prompt,
      cwd,
      model: input.model || null,
      effort: input.effort || null,
      resumeSessionId,
      newSession,
      role: "main",
      readOnly: false,
      maxAttempts: this.retryPolicy(worker).maxAttempts,
      maxBudgetUsd: Number(worker.maxBudgetUsd) > 0 ? Number(worker.maxBudgetUsd) : null,
    });
    this.pump(workerId);
    return task;
  }

  async pump(workerId) {
    if (this.activeByWorker.has(workerId)) return;
    const next = this.store.queuedFor(workerId)[0];
    if (!next) return;

    this.activeByWorker.set(workerId, next.id);
    const worker = this.workers[workerId];
    const policy = this.retryPolicy(worker);
    const attempt = Number(next.attempts || 0) + 1;
    const task = this.store.updateTask(next.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      nextRetryAt: null,
      attempts: attempt,
    });
    this.store.addProgress(
      task.id,
      policy.maxAttempts > 1
        ? `已从队列取出，正在启动员工（第 ${attempt}/${policy.maxAttempts} 次尝试）`
        : "已从队列取出，正在启动员工",
      "running",
    );

    let launched;
    try {
      // 停用只挡住“新任务”，已经在队列里的照常跑完，免得任务凭空消失。
      if (!worker) throw new Error(`员工 ${workerId} 已不存在`);
      const adapter = getAdapter(worker.kind);
      if (!adapter) {
        throw new Error(`暂不支持的员工类型：${worker.kind}（可用：${adapterKinds().join(" / ")}）`);
      }
      if (!commandExists(worker.command)) {
        throw new Error(`找不到 ${adapter.label} 命令：${worker.command}`);
      }
      launched = adapter.start(worker, task, {
        onSession: (sessionId) => {
          this.store.updateTask(task.id, { sessionId });
          this.store.setWorkerSession(workerId, task.cwd, sessionId);
        },
        onProgress: (message, type, data) => {
          this.store.addProgress(task.id, message, type, data);
        },
        onLog: (stream, chunk) => {
          this.store.appendLog(task.id, stream, chunk);
        },
        // 每跑完一轮就记一次：插话后有没有新输出靠它判断，比看时间戳准。
        onTurnEnd: () => {
          this.turnCounts.set(task.id, (this.turnCounts.get(task.id) || 0) + 1);
        },
      });
    } catch (error) {
      // 配置类错误（命令不存在、类型不支持）重试也不会好，直接进「等你」。
      const message = error instanceof Error ? error.message : String(error);
      this.#finishFailure(task.id, workerId, worker, { error: message, retryable: false });
      this.activeByWorker.delete(workerId);
      queueMicrotask(() => this.pump(workerId));
      return;
    }

    const { child, done } = launched;
    const pid = child.pid ?? null;
    this.store.updateTask(task.id, { pid });
    this.processes.set(task.id, child);
    this.runPromises.set(task.id, done);
    // 只有开了流式输入的适配器才会返回 steer；别的类型这里什么都不做。
    if (typeof launched.steer === "function") {
      this.steerables.set(task.id, { steer: launched.steer, child, usage: launched.usage });
    }

    done
      .then((result) => {
        const cancelled = this.cancelRequested.has(task.id);
        if (result.sessionId) this.store.setWorkerSession(workerId, task.cwd, result.sessionId);
        if (cancelled) {
          this.store.updateTask(task.id, {
            status: "cancelled",
            result: result.result || null,
            sessionId: result.sessionId || task.sessionId,
            exitCode: result.exitCode,
            finishedAt: new Date().toISOString(),
            pid: null,
          });
          this.store.addProgress(task.id, "任务已停止", "cancelled");
          return;
        }
        if (isBudgetExhausted(result)) {
          // 预算刹车：不是员工的错，也不该自动重试（重试还会撞同一个上限）。
          // 落进「等你」，让人看一眼结果再决定要不要提高上限重派。
          const usage = result.usage || null;
          const spent = usage?.costUsd ? `（本轮约 $${usage.costUsd.toFixed(2)}）` : "";
          const turns = usage?.turns ? `，跑了 ${usage.turns} 轮` : "";
          this.#finishFailure(task.id, workerId, worker, {
            error: `达到单任务预算上限${spent}${turns}，已被截停。预算是每轮结束后才检查的，所以正在跑的那一轮已经花出去了。结果可能不完整，提高上限后可重新派发。`,
            result: result.result || null,
            sessionId: result.sessionId,
            exitCode: result.exitCode,
            usage,
            retryable: false,
          });
          return;
        }
        if (result.isError) {
          this.#finishFailure(task.id, workerId, worker, {
            error: result.error || "员工执行失败",
            result: result.result || null,
            sessionId: result.sessionId,
            exitCode: result.exitCode,
            usage: result.usage,
          });
          return;
        }
        this.store.updateTask(task.id, {
          status: "completed",
          result: result.result,
          error: null,
          sessionId: result.sessionId || task.sessionId,
          exitCode: result.exitCode,
          usage: result.usage,
          // costUsd 保留是为兼容旧字段，真实数据在 usage.costUsd。
          costUsd: result.usage?.costUsd ?? null,
          finishedAt: new Date().toISOString(),
          pid: null,
        });
        this.store.addProgress(task.id, "任务完成", "completed");
      })
      .catch((error) => {
        const cancelled = this.cancelRequested.has(task.id);
        const message = error instanceof Error ? error.message : String(error);
        if (cancelled) {
          this.store.updateTask(task.id, {
            status: "cancelled",
            error: null,
            finishedAt: new Date().toISOString(),
            pid: null,
          });
          this.store.addProgress(task.id, "任务已停止", "cancelled");
          return;
        }
        this.#finishFailure(task.id, workerId, worker, { error: message, retryable: true });
      })
      .finally(() => {
        this.processes.delete(task.id);
        this.runPromises.delete(task.id);
        this.cancelRequested.delete(task.id);
        this.steerables.delete(task.id);
        this.turnCounts.delete(task.id);
        this.#clearSteerWatchdog(task.id);
        this.activeByWorker.delete(workerId);
        this.pump(workerId);
      });
  }

  /**
   * 失败统一走这里：还有重试额度就排下一次（间隔指数递增），
   * 额度用完才真正落到 failed —— 也就是面板上的「等你」。
   */
  #finishFailure(taskId, workerId, worker, detail) {
    const current = this.store.getTask(taskId);
    if (!current) return;
    if (current.status === "cancelled") return;

    const policy = this.retryPolicy(worker);
    const attempts = Number(current.attempts || 0);
    const canRetry = detail.retryable !== false && attempts < policy.maxAttempts;

    const patch = {
      result: detail.result || null,
      error: detail.error,
      sessionId: detail.sessionId || current.sessionId || null,
      exitCode: detail.exitCode ?? null,
      usage: detail.usage || null,
      costUsd: detail.costUsd ?? null,
      pid: null,
    };

    if (!canRetry) {
      this.store.updateTask(taskId, {
        ...patch,
        status: "failed",
        nextRetryAt: null,
        finishedAt: new Date().toISOString(),
      });
      const retried = attempts > 1 ? `，已试 ${attempts} 次` : "";
      this.store.addProgress(taskId, `任务失败${retried}，已转入「等你」`, "error", {
        error: detail.error,
        attempts,
      });
      return;
    }

    const delay = Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempts - 1), policy.maxDelayMs);
    this.store.updateTask(taskId, {
      ...patch,
      status: "retrying",
      nextRetryAt: new Date(Date.now() + delay).toISOString(),
      // 重试用全新会话：上一次可能停在半截，续接容易原地复发同一个错误。
      newSession: true,
      resumeSessionId: null,
    });
    this.store.addProgress(
      taskId,
      `${detail.error}。${Math.round(delay / 100) / 10} 秒后自动重试（第 ${attempts + 1}/${policy.maxAttempts} 次）`,
      "retrying",
      { error: detail.error, attempt: attempts + 1, delayMs: delay },
    );

    const timer = setTimeout(() => {
      this.retryTimers.delete(taskId);
      const latest = this.store.getTask(taskId);
      if (!latest || latest.status !== "retrying") return;
      this.store.updateTask(taskId, { status: "queued", nextRetryAt: null });
      this.pump(workerId);
    }, delay);
    timer.unref?.();
    this.retryTimers.set(taskId, timer);
  }

  stopTask(id) {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`没有任务 ${id}`);
    if (this.store.isTerminal(task.status)) return task;
    if (task.status === "queued") {
      this.store.updateTask(id, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
      });
      this.store.addProgress(id, "排队中的任务已取消", "cancelled");
      return this.store.getTask(id);
    }
    if (task.status === "retrying") {
      const timer = this.retryTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.retryTimers.delete(id);
      }
      this.store.updateTask(id, {
        status: "cancelled",
        nextRetryAt: null,
        finishedAt: new Date().toISOString(),
      });
      this.store.addProgress(id, "自动重试已取消", "cancelled");
      return this.store.getTask(id);
    }

    this.cancelRequested.add(id);
    this.store.updateTask(id, { status: "cancelling" });
    this.store.addProgress(id, "收到停止请求，正在结束 Claude 进程", "cancelling");
    const child = this.processes.get(id);
    if (!childProcessAlive(child)) {
      this.store.updateTask(id, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        pid: null,
      });
      return this.store.getTask(id);
    }

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {
        try { child.kill(); } catch { /* already gone */ }
      });
    } else {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    return this.store.getTask(id);
  }

  /** 人工重派：把已经结束（含重试耗尽）的任务重新放回队列，重试额度重置。 */
  retryTask(id) {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`没有任务 ${id}`);
    // 侧问是一次性答疑，重跑没有意义；让它回到队列还会占掉主任务槽位。
    if (task.role === "side") throw new Error("侧问不能重新派发：换个问题再问一次就行");
    if (!this.store.isTerminal(task.status)) {
      throw new Error("任务还在进行，先停止再重新派发");
    }
    const worker = this.workers[task.workerId];
    if (!worker) throw new Error(`员工 ${task.workerId} 已不存在，检查 config/workers.json`);
    if (worker.disabled) throw new Error(`员工 ${task.workerId} 已停用`);

    this.store.updateTask(id, {
      status: "queued",
      error: null,
      result: null,
      exitCode: null,
      usage: null,
      costUsd: null,
      startedAt: null,
      finishedAt: null,
      pid: null,
      nextRetryAt: null,
      acknowledgedAt: null,
      attempts: 0,
      manualRetries: Number(task.manualRetries || 0) + 1,
      newSession: true,
      resumeSessionId: null,
    });
    this.store.addProgress(id, "人工重新派发，已回到队列", "queued");
    this.pump(task.workerId);
    return this.store.getTask(id);
  }

  /** 「等你」里的任务由人判断处理完：不改状态，只把它移出「等你」。 */
  acknowledgeTask(id) {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`没有任务 ${id}`);
    if (task.acknowledgedAt) return task;
    if (stageOf(task) !== "waiting") {
      throw new Error("只有「等你」里的任务需要标记已处理");
    }
    this.store.updateTask(id, { acknowledgedAt: new Date().toISOString() });
    this.store.addProgress(id, "已由人标记处理完，移出「等你」", "acknowledged");
    return this.store.getTask(id);
  }

  /**
   * 给正在跑的任务追加一条用户消息（插话）。
   *
   * 每种拒绝都带 code + 中文原因：通道层要原文转述给用户，**不允许静默失败**。
   * 文案刻意**不写斜杠命令**：同一句会同时出现在手机 IM 和 Web 面板上，
   * 面板里没有输入框可发 `/停`，写了反而让人去找一个不存在的东西。
   *
   * 插话不改 status、不改 attempts、不重置 startedAt —— 它不是重试，
   * 耗时如实包含被插话拉长的那部分。
   */
  async steerTask(id, text, opts = {}) {
    const task = this.store.getTask(id);
    if (!task) throw codedError("NO_TASK", `没有找到编号 ${id} 的任务，可能已经被清理了。`);

    if (task.role === "side") {
      throw codedError("STEER_NOT_RUNNING", "侧问只回答一次问题，不能插话。想继续追问，再发一条新的问题就行。");
    }

    const body = String(text ?? "").trim();
    if (!body) throw codedError("STEER_EMPTY", "插话内容不能为空");
    if (body.length > MAX_STEER_CHARS) {
      throw codedError("STEER_TOO_LONG", `插话内容太长了（最多 ${MAX_STEER_CHARS} 字），拆短一点说`);
    }
    if (task.status !== "running") {
      throw codedError("STEER_NOT_RUNNING", this.#steerStatusMessage(task));
    }

    const worker = this.workers[task.workerId];
    if (!worker) throw codedError("WORKER_UNAVAILABLE", `员工 ${task.workerId} 已被删除，插不进去了`);
    const adapter = getAdapter(worker.kind);
    if (!adapter) {
      throw codedError("STEER_UNSUPPORTED", `暂不支持的员工类型：${worker.kind}`, { fallback: "side" });
    }
    if (adapter.supportsSteer !== true) {
      throw codedError(
        "STEER_UNSUPPORTED",
        `${adapter.label} 不支持插话（它的任务是把 prompt 当命令行参数一次性执行的）。`,
        { fallback: "side" },
      );
    }
    if (worker.streamInput !== true) {
      throw codedError(
        "STEER_UNSUPPORTED",
        `「${worker.name || task.workerId}」还没打开「允许插话」，先到员工设置里打开。`,
        { fallback: "side" },
      );
    }

    const live = this.steerables.get(task.id);
    if (!live || !childProcessAlive(live.child)) {
      throw codedError("STEER_WRITE_FAILED", "员工进程已经结束，插话没送进去。重新派发一次，或者改用侧问。");
    }

    let result;
    try {
      result = await live.steer(body);
    } catch (error) {
      throw codedError("STEER_WRITE_FAILED", error instanceof Error ? error.message : String(error));
    }
    if (!result || result.ok !== true) {
      throw codedError("STEER_WRITE_FAILED", result?.error || "插话没写进员工进程");
    }

    const at = new Date().toISOString();
    this.store.addSteer(task.id, {
      at,
      text: body,
      parts: Array.isArray(opts.parts) && opts.parts.length > 1 ? opts.parts : undefined,
      source: opts.source || "panel",
      actor: opts.actor && typeof opts.actor === "object" ? opts.actor : undefined,
      delivered: true,
    });
    // 事件类型用 steer-progress：真正的插话事件由 addSteer 写（带原文），
    // 这里再写一条同类型的会和它混在一起，事后 grep 分不清。
    this.store.addProgress(task.id, `主控插话：${body.slice(0, 120)}`, "steer-progress", {
      source: opts.source || "panel",
    });
    this.#armSteerWatchdog(task.id, this.turnCounts.get(task.id) || 0);

    return {
      delivered: "steer",
      task: this.store.getTask(task.id),
      warning: this.#budgetWarning(task, live),
    };
  }

  /** 每种状态都给一句"为什么不行 + 接下来怎么办"，措辞不含斜杠命令（面板也要显示）。 */
  #steerStatusMessage(task) {
    switch (task.status) {
      case "queued":
        return "任务还在排队，等它开始跑再插话；现在想撤就先把它停掉。";
      case "retrying":
        return "任务正在等自动重试，现在插话会被丢掉。等它重新跑起来，或者先停掉再重派。";
      case "cancelling":
        return "任务正在停止，等它停稳再说。";
      case "waiting":
        return "任务已经停下了（在等你处理），重新派发一次，或者换成侧问。";
      case "failed":
      case "interrupted":
        return "任务已经停下了，重新派发一次，或者换成侧问。";
      case "completed":
        return "任务已经结束了，看结果或直接派个新任务。";
      case "cancelled":
        return "任务已取消，重新派一个吧。";
      default:
        return `任务当前状态是 ${task.status}，插不进去。`;
    }
  }

  /**
   * 预算刹车前的提醒：不阻止插话（用户有权继续），但必须知道离上限还有多远。
   * 触顶后仍然走原来的预算截停路径，这里不引入第二套会计。
   */
  #budgetWarning(task, live) {
    const worker = this.workers[task.workerId];
    const max = Number(task.maxBudgetUsd ?? worker?.maxBudgetUsd ?? 0);
    if (!(max > 0)) return null;
    let usage = null;
    try {
      usage = live?.usage?.() || pickUsage(task);
    } catch {
      usage = pickUsage(task);
    }
    const spent = Number(usage?.costUsd);
    if (!Number.isFinite(spent) || spent <= 0) return null;
    if (spent / max <= 0.8) return null;
    return `已用 $${spent.toFixed(1)} / 上限 $${max.toFixed(1)}，插话会继续消耗，到顶就停`;
  }

  /** 插话后长时间没动静只提醒，不自动杀 —— 判断权在人手里。 */
  #armSteerWatchdog(taskId, baselineTurns) {
    const ms = this.steerWatchdogMs;
    if (!(ms > 0)) return;
    this.#clearSteerWatchdog(taskId);
    const timer = setTimeout(() => {
      this.steerWatchdogs.delete(taskId);
      const current = this.store.getTask(taskId);
      if (!current || current.status !== "running") return;
      // 只认"又跑完了一轮"：init/进度之类的噪声不算新输出。
      if ((this.turnCounts.get(taskId) || 0) > baselineTurns) return;
      const seconds = Math.max(1, Math.round(ms / 1000));
      this.store.addProgress(taskId, `插话后 ${seconds} 秒没有新输出，员工可能没在响应`, "warn");
    }, ms);
    timer.unref?.();
    this.steerWatchdogs.set(taskId, timer);
  }

  #clearSteerWatchdog(taskId) {
    const timer = this.steerWatchdogs.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.steerWatchdogs.delete(taskId);
    }
  }

  /**
   * 侧问：另起一个只读短任务回答问题。
   *
   * 三个"绝对不要"：
   *   1. 不占 activeByWorker（否则主任务会被自己堵住）
   *   2. 不复用 pump（pump 与员工互斥强绑定，硬塞会破坏现有语义）
   *   3. **不调 setWorkerSession**（否则侧问会把主任务的会话记忆冲掉，
   *      而且表面上完全正常，只是主任务突然失忆 —— 最难排查的一类 bug）
   */
  askSide(input = {}) {
    const question = String(input.question ?? "").trim();
    if (!question) throw codedError("QUESTION_EMPTY", "要问什么？例如 /问 这个仓库的构建命令是什么");
    if (question.length > MAX_SIDE_CHARS) {
      throw codedError("QUESTION_EMPTY", `问题太长了（最多 ${MAX_SIDE_CHARS} 字），拆短一点`);
    }

    let parent = input.parentTaskId ? this.store.getTask(input.parentTaskId) : null;
    if (input.parentTaskId && !parent) {
      throw codedError("NO_PARENT", `没有找到编号 ${input.parentTaskId} 的任务，可能已经被清理了。`);
    }

    // 追问侧问时，新侧问仍挂回原主任务，不能 side → side → side 一层层套下去。
    // 顺带让 buildSidePrompt 的摘要取主任务：上一条侧问的 prompt 只是个问题，没有上下文价值。
    // 理论上不该出现环，seen 只是防脏数据把这里卡死。
    const seen = new Set();
    while (parent?.role === "side" && parent.parentTaskId && !seen.has(parent.id)) {
      seen.add(parent.id);
      const upper = this.store.getTask(parent.parentTaskId);
      if (!upper) break;
      parent = upper;
    }

    const workerId = input.workerId || parent?.workerId || this.defaultWorkerId();
    if (!workerId) throw codedError("WORKER_UNAVAILABLE", "还没有可用的员工：在面板里先加一个");
    const worker = this.workers[workerId];
    if (!worker) throw codedError("WORKER_UNAVAILABLE", `没有员工 ${workerId}`);
    if (worker.disabled) throw codedError("WORKER_UNAVAILABLE", `员工「${worker.name || workerId}」已停用`);
    const adapter = getAdapter(worker.kind);
    if (!adapter) throw codedError("WORKER_UNAVAILABLE", `暂不支持的员工类型：${worker.kind}`);
    if (!commandExists(worker.command)) {
      throw codedError("WORKER_UNAVAILABLE", `找不到 ${adapter.label} 命令：${worker.command}`);
    }
    if (this.activeSideByWorker.has(workerId)) {
      throw codedError("SIDE_BUSY", `「${worker.name || workerId}」正在回答上一条侧问，等它答完再问`);
    }

    const cwd = resolve(input.cwd || parent?.cwd || worker.cwd || process.cwd());
    const task = this.store.createTask({
      workerId,
      kind: worker.kind || DEFAULT_KIND,
      title: `侧问 · ${question.slice(0, 40)}`,
      prompt: buildSidePrompt({ parent, question, cwd }),
      cwd,
      role: "side",
      parentTaskId: parent?.id || null,
      sideQuestion: question,
      readOnly: true,
      newSession: true,
      resumeSessionId: null,
      maxAttempts: 1,
      maxBudgetUsd: null,
    });

    this.activeSideByWorker.set(workerId, task.id);
    this.#runSide(task, worker, adapter);

    return {
      task: this.store.getTask(task.id),
      note: "侧问是只读的：不会改文件，也不会把答案塞回主任务。",
    };
  }

  /**
   * 任务中对话的统一入口：auto 的降级规则只有这一份，面板与通道层共用。
   *
   * auto 的语义是「能插就插，插不进去就换一条只读侧问把话答了」。
   * 所以对着侧问结果继续追问（面板里按 Enter）不能是死路：steerTask 会抛
   * STEER_NOT_RUNNING，这里把它当作「继续追问」降级成新侧问。
   * 显式 mode:"steer" 一律不降级，拒绝原因原样给用户。
   */
  async say(id, text, opts = {}) {
    const mode = ["auto", "steer", "side"].includes(opts.mode) ? opts.mode : "auto";
    const sayText = String(text ?? "").trim();

    if (mode === "side") return this.#saySide(id, sayText);

    try {
      const result = await this.steerTask(id, sayText, {
        source: opts.source || "panel",
        actor: opts.actor,
        parts: opts.parts,
      });
      return {
        delivered: "steer",
        task: this.taskDetail(id) || result.task,
        note: null,
        warning: result.warning || null,
      };
    } catch (error) {
      if (mode === "auto" && this.#sayShouldFallback(id, error)) {
        return this.#saySide(id, sayText);
      }
      throw error;
    }
  }

  #sayShouldFallback(id, error) {
    if (error?.code === "STEER_UNSUPPORTED") return true;
    // 只有「目标是侧问任务」才把 STEER_NOT_RUNNING 当成继续追问。
    // 主任务排队中/已结束时保持原样拒绝，别凭空多出一条侧问。
    if (error?.code !== "STEER_NOT_RUNNING") return false;
    return this.store.getTask(id)?.role === "side";
  }

  #saySide(id, question) {
    const side = this.askSide({ parentTaskId: id, question });
    return {
      delivered: "side",
      task: this.taskDetail(id) || side.task,
      sideTaskId: side.task.id,
      note: side.note,
      warning: null,
    };
  }

  #runSide(task, worker, adapter) {
    const configured = Math.trunc(Number(worker.sideTimeoutMs)) || DEFAULT_SIDE_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(configured, MIN_SIDE_TIMEOUT_MS), MAX_SIDE_TIMEOUT_MS);
    const workerId = task.workerId;

    this.store.updateTask(task.id, { status: "running", startedAt: new Date().toISOString() });
    this.store.addProgress(task.id, "侧问已启动（只读，不写会话记忆）", "running");

    let launched;
    try {
      launched = adapter.start(worker, { ...task, readOnly: true, newSession: true, resumeSessionId: null }, {
        // 只记到任务上；刻意不调 setWorkerSession，主任务的记忆必须原样保留。
        onSession: (sessionId) => {
          this.store.updateTask(task.id, { sessionId });
        },
        onProgress: (message, type, data) => {
          this.store.addProgress(task.id, message, type, data);
        },
        onLog: (stream, chunk) => {
          this.store.appendLog(task.id, stream, chunk);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#finishSide(task.id, workerId, { error: message });
      return;
    }

    const { child, done } = launched;
    this.processes.set(task.id, child);
    this.runPromises.set(task.id, done);
    this.store.updateTask(task.id, { pid: child.pid ?? null });

    const timer = setTimeout(() => {
      this.sideTimers.delete(task.id);
      this.sideTimedOut.add(task.id);
      try {
        this.stopTask(task.id);
      } catch {
        // 进程可能刚好自己结束了。
      }
    }, timeoutMs);
    timer.unref?.();
    this.sideTimers.set(task.id, timer);

    const cleanup = () => {
      const currentTimer = this.sideTimers.get(task.id);
      if (currentTimer) clearTimeout(currentTimer);
      this.sideTimers.delete(task.id);
      this.sideTimedOut.delete(task.id);
      this.processes.delete(task.id);
      this.runPromises.delete(task.id);
      this.cancelRequested.delete(task.id);
      if (this.activeSideByWorker.get(workerId) === task.id) this.activeSideByWorker.delete(workerId);
    };

    done
      .then((result) => {
        const timedOut = this.sideTimedOut.has(task.id);
        const cancelled = this.cancelRequested.has(task.id);
        if (timedOut) {
          this.#finishSide(task.id, workerId, {
            error: `侧问超过 ${Math.round(timeoutMs / 1000)} 秒，已停下`,
            usage: result?.usage || null,
          });
          return;
        }
        if (cancelled) {
          this.store.updateTask(task.id, {
            status: "cancelled",
            error: null,
            finishedAt: new Date().toISOString(),
            pid: null,
          });
          this.store.addProgress(task.id, "侧问已停止", "cancelled");
          return;
        }
        if (result?.isError) {
          this.#finishSide(task.id, workerId, {
            error: result.error || "侧问失败",
            result: result.result || null,
            usage: result.usage || null,
            exitCode: result.exitCode,
          });
          return;
        }
        this.store.updateTask(task.id, {
          status: "completed",
          result: result?.result || "",
          error: null,
          sessionId: result?.sessionId || task.sessionId,
          exitCode: result?.exitCode ?? null,
          usage: result?.usage || null,
          costUsd: result?.usage?.costUsd ?? null,
          finishedAt: new Date().toISOString(),
          pid: null,
        });
        this.store.addProgress(task.id, "侧问完成", "completed");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#finishSide(task.id, workerId, { error: message });
      })
      .finally(cleanup);
  }

  #finishSide(taskId, workerId, detail) {
    this.store.updateTask(taskId, {
      status: "failed",
      error: detail.error,
      result: detail.result || null,
      usage: detail.usage || null,
      exitCode: detail.exitCode ?? null,
      finishedAt: new Date().toISOString(),
      pid: null,
    });
    this.store.addProgress(taskId, `侧问没答出来：${detail.error}`, "error", { error: detail.error });
    if (this.activeSideByWorker.get(workerId) === taskId) this.activeSideByWorker.delete(workerId);
  }

  /** 面板用它决定插话按钮能不能点、点了为什么会灰。 */
  capabilities() {
    return {
      adapters: listAdapters().map((adapter) => ({
        kind: adapter.kind,
        label: adapter.label,
        supportsSteer: adapter.supportsSteer === true,
        steerHint: adapter.steerHint || "",
      })),
    };
  }

  async waitTask(id, timeoutSeconds = 0) {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`没有任务 ${id}`);
    if (this.store.isTerminal(task.status) || timeoutSeconds <= 0) {
      return { ...task, waitTimedOut: false };
    }
    const deadline = Date.now() + Math.min(Number(timeoutSeconds) || 0, 120) * 1000;
    while (Date.now() < deadline) {
      await sleep(250);
      const current = this.store.getTask(id);
      if (!current) throw new Error(`任务 ${id} 在等待期间消失`);
      if (this.store.isTerminal(current.status)) {
        return { ...current, waitTimedOut: false };
      }
    }
    return { ...this.store.getTask(id), waitTimedOut: true };
  }

  taskDetail(id) {
    let task = this.store.getTask(id);
    if (!task) return null;

    // 旧任务只存了 CLI 原始 usage，没有轮数。日志里本来就有，补一次并落盘。
    // 只有真拿到数据才写标记：拿不到就下次再试，避免一次偶发失败把记录钉死。
    if (!task.usageBackfilled && !pickUsage(task)?.turns) {
      const usage = usageFromLog(this.store.logsDir, id);
      if (usage) task = this.store.updateTask(id, { usage, usageBackfilled: true });
    }

    let logTail = "";
    try {
      logTail = readTail(join(this.store.logsDir, `${id}.log`), 12_000);
    } catch {
      // 没有日志时保持空。
    }
    return { ...task, logTail };
  }

  /** 用量统计。不传 workerId 就是全站，默认只算今天。 */
  usageStats(workerId = null, since = undefined) {
    return this.store.usageStats(since ? { workerId, since } : { workerId });
  }

  overview() {
    return {
      service: "dsh-agent-hub",
      version: PACKAGE.version || "0.0.0",
      time: new Date().toISOString(),
      counts: this.store.counts(),
      workers: this.listWorkers(),
      today: this.store.usageStats(),
      // 概览只列主任务：侧问是答疑产物，混进来会让「在跑」看起来比实际忙。
      tasks: this.store.listTasks({ role: "main", limit: 50 }),
    };
  }

  async stopAll() {
    for (const [id, timer] of this.retryTimers) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }
    for (const [id, timer] of this.sideTimers) {
      clearTimeout(timer);
      this.sideTimers.delete(id);
    }
    for (const id of [...this.steerWatchdogs.keys()]) this.#clearSteerWatchdog(id);
    const active = new Set([...this.processes.keys()]);
    for (const id of active) {
      try { this.stopTask(id); } catch { /* best effort */ }
    }
    const promises = [...active].map((id) => this.runPromises.get(id)).filter(Boolean);
    await Promise.race([
      Promise.allSettled(promises),
      sleep(4000),
    ]);
    this.steerables.clear();
    this.activeSideByWorker.clear();
  }
}
