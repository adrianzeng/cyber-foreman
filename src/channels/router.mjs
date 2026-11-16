import { MergeWindow, DEFAULT_MERGE_WINDOW_MS } from "./base.mjs";
import { parseIntent, shortId } from "./intent.mjs";
import * as text from "./notify.mjs";
import { scrub } from "./secrets.mjs";

/**
 * 消息路由：通道层唯一的「大脑」。
 *
 * 职责边界（设计 §1.2）：
 *   - 只做鉴权（白名单）、意图分发、调 Hub、回推文案
 *   - **不 spawn、不 import adapters、不改 TaskStore**（只读任务用于展示）
 *   - 插话/侧问怎么执行全在 Hub 里，这里只负责把用户那句话送进去并把结果说清楚
 *
 * 原则：任何拒绝都必须说清楚为什么、下一步做什么，绝不静默失败。
 */

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MAX_TEXT = 4000;
const MAX_LIST = 10;

/** 插话失败的错误码 → 一句能照着做的话（每个 code 都必须有一条，不许漏）。 */
const STEER_ERROR_TEXT = {
  NO_TASK: "找不到这个任务，发 /任务 看看编号",
  STEER_NOT_RUNNING: "任务现在不在跑，插不进去，等它跑起来再试",
  STEER_UNSUPPORTED: "这个员工不支持插话",
  STEER_EMPTY: "插话内容不能为空",
  STEER_TOO_LONG: `插话内容太长（最多 ${MAX_TEXT} 字）`,
  STEER_WRITE_FAILED: "员工进程已经结束，插话没送进去。用 /重派 重来一次，或 /问 侧问",
};

/** 侧问失败的错误码 → 人话。 */
const SIDE_ERROR_TEXT = {
  NO_PARENT: "没有找到对应的主任务；直接发 /问 你的问题 就行",
  SIDE_BUSY: "这个员工正在回答上一条侧问，等它答完再问",
  WORKER_UNAVAILABLE: "这个员工现在不可用（停用或命令找不到）",
  QUESTION_EMPTY: "要问什么？例如 /问 这个仓库的构建命令是什么",
};

function nowIso() {
  return new Date().toISOString();
}

export class MessageRouter {
  constructor(options = {}) {
    const {
      configStore,
      hub,
      store = null,
      logger = console,
      send = null,
      resolveChannel = null,
      mergeWindowMs = DEFAULT_MERGE_WINDOW_MS,
    } = options;
    if (!configStore) throw new Error("MessageRouter 需要 configStore");
    if (!hub) throw new Error("MessageRouter 需要 hub");
    this.configStore = configStore;
    this.hub = hub;
    this.store = store;
    this.logger = logger || console;
    this.sendFn = typeof send === "function" ? send : null;
    this.resolveChannel = typeof resolveChannel === "function" ? resolveChannel : () => null;

    // 600ms 合并窗口只作用于通道侧的插话（手机会把一句话拆成几次提交）。
    this.mergeWindowMs = Math.max(0, Number(mergeWindowMs) || 0);
    this.mergeWindow = this.mergeWindowMs > 0
      ? new MergeWindow({ windowMs: this.mergeWindowMs, onFlush: (parts) => this.flushSteer(parts) })
      : null;
  }

  // ── 入口 ────────────────────────────────────────────────────────────────

