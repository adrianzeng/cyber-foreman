import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST, DEFAULT_PORT, LOOPBACK_HOSTS, resolveDataDir } from "./cli-options.mjs";

/**
 * 统一配置装配。
 *
 * 原来 loadConfig 把 dataDir 固定解析到源码目录，`npx` 跑的时候包目录是只读的、
 * 升级还会被整体替换 —— 数据会丢。现在所有“东西放哪”的问题都走这里：
 *   - 端口/地址：命令行 > 环境变量 > 配置文件 > 默认
 *   - 数据目录：命令行 > 环境变量 > 配置文件 > 探测 ./data > 平台默认
 *   - 配置文件：命令行 > 环境变量 > <数据目录>/config.json > 兼容老的 config/workers.json
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** 包根目录。public/ 与静态资源用它定位，npx 下天然正确。 */
export const PROJECT_ROOT = resolve(HERE, "..");

/** 老版本放员工种子模板的位置，只作为兼容回退。 */
export const LEGACY_CONFIG_FILE = join(PROJECT_ROOT, "config", "workers.json");

export { DEFAULT_HOST, DEFAULT_PORT, LOOPBACK_HOSTS };

/** 本机回环地址判定（IPv6 的方括号要去掉再比）。 */
export function isLoopbackHost(host) {
  const value = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
  if (!value) return false;
  if (value === "::1" || value === "localhost") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/** 读配置 JSON。显式指定的文件不存在算错误，默认文件不存在算“还没配”。 */
export function readConfigFile(file, options = {}) {
  const required = options.required === true;
  if (!existsSync(file)) {
    if (required) throw new Error(`读取配置失败 ${file}：文件不存在`);
    return {};
  }
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`读取配置失败 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function firstPort(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`端口要填 0 到 65535 的整数，收到：${value}`);
    }
    return port;
  }
  return DEFAULT_PORT;
}

function normalizeHostList(list) {
  const result = [];
  for (const item of list) {
    const value = String(item || "")
      .trim()
      .toLowerCase()
      .replace(/^\[/, "")
      .replace(/\]$/, "");
    if (value && !result.includes(value)) result.push(value);
  }
  return result;
}

/**
 * 允许的 Host 头。
 * 默认只有三个回环值 —— 现有行为与测试保持不变。
 * 显式绑到非回环地址时必须放开校验，否则用户从局域网访问会被自己的 403 挡住；
 * 这个取舍会通过横幅和 /api/health 的 warning 明说。
 */
export function resolveAllowedHosts(rawAllowed, host) {
  if (Array.isArray(rawAllowed) && rawAllowed.length) {
    const list = normalizeHostList(rawAllowed);
    if (list.includes("*")) return { allowedHosts: list, allowAnyHost: true };
    return { allowedHosts: list.length ? list : LOOPBACK_HOSTS.slice(), allowAnyHost: false };
  }
  if (!isLoopbackHost(host)) {
    return { allowedHosts: [String(host).toLowerCase()], allowAnyHost: true };
  }
  return { allowedHosts: LOOPBACK_HOSTS.slice(), allowAnyHost: false };
}

/**
 * 默认配置文件位置：优先数据目录里的 config.json。
 * 只有在项目目录里直接 `npm start`（cwd 就是包根）时才回退到老的
 * `config/workers.json`，否则 npx 场景会错误地读到别人的配置。
 */
function defaultConfigFile(dataDir, cwd) {
  const inDataDir = join(dataDir, "config.json");
  if (existsSync(inDataDir)) return inDataDir;
  if (resolve(cwd) === PROJECT_ROOT && existsSync(LEGACY_CONFIG_FILE)) return LEGACY_CONFIG_FILE;
  return inDataDir;
}

/**
 * 装配运行时配置。
 *
 * @param {object|string} input 传字符串等同于 `{ configFile }`（兼容老调用）
 * @returns {{configFile:string, port:number, host:string, dataDir:string,
 *   workers:object, allowedHosts:string[], allowAnyHost:boolean,
 *   channelsEnabled:boolean, warning:string|null}}
 */
export function loadConfig(input = {}) {
  const options = typeof input === "string" ? { configFile: input } : input && typeof input === "object" ? input : {};
  const env = options.env || process.env;
  const cli = options.cli && typeof options.cli === "object" ? options.cli : {};
  const cwd = options.cwd || process.cwd();
  const platform = options.platform || process.platform;

  const explicitConfigFile = options.configFile || cli.configFile || env.AGENT_HUB_CONFIG || null;
  // cli.dataDir 只有在命令行或环境变量显式给了才有值（parse 里就解析成绝对路径了）。
  const explicitDataDir = options.dataDir || cli.dataDir || null;

  let configFile = null;
  let raw = {};

  if (explicitConfigFile) {
    configFile = isAbsolute(String(explicitConfigFile)) ? resolve(String(explicitConfigFile)) : resolve(cwd, String(explicitConfigFile));
    raw = readConfigFile(configFile, { required: true });
  }

  // 先按“不含配置文件里的 dataDir”算一次，才能知道默认配置文件该在哪。
  const preliminaryDataDir = explicitDataDir
    ? resolve(cwd, String(explicitDataDir))
    : resolveDataDir({
      env: env.AGENT_HUB_DATA_DIR,
      configDataDir: null,
      cwd,
      platform,
      homeDir: options.homeDir || null,
      envVars: env,
    });

  if (!configFile) {
    configFile = defaultConfigFile(preliminaryDataDir, cwd);
    raw = readConfigFile(configFile, { required: false });
  }

  const dataDir = explicitDataDir
    ? resolve(cwd, String(explicitDataDir))
    : resolveDataDir({
      env: env.AGENT_HUB_DATA_DIR,
      configDataDir: raw.dataDir,
      cwd,
      platform,
      homeDir: options.homeDir || null,
      envVars: env,
    });

  // 命令行/环境变量给的值比配置文件高；parse 会把来源标出来，这里据此排优先级。
  const cliPort = cli.portSource === "cli" || cli.portSource === "env" ? cli.port : null;
  const port = firstPort(options.port, cliPort, env.AGENT_HUB_PORT, cli.port, raw.port);
  const cliHost = cli.hostSource === "cli" || cli.hostSource === "env" ? cli.host : null;
  const host = String(
    options.host || cliHost || env.AGENT_HUB_HOST || raw.host || cli.host || DEFAULT_HOST,
  ).trim();
  const { allowedHosts, allowAnyHost } = resolveAllowedHosts(raw.allowedHosts, host);
  const workers = raw.workers && typeof raw.workers === "object" ? raw.workers : {};
  const channelsEnabled = options.channelsEnabled !== false && cli.channels !== false;

  return {
    configFile,
    port,
    host,
    dataDir,
    workers,
    allowedHosts,
    allowAnyHost,
    channelsEnabled,
    warning: allowAnyHost
      ? `正在监听 ${host}：局域网内任何人都能打开面板、派活、停任务。不确定的话请加 --host 127.0.0.1`
      : null,
  };
}
