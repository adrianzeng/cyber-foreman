import { BaseChannel } from "./base.mjs";
import { MessageDedupe, toInbound } from "./feishu-normalize.mjs";
import { scrub } from "./secrets.mjs";

/**
 * 飞书通道：官方 SDK 长连接（WSClient）+ 消息发送。
 *
 * 三条底线：
 *   1. **SDK 只允许 lazy import**：没装 / 装坏了只让飞书通道显示「需要先 npm install」，
 *      绝不能让整个 Hub 起不来（顶层硬 import 会这样）。
 *   2. **SDK 的 logger 必须收口**：官方 SDK 会把 appId/appSecret 打进日志，
 *      我们把它的日志接到自己的 logger 上并全部过 scrub()。
 *   3. **不自己实现长连接协议**：pbbp2 有分片/ACK/心跳/重连参数，跟着官方走。
 */

const SEGMENT_LIMIT = 4000;
const TOKEN_TIMEOUT_MS = 10_000;

const DOMAINS = ["open.feishu.cn", "open.larksuite.com"];

const FIELDS = [
  {
    key: "appId",
    label: "App ID",
    type: "text",
    secret: false,
    required: true,
    hint: "飞书开放平台 → 开发者后台 → 应用凭证，形如 cli_xxxxx",
  },
  {
    key: "appSecret",
    label: "App Secret",
    type: "password",
    secret: true,
    required: true,
    hint: "只存本地 data/channels.json；接口返回一律是掩码",
  },
  {
    key: "domain",
    label: "开放平台域名",
    type: "select",
    secret: false,
    required: false,
    hint: "国内版 open.feishu.cn；Lark 国际版 open.larksuite.com",
    options: DOMAINS.slice(),
  },
  {
    key: "notifyEnabled",
    label: "任务完成或卡住时主动推送通知",
    type: "switch",
    secret: false,
    required: false,
    hint: "开启后，网页或 MCP 派发的任务完成/落入「等你」时也会自动推到已绑定飞书会话",
  },
];

