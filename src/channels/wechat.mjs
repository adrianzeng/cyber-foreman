/**
 * 个人微信：占位通道。
 *
 * 微信 4.x 之后，以前能用的 hook 方案（wcferry / WeChatFerry 之类）全部失效，
 * 目前没有免费、稳定、不违反使用条款的路子，所以这里只留接口位并写清原因，
 * 面板上灰态显示、不允许启用。要做就得单独立项评估。
 */

const NOTE = "个人微信 4.x 目前没有免费可行方案（旧 hook 方案已失效），所以只留了接口位。手机遥控请用 Telegram 或飞书。";

export default {
  id: "wechat",
  label: "个人微信",
  implemented: false,
  needsPublicCallback: false,
  readiness: "unsupported",
  note: NOTE,

  describeConfig() {
    return [];
  },

  normalize(patch = {}, current = {}) {
    const next = { ...current };
    // 显式写 false，避免配置文件里手改出一半状态。
    next.enabled = false;
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
    throw new Error("个人微信还没接，消息发不出去");
  },

  listChats() {
    return [];
  },

  async test() {
    return { ok: false, message: NOTE };
  },
};
