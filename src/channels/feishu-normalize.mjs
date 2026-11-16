/**
 * 飞书事件归一化：纯函数 + 一个只做去重的小类。
 *
 * 单独拎出来的原因：真实事件必须连飞书、连 WS 才能拿到，
 * 而"字段取错了""群消息没 @我 也响应"这类 bug 恰恰最容易出在归一化上。
 * 纯函数可以穷举着测，不用碰网络。
 *
 * 事件形状（im.message.receive_v1 的 data）：
 * {
 *   sender: { sender_id: { open_id, user_id, union_id }, sender_type: "user"|"app" },
 *   message: {
 *     message_id, chat_id, chat_type: "p2p"|"group",
 *     message_type: "text"|"post"|"image"|...,
 *     content: "{\"text\":\"...\"}"   // 字符串，要再 JSON.parse
 *     mentions?: [{ key: "@_user_1", id: { open_id }, name: "机器人" }],
 *     create_time: "1700000000000"
 *   }
 * }
 */

/** 去重窗口：30 分钟（飞书重连后会补发，重复处理等于重复派活）。 */
export const DEDUPE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CAPACITY = 2000;

/** 解析 content 字符串，坏 JSON 一律当空。 */
export function parseContent(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 从 content 里取出可读文本。
 * text 直接取；post（富文本）把各段落拼起来 —— 用户眼里它就是一段文字，
 * 我们没理由因为格式不同就当他没说话。
 */
export function extractText(message) {
  if (!message || typeof message !== "object") return "";
  const content = parseContent(message.content);
  if (!content) return "";
  const type = String(message.message_type || "text");

  if (type === "text") {
    return typeof content.text === "string" ? content.text : "";
  }
  if (type === "post") {
    const paragraphs = Array.isArray(content.content) ? content.content : [];
    const lines = [];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      const line = paragraph
        .map((node) => (node && typeof node.text === "string" ? node.text : ""))
        .join("")
        .trim();
      if (line) lines.push(line);
    }
    return lines.join("\n");
  }
  return "";
}

/** 文本里的 @ 占位符（`@_user_1`）要去掉，否则命令解析会被它挡住。 */
export function stripMentionPlaceholders(text, mentions = []) {
  let body = String(text || "");
  for (const mention of mentions) {
    const key = mention && mention.key ? String(mention.key) : "";
    if (!key) continue;
    body = body.split(key).join(" ");
  }
  // 兜底：任何漏网的 @_user_n
  body = body.replace(/@_user_\d+/g, " ");
  return body.replace(/[ \t]+/g, " ").trim();
}

/**
 * 这条消息是不是在叫我。
 * 群里飞书默认只在被 @ 时才推事件，所以 mentions 非空基本就是我；
 * 能拿到 bot 的 open_id 时再精确比对一次。
 */
export function isMentionMe(payload, options = {}) {
  const message = payload?.message || {};
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const chatType = message.chat_type === "p2p" ? "p2p" : "group";
  if (chatType === "p2p") return true;
  const botOpenId = options.botOpenId ? String(options.botOpenId) : "";
  if (botOpenId) {
    return mentions.some((mention) => mention?.id?.open_id === botOpenId);
  }
  return mentions.length > 0;
}

/**
 * 事件 → InboundMessage。
 * 返回 null 表示"不该进 Router"：机器人自己发的、群里没叫我、或者缺关键字段。
 */
export function toInbound(payload, options = {}) {
  const sender = payload?.sender || {};
  const message = payload?.message || {};
  if (!message.chat_id || !message.message_id) return null;
  // 机器人自己发出去的消息会以 app 身份回流，处理它就会自问自答。
  if (sender.sender_type === "app") return null;

  const chatType = message.chat_type === "p2p" ? "p2p" : "group";
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  if (chatType === "group" && !isMentionMe(payload, options)) return null;

  const rawText = extractText(message);
  const text = stripMentionPlaceholders(rawText, mentions);
  const senderId = sender.sender_id || {};
  const createdAt = Number(message.create_time);

  return {
    channelId: "feishu",
    chatId: `fs:${message.chat_id}`,
    chatType,
    chatTitle: "",
    senderId: senderId.user_id || senderId.open_id || "",
    senderName: senderId.user_id || senderId.open_id || "有人",
    messageId: `fs:${message.message_id}`,
    text,
    mentionsMe: isMentionMe(payload, options),
    receivedAt: Number.isFinite(createdAt) && createdAt > 0
      ? new Date(createdAt).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * 30 分钟去重环。
 *
 * 不用"最近 N 条"是因为飞书补发可能跨越几分钟；也不用无限 Map，
 * 因为内存会一直涨。折中：按时间过期 + 容量上限，两个都留。
 */
export class MessageDedupe {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs) || DEDUPE_TTL_MS;
    this.capacity = Math.max(10, Number(options.capacity) || DEFAULT_CAPACITY);
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.entries = new Map();
  }

  /** 见过（且还在窗口内）返回 true。 */
  seen(messageId) {
    if (!messageId) return false;
    const key = String(messageId);
    const now = this.now();
    this.#sweep(now);
    if (this.entries.has(key)) return true;
    this.entries.set(key, now);
    if (this.entries.size > this.capacity) {
      // Map 保持插入顺序，最旧的先丢。
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return false;
  }

  #sweep(now) {
    for (const [key, at] of this.entries) {
      if (now - at <= this.ttlMs) break; // 插入有序，后面的都更新
      this.entries.delete(key);
    }
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}
