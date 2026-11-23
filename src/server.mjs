import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { TaskStore } from "./store.mjs";
import { AgentHub } from "./hub.mjs";
import { WorkerStore } from "./workers-store.mjs";
import { TemplateStore } from "./templates-store.mjs";
import { listAdapters } from "./adapters/index.mjs";
import { detectCliCommand, isDirectory, listDirectories, listDrives, parentDirectory } from "./fsutil.mjs";
import { DEFAULT_HOST, LOOPBACK_HOSTS, PROJECT_ROOT, isLoopbackHost, loadConfig } from "./config.mjs";
import { pickPort } from "./cli-options.mjs";
import { ChannelConfigStore } from "./channels/store.mjs";
import { ChannelManager } from "./channels/index.mjs";
import { maybeHandleChannels } from "./routes/channels.mjs";

export { PROJECT_ROOT, loadConfig };

const PUBLIC_ROOT = join(PROJECT_ROOT, "public");
const BODY_LIMIT = 1024 * 1024;

/**
 * 静态资源白名单：只放行这几个固定名字。
 * 不做目录遍历，是这套"本机面板"最简单的安全边界。
 */
const STATIC_FILES = new Set([
  "index.html",
  "app.js",
  "styles.css",
  "favicon.svg",
  "panel-common.js",
  "panel-workbench.js",
  "panel-talk.js",
  "panel-channels.js",
]);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/**
 * `/api/tasks/:id/say` 的错误码 → HTTP 状态。
 * 前端按 code 做细分文案，按状态码做通用兜底，两边都不能缺。
 */
const SAY_STATUS = {
  NO_TASK: 404,
  NO_PARENT: 404,
  STEER_UNSUPPORTED: 400,
  STEER_NOT_RUNNING: 409,
  SIDE_BUSY: 409,
  STEER_EMPTY: 400,
  QUESTION_EMPTY: 400,
  STEER_TOO_LONG: 400,
  WORKER_UNAVAILABLE: 503,
  STEER_WRITE_FAILED: 500,
};

function json(response, status, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function text(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
}

/**
 * Host 头校验。
 * 默认只认三个回环值（行为与 0.6.0 一致）；
 * 配置了 allowedHosts 就按配置来；显式绑非回环地址时放开（横幅会警告）。
 */
function hostAllowed(header, config) {
  if (!header) return false;
  if (config.allowAnyHost) return true;
  let hostname;
  try {
    hostname = normalizeHostname(new URL(`http://${header}`).hostname);
  } catch {
    return false;
  }
  const allowed = Array.isArray(config.allowedHosts) && config.allowedHosts.length
    ? config.allowedHosts
    : LOOPBACK_HOSTS;
  return allowed.includes(hostname) || isLoopbackHost(hostname);
}

function allowedOrigin(request, config) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (config.allowAnyHost) return true;
  let hostname;
  try {
    hostname = normalizeHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
  const allowed = Array.isArray(config.allowedHosts) && config.allowedHosts.length
    ? config.allowedHosts
    : LOOPBACK_HOSTS;
  return allowed.includes(hostname) || isLoopbackHost(hostname);
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("请求内容超过 1MB");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("请求 JSON 格式不正确");
  }
}

function staticFile(response, fileName) {
  if (!STATIC_FILES.has(fileName)) return false;
  const file = join(PUBLIC_ROOT, fileName);
  if (!existsSync(file)) return false;
  const body = readFileSync(file);
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file)] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
  return true;
}

function openFolder(target) {
  const command = process.platform === "win32"
    ? "explorer.exe"
    : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(command, [target], { detached: true, stdio: "ignore" });
    child.on("error", () => { /* 打不开就算了，不影响任务 */ });
    child.unref();
  } catch {
    // 同上：这只是个便利功能。
  }
}

/**
 * 装配一个 Hub（不监听端口）。
 * 通道只在这里装配一次：ChannelConfigStore → ChannelManager → MessageRouter，
 * 三者都是 in-process 直调，所以不受 loopback 校验和端口变更影响。
 */
