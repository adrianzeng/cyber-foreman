import { BaseChannel, backoffMs } from "./base.mjs";
import { maskConfig, scrub } from "./secrets.mjs";
import { MessageRouter } from "./router.mjs";

/**
 * 通道注册表 + 生命周期管理。
 *
 * 两个刻意的设计：
 *   1. 通道模块用 **动态 import**：飞书的 SDK 没装、某个通道文件还没生成，
 *      都只会让那一个通道显示"不可用"，不会让整个 Hub 起不来。
 *   2. 每个通道一个 supervisor：抛错 → error + 退避（1s→60s）→ 重连，
 *      连续 20 次失败转 stopped 提示人工。任何通道异常都不会 reject 到 HTTP。
 *
 * 注意：supervisor 只在这里有一份。base.mjs 只放平台无关的工具，
 * 否则两处都在写 lastError/state，早晚打架。
 */

export { backoffMs };

const MAX_RECONNECTS = 20;

/**
 * 通道元信息。模块没加载成功时用它生成占位通道（面板仍然能看到并填配置）。
 */
export const CHANNEL_SPECS = [
  {
    id: "telegram",
    module: "./telegram.mjs",
    label: "Telegram",
    readiness: "ready",
    needsPublicCallback: false,
    note: "Telegram 通道模块没加载成功，重装一次 npm 包再试",
    fields: [
      { key: "token", label: "机器人 Token", type: "password", secret: true, required: true, hint: "@BotFather 发给你的那一串" },
      { key: "apiBase", label: "API 地址", type: "text", secret: false, required: false, hint: "默认 https://api.telegram.org；要自建反代时再改" },
    ],
  },
  {
    id: "feishu",
    module: "./feishu.mjs",
    label: "飞书",
    readiness: "ready",
    needsPublicCallback: false,
    note: "飞书通道需要先 npm install（缺 @larksuiteoapi/node-sdk），当前不可用",
    fields: [
      { key: "appId", label: "App ID", type: "text", secret: false, required: true, hint: "开放平台 → 应用凭证" },
      { key: "appSecret", label: "App Secret", type: "password", secret: true, required: true, hint: "只存本地 data/channels.json" },
      { key: "domain", label: "开放平台域名", type: "select", secret: false, required: false, hint: "国内用 open.feishu.cn，国际版用 open.larksuite.com", options: ["open.feishu.cn", "open.larksuite.com"] },
    ],
  },
  {
    id: "wecom",
    module: "./wecom.mjs",
    label: "企业微信",
    readiness: "needs-public",
    needsPublicCallback: true,
    note: "企业微信需要公网回调地址，下一阶段再做",
    fields: [],
  },
  {
    id: "wechat",
    module: "./wechat.mjs",
    label: "个人微信",
    readiness: "unsupported",
    needsPublicCallback: false,
    note: "微信 4.x 暂无免费可行方案，只留接口位",
    fields: [],
  },
];

const SPEC_BY_ID = new Map(CHANNEL_SPECS.map((spec) => [spec.id, spec]));

export function channelSpec(id) {
  return SPEC_BY_ID.get(String(id || "")) || null;
}

/** 只把 patch 里出现过的字段搬过去，其余保持原样。 */
/** 生成一个"看着像通道、但什么也做不了"的占位对象。 */
function placeholderChannel(spec) {
  const note = spec.note || `${spec.label} 通道暂不可用`;
  return new BaseChannel({
    id: spec.id,
    label: spec.label,
    implemented: false,
    needsPublicCallback: spec.needsPublicCallback === true,
    readiness: spec.readiness || "unsupported",
    note,
    fields: spec.fields || [],
    startError: note,
    sendError: note,
  });
}

/**
 * 动态加载通道模块。任何一个失败都只记录原因，不当成致命错误。
 * @returns {Promise<{adapters: Map<string, object>, unavailable: Array<{id:string, reason:string}>}>}
 */
