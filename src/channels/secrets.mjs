/**
 * 脱敏：Token / appSecret 这类东西只允许出现在 data/channels.json 里，
 * HTTP 响应、日志、IM 消息、错误堆栈里一律打码。
 *
 * 三个约定：
 *   1. 掩码形如 `****a1b2`（后 4 位保留，便于人眼确认“换没换”）。
 *   2. 前端把掩码原样回传表示“没改”，必须还原成原值，否则一次保存就把 Token 清空了。
 *   3. 清空必须显式 `clearToken: true`，避免误提交空串把配置搞挂。
 */

const MASK_PREFIX = "****";

/** 字段名命中这些就按敏感处理。 */
export const SECRET_KEYS = new Set([
  "token",
  "botToken",
  "appSecret",
  "appKey",
  "secret",
  "password",
  "verificationToken",
  "encryptKey",
  "encodingAESKey",
]);

/** 太短的值不参与替换，否则日志里满屏都是掩码，反而看不清。 */
const MIN_SCRUB_LENGTH = 6;

export function isSecretKey(key) {
  return SECRET_KEYS.has(String(key || ""));
}

/** `****a1b2`：保留末 4 位。空值返回空串，别显示成 `****`。 */
export function mask(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= 4) return MASK_PREFIX;
  return `${MASK_PREFIX}${text.slice(-4)}`;
}

export function isMasked(value) {
  return typeof value === "string" && value.startsWith(MASK_PREFIX);
}

/**
 * 把 PUT 上来的 patch 与当前配置合并：
 *   - 敏感字段为空 或 等于当前值的掩码 → 保留原值
 *   - `clearToken: true` + 空敏感字段 → 真的清空
 *   - 其它字段原样覆盖
 */
export function mergeMasked(patch, current) {
  const source = patch && typeof patch === "object" ? patch : {};
  const base = current && typeof current === "object" ? current : {};
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "clearToken") continue;
    result[key] = value;
  }

  const clear = source.clearToken === true;
  for (const key of Object.keys(base)) {
    if (!isSecretKey(key)) continue;
    const incoming = source[key];
    if (incoming === undefined) continue;
    const currentValue = base[key];
    const text = typeof incoming === "string" ? incoming.trim() : incoming;
    const untouched = text === "" || text === null || isMasked(String(text)) || text === mask(currentValue);
    if (untouched) result[key] = clear ? "" : currentValue;
    else result[key] = incoming;
  }
  return result;
}

/** 递归收集敏感值，用于日志与错误脱敏。 */
export function collectSecrets(value, collected = []) {
  if (!value || typeof value !== "object") return collected;
  if (Array.isArray(value)) {
    for (const item of value) collectSecrets(item, collected);
    return collected;
  }
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key) && typeof item === "string" && item.trim().length >= MIN_SCRUB_LENGTH) {
      if (!collected.includes(item)) collected.push(item);
      continue;
    }
    if (item && typeof item === "object") collectSecrets(item, collected);
  }
  return collected;
}

/**
 * 文本脱敏。secrets 可以是配置对象，也可以是字符串数组。
 * Telegram 的报错会把 `/bot<token>/` 带进 URL，飞书 SDK 的 logger 也会打 appId/appSecret，
 * 这两处都必须过这个函数。
 */
export function scrub(text, secrets) {
  let body = String(text ?? "");
  if (!body) return "";
  const list = Array.isArray(secrets) ? secrets : collectSecrets(secrets);
  const candidates = [];
  for (const item of list) {
    const value = String(item ?? "");
    if (value.length >= MIN_SCRUB_LENGTH && !candidates.includes(value)) candidates.push(value);
  }
  // 长的先替换，避免短值把长值切碎。
  candidates.sort((a, b) => b.length - a.length);
  for (const value of candidates) {
    body = body.split(value).join(mask(value));
  }
  return body;
}

/** 把一份通道配置里的敏感字段换成掩码，其余字段原样保留。 */
export function maskConfig(config) {
  if (!config || typeof config !== "object") return {};
  const result = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSecretKey(key)) {
      result[key] = mask(value);
      continue;
    }
    result[key] = value && typeof value === "object" ? structuredClone(value) : value;
  }
  return result;
}
