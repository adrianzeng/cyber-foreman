import { BaseChannel } from "./base.mjs";
import { scrub } from "./secrets.mjs";

/**
 * QQ 官方机器人通道（QQ 开放平台 AppID + ClientSecret，WebSocket 长连接模式，无需公网 IP）。
 *
 * 链路：
 *   1. POST https://bots.qq.com/app/getAppAccessToken 换取 access_token
 *   2. GET  {apiBase}/gateway 拿到官方 WebSocket 地址
 *   3. 通过 Node 内置 WebSocket 接入网关：Hello(op=10) → 心跳(op=1) + Identify(op=2) → READY / C2C / GROUP_AT / AT_MESSAGE
 *   4. 所有收到的文字消息转成统一入站事件，直接复用 MessageRouter 的 /员工、/派、/换、/状态 等全部指令。
 */

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const PROD_API_BASE = "https://api.sgroup.qq.com";
const SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
const API_TIMEOUT_MS = 12_000;
const SEGMENT_LIMIT = 2000;
// 频道 @消息 + 群聊 @消息 / QQ 单聊（官方 Gateway Intents）
const DEFAULT_INTENTS = (1 << 25) | (1 << 30);

const FIELDS = [
  {
    key: "appId",
    label: "AppID",
    type: "text",
    secret: false,
    required: true,
    hint: "QQ 开放平台 → 开发设置 → BotAppID（纯数字）",
  },
  {
    key: "clientSecret",
    label: "ClientSecret（机器人密钥）",
    type: "password",
    secret: true,
    required: true,
    hint: "只存本地 data/channels.json；接口与日志全程掩码脱敏",
  },
  {
    key: "sandbox",
    label: "使用沙箱环境",
    type: "switch",
    secret: false,
    required: false,
    hint: "联调阶段可开启（sandbox.api.sgroup.qq.com），正式运行保持关闭",
  },
  {
    key: "notifyEnabled",
    label: "任务完成或卡住时主动推送通知",
    type: "switch",
    secret: false,
    required: false,
    hint: "开启后，网页或 MCP 派发的任务完成/落入「等你」时会自动推到已绑定 QQ 会话",
  },
];

function resolveApiBase(config = {}) {
  const custom = String(config.apiBase || "").trim().replace(/\/+$/, "");
  if (custom) return custom;
  return config.sandbox === true ? SANDBOX_API_BASE : PROD_API_BASE;
}

/** 清理 QQ 群/频道消息开头的 <@!botId> 提及标签，保留正文给意图解析器。 */
export function stripQqMention(content) {
  return String(content ?? "").replace(/^(?:\s*<@!?\w+>\s*)+/, "").trim();
}

/** 把 QQ Gateway Dispatch 事件归一化成统一入站消息。 */
export function normalizeQqEvent(eventType, payload = {}) {
  const data = payload && typeof payload === "object" ? payload : {};
  const text = stripQqMention(data.content);
  const messageId = data.id ? String(data.id) : "";
  const receivedAt = data.timestamp ? String(data.timestamp) : new Date().toISOString();

  if (eventType === "C2C_MESSAGE_CREATE") {
    const openid = data.author?.user_openid || data.author?.id || "";
    if (!openid) return null;
    return {
      channelId: "qq",
      chatId: `qq:c2c:${openid}`,
      chatType: "p2p",
      chatTitle: data.author?.username || `QQ 私聊 ${String(openid).slice(-6)}`,
      senderId: String(openid),
      senderName: data.author?.username || "",
      messageId,
      text,
      mentionsMe: true,
      receivedAt,
      replyMeta: { msgId: messageId },
    };
  }

  if (eventType === "GROUP_AT_MESSAGE_CREATE") {
    const groupId = data.group_openid || data.group_id || "";
    if (!groupId) return null;
    return {
      channelId: "qq",
      chatId: `qq:group:${groupId}`,
      chatType: "group",
      chatTitle: `QQ 群 ${String(groupId).slice(-6)}`,
      senderId: String(data.author?.member_openid || data.author?.id || ""),
      senderName: data.author?.username || "",
      messageId,
      text,
      mentionsMe: true,
      receivedAt,
      replyMeta: { msgId: messageId },
    };
  }

  if (eventType === "AT_MESSAGE_CREATE") {
    const channelId = data.channel_id || "";
    if (!channelId) return null;
    return {
      channelId: "qq",
      chatId: `qq:channel:${channelId}`,
      chatType: "group",
      chatTitle: `QQ 频道 ${channelId}`,
      senderId: String(data.author?.id || ""),
      senderName: data.author?.username || "",
      messageId,
      text,
      mentionsMe: true,
      receivedAt,
      replyMeta: { msgId: messageId },
    };
  }

  return null;
}

