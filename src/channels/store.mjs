import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { dirname } from "node:path";

/**
 * IM 通道配置仓库：`data/channels.json`。
 *
 * 与 `data/workers.json` 同一套假设：明文落盘（含 Token），原子写 + `.bak` 备份，
 * 文件在 `.gitignore` 的 `data/*` 里，不会进仓库。
 *
 * 里面存四样东西：
 *   channels     每个通道的配置、白名单、配对码
 *   deliveries   哪个任务要推给哪个会话（最多 200 条 FIFO）
 *   lastList     每个会话上次 /任务 的编号顺序（保证「/看 2」永远指同一个任务）
 */

export const CHANNEL_IDS = ["telegram", "feishu", "wecom", "wechat"];

/** 每个通道最多绑 30 个会话。 */
export const MAX_ALLOWLIST = 30;
/** 投递记录最多留 200 条，超了从最旧的丢。 */
export const MAX_DELIVERIES = 200;
/** 配对码 6 位数字，10 分钟有效，用后即焚。 */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
/** lastList 每个会话最多记 20 个任务编号。 */
const MAX_LAST_LIST = 20;

const CHANNEL_ID_SET = new Set(CHANNEL_IDS);

export function isChannelId(id) {
  return CHANNEL_ID_SET.has(String(id || ""));
}

/** 一个通道的出厂默认值。字段与面板表单一一对应。 */
export function emptyChannelConfig(id) {
  const base = { enabled: false, allowlist: [], pairCode: null };
  switch (id) {
    case "telegram":
      return {
        ...base,
        token: "",
        apiBase: "https://api.telegram.org",
        defaults: { workerId: null, cwd: null, newSession: false },
      };
    case "feishu":
      return {
        ...base,
        appId: "",
        appSecret: "",
        domain: "open.feishu.cn",
        defaults: { workerId: null, cwd: null, newSession: false },
      };
    case "wecom":
      return { ...base, note: "需要公网回调地址，下一阶段再做" };
    case "wechat":
      return { ...base, note: "微信 4.x 暂无免费方案，这里只留位置" };
    default:
      return base;
  }
}