export async function createHubServer(options = {}) {
  const config = options.config || loadConfig(options);
  mkdirSync(config.dataDir, { recursive: true });
  const store = new TaskStore(config.dataDir).init();
  const workerStore = new WorkerStore({
    file: join(config.dataDir, "workers.json"),
    seed: config.workers || {},
  }).load();
  const templateStore = new TemplateStore(join(config.dataDir, "templates.json")).load();
  const hub = new AgentHub({ store, workers: workerStore.snapshot() });

  const logger = options.logger || console;
  const channelStore = new ChannelConfigStore(join(config.dataDir, "channels.json")).load();
  const channelManager = new ChannelManager({ configStore: channelStore, hub, store, logger });
  await channelManager.load();
  const channelsEnabled = options.channels !== false && config.channelsEnabled !== false;
  if (channelsEnabled) await channelManager.startEnabled();

  const server = createServer(async (request, response) => {
    try {
      if (!hostAllowed(request.headers.host, config)) {
        json(response, 403, { error: "只接受本机访问" });
        return;
      }
      if (!allowedOrigin(request, config)) {
        json(response, 403, { error: "不接受的请求来源" });
        return;
      }

      const url = new URL(request.url || "/", `http://${request.headers.host}`);
      const pathname = url.pathname;
      const method = String(request.method || "GET").toUpperCase();

      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        staticFile(response, "index.html");
        return;
      }
      if (method === "GET" && STATIC_FILES.has(pathname.slice(1)) && pathname.lastIndexOf("/") === 0) {
        staticFile(response, pathname.slice(1));
        return;
      }

      // 通道接口：命中就返回，没命中继续走下面的 if 链。
      if (await maybeHandleChannels({
        request,
        response,
        method,
        pathname,
        url,
        manager: channelManager,
        configStore: channelStore,
        readBody,
        json,
      })) {
        return;
      }

      if (method === "GET" && pathname === "/api/health") {
        const overview = hub.overview();
        json(response, 200, config.warning ? { ...overview, warning: config.warning } : overview);
        return;
      }
      if (method === "GET" && pathname === "/api/overview") {
        json(response, 200, hub.overview());
        return;
      }
      if (method === "GET" && pathname === "/api/workers") {
        json(response, 200, { workers: hub.listWorkers() });
        return;
      }
      if (method === "GET" && pathname === "/api/adapters") {
        // 顺带把“这类员工现成的启动方式”和本机 CLI 探测结果给前端，避免切类型后命令对不上。
        const adapters = listAdapters().map((adapter) => ({
          ...adapter,
          commandTemplate: workerStore.commandTemplateFor(adapter.kind),
          detected: detectCliCommand(adapter.kind),
        }));
        json(response, 200, { adapters });
        return;
      }
      if (method === "GET" && pathname === "/api/models") {
        // 模型候选全部按 kind 严格隔离并来自本机配置；refresh=1 强制实时重读。
        const refreshParam = url.searchParams.get("refresh");
        const refresh = refreshParam === "1" || refreshParam === "true";
        json(response, 200, hub.modelOptions(
          url.searchParams.get("kind"),
          url.searchParams.get("workerId"),
          { refresh },
        ));
        return;
      }
      if (method === "GET" && pathname === "/api/usage") {
        json(response, 200, hub.usageStats(
          url.searchParams.get("workerId") || null,
          url.searchParams.get("since") || undefined,
        ));
        return;
      }
      if (method === "GET" && pathname === "/api/templates") {
        json(response, 200, { templates: templateStore.list() });
        return;
      }
      if (method === "POST" && pathname === "/api/templates") {
        const body = await readBody(request);
        json(response, 201, { template: templateStore.create(body) });
        return;
      }
      const templateMatch = /^\/api\/templates\/([A-Za-z0-9_-]+)$/.exec(pathname);
      if (templateMatch) {
        const id = templateMatch[1];
        if (method === "PUT") {
          const body = await readBody(request);
          json(response, 200, { template: templateStore.update(id, body) });
          return;
        }
        if (method === "DELETE") {
          templateStore.remove(id);
          json(response, 200, { removed: id });
          return;
        }
      }
      if (method === "POST" && pathname === "/api/workers") {
        const body = await readBody(request);
        const created = workerStore.create(body);
        hub.replaceWorkers(workerStore.snapshot());
        json(response, 201, { worker: hub.listWorkers().find((item) => item.id === created.id) });
        return;
      }
      const workerMatch = /^\/api\/workers\/([A-Za-z0-9_-]+)$/.exec(pathname);
      if (workerMatch && method === "PUT") {
        const body = await readBody(request);
        const updated = workerStore.update(workerMatch[1], body);
        hub.replaceWorkers(workerStore.snapshot());
        json(response, 200, { worker: hub.listWorkers().find((item) => item.id === updated.id) });
        return;
      }
      if (workerMatch && method === "DELETE") {
        const id = workerMatch[1];
        if (hub.activeByWorker.get(id)) {
          throw new Error("这个员工还有任务在跑，先停止任务再删除");
        }
        const queued = store.queuedFor(id).length;
        if (queued) throw new Error(`这个员工还有 ${queued} 个任务在排队，先停止它们再删除`);
        workerStore.remove(id);
        hub.replaceWorkers(workerStore.snapshot());
        json(response, 200, { removed: id });
        return;
      }

      if (method === "GET" && pathname === "/api/fs/drives") {
        json(response, 200, { drives: listDrives() });
        return;
      }
      if (method === "GET" && pathname === "/api/fs/list") {
        const requested = url.searchParams.get("path");
        const target = requested ? resolve(requested) : listDrives()[0]?.path;
        if (!target || !isDirectory(target)) {
          json(response, 400, { error: `目录不存在：${target || "没有可用的磁盘"}` });
          return;
        }
        let dirs = [];
        let warning = null;
        try {
          dirs = listDirectories(target);
        } catch (error) {
          warning = `这个目录读不了：${error instanceof Error ? error.message : String(error)}`;
        }
        json(response, 200, {
          path: target,
          parent: parentDirectory(target),
          dirs,
          warning,
        });
        return;
      }
      if (method === "GET" && pathname === "/api/fs/stat") {
        const target = resolve(String(url.searchParams.get("path") || ""));
        json(response, 200, { path: target, exists: existsSync(target), isDirectory: isDirectory(target) });
        return;
      }
      if (method === "POST" && pathname === "/api/fs/mkdir") {
        const body = await readBody(request);
        const parent = resolve(String(body.parent || ""));
        const name = String(body.name || "").trim();
        if (!name) throw new Error("文件夹名字不能为空");
        if (/[\\/:*?"<>|]/.test(name) || name === "." || name === "..") {
          throw new Error('文件夹名字不能包含 \\ / : * ? " < > |');
        }
        if (!isDirectory(parent)) throw new Error(`上级目录不存在：${parent}`);
        const target = join(parent, name);
        mkdirSync(target, { recursive: false });
        json(response, 200, { path: target });
        return;
      }
      if (method === "POST" && pathname === "/api/open-folder") {
        const body = await readBody(request);
        const target = resolve(String(body.path || ""));
        if (!isDirectory(target)) throw new Error(`目录不存在：${target}`);
        openFolder(target);
        json(response, 200, { opened: true, path: target });
        return;
      }

      if (method === "GET" && pathname === "/api/tasks") {
        // 默认只列主任务：侧问是答疑产物，混进主列表会让任务流看起来很乱。
        const roleParam = url.searchParams.get("role");
        const role = roleParam === "side" ? "side" : roleParam === "all" ? null : "main";
        json(response, 200, {
          counts: store.counts(),
          tasks: store.listTasks({
            status: url.searchParams.get("status"),
            stage: url.searchParams.get("stage"),
            role,
            limit: url.searchParams.get("limit"),
          }),
        });
        return;
      }
      if (method === "POST" && pathname === "/api/tasks") {
        const body = await readBody(request);
        const task = hub.dispatch({
          workerId: body.workerId,
          prompt: body.prompt || body.task,
          cwd: body.cwd,
          model: body.model,
          effort: body.effort,
          newSession: body.newSession,
        });
        json(response, 202, { task });
        return;
      }

      if (method === "POST" && pathname === "/api/tasks/retry-interrupted") {
        json(response, 200, hub.retryInterruptedTasks());
        return;
      }

      // 任务中对话：插话 / 侧问。策略（含 auto 降级）只在 Hub.say 里一份，
      // 面板按 Enter 和 IM 无前缀消息都走这里，前端不做任何特判。
      const sayMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/say$/.exec(pathname);
      if (sayMatch && method === "POST") {
        const id = sayMatch[1];
        const body = await readBody(request);
        const mode = ["auto", "steer", "side"].includes(body.mode) ? body.mode : "auto";
        const say = String(body.text || "").trim();
        try {
          const result = await hub.say(id, say, { mode, source: "panel" });
          json(response, 200, result);
          return;
        } catch (error) {
          const status = SAY_STATUS[error?.code] || 400;
          const message = error instanceof Error ? error.message : String(error);
          // error 与 message 同值：前端读 message（可直接显示），老调用方读 error。
          // 文案只在这里和后端错误里各一份，不给前端留"自己拼"的空间。
          json(response, status, {
            error: message,
            message,
            code: error?.code || "SAY_FAILED",
            ...(error?.fallback ? { fallback: error.fallback } : {}),
          });
          return;
        }
      }

      const match = /^\/api\/tasks\/([A-Za-z0-9_-]+)(\/stop|\/wait|\/retry|\/ack)?$/.exec(pathname);
      if (match) {
        const id = match[1];
        const action = match[2];
        if (method === "GET" && !action) {
          const task = hub.taskDetail(id);
          if (!task) {
            json(response, 404, { error: `没有任务 ${id}` });
            return;
          }
          json(response, 200, { task });
          return;
        }
        if (method === "POST" && action === "/stop") {
          json(response, 200, { task: hub.stopTask(id) });
          return;
        }
        if (method === "POST" && action === "/retry") {
          json(response, 200, { task: hub.retryTask(id) });
          return;
        }
        if (method === "POST" && action === "/ack") {
          json(response, 200, { task: hub.acknowledgeTask(id) });
          return;
        }
        if (method === "POST" && action === "/wait") {
          const body = await readBody(request);
          const task = await hub.waitTask(id, body.timeoutSeconds);
          json(response, 200, { task });
          return;
        }
      }

      json(response, 404, { error: "没有这个接口" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return {
    server,
    hub,
    store,
    config,
    workerStore,
    templateStore,
    channelStore,
    channelManager,
  };
}

function listen(server, port, host) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

/** 用户永远要知道自己的数据在哪、通道什么状态，所以横幅必须把这些打全。 */
function printBanner(context, { host, port }) {
  const { config, hub, channelManager } = context;
  const version = hub.overview().version;
  const wildcard = host === "0.0.0.0" || host === "::" || host === "";
  const address = wildcard ? `http://127.0.0.1:${port}（本机；已对外开放）` : `http://${host}:${port}`;
  console.log(`CyberForeman（赛博包工头） v${version}`);
  console.log(`地址: ${address}`);
  console.log(`数据目录: ${config.dataDir}`);
  console.log(`配置文件: ${config.configFile}`);
  console.log(`员工配置: ${join(config.dataDir, "workers.json")}（面板改的就是这里）`);
  const channels = channelManager.statusList()
    .map((item) => `${item.label}${describeChannelState(item)}`)
    .join(" · ");
  if (channels) console.log(`通道: ${channels}`);
  if (config.warning) console.log(`⚠ ${config.warning}`);
  console.log("按 Ctrl+C 停止");
}

function describeChannelState(item) {
  if (item.implemented !== true) return `（${item.note || "暂不可用"}）`;
  if (!item.enabled) return "（未启用）";
  if (item.state === "running") return "（已连接）";
  if (item.state === "starting") return "（连接中）";
  if (item.state === "error") return `（出错：${item.lastError || "原因不明"}）`;
  return "（未启动）";
}

function installShutdown(context) {
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("\n正在停止 CyberForeman...");
    // 先停通道（不再收新消息），再停任务。
    try {
      await context.channelManager.stopAll();
    } catch {
      // 停通道失败也要继续停任务。
    }
    try {
      await context.hub.stopAll();
    } catch {
      // 同上。
    }
    context.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return shutdown;
}

/**
 * 启动服务。端口/地址由调用方（bin 或 startFromConfig）算好传进来，
 * 这样 `npx` 场景里"端口被占用自动 +1"的逻辑只写一份。
 */
export async function startServer(config, options = {}) {
  const host = String(options.host || config.host || DEFAULT_HOST);
  const port = options.port === undefined ? config.port : options.port;
  const context = await createHubServer({ ...options, config });
  await listen(context.server, port, host);
  const address = context.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  if (options.banner !== false) printBanner(context, { host, port: actualPort });
  installShutdown(context);
  return { ...context, host, port: actualPort };
}

/** 兼容 `npm start` / `node src/server.mjs`：从配置文件装配并启动。 */
export async function startFromConfig(configFile) {
  const config = loadConfig({ configFile });
  const port = await pickPort(config.port, { host: config.host });
  if (port !== config.port) console.log(`端口 ${config.port} 被占用，改用 ${port}`);
  return startServer(config, { port, host: config.host });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  startFromConfig().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
