import { BaseChannel } from "./base.mjs";
import { scrub } from "./secrets.mjs";

/**
 * 微信通道（参考 AionUi 合规方案：本地合规扫码/桌面桥接模式）。
 *
 * 合规红线：
 *   - 严禁接入易封号的逆向抓包/内存 hook 协议（如 wcferry / Pad 协议）。
 *   - 通过本机运行的合规桌面桥接服务（默认 http://127.0.0.1:8787）以标准 HTTP
 *     长轮询（GET /poll）+ 主动推送（POST /send）通信，完全不暴露公网端口。
 *   - 所有收到的文本消息进入统一 MessageRouter，天然支持 /员工、/派、/换、/问、/状态 与主动通知。
 */

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8787";
const POLL_TIMEOUT_MS = 25_000;
const API_TIMEOUT_MS = 10_000;
const SEGMENT_LIMIT = 2000;

const FIELDS = [
  {
    key: "bridgeUrl",
    label: "本地合规桥接地址",
    type: "text",
    secret: false,
    required: true,
    hint: "本地合规扫码/桌面桥接服务地址，默认 http://127.0.0.1:8787（不使用逆向协议）",
  },
  {
    key: "bridgeToken",
    label: "桥接密钥（可选）",
    type: "password",
    secret: true,
    required: false,
    hint: "如果本地桥接启用了 Bearer Token 鉴权就填这里；只存本地且全程脱敏",
  },
  {
    key: "notifyEnabled",
    label: "任务完成或卡住时主动推送通知",
    type: "switch",
    secret: false,
    required: false,
    hint: "开启后，网页或 MCP 派发的任务完成/落入「等你」时会自动推到已绑定微信会话",
  },
];

function cleanBase(url) {
  return String(url || DEFAULT_BRIDGE_URL).trim().replace(/\/+$/, "") || DEFAULT_BRIDGE_URL;
}

function authHeaders(config) {
  const headers = { "Content-Type": "application/json" };
  if (config?.bridgeToken) headers.Authorization = `Bearer ${config.bridgeToken}`;
  return headers;
}

/** 把桥接服务推上来的事件归一化成标准入站消息。 */
export function normalizeWechatItem(item = {}) {
  if (!item || typeof item !== "object") return null;
  const rawChatId = String(item.chatId || item.roomId || item.fromId || "").trim();
  if (!rawChatId) return null;
  const chatId = rawChatId.startsWith("wx:") ? rawChatId : `wx:${rawChatId}`;
  const text = String(item.text ?? item.content ?? "").trim();
  return {
    channelId: "wechat",
    chatId,
    chatType: item.chatType === "group" || Boolean(item.roomId) ? "group" : "p2p",
    chatTitle: String(item.chatTitle || item.roomName || item.senderName || chatId).slice(0, 80),
    senderId: String(item.senderId || item.fromId || ""),
    senderName: String(item.senderName || ""),
    messageId: item.messageId || item.id ? String(item.messageId || item.id) : "",
    text,
    mentionsMe: item.mentionsMe !== false,
    receivedAt: item.receivedAt || new Date().toISOString(),
  };
}

export class WechatChannel extends BaseChannel {
  constructor(options = {}) {
    super({
      id: "wechat",
      label: "微信",
      implemented: true,
      needsPublicCallback: false,
      readiness: "ready",
      note: "采用本地合规扫码/桌面桥接模式（参考 AionUi），不使用易封号逆向协议；可与企业微信配合使用。",
      fields: FIELDS,
      throttleMs: options.throttleMs === undefined ? 1000 : options.throttleMs,
      segmentLimit: options.segmentLimit || SEGMENT_LIMIT,
    });
    this.fetchImpl = typeof options.fetchImpl === "function"
      ? options.fetchImpl
      : (...args) => fetch(...args);
    this.runtime = {
      stopped: true,
      abort: null,
      cursor: "",
      me: null,
      config: null,
    };
  }

  normalize(patch = {}, current = {}) {
    const next = super.normalize(patch, current);
    next.bridgeUrl = cleanBase(next.bridgeUrl || current.bridgeUrl || DEFAULT_BRIDGE_URL);
    if (!/^https?:\/\//i.test(next.bridgeUrl)) {
      throw new Error("桥接地址需要以 http:// 或 https:// 开头，例如 http://127.0.0.1:8787");
    }
    next.bridgeToken = String(next.bridgeToken || "").trim();
    next.notifyEnabled = typeof patch.notifyEnabled === "boolean"
      ? patch.notifyEnabled
      : current.notifyEnabled !== false;
    const defaults = next.defaults && typeof next.defaults === "object" ? next.defaults : {};
    next.defaults = {
      workerId: defaults.workerId || null,
      cwd: defaults.cwd || null,
      newSession: defaults.newSession === true,
    };
    return next;
  }