export class QQChannel extends BaseChannel {
  constructor(options = {}) {
    super({
      id: "qq",
      label: "QQ",
      implemented: true,
      needsPublicCallback: false,
      readiness: "ready",
      note: "QQ 开放平台官方机器人（WebSocket 长连接，无需公网 IP），支持 /员工、/派、/换 等全部指令。",
      fields: FIELDS,
      throttleMs: options.throttleMs === undefined ? 1000 : options.throttleMs,
      segmentLimit: options.segmentLimit || SEGMENT_LIMIT,
    });
    this.fetchImpl = typeof options.fetchImpl === "function"
      ? options.fetchImpl
      : (...args) => fetch(...args);
    this.webSocketFactory = typeof options.webSocketFactory === "function"
      ? options.webSocketFactory
      : (url) => new WebSocket(url);
    this.tokenUrl = options.tokenUrl || TOKEN_URL;
    this.runtime = {
      stopped: true,
      ws: null,
      heartbeat: null,
      lastSeq: null,
      me: null,
      config: null,
      tokenCache: { key: "", token: "", expiresAt: 0 },
      lastMsgIdByChat: new Map(),
      msgSeq: 1,
    };
  }

  normalize(patch = {}, current = {}) {
    const next = super.normalize(patch, current);
    next.appId = String(next.appId || "").trim();
    next.clientSecret = String(next.clientSecret || "").trim();
    next.sandbox = next.sandbox === true;
    next.notifyEnabled = typeof patch.notifyEnabled === "boolean"
      ? patch.notifyEnabled
      : current.notifyEnabled !== false;
    if (Object.hasOwn(patch, "apiBase")) {
      next.apiBase = String(patch.apiBase || "").trim();
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
    return { me: this.runtime.me, ready: true };
  }

  async #getAccessToken(config, { force = false } = {}) {
    if (!config?.appId || !config?.clientSecret) {
      throw new Error("还没填 QQ 机器人的 AppID 和 ClientSecret");
    }
    const key = `${config.appId}|${config.clientSecret}`;
    if (!force && this.runtime.tokenCache.key === key && this.runtime.tokenCache.expiresAt > Date.now() + 30_000) {
      return this.runtime.tokenCache.token;
    }
    let response;
    try {
      response = await this.fetchImpl(this.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: config.appId, clientSecret: config.clientSecret }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(scrub(`连不上 QQ 开放平台鉴权接口：${detail}`, config));
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.access_token) {
      throw new Error(scrub(`QQ 获取 access_token 失败（HTTP ${response.status}）：${data?.message || data?.msg || "请检查 AppID 与 ClientSecret"}`, config));
    }
    const ttlSec = Math.max(60, Number(data.expires_in) || 7200);
    this.runtime.tokenCache = {
      key,
      token: String(data.access_token),
      expiresAt: Date.now() + ttlSec * 1000,
    };
    return this.runtime.tokenCache.token;
  }

