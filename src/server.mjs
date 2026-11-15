import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TaskStore } from "./store.mjs";
import { AgentHub } from "./hub.mjs";
import { WorkerStore } from "./workers-store.mjs";
import { TemplateStore } from "./templates-store.mjs";
import { listAdapters } from "./adapters/index.mjs";
import { isDirectory, listDirectories, listDrives, parentDirectory } from "./fsutil.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "..");
const PUBLIC_ROOT = join(PROJECT_ROOT, "public");
const BODY_LIMIT = 1024 * 1024;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
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

function loopbackHost(header) {
  if (!header) return false;
  try {
    const hostname = new URL(`http://${header}`).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function allowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
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

export function loadConfig(configFile = process.env.AGENT_HUB_CONFIG || join(PROJECT_ROOT, "config", "workers.json")) {
  const file = resolve(configFile);
  let config;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`读取配置失败 ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // workers 只是首次安装的种子；真正在用的员工存在 data/workers.json 里。
  const workers = config.workers && typeof config.workers === "object" ? config.workers : {};
  return {
    configFile: file,
    port: Number(config.port || process.env.AGENT_HUB_PORT || 4647),
    dataDir: resolve(PROJECT_ROOT, config.dataDir || "data"),
    workers,
  };
}

export async function createHubServer(options = {}) {
  const config = options.config || loadConfig(options.configFile);
  mkdirSync(config.dataDir, { recursive: true });
  const store = new TaskStore(config.dataDir).init();
  const workerStore = new WorkerStore({
    file: join(config.dataDir, "workers.json"),
    seed: config.workers || {},
  }).load();
  const templateStore = new TemplateStore(join(config.dataDir, "templates.json")).load();
  const hub = new AgentHub({ store, workers: workerStore.snapshot() });

  const server = createServer(async (request, response) => {
    try {
      if (!loopbackHost(request.headers.host)) {
        json(response, 403, { error: "只接受本机访问" });
        return;
      }
      if (!allowedOrigin(request)) {
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
      if (method === "GET" && ["/app.js", "/styles.css", "/favicon.svg"].includes(pathname)) {
        staticFile(response, pathname.slice(1));
        return;
      }

      if (method === "GET" && pathname === "/api/health") {
        json(response, 200, hub.overview());
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
        // 顺带把“这类员工现成的启动方式”给前端，避免切类型后命令对不上。
        const adapters = listAdapters().map((adapter) => ({
          ...adapter,
          commandTemplate: workerStore.commandTemplateFor(adapter.kind),
        }));
        json(response, 200, { adapters });
        return;
      }
      if (method === "GET" && pathname === "/api/models") {
        // 模型候选全部来自本机已有配置，不内置写死的清单。
        json(response, 200, hub.modelOptions(
          url.searchParams.get("kind"),
          url.searchParams.get("workerId"),
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
        json(response, 200, {
          counts: store.counts(),
          tasks: store.listTasks({
            status: url.searchParams.get("status"),
            stage: url.searchParams.get("stage"),
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

  return { server, hub, store, config, workerStore, templateStore };
}

export async function startFromConfig(configFile) {
  const { server, hub, config } = await createHubServer({ configFile });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(`Agent Hub 已启动: http://127.0.0.1:${port}`);
  console.log(`配置文件: ${config.configFile}`);
  console.log(`员工配置: ${join(config.dataDir, "workers.json")}（面板改的就是这里）`);
  console.log(`数据目录: ${config.dataDir}`);
  console.log("按 Ctrl+C 停止");

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("\n正在停止 Hub...");
    await hub.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { server, hub, config, port };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  startFromConfig().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
