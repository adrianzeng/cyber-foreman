import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.AGENT_HUB_PORT || 4647);
const PANEL = `http://127.0.0.1:${PORT}`;
const RULE = "-".repeat(42);

function isListening(timeoutMs = 800) {
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

async function main() {
  if (await isListening()) {
    console.log("");
    console.log("  Agent Hub 已经在运行了，不重复启动。");
    console.log(`  正在打开面板：${PANEL}`);
    console.log("");
    openBrowser(PANEL);
    return 0;
  }

  console.log("");
  console.log(`  ${RULE}`);
  console.log("     DSH Agent Hub");
  console.log(`     面板地址：${PANEL}`);
  console.log(`  ${RULE}`);
  console.log("");
  console.log("  正在启动，浏览器会在几秒后自动打开。");
  console.log("");
  console.log("  [重要] 这个窗口不要关。");
  console.log("         关掉窗口就是停止服务，手机上就派不了活。");
  console.log("");
  console.log(`  ${RULE}`);
  console.log("");

  // 走 0.7.0 的正式入口：参数、数据目录、端口、通道开关都由 config.mjs 统一解析，
  // 和 `npx dsh-agent-hub` 是同一个启动路径，别再直连 src/server.mjs。
  const child = spawn(process.execPath, [join(ROOT, "bin", "dsh-agent-hub.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  // 等端口真的通了再开浏览器，避免打开一个「无法访问」的页面。
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
    try { child.kill(); } catch { /* 已经退出了 */ }
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
  console.log("");
  console.log(`  ${RULE}`);
  console.log("  服务已停止。");
  console.log("");
  return code;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error("  启动失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
