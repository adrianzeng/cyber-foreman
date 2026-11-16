import { existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/**
 * 命令行参数的纯函数实现。
 *
 * 这里刻意不读全局状态（除了显式传入的默认值）：npx 场景下端口、数据目录、
 * 配置文件一律不许写死，全部按 `--参数 > 环境变量 > 配置文件 > 默认` 的优先级解析，
 * 这样同一个包既能 `npx` 直跑，也能在项目目录里 `npm start`，还能在 CI 里固定参数。
 */

export const DEFAULT_PORT = 4647;
export const DEFAULT_HOST = "127.0.0.1";
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
/** 端口被占用时最多往后试几个。 */
export const PORT_RETRY_ATTEMPTS = 10;

const CLI_OPTIONS = {
  port: { type: "string" },
  host: { type: "string" },
  "data-dir": { type: "string" },
  config: { type: "string" },
  open: { type: "boolean" },
  "no-channels": { type: "boolean" },
  "log-level": { type: "string" },
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
};

function filled(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function toPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return port;
}

/**
 * 解析命令行。返回的对象一定带 `ok` 字段：
 *   ok:false —— 参数写错了，error 里是能直接打印给用户看的中文
 *   ok:true  —— help/version 为 true 时只需要打印，不要启动服务
 *
 * @param {string[]} argv 不含 node 与脚本路径的参数
 * @param {Record<string, string|undefined>} env 环境变量
 * @param {{port?: number|string, dataDir?: string, host?: string}} config 配置文件里读到的值
 * @param {{cwd?: string, platform?: string, homeDir?: string}} overrides 便于测试注入
 */
export function parse(argv = [], env = {}, config = {}, overrides = {}) {
  const cwd = overrides.cwd || process.cwd();
  const platform = overrides.platform || process.platform;
  const homeDir = overrides.homeDir || env.HOME || env.USERPROFILE || homedir();

  let parsed;
  try {
    parsed = parseArgs({
      args: Array.isArray(argv) ? [...argv] : [],
      options: CLI_OPTIONS,
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `参数不对：${detail}\n发 --help 看用法` };
  }

  const values = parsed.values || {};
  if (values.help === true) return { ok: true, help: true, version: false };
  if (values.version === true) return { ok: true, help: false, version: true };

  // portSource 告诉上层这个值到底是哪来的：配置文件里的端口优先级最低，
  // 必须留在 loadConfig 里参与比较，不能在这里就盖住它。
  let port = DEFAULT_PORT;
  let portSource = "default";
  if (filled(values.port)) {
    portSource = "cli";
    port = toPort(values.port);
  } else if (filled(env.AGENT_HUB_PORT)) {
    portSource = "env";
    port = toPort(env.AGENT_HUB_PORT);
  } else if (filled(config.port)) {
    portSource = "config";
    port = toPort(config.port);
  }
  if (port === null) {
    const raw = portSource === "cli" ? values.port : portSource === "env" ? env.AGENT_HUB_PORT : config.port;
    return { ok: false, error: `端口要填 0 到 65535 的整数，收到：${raw}` };
  }

  let host = DEFAULT_HOST;
  let hostSource = "default";
  if (filled(values.host)) {
    hostSource = "cli";
    host = String(values.host).trim();
  } else if (filled(env.AGENT_HUB_HOST)) {
    hostSource = "env";
    host = String(env.AGENT_HUB_HOST).trim();
  } else if (filled(config.host)) {
    hostSource = "config";
    host = String(config.host).trim();
  }

  const explicitConfig = filled(values.config) ? values.config : filled(env.AGENT_HUB_CONFIG) ? env.AGENT_HUB_CONFIG : null;
  const explicitDataDir = filled(values["data-dir"])
    ? values["data-dir"]
    : filled(env.AGENT_HUB_DATA_DIR)
      ? env.AGENT_HUB_DATA_DIR
      : filled(config.dataDir)
        ? config.dataDir
        : null;

  return {
    ok: true,
    help: false,
    version: false,
    port,
    portSource,
    host,
    hostSource,
    configFile: explicitConfig ? resolve(cwd, String(explicitConfig)) : null,
    /** 只有命令行/环境变量/配置里显式写了才有值；null 表示交给 loadConfig 按平台规则解析。 */
    dataDir: explicitDataDir ? resolve(cwd, String(explicitDataDir)) : null,
    open: values.open === true,
    channels: values["no-channels"] !== true,
    logLevel: String(values["log-level"] || env.AGENT_HUB_LOG_LEVEL || "info").trim() || "info",
  };
}

/**
 * 数据目录优先级：--data-dir > AGENT_HUB_DATA_DIR > 配置文件 > 探测 ./data > 平台默认。
 *
 * 探测这一条是为了老用户：以前 `npm start` 把数据放项目里的 `./data`，
 * 直接切到平台默认目录会让历史任务“凭空消失”。
 */
export function resolveDataDir(options = {}) {
  const cwd = options.cwd || process.cwd();
  const platform = options.platform || process.platform;
  const envVars = options.envVars || process.env;
  const homeDir = options.homeDir || envVars.HOME || envVars.USERPROFILE || homedir();

  if (filled(options.cli)) return resolve(cwd, String(options.cli));
  if (filled(options.env)) return resolve(cwd, String(options.env));
  if (filled(options.configDataDir)) return resolve(cwd, String(options.configDataDir));

  const probe = join(cwd, "data");
  if (looksLikeDataDir(probe)) return probe;

  return defaultDataDir({ platform, homeDir, envVars });
}

/** 目录里已经有任务记录或员工配置，就认为它是老用户的数据目录。 */
export function looksLikeDataDir(directory) {
  try {
    if (existsSync(join(directory, "workers.json"))) return true;
    const tasks = join(directory, "tasks");
    return existsSync(tasks) && statSync(tasks).isDirectory();
  } catch {
    return false;
  }
}

/** 各平台的默认数据目录。 */
export function defaultDataDir({ platform = process.platform, homeDir = null, envVars = process.env } = {}) {
  const home = homeDir || envVars.HOME || envVars.USERPROFILE || homedir();
  if (platform === "win32") {
    return join(envVars.LOCALAPPDATA || join(home, "AppData", "Local"), "dsh-agent-hub", "data");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "dsh-agent-hub", "data");
  }
  return join(envVars.XDG_DATA_HOME || join(home, ".local", "share"), "dsh-agent-hub", "data");
}

/**
 * 挑一个能用的端口：优先用你指定的，被占了就往后 +1，最多试 10 个。
 * `--port 0` 直接交给系统分配，不做探测。
 */
export async function pickPort(preferred = DEFAULT_PORT, options = {}) {
  const host = options.host || DEFAULT_HOST;
  const attempts = Math.max(1, Number(options.attempts) || PORT_RETRY_ATTEMPTS);
  const probe = typeof options.probe === "function" ? options.probe : canListen;
  const start = toPort(preferred);
  if (start === null) throw new Error(`端口要填 0 到 65535 的整数，收到：${preferred}`);
  if (start === 0) return 0;

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = start + offset;
    if (port > 65535) break;
    if (await probe(port, host)) return port;
  }
  throw new Error(`端口 ${start} 起连续 ${attempts} 个都被占用了，换一个：--port ${start + attempts}`);
}