  async #getGatewayUrl(config, token) {
    const base = resolveApiBase(config);
    let response;
    try {
      response = await this.fetchImpl(`${base}/gateway`, {
        method: "GET",
        headers: { Authorization: `QQBot ${token}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(scrub(`连不上 QQ 网关地址接口（${base}）：${detail}`, config));
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.url) {
      throw new Error(scrub(`QQ 获取 WebSocket 网关失败（HTTP ${response.status}）：${data?.message || "请检查机器人权限配置"}`, config));
    }
    return String(data.url);
  }

  async start(ctx = {}) {
    const config = typeof ctx.getConfig === "function" ? ctx.getConfig() : ctx.config;
    if (!config?.appId) throw new Error("还没填 QQ AppID：面板 → 通道 → QQ");
    if (!config?.clientSecret) throw new Error("还没填 QQ ClientSecret：面板 → 通道 → QQ");

    this.runtime.stopped = false;
    this.runtime.config = config;
    this.runtime.lastSeq = null;
    this.runtime.me = null;
    this.dedupe.clear();

    const token = await this.#getAccessToken(config, { force: true });
    if (this.runtime.stopped) return;
    const gatewayUrl = await this.#getGatewayUrl(config, token);
    if (this.runtime.stopped) return;

    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (error = null) => {
        if (settled) return;
        settled = true;
        this.#clearHeartbeat();
        if (error && !this.runtime.stopped) reject(error);
        else resolve();
      };

      let ws;
      try {
        ws = this.webSocketFactory(gatewayUrl);
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.runtime.ws = ws;

      const onMessage = (event) => {
        const raw = typeof event === "string" ? event : String(event?.data ?? "");
        let packet;
        try {
          packet = JSON.parse(raw);
        } catch {
          return;
        }
        if (typeof packet.s === "number") this.runtime.lastSeq = packet.s;

        // Hello → 启动心跳 + 发送 Identify
        if (packet.op === 10) {
          const interval = Math.max(5_000, Number(packet.d?.heartbeat_interval) || 30_000);
          this.#clearHeartbeat();
          this.runtime.heartbeat = setInterval(() => {
            try {
              ws.send(JSON.stringify({ op: 1, d: this.runtime.lastSeq }));
            } catch {
              // 断线由 close 处理。
            }
          }, interval);
          this.runtime.heartbeat.unref?.();
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: DEFAULT_INTENTS,
              shard: [0, 1],
            },
          }));
          return;
        }

        // Dispatch 事件
        if (packet.op === 0) {
          ctx.onActivity?.();
          if (packet.t === "READY") {
            const user = packet.d?.user || {};
            this.runtime.me = {
              id: String(user.id || config.appId),
              name: String(user.username || `QQBot ${config.appId}`),
            };
            ctx.logger?.log?.(`[通道 qq] 长连接已建立（${this.runtime.me.name}）`);
            ctx.onConnected?.({ me: this.runtime.me });
            return;
          }
          const inbound = normalizeQqEvent(packet.t, packet.d);
          if (!inbound) return;
          if (inbound.messageId && this.dedupe.seen(inbound.messageId)) return;
          if (inbound.replyMeta?.msgId) {
            this.runtime.lastMsgIdByChat.set(inbound.chatId, inbound.replyMeta.msgId);
          }
          this.rememberChat(inbound);
          if (!inbound.text) return;
          ctx.onMessage?.(inbound);
          return;
        }

        // Reconnect / Invalid Session
        if (packet.op === 7 || packet.op === 9) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          done(new Error(packet.op === 9 ? "QQ 网关鉴权失效，准备重连" : "QQ 网关要求重连"));
        }
      };

      const onError = (event) => {
        const message = event?.message || event?.error?.message || "QQ WebSocket 连接异常";
        done(new Error(scrub(message, config)));
      };

      const onClose = () => {
        this.runtime.ws = null;
        done();
      };

      if (typeof ws.addEventListener === "function") {
        ws.addEventListener("message", onMessage);
        ws.addEventListener("error", onError);
        ws.addEventListener("close", onClose);
      } else if (typeof ws.on === "function") {
        ws.on("message", (data) => onMessage({ data: String(data) }));
        ws.on("error", onError);
        ws.on("close", onClose);
      }
    });
  }

  #clearHeartbeat() {
    if (this.runtime.heartbeat) {
      clearInterval(this.runtime.heartbeat);
      this.runtime.heartbeat = null;
    }
  }

  async stop() {
    this.runtime.stopped = true;
    this.#clearHeartbeat();
    try {
      this.runtime.ws?.close();
    } catch {
      // ignore
    }
    this.runtime.ws = null;
    this.throttle.reset();
  }

  async send(chatId, text, opts = {}) {
    const config = opts.config || this.runtime.config;
    const token = await this.#getAccessToken(config);
    const base = resolveApiBase(config);
    const target = String(chatId || "").trim();

    let url = "";
    let bodyBase = {};
    if (target.startsWith("qq:c2c:")) {
      const openid = target.slice("qq:c2c:".length);
      url = `${base}/v2/users/${encodeURIComponent(openid)}/messages`;
      bodyBase = { msg_type: 0 };
    } else if (target.startsWith("qq:group:")) {
      const groupOpenid = target.slice("qq:group:".length);
      url = `${base}/v2/groups/${encodeURIComponent(groupOpenid)}/messages`;
      bodyBase = { msg_type: 0 };
    } else if (target.startsWith("qq:channel:")) {
      const channelId = target.slice("qq:channel:".length);
      url = `${base}/channels/${encodeURIComponent(channelId)}/messages`;
      bodyBase = {};
    } else {
      throw new Error(`QQ 会话 ID 格式不对（应以 qq:c2c: / qq:group: / qq:channel: 开头）：${target}`);
    }

    const parts = this.segments(text);
    if (!parts.length) return { ok: true, segments: 0 };
    const msgId = opts.msgId || this.runtime.lastMsgIdByChat.get(target) || null;

    for (const part of parts) {
      await this.throttle.run(target, async () => {
        const payload = {
          ...bodyBase,
          content: part,
          ...(msgId ? { msg_id: msgId, msg_seq: this.runtime.msgSeq++ } : {}),
        };
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `QQBot ${token}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(scrub(`QQ 发送消息失败（HTTP ${response.status}）：${data?.message || "原因不明"}`, config));
        }
      });
    }
    return { ok: true, segments: parts.length };
  }

  async test(config) {
    if (!config?.appId || !config?.clientSecret) {
      return { ok: false, message: "先填 QQ 开放平台的 AppID 和 ClientSecret" };
    }
    try {
      const token = await this.#getAccessToken(config, { force: true });
      const gatewayUrl = await this.#getGatewayUrl(config, token);
      return {
        ok: true,
        message: `QQ 官方网关鉴权通过（${gatewayUrl}），可以启用长连接了`,
        me: { id: config.appId, name: `QQBot ${config.appId}` },
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  listChats() {
    return this.recentChats();
  }
}

export default new QQChannel();
