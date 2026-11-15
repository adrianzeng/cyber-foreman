import { readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { adapterKinds, DEFAULT_KIND, getAdapter } from "./adapters/index.mjs";
import { commandExists } from "./fsutil.mjs";
import { readTail, usageFromLog } from "./log-usage.mjs";
import { currentModels, listModels, modelOptionsFor } from "./models.mjs";
import { isBudgetExhausted } from "./usage.mjs";
import { pickUsage, stageOf } from "./store.mjs";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function taskTitle(prompt) {
  const line = String(prompt).trim().split(/\r?\n/).find(Boolean) || "未命名任务";
  return line.length > 72 ? `${line.slice(0, 72)}...` : line;
}

function childProcessAlive(child) {
  return Boolean(child && child.exitCode === null && !child.killed);
}

export class AgentHub {
  constructor({ store, workers }) {
    this.store = store;
    this.workers = workers;
    this.processes = new Map();
    this.runPromises = new Map();
    this.activeByWorker = new Map();
    this.cancelRequested = new Set();
    this.retryTimers = new Map();
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
        activeTaskId,
        activeTaskTitle: activeTask?.title || null,
        queued: this.store.queuedFor(id).length,
      };
    });
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
      tasks: this.store.listTasks({ limit: 50 }),
    };
  }

  async stopAll() {
    for (const [id, timer] of this.retryTimers) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }
    const active = [...this.processes.keys()];
    for (const id of active) {
      try { this.stopTask(id); } catch { /* best effort */ }
    }
    const promises = active.map((id) => this.runPromises.get(id)).filter(Boolean);
    await Promise.race([
      Promise.allSettled(promises),
      sleep(4000),
    ]);
  }
}
