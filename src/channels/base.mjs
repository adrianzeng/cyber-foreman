import { maskConfig, scrub } from "./secrets.mjs";

/**
 * 通道层公共件。
 *
 * 这里只有"平台无关"的东西：退避、去重环、节流、分段、合并窗口、字段驱动表单。
 * **supervisor（启停/重连/状态机）在 ChannelManager 里**，不要在这里再来一套，
 * 否则两处状态会打架（谁最后写 lastError 都说不清）。
 */

export const DEFAULT_SEGMENT_LIMIT = 3900;
export const DEFAULT_MAX_SEGMENTS = 3;
export const DEFAULT_THROTTLE_MS = 1000;
export const DEFAULT_MERGE_WINDOW_MS = 600;

/** 指数退避：1s → 2s → 4s … 封顶 60s。attempt 从 1 开始。 */
export function backoffMs(attempt, options = {}) {
  const min = Number(options.min) || 1000;
  const max = Number(options.max) || 60_000;
  const index = Math.max(1, Number(attempt) || 1);
  return Math.min(min * 2 ** (index - 1), max);
}

/**
 * 去重环：`getUpdates` 重放、飞书重连补发都会让同一条消息来两次。
 * 只记最近 N 个 id，内存占用恒定。
 */
export class DedupeRing {
  constructor(capacity = 500) {
    this.capacity = Math.max(2, Number(capacity) || 500);
    this.seenIds = new Set();
    this.order = [];
  }

  /** 见过返回 true（表示应该丢弃）。 */
  seen(id) {
    if (id === null || id === undefined || id === "") return false;
    const key = String(id);
    if (this.seenIds.has(key)) return true;
    this.seenIds.add(key);
    this.order.push(key);
    while (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      this.seenIds.delete(oldest);
    }
    return false;
  }

  clear() {
    this.seenIds.clear();
    this.order = [];
  }
}

/**
 * 按会话串行 + 节流。
 *
 * 两条都必须有：
 *   - 串行：并发 sendMessage 会让消息顺序错乱（回执跑到结果后面）。
 *   - 节流：Telegram 单聊限制约 1 条/秒，连发会被 429。
 */
export class ChatThrottle {
  constructor(intervalMs = DEFAULT_THROTTLE_MS) {
    this.intervalMs = Math.max(0, Number(intervalMs) || 0);
    this.chains = new Map();
    this.lastAt = new Map();
  }

  /**
   * @param {string} key 会话 key
   * @param {() => Promise<any>} task 真正要做的事
   */
  run(key, task) {
    const previous = this.chains.get(key) || Promise.resolve();
    const next = previous.then(async () => {
      const last = this.lastAt.get(key);
      // 第一条不该等：lastAt 为空说明这个会话还没发过东西。
      const wait = last === undefined ? 0 : Math.max(0, this.intervalMs - (Date.now() - last));
      // 这里的等待不能 unref：节流中的消息还没发出去，
      // 若此时只剩这一个定时器，事件循环会提前退出，消息就永远发不出去了。
      if (wait > 0) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, wait));
      }
      try {
        return await task();
      } finally {
        this.lastAt.set(key, Date.now());
      }
    });
    // 链不能因为某一条失败就断掉，但调用方要能看到失败。
    this.chains.set(key, next.then(() => {}, () => {}));
    return next;
  }

  reset() {
    this.chains.clear();
    this.lastAt.clear();
  }
}

/**
 * 按上限分段。优先在换行处切，避免把一句中文从中间劈开。
 * 只返回最多 maxParts 段，超出部分标记 truncated（调用方补"去面板看"）。
 */