function apiBase(domain) {
  return String(domain || "open.feishu.cn").includes("larksuite")
    ? "https://open.larksuite.com"
    : "https://open.feishu.cn";
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class FeishuChannel extends BaseChannel {
  constructor(options = {}) {
    super({
      id: "feishu",
      label: "飞书",
      implemented: true,
      needsPublicCallback: false,
      readiness: "ready",
      fields: FIELDS,
      throttleMs: options.throttleMs === undefined ? 1000 : options.throttleMs,
      segmentLimit: options.segmentLimit || SEGMENT_LIMIT,
    });
    this.sdkLoader = typeof options.sdkLoader === "function"
      ? options.sdkLoader
      : () => import("@larksuiteoapi/node-sdk");
    this.fetchImpl = typeof options.fetchImpl === "function"
      ? options.fetchImpl
      : (...args) => fetch(...args);
    this.dedupe = new MessageDedupe(options.dedupe || {});
    this.sdk = null;
    this.sdkError = null;
    this.runtime = {
      stopped: true,
      wsClient: null,
      resume: null,
      me: null,
      config: null,
      client: null,
      clientKey: "",
      botOpenId: "",
    };
    // 启动时探一次：探不到就在面板上直接显示原因，而不是等用户点"启用"才报错。
    this.#probeSdk();
  }

  #probeSdk() {
    Promise.resolve()
      .then(() => this.#loadSdk())
      .catch(() => {
        // 原因已经记在 this.note 上，面板会显示。
      });
  }

  async #loadSdk() {
    if (this.sdk) return this.sdk;
    if (this.sdkError) throw new Error(this.note);
    try {
      const loaded = await this.sdkLoader();
      const sdk = loaded?.WSClient ? loaded : loaded?.default;
      if (!sdk || typeof sdk.WSClient !== "function") {
        throw new Error("SDK 里没有 WSClient");
      }
      this.sdk = sdk;
      this.sdkError = null;
      this.note = null;
      return sdk;
    } catch (error) {
      this.sdkError = error;
      this.note = "飞书通道需要先 npm install（缺 @larksuiteoapi/node-sdk），当前不可用";
      throw new Error(this.note);
    }
  }

  // ── 配置 ────────────────────────────────────────────────────────────────

  normalize(patch = {}, current = {}) {
    const next = super.normalize(patch, current);
    next.appId = String(next.appId || "").trim();
    next.appSecret = String(next.appSecret || "").trim();
    next.domain = String(next.domain || "open.feishu.cn").trim() || "open.feishu.cn";
    if (!DOMAINS.includes(next.domain)) {
      throw new Error(`开放平台域名只能是 ${DOMAINS.join(" 或 ")}`);
    }
    if (next.appId && !/^cli_[A-Za-z0-9_-]{4,}$/.test(next.appId)) {
      throw new Error("App ID 应该是 cli_ 开头的一串字符（开放平台 → 应用凭证里复制）");
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
    return { me: this.runtime.me, ready: Boolean(this.sdk) };
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start(ctx = {}) {
    const config = typeof ctx.getConfig === "function" ? ctx.getConfig() : ctx.config;
    if (!config?.appId) throw new Error("还没填 App ID：面板 → 通道 → 飞书");
    if (!config?.appSecret) throw new Error("还没填 App Secret：面板 → 通道 → 飞书");
    const sdk = await this.#loadSdk();

    const hold = new Promise((resolve) => {
      this.runtime.resume = resolve;
    });
    this.runtime.stopped = false;
    this.runtime.config = config;
    this.runtime.me = null;
    this.dedupe.clear();

    const logger = this.#sdkLogger(ctx, config);
    const loggerLevel = sdk.LoggerLevel ? sdk.LoggerLevel.warn : undefined;

    const dispatcher = new sdk.EventDispatcher({ logger, loggerLevel });
    dispatcher.register({
      "im.message.receive_v1": (data) => {
        try {
          this.#onEvent(data, ctx);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          ctx.logger?.warn?.(`[通道 feishu] 处理事件失败：${scrub(detail, config)}`);
        }
      },
    });

    const wsClient = new sdk.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain || "open.feishu.cn",
      logger,
      loggerLevel,
      autoReconnect: true,
    });
    this.runtime.wsClient = wsClient;

    // 连不上会 reject → supervisor 记 error 并退避重连。
    await wsClient.start({ eventDispatcher: dispatcher });
    if (this.runtime.stopped) return;

    this.runtime.me = { id: config.appId, name: config.appId, username: config.appId };
    ctx.logger?.log?.("[通道 feishu] 长连接已建立");
    ctx.onConnected?.({ me: this.runtime.me });

    // SDK 自己负责断线重连；这里挂住不返回 = 通道仍在工作。
    // start() resolve 才表示"通道结束了"，supervisor 据此决定要不要重连。
    await hold;
  }

  async stop() {
    this.runtime.stopped = true;
    try {
      this.runtime.wsClient?.close({ force: true });
    } catch {
      // 已经关掉或没连上，忽略。
    }
    this.runtime.wsClient = null;
    const resume = this.runtime.resume;
    this.runtime.resume = null;
    if (resume) resume();
    this.throttle.reset();
  }

  #onEvent(data, ctx) {
    const config = this.runtime.config || {};
    const inbound = toInbound(data, { botOpenId: this.runtime.botOpenId });
    if (!inbound) return;
    // 重连补发会重复推同一条消息，不拦就会重复派活。
    if (this.dedupe.seen(inbound.messageId)) return;
    this.rememberChat(inbound);

    if (!inbound.text) {
      if (inbound.chatType === "p2p") {
        this.send(inbound.chatId, "目前只认文字消息。发文字、/派、/问 都行。", { config }).catch((error) => {
          ctx.logger?.warn?.(`[通道 feishu] 提示发送失败：${scrub(String(error?.message || error), config)}`);
        });
      }
      return;
    }
    ctx.onMessage?.(inbound);
  }

  // ── 发送 ────────────────────────────────────────────────────────────────

  async send(chatId, text, opts = {}) {
    const config = opts.config || this.runtime.config;
    if (!config?.appId) throw new Error("飞书还没配 App ID，消息发不出去");
    const sdk = await this.#loadSdk();
    const receiveId = String(chatId || "").replace(/^fs:/, "");
    if (!receiveId) throw new Error(`会话 id 不对：${chatId}`);

    const parts = this.segments(text);
    if (!parts.length) return { ok: true, segments: 0 };
    const client = this.#client(sdk, config);
    for (const part of parts) {
      await this.throttle.run(chatId, () => this.#sendOne(client, receiveId, part, config));
    }
    return { ok: true, segments: parts.length };
  }

  async #sendOne(client, receiveId, part, config) {
    try {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: receiveId,
          msg_type: "text",
          content: JSON.stringify({ text: part }),
        },
      });
    } catch (error) {
      throw new Error(this.#translate(error, config));
    }
  }

  #client(sdk, config) {
    const key = `${config.appId}|${config.domain || ""}`;
    if (this.runtime.client && this.runtime.clientKey === key) return this.runtime.client;
    const client = new sdk.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain || "open.feishu.cn",
      logger: this.#sdkLogger(null, config),
      loggerLevel: sdk.LoggerLevel ? sdk.LoggerLevel.warn : undefined,
    });
    this.runtime.client = client;
    this.runtime.clientKey = key;
    return client;
  }

  /** 把 SDK / HTTP 的报错翻译成"能照着做"的中文，并去掉 appSecret。 */
  #translate(error, config) {
    const data = error?.response?.data || null;
    const code = data?.code ?? error?.code ?? null;
    const msg = data?.msg || error?.message || "原因不明";
    let text;
    switch (code) {
      case 99991661:
      case 99991663:
      case 99991668:
        text = "飞书拒绝了请求：应用凭据可能不对或被停用，去通道设置里重新填一次 App Secret";
        break;
      case 230002:
      case 230013:
        text = "机器人不在这个会话里：先在飞书里把它拉进群，或直接私聊它";
        break;
      case 230020:
        text = "飞书限流了，稍后会自动重试";
        break;
      default:
        text = `飞书接口报错（code=${code ?? "?"}）：${msg}`;
    }
    return scrub(text, config);
  }

  // ── 连接测试 ────────────────────────────────────────────────────────────

  async test(config) {
    if (!config?.appId || !config?.appSecret) {
      return { ok: false, message: "先填 App ID 和 App Secret" };
    }
    try {
      const data = await this.#tenantToken(config);
      return {
        ok: true,
        message: `已拿到 tenant token（有效期 ${data.expire || "?"} 秒），可以启用了`,
        me: { id: config.appId, name: config.appId },
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async #tenantToken(config) {
    const base = apiBase(config.domain);
    let response;
    try {
      response = await this.fetchImpl(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(scrub(`连不上飞书（${base}）：${detail}`, config));
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (data?.code === 0 && data.tenant_access_token) return data;

    const code = data?.code ?? response.status;
    if (code === 10003 || code === 10014) throw new Error("App Secret 不对，去开放平台重新复制一次");
    if (code === 10002 || code === 10001) throw new Error("App ID 不对，检查是不是复制了别的应用");
    throw new Error(scrub(`飞书拒绝拿 token（code=${code}）：${data?.msg || "原因不明"}`, config));
  }

  // ── SDK logger 收口 ─────────────────────────────────────────────────────

  /**
   * 官方 SDK 的日志会带 appId，有些错误还会带整段请求体（含 appSecret）。
   * 一律接到我们自己的 logger 上，逐条 scrub —— 这是设计里点名的坑。
   */
  #sdkLogger(ctx, config) {
    const target = ctx?.logger || { log() {}, warn() {} };
    const write = (level) => (...args) => {
      const body = scrub(
        args.map((arg) => (typeof arg === "string" ? arg : safeStringify(arg))).join(" "),
        config,
      );
      if (level === "warn" || level === "error") target.warn?.(`[通道 feishu/sdk] ${body}`);
      else target.log?.(`[通道 feishu/sdk] ${body}`);
    };
    return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
  }

  listChats() {
    return this.recentChats();
  }
}

export default new FeishuChannel();