  /**
   * 处理一条入站消息。
   * @param {{channelId:string, chatId:string, chatType?:string, chatTitle?:string,
   *   senderId?:string, senderName?:string, messageId?:string, text:string,
   *   mentionsMe?:boolean, receivedAt?:string}} msg
   */
  async handle(msg) {
    if (!msg || typeof msg !== "object") return;
    const channelId = String(msg.channelId || "");
    const chatId = String(msg.chatId || "");
    if (!channelId || !chatId) return;

    const channel = this.resolveChannel(channelId);
    const label = channel?.label || channelId;
    const raw = String(msg.text || "").trim();

    const intent = parseIntent(raw, this.intentContext(chatId));

    if (intent.kind === "empty") return;
    if (intent.kind === "bind") {
      await this.bindChat(channelId, chatId, label, intent, msg);
      return;
    }
    if (intent.kind === "help") {
      await this.reply(channelId, chatId, text.help());
      return;
    }

    const binding = this.resolveBinding(msg);
    if (!binding) {
      // 未绑定：固定话术，不执行任何 Hub 操作，也不产生任务。
      await this.reply(channelId, chatId, text.unbound(label));
      return;
    }

    switch (intent.kind) {
      case "status":
        await this.reply(channelId, chatId, text.statusLine(this.store?.counts?.() || null));
        return;
      case "workers":
        await this.reply(channelId, chatId, this.workersText(binding));
        return;
      case "list":
        await this.reply(channelId, chatId, this.listText(chatId));
        return;
      case "detail":
        await this.reply(channelId, chatId, this.detailText(chatId, intent));
        return;
      case "stop":
        await this.reply(channelId, chatId, this.stopText(chatId, intent));
        return;
      case "retry":
        await this.reply(channelId, chatId, this.retryText(chatId, intent));
        return;
      case "ack":
        await this.reply(channelId, chatId, this.ackText(chatId, intent));
        return;
      case "switch":
        await this.reply(channelId, chatId, this.switchText(binding, intent));
        return;
      case "clear":
        await this.reply(channelId, chatId, this.clearText(binding));
        return;
      case "dispatch":
        await this.dispatchTask(channelId, chatId, binding, intent, msg);
        return;
      case "steer":
        await this.steerOrSide(channelId, chatId, binding, intent, msg);
        return;
      case "side":
        await this.askSide(channelId, chatId, binding, intent, msg);
        return;
      case "ambiguous":
        await this.reply(channelId, chatId, text.ambiguous(intent.candidates, {
          workerName: (workerId) => this.workerName(workerId),
        }));
        return;
      default:
        await this.reply(channelId, chatId, intent.hint || `没看懂「${text.clip(raw, 60)}」，发 /帮 看能用的命令`);
    }
  }

  /**
   * 任务事件回调。只推三种：首次进「等你」、终态、侧问答案；
   * running 期间老老实实不打扰（长任务最烦的就是刷屏）。
   */
  async onTaskEvent(event) {
    if (!event || event.type !== "task") return;
    const deliveries = this.configStore.deliveriesFor(event.taskId);
    if (!deliveries.length) return;

    const isTerminal = TERMINAL_STATUSES.has(event.status);
    const isWaiting = event.stage === "waiting";
    if (!isTerminal && !isWaiting) return;

    const detail = this.hub.taskDetail ? this.hub.taskDetail(event.taskId) : null;

    for (const delivery of deliveries) {
      if (isWaiting && delivery.lastNotifiedStatus === "waiting") continue;
      if (isTerminal && delivery.lastNotifiedStatus === event.status) continue;

      const messages = this.eventMessages(event, detail || { title: event.title, role: event.role }, delivery);
      if (!messages.length) continue;

      for (const message of messages) {
        await this.reply(delivery.channelId, delivery.chatId, message);
      }
      this.configStore.recordDelivery(event.taskId, {
        pushedAt: nowIso(),
        lastNotifiedStatus: isTerminal ? event.status : "waiting",
      });
    }
  }

  eventMessages(event, detail, delivery) {
    const role = event.role || detail?.role || "main";
    if (role === "side" || delivery?.kind === "side") {
      if (event.status === "completed") return text.sideAnswer(detail, detail?.sideQuestion || null);
      if (TERMINAL_STATUSES.has(event.status)) return [text.sideFailed(detail)];
      return [];
    }
    if (event.stage === "waiting") return [text.waiting(detail)];
    switch (event.status) {
      case "completed":
        return text.completed(detail);
      case "failed":
        return text.failed(detail);
      case "cancelled":
        return [text.cancelled(detail)];
      case "interrupted":
        return [text.interrupted(detail)];
      default:
        return [];
    }
  }

  // ── 绑定 ────────────────────────────────────────────────────────────────

  resolveBinding(msg) {
    const chatId = String(msg?.chatId || "");
    if (!chatId) return null;
    const found = this.configStore.findBinding(chatId);
    if (!found) return null;
    return { channelId: found.channelId, chatId, entry: found.entry };
  }

