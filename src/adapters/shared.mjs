import { spawn } from "node:child_process";

/**
 * 所有 CLI 员工共用的启动与收尾逻辑。
 *
 * 每个适配器只需要提供四样东西：
 *   args       —— 命令行参数
 *   input      —— 通过 stdin 送进去的内容（没有就传空）
 *   parseLine  —— 把一行输出解析成统一状态
 *   finalize   —— 进程结束时给出最终结果
 *
 * 这样新增一种 CLI，只要写一个适配器文件，Hub 和面板都不用动。
 */
export function runStream({ worker, task, hooks, args, input, parseLine, finalize }) {
  const child = spawn(worker.command, args, {
    cwd: task.cwd,
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...(worker.env && typeof worker.env === "object" ? worker.env : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state = {
    sessionId: task.resumeSessionId || null,
    lastAssistant: "",
    finalEvent: null,
    stderrTail: "",
    seenTools: new Set(),
    usage: null,
    costUsd: null,
  };

  let buffer = "";
  let settled = false;

  const progress = (message, type = "progress", data = {}) => {
    if (message) hooks.onProgress?.(message, type, data);
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    hooks.onLog?.("stdout", trimmed);
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // 不是 JSON 的行（例如 CLI 的提示语）只进日志，不打断解析。
      return;
    }
    try {
      parseLine(event, state, { progress, hooks });
    } catch {
      // 单行解析失败不能毁掉整个任务。
    }
  };

  const done = new Promise((resolve, reject) => {
    child.on("spawn", () => progress("进程已启动"));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      state.stderrTail = `${state.stderrTail}${chunk}`.slice(-8000);
      hooks.onLog?.("stderr", chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (buffer.trim()) handleLine(buffer);
      resolve(finalize(state, code));
    });
  });

  child.stdin.on("error", () => {
    // CLI 提前退出时会关闭 stdin，真正的错误从 close / stderr 处理。
  });
  child.stdin.end(input ?? "", "utf8");

  return { child, done };
}

/** 统一的员工指令：三种 CLI 用同一套交代方式，行为才一致。 */
export function buildWorkerPrompt(text, label) {
  return [
    `你是 DSH 通过本地 Agent Hub 派出的 ${label} 员工。`,
    "请独立完成下面的任务，不要等待用户切换窗口或手动确认。",
    "遇到不影响主目标的细节缺失时，采用合理默认值继续；确实无法继续时，在最终回答开头写【需要主控补充】并说明原因。",
    "遇到付费、删除、对外发布等不可逆操作，未获明确授权时不要执行，写进最终汇报。",
    "最终回答请用简洁中文说明：做了什么、产物路径、验证结果、未解决事项。",
    "",
    "任务：",
    String(text),
  ].join("\n");
}

/** 从 stderr 末尾取几行，用作失败原因。 */
export function stderrSummary(state, code) {
  const tail = String(state.stderrTail || "").trim().split(/\r?\n/).filter(Boolean);
  return tail.slice(-4).join("\n") || `进程退出码 ${code}`;
}