  status() {
    return { me: this.runtime.me, ready: true };
  }

  async #checkHealth(config) {
    const base = cleanBase(config?.bridgeUrl);
    let response;
    try {
      response = await this.fetchImpl(`${base}/health`, {
        method: "GET",
        headers: authHeaders(config),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(scrub(`连不上本地微信合规桥接（${base}）：请先启动扫码/桌面桥接服务。（${detail}）`, config));
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(scrub(`微信桥接返回 HTTP ${response.status}：${data?.error || data?.message || "鉴权或状态异常"}`, config));
    }
    return data;
  }

  async start(ctx = {}) {
    const config = typeof ctx.getConfig === "function" ? ctx.getConfig() : ctx.config;
    const base = cleanBase(config?.bridgeUrl);
    this.runtime.stopped = false;
    this.runtime.config = config;
    this.runtime.me = null;
    this.dedupe.clear();

    const health = await this.#checkHealth(config);
    if (this.runtime.stopped) return;

    this.runtime.me = {
      id: String(health?.accountId || "wechat-bridge"),
      name: String(health?.accountName || health?.nickname || "微信合规桥接"),
    };
    ctx.logger?.log?.(`[通道 wechat] 已连接本地合规桥接（${base}）`);
    ctx.onConnected?.({ me: this.runtime.me });

    while (!this.runtime.stopped) {
      const controller = new AbortController();
      this.runtime.abort = controller;
      const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
      timer.unref?.();
      try {
        const query = this.runtime.cursor ? `?cursor=${encodeURIComponent(this.runtime.cursor)}` : "";
        const response = await this.fetchImpl(`${base}/poll${query}`, {
          method: "GET",
          headers: authHeaders(config),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (this.runtime.stopped) break;
        if (!response.ok) {
          throw new Error(`微信桥接轮询返回 HTTP ${response.status}`);
        }
        const data = await response.json().catch(() => ({}));
        ctx.onActivity?.();
        if (data?.nextCursor !== undefined && data?.nextCursor !== null) {
          this.runtime.cursor = String(data.nextCursor);
        }
        const items = Array.isArray(data?.messages) ? data.messages : [];
        for (const item of items) {
          const inbound = normalizeWechatItem(item);
          if (!inbound) continue;
          if (inbound.messageId && this.dedupe.seen(inbound.messageId)) continue;
          this.rememberChat(inbound);
          if (!inbound.text) continue;
          ctx.onMessage?.(inbound);
        }
      } catch (error) {
        clearTimeout(timer);
        if (this.runtime.stopped) break;
        if (error?.name === "AbortError") continue;
        throw new Error(scrub(error instanceof Error ? error.message : String(error), config));
      } finally {
        this.runtime.abort = null;
      }
    }
  }

  async stop() {
    this.runtime.stopped = true;
    try {
      this.runtime.abort?.abort();
    } catch {
      // ignore
    }
    this.runtime.abort = null;
    this.throttle.reset();
  }

  async send(chatId, text, opts = {}) {
    const config = opts.config || this.runtime.config;
    const base = cleanBase(config?.bridgeUrl);
    const target = String(chatId || "").replace(/^wx:/, "").trim();
    if (!target) throw new Error(`微信会话 ID 不能为空：${chatId}`);

    const parts = this.segments(text);
    if (!parts.length) return { ok: true, segments: 0 };

    for (const part of parts) {
      await this.throttle.run(chatId, async () => {
        const response = await this.fetchImpl(`${base}/send`, {
          method: "POST",
          headers: authHeaders(config),
          body: JSON.stringify({ chatId: target, text: part }),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(scrub(`微信桥接发送失败（HTTP ${response.status}）：${data?.error || data?.message || "原因不明"}`, config));
        }
      });
    }
    return { ok: true, segments: parts.length };
  }

  async test(config) {
    try {
      const health = await this.#checkHealth(config);
      const loggedIn = health?.loggedIn !== false;
      const name = health?.accountName || health?.nickname || "本地微信桥接";
      return {
        ok: true,
        message: loggedIn
          ? `已连上合规微信桥接（${name}），状态正常，可以启用`
          : `已连上桥接服务（${name}），请先在桥接窗口完成合规扫码登录`,
        warning: loggedIn ? null : "尚未完成扫码登录",
        me: { id: health?.accountId || "wechat-bridge", name },
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  listChats() {
    return this.recentChats();
  }
}

export default new WechatChannel();
