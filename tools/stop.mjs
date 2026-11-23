import { existsSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.AGENT_HUB_PORT || 4647);
const DATA_DIR = resolve(process.env.AGENT_HUB_DATA_DIR || join(ROOT, "data"));
const PID_FILE = join(DATA_DIR, "hub.pid");

function isListening(timeoutMs = 400) {
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

async function main() {
  if (!existsSync(PID_FILE)) {
    if (await isListening()) {
      console.log(`未找到 PID 文件（${PID_FILE}），但端口 ${PORT} 仍在监听；请关闭启动它的终端窗口或手动结束 node 进程。`);
      return 1;
    }
    console.log("CyberForeman（赛博包工头）当前未在后台运行。");
    return 0;
  }

  let info = null;
  try {
    info = JSON.parse(readFileSync(PID_FILE, "utf8"));
  } catch {
    info = null;
  }
  const pid = Number(info?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    rmSync(PID_FILE, { force: true });
    console.log("PID 文件已损坏并清理。");
    return 0;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error && error.code === "ESRCH") {
      rmSync(PID_FILE, { force: true });
      console.log(`后台进程（PID ${pid}）已不在运行，已清理 PID 记录。`);
      return 0;
    }
    try {
      process.kill(pid);
    } catch {
      // 忽略二次错误，下面继续检查端口状态
    }
  }

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (!(await isListening(200))) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  rmSync(PID_FILE, { force: true });
  if (await isListening(200)) {
    console.log(`已发送停止信号给 PID ${pid}，但端口 ${PORT} 尚未释放，请稍后再试。`);
    return 1;
  }
  console.log(`已停止 CyberForeman（赛博包工头）后台服务（PID ${pid}）。`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error("停止失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