  async bindChat(channelId, chatId, label, intent, msg) {
    const code = String(intent.text || "").trim();
    if (!/^\d{6}$/.test(code)) {
      await this.reply(channelId, chatId, text.bindCodeHint(label));
      return;
    }

    const config = this.configStore.get(channelId);
    const pair = this.configStore.pairCodeFor(channelId);
    if (!pair || pair.code !== code) {
      await this.reply(channelId, chatId, text.bindExpired());
      return;
    }

    // 用后即焚：先作废再写绑定，避免同一个码被两个会话同时用掉。
    this.configStore.consumePairCode(channelId, code);
    const entry = this.configStore.upsertBinding(channelId, {
      chatId,
      chatType: msg.chatType === "group" ? "group" : "p2p",
      chatTitle: msg.chatTitle || "",
      workerId: config?.defaults?.workerId || null,
      cwd: config?.defaults?.cwd || null,
      newSession: config?.defaults?.newSession === true,
      boundAt: nowIso(),
      boundBy: "pair-code",
      enabled: true,
    });

    await this.reply(channelId, chatId, text.bindSuccess(this.workerName(entry.workerId), entry));
  }

  // ── 派活 ────────────────────────────────────────────────────────────────

  async dispatchTask(channelId, chatId, binding, intent, msg) {
    const prompt = String(intent.text || "").trim();
    const selector = intent.workerSelector ? String(intent.workerSelector).trim() : "";

    if (selector && !prompt) {
      await this.reply(channelId, chatId, text.dispatchWorkerNoText(selector));
      return;
    }
    if (!prompt) {
      await this.reply(channelId, chatId, text.dispatchEmpty());
      return;
    }
    if (prompt.length > MAX_TEXT * 50) {
      await this.reply(channelId, chatId, text.dispatchTooLong());
      return;
    }

    // 临时点名：编号 / id / 名字都能选；点错了要说清，绝不悄悄派给默认员工。
    let picked = null;
    if (selector) {
      picked = this.resolveWorker(selector);
      if (!picked) {
        await this.reply(channelId, chatId, text.workerNotFound(selector, this.workerList()));
        return;
      }
      if (picked.enabled === false || picked.available === false) {
        await this.reply(channelId, chatId, text.workerUnavailable(picked));
        return;
      }
    }

    let task;
    try {
      task = this.hub.dispatch({
        workerId: picked?.id || binding.entry.workerId || undefined,
        prompt,
        // 临时点名时绝不沿用会话目录：4 个员工各绑不同项目，混用会串项目。
        // cwd 不传，Hub 就会用这个员工自己配置里的目录。
        cwd: picked ? undefined : (binding.entry.cwd || undefined),
        newSession: binding.entry.newSession === true,
      });
    } catch (error) {
      await this.reply(channelId, chatId, text.dispatchFailed(this.errorText(error, channelId)));
      return;
    }

    this.configStore.addDelivery({
      taskId: task.id,
      channelId,
      chatId,
      kind: "main",
      ackedAt: nowIso(),
      pushedAt: null,
      lastNotifiedStatus: task.status || "queued",
    });

    const defaultId = binding.entry.workerId
      || (typeof this.hub.defaultWorkerId === "function" ? this.hub.defaultWorkerId() : null);
    await this.reply(channelId, chatId, text.receipt(task, this.workerName(task.workerId), {
      picked: picked ? picked.name : null,
      defaultName: this.workerName(defaultId),
    }));
  }

  /**
   * 插话优先；不支持就自动降级侧问并明说（绝不静默）。
   * 先用 600ms 合并窗口收一下（手机碎句），再真正写进员工进程。
   */
  async steerOrSide(channelId, chatId, binding, intent, msg) {
    const target = this.resolveTask(chatId, intent) || this.onlyRunning(chatId);
    if (!target) {
      if (intent.invalidIndex) {
        await this.reply(channelId, chatId, text.taskMissing(intent.targetIndex));
        return;
      }
      await this.reply(channelId, chatId, text.noRunningTask());
      return;
    }
    const say = String(intent.text || "").trim();
    if (!say) {
      await this.reply(channelId, chatId, text.steerEmpty(target.title, this.indexHint(chatId, target.id)));
      return;
    }
    if (say.length > MAX_TEXT) {
      await this.reply(channelId, chatId, text.steerTooLong(MAX_TEXT));
      return;
    }

    if (this.mergeWindow) {
      this.mergeWindow.push(`${chatId}::${target.id}`, { channelId, chatId, target, text: say, msg });
      return;
    }
    await this.deliverSteer(channelId, chatId, target, say, null, msg);
  }

