/**
 * 企业微信：占位通道。
 *
 * 收消息必须有一个公网可达的回调地址（企业微信不提供长连接/轮询），
 * 而 Hub 默认只监听 127.0.0.1 —— 所以这一阶段只留接口位：
 * 面板上灰态显示、写明原因、不允许启用。
 *
 * 字段先摆出来，是为了让人看得懂"要接需要填什么"，
 * 而不是给一个空表单让人猜。
 */

const NOTE = "企业微信需要公网回调地址才能收消息，这一阶段只留位置。想先用手机遥控，选 Telegram 或飞书。";

const FIELDS = [
  { key: "corpId", label: "企业 ID（corpId）", type: "text", secret: false, required: false, hint: "企业微信后台 → 我的企业 → 企业 ID" },
  { key: "agentId", label: "应用 AgentId", type: "text", secret: false, required: false, hint: "自建应用 → AgentId" },
  { key: "secret", label: "应用 Secret", type: "password", secret: true, required: false, hint: "只存本地 data/channels.json" },
  { key: "callbackToken", label: "回调 Token", type: "password", secret: true, required: false, hint: "需要公网回调地址才能生效" },
];

export default {
  id: "wecom",
  label: "企业微信",
  implemented: false,
  needsPublicCallback: true,
  readiness: "needs-public",
  note: NOTE,

  describeConfig() {
    return FIELDS.map((field) => ({ ...field }));
  },

  /** 占位通道只保存配置，永不启用：启用一个必然失败的连接只会让人困惑。 */
  normalize(patch = {}, current = {}) {
    const next = { ...current };
    delete next.enabled;
    next.enabled = false;
    for (const field of FIELDS) {
      if (!Object.hasOwn(patch, field.key)) continue;
      const value = patch[field.key];
      if (value === undefined) continue;
      next[field.key] = String(value ?? "").trim();
    }
    if (patch.defaults && typeof patch.defaults === "object") {
      next.defaults = { ...(current.defaults || {}), ...patch.defaults };
    }
    if (Array.isArray(patch.allowlist)) next.allowlist = patch.allowlist;
    return next;
  },

  status() {
    return { state: "stopped", ready: false, me: null };
  },

  async start() {
    throw new Error(NOTE);
  },

  async stop() {},

  async send() {
    throw new Error("企业微信还没接，消息发不出去");
  },

  listChats() {
    return [];
  },

  async test() {
    return { ok: false, message: NOTE };
  },
};