/** 试着监听一下，能监听就说明这个端口空着。 */
export function canListen(port, host = DEFAULT_HOST) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

/** 全中文帮助。 */
export function helpText(version = "") {
  const title = version ? `DSH Agent Hub v${version}` : "DSH Agent Hub";
  return [
    title,
    "",
    "用法：dsh-agent-hub [参数]",
    "",
    "参数：",
    "  --port <端口>       监听端口，默认 4647；被占用会自动往后试；--port 0 交给系统分配",
    "  --host <地址>       绑定地址，默认 127.0.0.1（只有本机能访问）；填 0.0.0.0 会给出安全警告",
    "  --data-dir <目录>   数据目录（任务记录、员工与通道配置），默认放到系统用户目录下",
    "  --config <文件>     配置文件（端口、数据目录、初始员工），默认 <数据目录>/config.json",
    "  --open              启动后自动打开浏览器",
    "  --no-channels       这次不启动任何 IM 通道",
    "  --log-level <级别>  debug / info / warn / error，默认 info",
    "  --version           打印版本号",
    "  --help              打印这段帮助",
    "",
    "也认环境变量：AGENT_HUB_PORT / AGENT_HUB_HOST / AGENT_HUB_DATA_DIR / AGENT_HUB_CONFIG",
    "",
    "例子：",
    "  npx @local/dsh-agent-hub",
    "  npx @local/dsh-agent-hub --port 4700 --data-dir D:\\hub-data",
    "  AGENT_HUB_PORT=4700 dsh-agent-hub --no-channels",
  ].join("\n");
}
