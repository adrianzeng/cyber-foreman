import { BaseChannel, backoffMs } from "./base.mjs";
import { scrub } from "./secrets.mjs";

/**
 * Telegram 通道：getUpdates 长轮询 + sendMessage，全部用内置 fetch，不引任何包。
 *
 * 为什么手写而不是引 grammy：
 *   offset 推进、429 的 retry_after、每会话 1 条/秒节流、3900 字分段，
 *   这四件事都需要精确控制；引包只是多一层抽象，还得再包一遍。
 *
 * 三个必须记住的坑：
 *   1. Bot API 的错误 URL 里带 token（`/bot<token>/getUpdates`），
 *      所以所有错误消息、日志都要过 scrub，否则 token 直接进日志。
 *   2. getUpdates 的 offset 要「已处理的最大 update_id + 1」，
 *      否则重启会重放旧消息；同一条 update_id 还要再去重一次（弱网重放）。
 *   3. 群里只在 @我 或发命令时才响应，否则等于在群里刷屏。
 */

const POLL_TIMEOUT_SECONDS = 25;
const API_TIMEOUT_MS = 15_000;
const MAX_SEND_RETRIES = 3;
const DEFAULT_API_BASE = "https://api.telegram.org";
const SEGMENT_LIMIT = 3900;

const FIELDS = [
  {
    key: "token",
    label: "机器人 Token",
    type: "password",
    secret: true,
    required: true,
    hint: "@BotFather 发给你的那一串，形如 123456789:AA...",
  },
  {
    key: "apiBase",
    label: "API 地址",
    type: "text",
    secret: false,
    required: false,
    hint: "默认 https://api.telegram.org；只有自建反代时才改",
  },
];

class TelegramError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TelegramError";
    this.code = options.code || "TG_ERROR";
    this.retryable = options.retryable === true;
    this.retryAfter = Number(options.retryAfter) || 0;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref?.();
  });
}