function defaultDocument() {
  const channels = {};
  for (const id of CHANNEL_IDS) channels[id] = emptyChannelConfig(id);
  return { version: 1, updatedAt: new Date().toISOString(), channels, deliveries: [], lastList: {} };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 白名单条目规范化。绑定单元是「会话」而不是「人」：
 * 同一个私聊里换个人拿手机发消息也算已绑定 —— 这是刻意的取舍，
 * 面板上写明了「绑定的是会话，别把 Bot 借给别人用」。
 */
export function normalizeAllowlistEntry(input = {}, channelConfig = {}) {
  const chatId = String(input.chatId || "").trim().slice(0, 120);
  if (!chatId) throw new Error("要绑定哪个会话？chatId 不能为空");
  const defaults = channelConfig.defaults && typeof channelConfig.defaults === "object" ? channelConfig.defaults : {};
  return {
    chatId,
    chatType: input.chatType === "group" ? "group" : "p2p",
    chatTitle: String(input.chatTitle || "").trim().slice(0, 80),
    workerId: String(input.workerId || defaults.workerId || "").trim() || null,
    cwd: input.cwd ? String(input.cwd) : defaults.cwd || null,
    newSession: input.newSession === true || defaults.newSession === true,
    boundAt: input.boundAt || nowIso(),
    boundBy: String(input.boundBy || "manual").slice(0, 40),
    enabled: input.enabled !== false,
  };
}

export class ChannelConfigStore {
  constructor(file) {
    this.file = file;
    this.data = defaultDocument();
  }

  /** 读盘。缺的通道/字段按默认值补齐，坏文件降级成默认值而不是让 Hub 起不来。 */
  load() {
    const raw = existsSync(this.file) ? readJson(this.file, null) : null;
    const merged = defaultDocument();
    if (raw && typeof raw === "object") {
      merged.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : merged.updatedAt;
      if (raw.channels && typeof raw.channels === "object") {
        for (const id of CHANNEL_IDS) {
          const current = raw.channels[id];
          if (!current || typeof current !== "object") continue;
          merged.channels[id] = {
            ...merged.channels[id],
            ...current,
            allowlist: Array.isArray(current.allowlist)
              ? current.allowlist.filter((item) => item && item.chatId).slice(0, MAX_ALLOWLIST)
              : [],
          };
        }
      }
      if (Array.isArray(raw.deliveries)) {
        merged.deliveries = raw.deliveries
          .filter((item) => item && item.taskId && item.channelId && item.chatId)
          .slice(-MAX_DELIVERIES);
      }
      if (raw.lastList && typeof raw.lastList === "object") {
        for (const [chatId, ids] of Object.entries(raw.lastList)) {
          if (Array.isArray(ids)) merged.lastList[chatId] = ids.filter((id) => typeof id === "string").slice(0, MAX_LAST_LIST);
        }
      }
    }
    this.data = merged;
    return this;
  }

  persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    this.data.updatedAt = nowIso();
    const text = `${JSON.stringify(this.data, null, 2)}\n`;
    if (existsSync(this.file)) {
      try {
        copyFileSync(this.file, `${this.file}.bak`);
      } catch {
        // 备份失败不影响写入。
      }
    }
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, text, "utf8");
    renameSync(temporary, this.file);
  }

  #assertId(id) {
    if (!isChannelId(id)) throw new Error(`没有这个通道：${id}`);
  }

  #config(id) {
    this.#assertId(id);
    return this.data.channels[id];
  }

  /** 返回深拷贝，调用方随便改都写不回仓库。 */
  get(id) {
    const config = this.#config(id);
    return config ? structuredClone(config) : null;
  }

  /**
   * 改配置。配对码只能通过 createPairCode 生成，这里直接忽略外部传入的 pairCode。
   * allowlist 传了整表就整表替换（面板就是整表提交的）。
   */
  patch(id, patch = {}) {
    const current = this.#config(id);
    const next = { ...current };
    for (const [key, value] of Object.entries(patch || {})) {
      if (value === undefined) continue;
      if (key === "allowlist" || key === "pairCode") continue;
      if (key === "defaults" && value && typeof value === "object") {
        next.defaults = { ...(current.defaults || {}), ...value };
        continue;
      }
      next[key] = value;
    }
    if (Array.isArray(patch.allowlist)) {
      const list = [];
      patch.allowlist.slice(0, MAX_ALLOWLIST).forEach((raw, index) => {
        try {
          list.push(normalizeAllowlistEntry(raw, next));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`第 ${index + 1} 个绑定项有问题：${reason}`);
        }
      });
      next.allowlist = list;
    }
    this.data.channels[id] = next;
    this.persist();
    return this.get(id);
  }

  setAllowlist(id, list) {
    return this.patch(id, { allowlist: Array.isArray(list) ? list : [] });
  }

  /** 按会话查绑定。chatId 带渠道前缀，全局唯一，所以扫所有通道也很快。 */
  findBinding(chatId) {
    const target = String(chatId || "").trim();
    if (!target) return null;
    for (const id of CHANNEL_IDS) {
      const entry = (this.data.channels[id].allowlist || []).find(
        (item) => item.chatId === target && item.enabled !== false,
      );
      if (entry) return { channelId: id, entry: structuredClone(entry) };
    }
    return null;
  }

  upsertBinding(channelId, entry) {
    const config = this.#config(channelId);
    const normalized = normalizeAllowlistEntry(entry, config);
    const list = Array.isArray(config.allowlist) ? config.allowlist.slice() : [];
    const index = list.findIndex((item) => item.chatId === normalized.chatId);
    if (index >= 0) list[index] = normalized;
    else list.push(normalized);
    // 满了从最旧的开始挤掉：新绑定一定比老绑定更有用。
    while (list.length > MAX_ALLOWLIST) list.shift();
    config.allowlist = list;
    this.persist();
    return structuredClone(normalized);
  }

  removeBinding(channelId, chatId) {
    const config = this.#config(channelId);
    const target = String(chatId || "").trim();
    const list = Array.isArray(config.allowlist) ? config.allowlist : [];
    const next = list.filter((item) => item.chatId !== target);
    if (next.length === list.length) return false;
    config.allowlist = next;
    this.persist();
    return true;
  }

  /** 生成配对码（6 位数字 / 10 分钟 / 用后即焚）。 */
  createPairCode(channelId, options = {}) {
    const config = this.#config(channelId);
    const ttlMs = Math.max(60_000, Number(options.ttlMs) || PAIR_CODE_TTL_MS);
    const now = Number(options.now) || Date.now();
    const code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(now + ttlMs).toISOString();
    config.pairCode = { code, expiresAt };
    this.persist();
    return { code, expiresAt, ttlMs };
  }

  /** 有效才返回，过期一律当没有。 */
  pairCodeFor(channelId, now = Date.now()) {
    const config = this.#config(channelId);
    const pair = config?.pairCode;
    if (!pair || !pair.code || !pair.expiresAt) return null;
    const expires = Date.parse(pair.expiresAt);
    if (!Number.isFinite(expires) || expires <= now) return null;
    return { code: pair.code, expiresAt: pair.expiresAt, remainingMs: expires - now };
  }

  /** 校验并作废配对码。 */
  consumePairCode(channelId, code, now = Date.now()) {
    const pair = this.pairCodeFor(channelId, now);
    if (!pair || pair.code !== String(code || "").trim()) return false;
    this.#config(channelId).pairCode = null;
    this.persist();
    return true;
  }

  clearPairCode(channelId) {
    this.#config(channelId).pairCode = null;
    this.persist();
  }

  /** 记一条投递：这个任务的结果要推给哪个会话。 */
  addDelivery(delivery = {}) {
    const entry = {
      taskId: String(delivery.taskId || ""),
      channelId: String(delivery.channelId || ""),
      chatId: String(delivery.chatId || ""),
      kind: delivery.kind === "side" ? "side" : "main",
      ackedAt: delivery.ackedAt || nowIso(),
      pushedAt: delivery.pushedAt || null,
      lastNotifiedStatus: delivery.lastNotifiedStatus || null,
    };
    if (!entry.taskId || !entry.channelId || !entry.chatId) {
      throw new Error("投递记录缺少 taskId / channelId / chatId");
    }
    const index = this.data.deliveries.findIndex(
      (item) => item.taskId === entry.taskId && item.chatId === entry.chatId,
    );
    if (index >= 0) this.data.deliveries[index] = { ...this.data.deliveries[index], ...entry };
    else this.data.deliveries.push(entry);
    if (this.data.deliveries.length > MAX_DELIVERIES) {
      this.data.deliveries = this.data.deliveries.slice(-MAX_DELIVERIES);
    }
    this.persist();
    return { ...entry };
  }

  recordDelivery(taskId, patch = {}) {
    let changed = false;
    for (const item of this.data.deliveries) {
      if (item.taskId !== taskId) continue;
      for (const [key, value] of Object.entries(patch)) {
        if (["taskId", "channelId", "chatId", "kind"].includes(key)) continue;
        item[key] = value;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  deliveriesFor(taskId) {
    return this.data.deliveries
      .filter((item) => item.taskId === taskId)
      .map((item) => structuredClone(item));
  }

  /** 某个会话派过的任务，最新的排前面。 */
  deliveriesForChat(chatId) {
    const target = String(chatId || "").trim();
    return this.data.deliveries
      .filter((item) => item.chatId === target)
      .sort((a, b) => String(b.ackedAt).localeCompare(String(a.ackedAt)))
      .map((item) => structuredClone(item));
  }

  /**
   * 记下 /任务 的编号顺序。
   * 不记的话「/看 2」会随新任务到来漂移，用户点开的就不是他刚看到的那个。
   */
  setLastList(chatId, ids) {
    const target = String(chatId || "").trim();
    if (!target) return;
    this.data.lastList[target] = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string").slice(0, MAX_LAST_LIST);
    this.persist();
  }

  getLastList(chatId) {
    const ids = this.data.lastList[String(chatId || "").trim()];
    return Array.isArray(ids) ? ids.slice() : [];
  }
}