export async function loadChannelAdapters() {
  const adapters = new Map();
  const unavailable = [];
  for (const spec of CHANNEL_SPECS) {
    try {
      const module = await import(new URL(spec.module, import.meta.url).href);
      const adapter = module.default || module.channel || module[`${spec.id}Channel`] || null;
      if (adapter && typeof adapter === "object") adapters.set(spec.id, adapter);
      else unavailable.push({ id: spec.id, reason: `${spec.module} 没有导出通道对象` });
    } catch (error) {
      unavailable.push({
        id: spec.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { adapters, unavailable };
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

export class ChannelManager {
  constructor(options = {}) {
    const { configStore, hub, store = null, logger = console, adapters = null, router = null } = options;
    if (!configStore) throw new Error("ChannelManager 需要 configStore");
    if (!hub) throw new Error("ChannelManager 需要 hub");
    this.configStore = configStore;
    this.hub = hub;
    this.store = store;
    this.logger = logger || console;
    this.adapters = adapters;
    this.unavailable = [];
    this.entries = new Map();
    this.router = router;
    this.unsubscribe = null;
    this.stopped = false;
  }

  /** 建表、挂任务事件、装配 Router。不启动任何连接。 */
  async load() {
    if (!this.adapters) {
      const loaded = await loadChannelAdapters();
      this.adapters = loaded.adapters;
      this.unavailable = loaded.unavailable;
    }
    for (const spec of CHANNEL_SPECS) {
      const loaded = this.adapters.get(spec.id) || null;
      const adapter = loaded || placeholderChannel(spec);
      this.entries.set(spec.id, {
        id: spec.id,
        spec,
        adapter,
        loaded: Boolean(loaded),
        status: {
          state: "stopped",
          lastError: loaded ? null : (spec.note || "通道模块没加载成功"),
          lastOkAt: null,
          lastErrorAt: null,
          reconnects: 0,
          me: null,
        },
        wanted: false,
        attempts: 0,
      });
    }

    if (!this.router) {
      this.router = new MessageRouter({
        configStore: this.configStore,
        hub: this.hub,
        store: this.store,
        logger: this.logger,
        send: (channelId, chatId, text, opts) => this.send(channelId, chatId, text, opts),
        resolveChannel: (channelId) => this.getChannel(channelId),
      });
    }

    if (this.store && typeof this.store.subscribe === "function") {
      this.unsubscribe = this.store.subscribe((event) => this.onTaskEvent(event));
    }
    return this;
  }

  // ── 启停 ────────────────────────────────────────────────────────────────

  async startEnabled() {
    for (const entry of this.entries.values()) {
      const config = this.configStore.get(entry.id);
      if (!config?.enabled) continue;
      if (entry.adapter.implemented !== true) {
        entry.status.state = "stopped";
        entry.status.lastError = entry.adapter.note || `${entry.adapter.label || entry.id} 通道暂不可用`;
        continue;
      }
      this.start(entry.id);
    }
  }

  /** 启动一个通道（不等待它连上，连不上会自己退避重连）。 */
  start(channelId) {
    const entry = this.entries.get(String(channelId || ""));
    if (!entry) throw new Error(`没有这个通道：${channelId}`);
    if (entry.adapter.implemented !== true) return this.describe(entry.id);
    entry.wanted = true;
    entry.attempts = 0;
    this.supervise(entry);
    return this.describe(entry.id);
  }

  async restart(channelId) {
    const entry = this.entries.get(String(channelId || ""));
    if (!entry) throw new Error(`没有这个通道：${channelId}`);
    await this.stopEntry(entry);
    const config = this.configStore.get(entry.id);
    if (config?.enabled && entry.adapter.implemented === true) this.start(entry.id);
    return this.describe(entry.id);
  }

  async stopAll() {
    this.stopped = true;
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {
        // 取消订阅失败不影响退出。
      }
      this.unsubscribe = null;
    }
    await Promise.all([...this.entries.values()].map((entry) => this.stopEntry(entry)));
  }

  async stopEntry(entry) {
    entry.wanted = false;
    try {
      await entry.adapter.stop?.();
    } catch (error) {
      this.logError(entry, error);
    }
    entry.status.state = "stopped";
    entry.status.me = null;
    entry.attempts = 0;
  }

  /**
   * 每通道一个 supervisor：失败就退避重连，连续 20 次转 stopped。
   * 这里刻意不 await —— 启动过程不能拖住 HTTP 服务。
   */
  supervise(entry) {
    const run = async () => {
      while (entry.wanted && !this.stopped) {
        entry.status.state = "starting";
        try {
          await entry.adapter.start(this.startContext(entry));
          if (!entry.wanted || this.stopped) break;
          this.markError(entry, "连接断了，准备重连");
        } catch (error) {
          this.markError(entry, error);
        }
        if (!entry.wanted || this.stopped) break;
        entry.attempts += 1;
        if (entry.attempts > MAX_RECONNECTS) {
          entry.status.state = "stopped";
          entry.status.lastError = `连续 ${MAX_RECONNECTS} 次重连都失败，已停止。检查配置后重启 Hub。`;
          this.logError(entry, entry.status.lastError);
          entry.wanted = false;
          break;
        }
        await sleep(backoffMs(entry.attempts));
      }
      if (!entry.wanted) entry.status.state = "stopped";
    };
    run().catch((error) => this.logError(entry, error));
  }

  startContext(entry) {
    const config = () => this.configStore.get(entry.id);
    return {
      channelId: entry.id,
      config: config(),
      getConfig: config,
      hub: this.hub,
      logger: this.logger,
      onMessage: (msg) => this.handleInbound(entry, msg),
      /** 通道连上之后调一次：状态从 starting 转 running。 */
      onConnected: (info) => {
        entry.status.state = "running";
        entry.status.lastError = null;
        entry.status.lastOkAt = nowIso();
        if (info?.me) entry.status.me = info.me;
      },
      /** 每次成功轮询/收事件都可以调，用来刷新 lastOkAt。 */
      onActivity: () => {
        entry.status.lastOkAt = nowIso();
      },
      scrub: (value) => scrub(String(value ?? ""), config()),
      manager: this,
    };
  }

  /** 通道线程里抛出来的任何东西都在这里被吃掉，绝不冒泡。 */
  handleInbound(entry, msg) {
    Promise.resolve()
      .then(() => this.router.handle({ channelId: entry.id, ...(msg || {}) }))
      .catch((error) => this.logError(entry, error));
  }

  onTaskEvent(event) {
    try {
      const result = this.router?.onTaskEvent?.(event);
      if (result && typeof result.catch === "function") {
        result.catch((error) => this.logError(null, error));
      }
    } catch (error) {
      this.logError(null, error);
    }
  }

  // ── 状态与配置视图 ──────────────────────────────────────────────────────

  getChannel(channelId) {
    return this.entries.get(String(channelId || ""))?.adapter || null;
  }

  entryOf(channelId) {
    return this.entries.get(String(channelId || "")) || null;
  }

  /** 面板要的一切：能力、状态、掩码后的配置、白名单、配对码。 */
  describe(channelId) {
    const entry = this.entries.get(String(channelId || ""));
    if (!entry) return null;
    const adapter = entry.adapter;
    const config = this.configStore.get(entry.id) || {};
    const live = typeof adapter.status === "function" ? adapter.status() || {} : {};
    const status = {
      state: live.state || entry.status.state,
      lastError: live.lastError || entry.status.lastError || null,
      lastOkAt: live.lastOkAt || entry.status.lastOkAt || null,
      lastErrorAt: live.lastErrorAt || entry.status.lastErrorAt || null,
      reconnects: entry.status.reconnects,
      me: live.me || entry.status.me || null,
    };
    return {
      id: entry.id,
      label: adapter.label || entry.spec.label,
      implemented: adapter.implemented === true,
      needsPublicCallback: adapter.needsPublicCallback === true,
      readiness: adapter.readiness || entry.spec.readiness || "unsupported",
      // note 只认通道自己的：占位对象的 note 已经是"为什么不可用"，
      // 真通道加载成功时它是 null —— 不能拿 spec.note 兜底，否则会显示假原因。
      note: adapter.note || null,
      enabled: config.enabled === true,
      // ready === false 表示通道自己知道现在还不可用（例如飞书 SDK 没装）。
      available: entry.loaded && adapter.implemented === true && live.ready !== false,
      // 状态既平铺（老面板/告警直接用）也放进 status（新面板按 status 取），两套都别缺。
      ...status,
      status,
      fields: typeof adapter.describeConfig === "function" ? adapter.describeConfig() : [],
      config: maskConfig(config),
      allowlist: Array.isArray(config.allowlist) ? structuredClone(config.allowlist) : [],
      pairCode: this.configStore.pairCodeFor(entry.id),
      chats: [],
    };
  }

  statusList() {
    return [...this.entries.keys()].map((id) => this.describe(id)).filter(Boolean);
  }

  view() {
    return this.statusList();
  }

  /** 列表视图：顺带把「最近会话」取回来，方便面板一键绑定。 */
  async viewWithChats() {
    return Promise.all([...this.entries.keys()].map((id) => this.describeWithChats(id)));
  }

  async describeWithChats(channelId) {
    const view = this.describe(channelId);
    if (!view) return null;
    const adapter = this.getChannel(channelId);
    try {
      const result = typeof adapter?.listChats === "function" ? await adapter.listChats() : [];
      view.chats = Array.isArray(result) ? result : [];
    } catch (error) {
      view.chats = [];
      this.logError(this.entries.get(String(channelId)) || null, error);
    }
    return view;
  }

  async send(channelId, chatId, text, opts = {}) {
    const entry = this.entries.get(String(channelId || ""));
    if (!entry) throw new Error(`没有这个通道：${channelId}`);
    if (entry.adapter.implemented !== true) {
      throw new Error(entry.adapter.note || `${entry.adapter.label || channelId} 通道暂不可用`);
    }
    // 通道自己拿不到配置（send 是纯发送语义），把当前配置递进去，
    // 这样"刚改完 Token 就推消息"也能用新配置，不用等重启。
    const config = this.configStore.get(entry.id);
    return entry.adapter.send(chatId, text, { ...opts, config });
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  markError(entry, error) {
    const message = error instanceof Error ? error.message : String(error);
    entry.status.state = "error";
    entry.status.lastError = entry.loaded
      ? scrub(message, this.configStore.get(entry.id)) || "原因不明"
      : (entry.spec.note || "通道模块没加载成功");
    entry.status.lastErrorAt = nowIso();
    entry.status.reconnects = (entry.status.reconnects || 0) + 1;
    this.logError(entry, message);
  }

  logError(entry, error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = entry ? `[通道 ${entry.id}]` : "[通道]";
    const body = entry ? scrub(message, this.configStore.get(entry.id)) : message;
    this.logger?.warn?.(`${prefix} ${body}`);
  }
}
