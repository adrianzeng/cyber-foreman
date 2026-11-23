import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.AGENT_HUB_PORT || 4647);
const PANEL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = resolve(process.env.AGENT_HUB_DATA_DIR || join(ROOT, "data"));
const PID_FILE = join(DATA_DIR, "hub.pid");
const LOG_FILE = join(DATA_DIR, "hub-daemon.log");
const RULE = "-".repeat(46);

function isListening(timeoutMs = 500) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port: PORT });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function isHealthy() {
  try {
    const res = await fetch(`${PANEL}/api/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const command = process.platform === "win32"
    ? "explorer"
    : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(command, [url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // 打不开浏览器不算失败，地址已经打印在窗口里了。
  }
}

function tailLog(file, maxLines = 20) {
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

async function runForeground() {
  const child = spawn(process.execPath, [join(ROOT, "bin", "cyber-foreman.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  let opened = false;
  const timer = setInterval(async () => {
    if (opened) return;
    if (await isListening(300)) {
      opened = true;
      clearInterval(timer);
      openBrowser(PANEL);
    }
  }, 400);

  const forward = () => {
    try { child.kill(); } catch { /* 已退出 */ }
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  const code = await new Promise((done) => {
    child.once("exit", (value) => done(value ?? 0));
    child.once("error", (error) => {
      console.error("  启动失败：", error instanceof Error ? error.message : error);
      done(1);
    });
  });

  clearInterval(timer);
  return code;
}

async function runDetached() {
  mkdirSync(DATA_DIR, { recursive: true });
  const header = `\n===== CyberForeman daemon start ${new Date().toISOString()} =====\n`;
  writeFileSync(LOG_FILE, header, { flag: "a", encoding: "utf8" });

  const logFd = openSync(LOG_FILE, "a");
  let child;
  try {
    child = spawn(process.execPath, [join(ROOT, "bin", "cyber-foreman.mjs")], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
  } finally {
    closeSync(logFd);
  }

  let earlyExit = null;
  child.once("exit", (code) => { earlyExit = code ?? 1; });
  child.unref();

  writeFileSync(
    PID_FILE,
    JSON.stringify({ pid: child.pid, port: PORT, startedAt: new Date().toISOString(), logFile: LOG_FILE }, null, 2),
    "utf8",
  );

  // 等待端口与 /api/health 真正就绪（最长 15 秒）
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (earlyExit !== null) break;
    if (await isHealthy()) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!ready) {
    console.error("  启动失败：15 秒内未检测到 CyberForeman 服务就绪。");
    const detail = tailLog(LOG_FILE, 20);
    if (detail) {
      console.error("  最近日志：\n" + detail);
    }
    return 1;
  }

  console.log("");
  console.log(`  ${RULE}`);
  console.log("     CyberForeman · 赛博包工头（后台常驻）");
  console.log(`     面板地址：${PANEL}`);
  console.log(`     后台 PID：${child.pid}`);
  console.log(`     日志文件：${LOG_FILE}`);
  console.log(`  ${RULE}`);
  console.log("");
  console.log("  已切换为静默后台常驻，本窗口关闭不会中断服务。");
  console.log("  如需停止服务，请双击根目录的 stop-hub.bat（或运行 npm run stop）。");
  console.log("");

  if (!process.argv.includes("--no-open")) {
    openBrowser(PANEL);
  }
  return 0;
}

async function main() {
  if (await isListening()) {
    console.log("");
    console.log("  CyberForeman（赛博包工头）已经在后台运行，不重复启动。");
    console.log(`  正在打开面板：${PANEL}`);
    console.log("");
    if (!process.argv.includes("--no-open")) {
      openBrowser(PANEL);
    }
    return 0;
  }

  if (process.argv.includes("--foreground")) {
    return runForeground();
  }
  return runDetached();
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error("  启动失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