  /** 合并窗口到点后统一发一条；`parts` 保留用户原话，便于事后追溯。 */
  async flushSteer(pending) {
    if (!Array.isArray(pending) || !pending.length) return;
    const first = pending[0];
    const rawParts = pending.map((item) => item.text);
    const combined = rawParts.join("\n\n");
    try {
      await this.deliverSteer(first.channelId, first.chatId, first.target, combined, rawParts.length > 1 ? rawParts : null, first.msg);
    } catch (error) {
      this.warn(error);
    }
  }

  async deliverSteer(channelId, chatId, target, say, parts, msg) {
    try {
      // Hub 的 steerTask 是 async（要真的写进员工进程），必须 await，
      // 否则拒绝会变成未处理的 Promise，用户就看不到原因了。
      const result = await this.hub.steerTask(target.id, say, {
        source: channelId,
        actor: { chatId, senderName: msg?.senderName || null },
        parts: parts || undefined,
      });
      await this.reply(channelId, chatId, text.steered(result?.task || target, result?.warning));
      return;
    } catch (error) {
      const code = error?.code || null;
      if (code !== "STEER_UNSUPPORTED") {
        await this.reply(channelId, chatId, this.steerFailureText(error));
        return;
      }
    }

    // 不支持插话 → 自动降级为侧问，并把降级原因说清楚。
    if (typeof this.hub.askSide !== "function") {
      await this.reply(
        channelId,
        chatId,
        text.steerRejected(
          `「${this.workerName(target.workerId)}」不支持插话，当前版本也不能侧问。`,
          "想改方向请 /停 后重新 /派。",
        ),
      );
      return;
    }
    try {
      const result = this.hub.askSide({ parentTaskId: target.id, question: say });
      if (result?.task?.id) {
        this.configStore.addDelivery({
          taskId: result.task.id,
          channelId,
          chatId,
          kind: "side",
          ackedAt: nowIso(),
          pushedAt: null,
          lastNotifiedStatus: result.task.status || "queued",
        });
      }
      await this.reply(channelId, chatId, text.sideFallback(this.workerName(target.workerId), result?.note));
    } catch (error) {
      await this.reply(
        channelId,
        chatId,
        text.steerRejected(
          `「${this.workerName(target.workerId)}」不支持插话；侧问也没起来：${this.errorText(error, channelId)}`,
          "想改方向请 /停 后重新 /派。",
        ),
      );
    }
  }

  async askSide(channelId, chatId, binding, intent, msg) {
    const question = String(intent.text || "").trim();
    if (!question) {
      await this.reply(channelId, chatId, text.askWhat());
      return;
    }
    if (question.length > MAX_TEXT) {
      await this.reply(channelId, chatId, text.questionTooLong(MAX_TEXT));
      return;
    }
    if (typeof this.hub.askSide !== "function") {
      await this.reply(channelId, chatId, "当前版本还不支持侧问，先在面板里问。");
      return;
    }

    const parent = intent.targetTaskId
      ? this.findTask(intent.targetTaskId)
      : this.onlyRunning(chatId) || this.recentTasks(chatId, 1)[0] || null;

    try {
      const result = this.hub.askSide({ parentTaskId: parent?.id || null, question });
      if (result?.task?.id) {
        this.configStore.addDelivery({
          taskId: result.task.id,
          channelId,
          chatId,
          kind: "side",
          ackedAt: nowIso(),
          pushedAt: null,
          lastNotifiedStatus: result.task.status || "queued",
        });
      }
      await this.reply(channelId, chatId, text.sideStarted(this.workerName(parent?.workerId), result?.note));
    } catch (error) {
      await this.reply(channelId, chatId, this.sideFailureText(error));
    }
  }

  // ── 查询类命令 ──────────────────────────────────────────────────────────