export function splitText(text, limit = DEFAULT_SEGMENT_LIMIT, maxParts = DEFAULT_MAX_SEGMENTS) {
  const body = String(text ?? "");
  const size = Math.max(200, Number(limit) || DEFAULT_SEGMENT_LIMIT);
  const maxPartsCount = Math.max(1, Number(maxParts) || DEFAULT_MAX_SEGMENTS);
  if (!body.trim()) return { parts: [], truncated: false };
  if (body.length <= size) return { parts: [body], truncated: false };

  const parts = [];
  let rest = body;
  while (rest && parts.length < maxPartsCount) {
    if (rest.length <= size) {
      parts.push(rest);
      rest = "";
      break;
    }
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  return { parts, truncated: Boolean(rest) };
}

/**
 * 600ms 合并窗口。
 *
 * 手机输入法经常把一句话拆成三次提交；逐条发会让员工收到半句话就跑一轮。
 * 只在**通道侧**合并（面板不合并，人要看见自己发了三条）。
 */
export class MergeWindow {
  constructor(options = {}) {
    this.windowMs = Math.max(0, Number(options.windowMs) || 0);
    this.onFlush = typeof options.onFlush === "function" ? options.onFlush : () => {};
    this.pending = new Map();
  }

  push(key, payload) {
    const current = this.pending.get(key);
    if (current) {
      current.parts.push(payload);
      return;
    }
    const entry = { parts: [payload], timer: null };
    entry.timer = setTimeout(() => this.flush(key), this.windowMs);
    entry.timer.unref?.();
    this.pending.set(key, entry);
  }

  flush(key) {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    clearTimeout(entry.timer);
    Promise.resolve()
      .then(() => this.onFlush(entry.parts))
      .catch(() => {});
  }

  /** flush 所有待处理项（测试与关闭时用）。 */
  flushAll() {
    for (const key of [...this.pending.keys()]) this.flush(key);
  }

  clear() {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}

/** 把 patch 里出现过的字段搬过去（`describeConfig()` 的字段驱动版本）。 */
export function normalizeFields(fields, patch = {}, current = {}) {
  const next = { ...current };
  // 没传 enabled 就保持现状；新通道默认关闭（不默开是安全默认值）。
  next.enabled = typeof patch.enabled === "boolean" ? patch.enabled : current.enabled === true;
  for (const field of fields) {
    if (!Object.hasOwn(patch, field.key)) continue;
    const value = patch[field.key];
    if (value === undefined) continue;
    next[field.key] = field.type === "switch" ? value === true : String(value ?? "").trim();
  }
  if (patch.defaults && typeof patch.defaults === "object") {
    next.defaults = { ...(current.defaults || {}), ...patch.defaults };
  }
  if (Array.isArray(patch.allowlist)) next.allowlist = patch.allowlist;
  return next;
}

/**
 * 通道基类：把"所有通道都一样"的部分收在这里，
 * 子类只实现 start / stop / send / test（按需覆盖 normalize、listChats）。
 *
 * 注意 `implemented` 为 false 的通道（占位）不允许启用：`start()` 直接抛出原因，
 * 面板据此显示灰态。
 */
export class BaseChannel {
  constructor(options = {}) {
    this.id = String(options.id || "");
    this.label = String(options.label || this.id);
    this.implemented = options.implemented === true;
    this.needsPublicCallback = options.needsPublicCallback === true;
    this.readiness = options.readiness || (this.implemented ? "ready" : "unsupported");
    this.note = options.note || null;
    this.fields = Array.isArray(options.fields) ? options.fields.map((field) => ({ ...field })) : [];
    this.startError = options.startError || null;
    this.sendError = options.sendError || null;
    this.maxSegments = Number(options.maxSegments) || DEFAULT_MAX_SEGMENTS;
    this.segmentLimit = Number(options.segmentLimit) || DEFAULT_SEGMENT_LIMIT;
    this.throttle = new ChatThrottle(
      options.throttleMs === undefined ? DEFAULT_THROTTLE_MS : Math.max(0, Number(options.throttleMs) || 0),
    );
    this.dedupe = new DedupeRing(Number(options.dedupeCapacity) || 500);
    this.chats = new Map();
  }

  describeConfig() {
    return this.fields.map((field) => ({ ...field }));
  }

  normalize(patch = {}, current = {}) {
    const next = normalizeFields(this.fields, patch, current);
    // 占位通道永远不允许启用，避免面板点开就是一个必然失败的连接。
    if (!this.implemented) next.enabled = false;
    return next;
  }

  status() {
    return { state: "stopped", me: null };
  }

  async start() {
    throw new Error(this.startError || this.note || `${this.label} 通道暂不可用`);
  }

  async stop() {}

  async send() {
    throw new Error(this.sendError || this.note || `${this.label} 通道暂不可用`);
  }

  listChats() {
    return [];
  }

  async test() {
    return { ok: false, message: this.note || `${this.label} 通道暂不可用` };
  }

  // ── 子类可用的小工具 ────────────────────────────────────────────────────

  /** 记一个"最近会话"，供面板一键绑定。最多留 20 个，新的在前。 */
  rememberChat(chat) {
    if (!chat || !chat.chatId) return;
    const entry = {
      chatId: String(chat.chatId),
      chatType: chat.chatType === "group" ? "group" : "p2p",
      chatTitle: String(chat.chatTitle || "").slice(0, 80),
      lastAt: chat.lastAt || new Date().toISOString(),
    };
    this.chats.set(entry.chatId, entry);
    if (this.chats.size > 20) {
      const oldest = [...this.chats.entries()]
        .sort((a, b) => String(a[1].lastAt).localeCompare(String(b[1].lastAt)))[0];
      if (oldest) this.chats.delete(oldest[0]);
    }
  }

  recentChats() {
    return [...this.chats.values()].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  }

  /** 分段 + 补齐"太长了去面板看"的提示。 */
  segments(text) {
    const { parts, truncated } = splitText(text, this.segmentLimit, this.maxSegments);
    if (truncated && parts.length) {
      parts[parts.length - 1] = `${parts[parts.length - 1]}\n\n（内容太长，只推了前 ${this.maxSegments} 段。完整内容去面板看。）`;
    }
    return parts;
  }

  scrub(value, config) {
    return scrub(String(value ?? ""), config);
  }

  masked(config) {
    return maskConfig(config);
  }
}
