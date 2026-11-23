import { BaseChannel } from "./base.mjs";
import { scrub } from "./secrets.mjs";

/**
 * 企业微信合规通道（群机器人 Webhook + 可选本地合规插件桥接，无需公网 IP）。
 *
 * 两种合规工作模式：
 *   - webhook（默认）：接入企业微信官方群机器人 Webhook，无需公网回调，开箱支持任务完成/等你主动通知推送。
 *   - bridge：接入本地合规企业微信插件桥接（GET /poll + POST /send），支持双向收发 /员工、/派、/换 等指令。
 */

const API_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS = 25_000;
const SEGMENT_LIMIT = 2000;

const MODES = [
  { value: "webhook", label: "官方群机器人 Webhook（推荐，免公网主动推送）" },
  { value: "bridge", label: "本地合规插件桥接（支持双向收发指令）" },
];

const FIELDS = [
  {
    key: "mode",
    label: "接入模式",
    type: "select",
    secret: false,
    required: false,
    options: MODES,
    hint: "仅做任务完成/报错提醒选 Webhook；需要在企微群里发 /派 选本地插件桥接",
  },
  {
    key: "webhookUrl",
    label: "群机器人 Webhook 地址",
    type: "password",
    secret: true,
    required: false,
    hint: "企业微信群 → 添加群机器人 → 复制 Webhook URL（形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...）",
  },
  {
    key: "bridgeUrl",
    label: "本地插件桥接地址（bridge 模式用）",
    type: "text",
    secret: false,
    required: false,
    hint: "例如 http://127.0.0.1:8788；webhook 模式可留空",
  },
  {
    key: "bridgeToken",
    label: "桥接密钥（可选）",
    type: "password",
    secret: true,
    required: false,
    hint: "仅 bridge 模式且桥接开启鉴权时填写",
  },
  {
    key: "notifyEnabled",
    label: "任务完成或卡住时主动推送通知",
    type: "switch",
    secret: false,
    required: false,
    hint: "开启后，网页或 MCP 派发的任务完成/落入「等你」时会自动推到企业微信",
  },
];

function cleanBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function authHeaders(config) {
  const headers = { "Content-Type": "application/json" };
  if (config?.bridgeToken) headers.Authorization = `Bearer ${config.bridgeToken}`;
  return headers;
}

export class WecomChannel extends BaseChannel {
  constructor(options = {}) {
    super({
      id: "wecom",
      label: "企业微信",
      implemented: true,
      needsPublicCallback: false,
      readiness: "ready",
      note: "支持企业微信官方群机器人 Webhook（免公网主动推送）及本地合规插件桥接（双向遥控）。",
      fields: FIELDS,
      throttleMs: options.throttleMs === undefined ? 1000 : options.throttleMs,
      segmentLimit: options.segmentLimit || SEGMENT_LIMIT,
    });
    this.fetchImpl = typeof options.fetchImpl === "function"
      ? options.fetchImpl
      : (...args) => fetch(...args);
    this.runtime = {
      stopped: true,
      resume: null,
      abort: null,
      cursor: "",
      me: null,
      config: null,
    };
  }