  listText(chatId) {
    const tasks = this.recentTasks(chatId, MAX_LIST);
    if (!tasks.length) return text.taskList([], { workerName: (id) => this.workerName(id) });
    this.configStore.setLastList(chatId, tasks.slice(0, MAX_LIST).map((task) => task.id));
    return text.taskList(tasks.slice(0, MAX_LIST), { workerName: (id) => this.workerName(id) });
  }

  detailText(chatId, intent) {
    const task = this.resolveTask(chatId, intent);
    if (!task) return intent.invalidIndex ? text.taskMissing(intent.targetIndex) : text.noTaskInChat();
    const detail = (this.hub.taskDetail ? this.hub.taskDetail(task.id) : null) || task;
    return text.taskDetail(detail, { workerName: (id) => this.workerName(id) });
  }

  stopText(chatId, intent) {
    const task = this.resolveTask(chatId, intent);
    if (!task) return intent.invalidIndex ? text.taskMissing(intent.targetIndex) : text.noTaskInChat();
    try {
      this.hub.stopTask(task.id);
      return text.stopped(task);
    } catch (error) {
      return `没停掉：${this.errorText(error, this.channelOf(chatId))}`;
    }
  }

  retryText(chatId, intent) {
    const task = this.resolveTask(chatId, intent);
    if (!task) return intent.invalidIndex ? text.taskMissing(intent.targetIndex) : text.noTaskInChat();
    try {
      this.hub.retryTask(task.id);
      return text.retried(task);
    } catch (error) {
      return `没重派成功：${this.errorText(error, this.channelOf(chatId))}`;
    }
  }

  ackText(chatId, intent) {
    const task = this.resolveTask(chatId, intent);
    if (!task) return intent.invalidIndex ? text.taskMissing(intent.targetIndex) : text.noTaskInChat();
    try {
      this.hub.acknowledgeTask(task.id);
      return text.acknowledged(task);
    } catch (error) {
      return `没标记成功：${this.errorText(error, this.channelOf(chatId))}`;
    }
  }

  // ── 选员工 ──────────────────────────────────────────────────────────────

  workerList() {
    return typeof this.hub.listWorkers === "function" ? this.hub.listWorkers() : [];
  }

  /**
   * 编号最省事（手机上打 /派 @3 就行），也支持 id 和名字的模糊匹配。
   * 顺序固定 = /员工 里列出来的顺序，两边编号必须对得上。
   */
  resolveWorker(selector) {
    const key = String(selector || "").trim().replace(/^@/, "");
    if (!key) return null;
    const workers = this.workerList();
    if (/^\d{1,3}$/.test(key)) return workers[Number(key) - 1] || null;
    const norm = (value) => String(value ?? "").toLowerCase().replace(/\s+/g, "");
    const needle = norm(key);
    return workers.find((worker) => norm(worker.id) === needle)
      || workers.find((worker) => norm(worker.name) === needle)
      // /员工 里会显示职责备注，用户自然会照着喊「@总经理」「@审核」。
      || workers.find((worker) => norm(worker.note) === needle)
      || workers.find((worker) => (
        norm(worker.name).includes(needle)
        || norm(worker.id).includes(needle)
        || norm(worker.note).includes(needle)
      ))
      || null;
  }

  workersText(binding) {
    const defaultId = typeof this.hub.defaultWorkerId === "function" ? this.hub.defaultWorkerId() : null;
    return text.workersList(this.workerList(), {
      currentId: binding.entry.workerId || null,
      defaultId,
    });
  }

  switchText(binding, intent) {
    const key = String(intent.workerName || "").trim();
    const workers = this.workerList();
    const current = this.workerName(binding.entry.workerId);
    if (!key) return text.switchHint(current, workers);
    const found = this.resolveWorker(key);
    if (!found) return text.switchNotFound(key, workers);
    if (found.enabled === false) return text.switchDisabled(found);
    if (found.available === false) return text.workerUnavailable(found);
    // 换人必须连工作目录一起换：不沿用上一个员工（或 defaults）的目录，否则串项目。
    this.configStore.upsertBinding(binding.channelId, {
      ...binding.entry,
      workerId: found.id,
      cwd: found.cwd || null,
    });
    return text.switched(found);
  }