function normalizeBase(value) {
  return String(value || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
}

/** 把 Telegram 的 HTTP 状态翻译成"能照着做"的中文。 */
function translateStatus(status, payload) {
  const description = String(payload?.description || "").trim();
  switch (status) {
    case 401:
      return "Token 不对或已被撤销（401 Unauthorized）。去 @BotFather 重新确认一次 Token。";
    case 403:
      return "机器人被这个会话挡住了（403 Forbidden）。先在 Telegram 里解除屏蔽，再试一次。";
    case 404:
      return "Token 格式不对或 API 地址写错了（404 Not Found）。检查 Token 和 API 地址。";
    case 409:
      return "另一个进程正在用同一个 Token 拉消息（409 Conflict）。确认只开了一个 Hub。";
    default:
      return description
        ? `Telegram 返回 ${status}：${description}`
        : `Telegram 返回 ${status}，稍后会自动重试。`;
  }
}

/** 从 `tg:123` / `123` 里取出数字 chat id。 */
function numericChatId(chatId) {
  const text = String(chatId || "").trim();
  const bare = text.startsWith("tg:") ? text.slice(3) : text;
  if (!/^-?\d+$/.test(bare)) throw new Error(`会话 id 不对：${chatId}`);
  return bare;
}

/**
 * `message` 对象 → 统一 InboundMessage（纯函数，便于单测）。
 * 返回 null 表示这条消息不该进 Router（例如群里没 @我）。
 */
export function toInboundMessage(message, me = null) {
  if (!message || !message.chat) return null;
  const chat = message.chat;
  const from = message.from || {};
  const chatType = chat.type === "private" ? "p2p" : "group";
  const botUsername = me && me.username ? String(me.username) : "";

  let text = typeof message.text === "string" ? message.text : "";
  let mentionsMe = false;

  if (botUsername) {
    const mentionPattern = new RegExp(`@${botUsername}`, "gi");
    if (mentionPattern.test(text)) {
      mentionsMe = true;
      text = text.replace(mentionPattern, " ");
    }
    const replyFrom = message.reply_to_message?.from?.username;
    if (replyFrom && String(replyFrom).toLowerCase() === botUsername.toLowerCase()) mentionsMe = true;
  }

  // `/派@my_bot 内容` 这种命令式提及，去掉尾巴上的 @bot
  text = text.replace(/^(\/[^\s@]+)@\w+/u, "$1");
  text = text.replace(/[ \t]+/g, " ").replace(/^\s+|\s+$/g, "");

  const isCommand = /^[/／][^\s]/.test(text);
  if (isCommand) mentionsMe = true;

  if (chatType === "group" && !mentionsMe) return null;

  const senderName = from.username
    ? `@${from.username}`
    : [from.first_name, from.last_name].filter(Boolean).join(" ") || "有人";

  return {
    channelId: "telegram",
    chatId: `tg:${chat.id}`,
    chatType,
    chatTitle: chat.title || [from.first_name, from.last_name].filter(Boolean).join(" ") || chat.username || String(chat.id),
    senderId: from.id ? String(from.id) : "",
    senderName,
    messageId: `tg:${chat.id}:${message.message_id}`,
    text,
    mentionsMe,
    receivedAt: message.date ? new Date(message.date * 1000).toISOString() : nowIso(),
  };
}

export class TelegramChannel extends BaseChannel {
  constructor(options = {}) {
    super({
      id: "telegram",
      label: "Telegram",
      implemented: true,
      needsPublicCallback: false,
      readiness: "ready",
      fields: FIELDS,
      throttleMs: options.throttleMs === undefined ? 1000 : options.throttleMs,
      segmentLimit: options.segmentLimit || SEGMENT_LIMIT,
      dedupeCapacity: options.dedupeCapacity || 500,
    });
    this.runtime = {
      stopped: true,
      abort: null,
      config: null,
      me: null,
      offset: 0,
    };
  }

  // ── 配置 ────────────────────────────────────────────────────────────────

  normalize(patch = {}, current = {}) {
    const next = super.normalize(patch, current);
    next.token = String(next.token || "").trim();
    next.apiBase = normalizeBase(next.apiBase);
    if (next.token && !/^\d{5,}:[A-Za-z0-9_-]{10,}$/.test(next.token)) {
      throw new Error("Token 长得不像 Telegram 机器人 Token（应该是 123456789:AA... 这种）。去 @BotFather 复制一次。");
    }
    if (!/^https?:\/\//i.test(next.apiBase)) {
      throw new Error("API 地址要以 http:// 或 https:// 开头，默认 https://api.telegram.org");
    }
    const defaults = next.defaults && typeof next.defaults === "object" ? next.defaults : {};
    next.defaults = {
      workerId: defaults.workerId || null,
      cwd: defaults.cwd || null,
      newSession: defaults.newSession === true,
    };
    return next;
  }

  status() {
    return { me: this.runtime.me };
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start(ctx = {}) {
    const config = typeof ctx.getConfig === "function" ? ctx.getConfig() : ctx.config;
    if (!config || !config.token) {
      throw new Error("还没填机器人 Token：面板 → 通道 → Telegram → 填 Token → 启用");
    }

    this.runtime = {
      stopped: false,
      abort: new AbortController(),
      config,
      me: null,
      offset: 0,
    };
    this.dedupe.clear();

    const me = await this.#api("getMe", {}, { config, timeoutMs: 8000 });
    this.runtime.me = {
      id: me?.id || null,
      username: me?.username || null,
      name: [me?.first_name, me?.last_name].filter(Boolean).join(" ") || me?.username || "机器人",
    };
    ctx.logger?.log?.(`[通道 telegram] 已连接 @${this.runtime.me.username || "?"}，开始长轮询`);
    ctx.onConnected?.({ me: this.runtime.me });

    await this.#pollLoop(ctx);
  }

  async stop() {
    this.runtime.stopped = true;
    try {
      this.runtime.abort?.abort();
    } catch {
      // 已经结束的请求，忽略。
    }
    this.throttle.reset();
  }

  async #pollLoop(ctx) {
    while (!this.runtime.stopped) {
      let updates;
      try {
        updates = await this.#api("getUpdates", {
          offset: this.runtime.offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ["message"],
        }, { config: this.runtime.config, timeoutMs: (POLL_TIMEOUT_SECONDS + 15) * 1000 });
      } catch (error) {
        if (this.runtime.stopped || error?.code === "TG_STOPPED") return;
        throw error;
      }
      if (this.runtime.stopped) return;
      ctx.onActivity?.();

      const list = Array.isArray(updates) ? updates : [];
      for (const update of list) {
        // 先把 offset 推上去：哪怕这条消息处理失败，也不要下次重放它。
        if (typeof update?.update_id === "number") {
          this.runtime.offset = Math.max(this.runtime.offset, update.update_id + 1);
        }
        try {
          await this.#handleUpdate(update, ctx);
        } catch (error) {
          ctx.logger?.warn?.(`[通道 telegram] 处理消息失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // 真实长轮询会挂住 25 秒，不会空转；这里兜一下假 API / 极端情况。
      if (!list.length) await sleep(200);
    }
  }

  async #handleUpdate(update, ctx) {
    if (!update) return;
    if (this.dedupe.seen(update.update_id)) return;

    const message = update.message || update.channel_post || null;
    if (!message) return;

    const inbound = toInboundMessage(message, this.runtime.me);
    if (!inbound) return;

    this.rememberChat(inbound);

    if (!inbound.text) {
      if (inbound.chatType === "p2p") {
        await this.send(inbound.chatId, "目前只认文字消息。发文字、/派、/问 都行。", { config: this.runtime.config });
      }
      return;
    }

    // 不 await：拉消息不能被一个长任务拖住（回执是 Router 自己发的）。
    ctx.onMessage?.(inbound);
  }

  // ── 发送 ────────────────────────────────────────────────────────────────

  async send(chatId, text, opts = {}) {
    const config = opts.config || this.runtime.config;
    if (!config?.token) throw new Error("Telegram 还没配 Token，消息发不出去");

    const chat = numericChatId(chatId);
    const parts = this.segments(text);
    if (!parts.length) return { ok: true, segments: 0 };

    for (const part of parts) {
      await this.throttle.run(chatId, () => this.#sendOne(chat, part, config));
    }
    return { ok: true, segments: parts.length };
  }

  async #sendOne(chat, text, config) {
    let attempt = 0;
    while (attempt < MAX_SEND_RETRIES + 1) {
      attempt += 1;
      try {
        return await this.#api("sendMessage", {
          chat_id: chat,
          text,
          disable_web_page_preview: true,
        }, { config });
      } catch (error) {
        if (error?.code === "TG_RATE_LIMIT" && attempt <= MAX_SEND_RETRIES) {
          // 429 必须按 Telegram 说的秒数等，自己拍脑袋会被继续限流。
          await sleep(Math.max(0, Math.min(error.retryAfter || 1, 30)) * 1000);
          continue;
        }
        if (error?.retryable && attempt <= 2) {
          await sleep(backoffMs(attempt, { max: 5000 }));
          continue;
        }
        throw error;
      }
    }
    throw new TelegramError("消息发不出去，重试次数用完了", { retryable: false });
  }

  // ── Bot API ─────────────────────────────────────────────────────────────

  async #api(method, payload = {}, options = {}) {
    const config = options.config || this.runtime.config || {};
    const token = String(config.token || "").trim();
    if (!token) throw new TelegramError("还没填机器人 Token", { code: "TG_NO_TOKEN" });

    const base = normalizeBase(config.apiBase);
    const url = `${base}/bot${token}/${method}`;
    const timeoutMs = options.timeoutMs || API_TIMEOUT_MS;

    const signals = [AbortSignal.timeout(timeoutMs)];
    if (this.runtime.abort && !this.runtime.stopped) signals.push(this.runtime.abort.signal);

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      });
    } catch (error) {
      if (this.runtime.stopped) {
        throw new TelegramError("通道已停止", { code: "TG_STOPPED" });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new TelegramError(
        scrub(`连不上 Telegram（${base}）：${detail}`, [token]),
        { retryable: true, code: "TG_NETWORK" },
      );
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.status === 429) {
      const retryAfter = Number(data?.parameters?.retry_after) || 0;
      throw new TelegramError(
        `Telegram 限流了（429），${retryAfter || 1} 秒后自动重试`,
        { code: "TG_RATE_LIMIT", retryAfter, retryable: true },
      );
    }
    if (!response.ok || data?.ok === false) {
      throw new TelegramError(scrub(translateStatus(response.status, data), [token]), {
        retryable: response.status >= 500,
        code: `TG_HTTP_${response.status}`,
      });
    }
    return data?.result ?? null;
  }

  // ── 连接测试 ────────────────────────────────────────────────────────────

  async test(config) {
    if (!config?.token) return { ok: false, message: "还没填机器人 Token" };
    try {
      const me = await this.#api("getMe", {}, { config, timeoutMs: 8000 });
      return {
        ok: true,
        message: `已连上 @${me?.username || "机器人"}`,
        me: { id: me?.id || null, username: me?.username || null },
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  listChats() {
    return this.recentChats();
  }
}

export default new TelegramChannel();