  normalize(patch = {}, current = {}) {
    const next = super.normalize(patch, current);
    const mode = String(next.mode || current.mode || "webhook").trim();
    next.mode = mode === "bridge" ? "bridge" : "webhook";
    next.webhookUrl = String(next.webhookUrl || "").trim();
    next.bridgeUrl = cleanBase(next.bridgeUrl || "");
    next.bridgeToken = String(next.bridgeToken || "").trim();
    next.notifyEnabled = typeof patch.notifyEnabled === "boolean"
      ? patch.notifyEnabled
      : current.notifyEnabled !== false;
    if (next.webhookUrl && !/^https?:\/\//i.test(next.webhookUrl)) {
      throw new Error("企业微信 Webhook 地址需要以 https:// 开头");
    }
    if (next.bridgeUrl && !/^https?:\/\//i.test(next.bridgeUrl)) {
      throw new Error("桥接地址需要以 http:// 或 https:// 开头");
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

  async start(ctx = {}) {
    const config = typeof ctx.getConfig === "function" ? ctx.getConfig() : ctx.config;
    const mode = config?.mode === "bridge" ? "bridge" : "webhook";
    this.runtime.stopped = false;
    this.runtime.config = config;
    this.runtime.me = null;
    this.dedupe.clear();

    if (mode === "webhook") {
      if (!config?.webhookUrl) {
        throw new Error("还没填企业微信群机器人 Webhook 地址：面板 → 通道 → 企业微信");
      }
      this.runtime.me = { id: "wecom-webhook", name: "企业微信群机器人" };
      ctx.logger?.log?.("[通道 wecom] Webhook 主动推送模式已就绪");
      ctx.onConnected?.({ me: this.runtime.me });
      await new Promise((resolve) => {
        this.runtime.resume = resolve;
      });
      return;
    }

    const base = cleanBase(config?.bridgeUrl);
    if (!base) throw new Error("bridge 模式下请填写本地插件桥接地址");
    const healthRes = await this.fetchImpl(`${base}/health`, {
      method: "GET",
      headers: authHeaders(config),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!healthRes.ok) throw new Error(`企业微信本地桥接返回 HTTP ${healthRes.status}`);
    const health = await healthRes.json().catch(() => ({}));
    if (this.runtime.stopped) return;

    this.runtime.me = { id: "wecom-bridge", name: String(health?.name || "企业微信插件桥接") };
    ctx.logger?.log?.(`[通道 wecom] 已连接本地插件桥接（${base}）`);
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
        if (!response.ok) throw new Error(`企业微信桥接轮询返回 HTTP ${response.status}`);
        const data = await response.json().catch(() => ({}));
        ctx.onActivity?.();
        if (data?.nextCursor !== undefined && data?.nextCursor !== null) {
          this.runtime.cursor = String(data.nextCursor);
        }
        for (const item of Array.isArray(data?.messages) ? data.messages : []) {
          const rawId = String(item?.chatId || item?.fromId || "").trim();
          if (!rawId) continue;
          const chatId = rawId.startsWith("wecom:") ? rawId : `wecom:${rawId}`;
          const messageId = item?.messageId || item?.id ? String(item.messageId || item.id) : "";
          if (messageId && this.dedupe.seen(messageId)) continue;
          const inbound = {
            channelId: "wecom",
            chatId,
            chatType: item?.chatType === "group" ? "group" : "p2p",
            chatTitle: String(item?.chatTitle || chatId).slice(0, 80),
            senderId: String(item?.senderId || ""),
            senderName: String(item?.senderName || ""),
            messageId,
            text: String(item?.text ?? item?.content ?? "").trim(),
            mentionsMe: item?.mentionsMe !== false,
            receivedAt: item?.receivedAt || new Date().toISOString(),
          };
          this.rememberChat(inbound);
          if (inbound.text) ctx.onMessage?.(inbound);
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
    const resume = this.runtime.resume;
    this.runtime.resume = null;
    if (resume) resume();
    this.throttle.reset();
  }

  async send(chatId, text, opts = {}) {
    const config = opts.config || this.runtime.config;
    const mode = config?.mode === "bridge" ? "bridge" : "webhook";
    const parts = this.segments(text);
    if (!parts.length) return { ok: true, segments: 0 };

    if (mode === "webhook") {
      if (!config?.webhookUrl) throw new Error("企业微信还没填群机器人 Webhook 地址，消息发不出去");
      for (const part of parts) {
        await this.throttle.run(chatId || "wecom:webhook", async () => {
          const response = await this.fetchImpl(config.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ msgtype: "text", text: { content: part } }),
            signal: AbortSignal.timeout(API_TIMEOUT_MS),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || (data?.errcode !== undefined && data.errcode !== 0)) {
            throw new Error(scrub(`企业微信 Webhook 发送失败：${data?.errmsg || `HTTP ${response.status}`}`, config));
          }
        });
      }
      return { ok: true, segments: parts.length };
    }

    const base = cleanBase(config?.bridgeUrl);
    if (!base) throw new Error("企业微信还没填本地桥接地址");
    const target = String(chatId || "").replace(/^wecom:/, "").trim();
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
          throw new Error(scrub(`企业微信桥接发送失败（HTTP ${response.status}）：${data?.error || "原因不明"}`, config));
        }
      });
    }
    return { ok: true, segments: parts.length };
  }

  async test(config) {
    const mode = config?.mode === "bridge" ? "bridge" : "webhook";
    if (mode === "webhook") {
      const url = String(config?.webhookUrl || "").trim();
      if (!url) return { ok: false, message: "先填企业微信群机器人 Webhook 地址" };
      if (!/^https?:\/\/.+/i.test(url)) return { ok: false, message: "Webhook 地址格式不对，应以 https:// 开头" };
      return {
        ok: true,
        message: "企业微信群机器人 Webhook 格式校验通过，启用后任务完成或卡住会自动推送到群里",
        me: { id: "wecom-webhook", name: "企业微信群机器人" },
      };
    }

    const base = cleanBase(config?.bridgeUrl);
    if (!base) return { ok: false, message: "bridge 模式下请先填本地插件桥接地址" };
    try {
      const response = await this.fetchImpl(`${base}/health`, {
        method: "GET",
        headers: authHeaders(config),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, message: `本地桥接返回 HTTP ${response.status}` };
      const data = await response.json().catch(() => ({}));
      return {
        ok: true,
        message: `已连上企业微信本地桥接（${data?.name || base}），可以启用`,
        me: { id: "wecom-bridge", name: data?.name || "企业微信插件桥接" },
      };
    } catch (error) {
      return { ok: false, message: scrub(error instanceof Error ? error.message : String(error), config) };
    }
  }

  listChats() {
    return this.recentChats();
  }
}

export default new WecomChannel();