  clearText(binding) {
    const next = binding.entry.newSession !== true;
    this.configStore.upsertBinding(binding.channelId, { ...binding.entry, newSession: next });
    return text.cleared(next);
  }

  // ── 任务查询（只读） ────────────────────────────────────────────────────

  /** 该会话看得见的任务：先按上次 /任务 的顺序，再补上新的投递记录。 */
  recentTasks(chatId, limit = MAX_LIST) {
    const ids = [];
    for (const id of this.configStore.getLastList(chatId)) {
      if (!ids.includes(id)) ids.push(id);
    }
    for (const delivery of this.configStore.deliveriesForChat(chatId)) {
      if (!ids.includes(delivery.taskId)) ids.push(delivery.taskId);
    }
    const tasks = [];
    for (const id of ids) {
      const task = this.findTask(id);
      if (task) tasks.push(task);
      if (tasks.length >= limit) break;
    }
    return tasks;
  }

  findTask(taskId) {
    if (!taskId || !this.store?.getTask) return null;
    return this.store.getTask(taskId) || null;
  }

  resolveTask(chatId, intent) {
    if (intent?.targetTaskId) return this.findTask(intent.targetTaskId);
    if (intent?.targetIndex) return this.recentTasks(chatId, MAX_LIST)[intent.targetIndex - 1] || null;
    return this.recentTasks(chatId, 1)[0] || null;
  }

  onlyRunning(chatId) {
    const running = this.recentTasks(chatId, MAX_LIST).filter((task) => task.status === "running");
    return running.length === 1 ? running[0] : null;
  }

  intentContext(chatId) {
    const tasks = this.recentTasks(chatId, MAX_LIST);
    return {
      running: tasks
        .filter((task) => task.status === "running")
        .map((task) => ({ id: task.id, title: task.title, workerId: task.workerId })),
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        workerId: task.workerId,
        status: task.status,
        role: task.role || "main",
      })),
    };
  }

  workerName(workerId) {
    if (!workerId) return "默认员工";
    const workers = this.hub.listWorkers ? this.hub.listWorkers() : [];
    const found = workers.find((worker) => worker.id === workerId);
    return found?.name || workerId;
  }

  indexHint(chatId, taskId) {
    const index = this.recentTasks(chatId, MAX_LIST).findIndex((task) => task.id === taskId);
    return index >= 0 ? String(index + 1) : "1";
  }

  // ── 发消息 ──────────────────────────────────────────────────────────────

  /**
   * 所有出站文案都从这里走：统一脱敏 + 统一兜底。
   * 发不出去只记日志，绝不让异常冒到 HTTP 链路或 Hub。
   */
  async reply(channelId, chatId, body) {
    const content = this.sanitize(channelId, body);
    if (!content) return false;
    if (!this.sendFn) {
      this.warn(`没有可用的发送通道，消息丢弃：${text.clip(content, 80)}`);
      return false;
    }
    try {
      await this.sendFn(channelId, chatId, content, {});
      return true;
    } catch (error) {
      this.warn(error);
      return false;
    }
  }

  sanitize(channelId, body) {
    const config = this.configStore.get(channelId);
    return scrub(String(body ?? ""), config).trim();
  }

  errorText(error, channelId) {
    const message = error instanceof Error ? error.message : String(error);
    const config = channelId ? this.configStore.get(channelId) : null;
    return scrub(message, config) || "原因不明";
  }

  steerFailureText(error) {
    const code = error?.code || null;
    const hint = STEER_ERROR_TEXT[code];
    const message = error instanceof Error ? error.message : "";
    if (message && hint) return `${message}（${hint}）`;
    return message || hint || "插话没成功，原因不明。用 /看 看任务状态。";
  }

  sideFailureText(error) {
    const code = error?.code || null;
    const hint = SIDE_ERROR_TEXT[code];
    const message = error instanceof Error ? error.message : "";
    if (message && hint) return `${message}（${hint}）`;
    return message || hint || "侧问没起来，原因不明";
  }

  channelOf(chatId) {
    return this.configStore.findBinding(chatId)?.channelId || null;
  }

  warn(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (this.logger?.warn) this.logger.warn(`[通道] ${message}`);
  }
}

export { shortId };
