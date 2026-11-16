import { spawn } from "node:child_process";

/**
 * 所有 CLI 员工共用的启动与收尾逻辑。
 *
 * 每个适配器只需要提供五样东西：
 *   args        —— 命令行参数
 *   input       —— 通过 stdin 送进去的内容（没有就传空）
 *   parseLine   —— 把一行输出解析成统一状态
 *   finalize    —— 进程结束时给出最终结果
 *   可选 streamInput + formatInput —— 打开双向流式输入（插话的前提）
 *
 * 铁律：`streamInput` 默认 **false**，此时行为与 0.6.0 逐字节一致
 * （写完 input 立刻 end，返回值里没有 steer）——
 * 现有 46 项测试就靠这条当回归闸门。
 */

const STDIN_CLOSED = "员工进程已经结束，插话没送进去";
const DEFAULT_IDLE_MS = 3000;
const MIN_IDLE_MS = 500;
const MAX_IDLE_MS = 60_000;

function clampIdle(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_IDLE_MS;
  return Math.min(Math.max(Math.trunc(number), MIN_IDLE_MS), MAX_IDLE_MS);
}

export function runStream(options) {
  const {
    worker,
    task,
    hooks,
    args,
    input,
    parseLine,
    finalize,
    streamInput = false,
    formatInput = (text) => String(text),
    onTurnEnd,
  } = options;

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
  let idleTimer = null;
  let writeChain = Promise.resolve();

  const idleMs = clampIdle(worker.steerIdleMs);

  const progress = (message, type = "progress", data = {}) => {
    if (message) hooks.onProgress?.(message, type, data);
  };

  /** 串行写：两条插话同时写会把 JSONL 写坏，员工直接解析失败。 */
  const enqueue = (job) => {
    const run = writeChain.then(job, job);
    writeChain = run.then(() => {}, () => {});
    return run;
  };

  const closeInput = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (child.stdin.destroyed || child.stdin.writableEnded) return;
    try {
      child.stdin.end();
    } catch {
      // 进程可能刚退出，忽略。
    }
  };

  /** 每轮结束（result 事件）后开一个空闲收口计时器：3 秒没人再插话就关 stdin 让进程正常退出。 */
  const armIdleClose = () => {
    if (!streamInput) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(closeInput, idleMs);
    idleTimer.unref?.();
  };

  const writeLine = (text) => enqueue(() => new Promise((resolve, reject) => {
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      reject(new Error(STDIN_CLOSED));
      return;
    }
    const line = String(text ?? "");
    child.stdin.write(line.endsWith("\n") ? line : `${line}\n`, "utf8", (error) => {
      if (error) reject(new Error(STDIN_CLOSED));
      else resolve();
    });
  }));

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
      parseLine(event, state, {
        progress,
        hooks,
        // 适配器在 result 事件里调它：这一轮结束了，可以开始空闲收口计时。
        turnEnd: () => {
          armIdleClose();
          onTurnEnd?.(state);
        },
      });
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
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (buffer.trim()) handleLine(buffer);
      resolve(finalize(state, code));
    });
  });

  child.stdin.on("error", () => {
    // CLI 提前退出时会关闭 stdin，真正的错误从 close / stderr 处理。
  });

  if (streamInput) {
    // 首条 prompt 也要转成 JSONL：stream-json 模式下 stdin 只认 JSON 行。
    writeLine(formatInput(input ?? "")).catch(() => {
      // 首条写失败会在后续 close/stderr 里体现，这里不额外炸。
    });
  } else {
    child.stdin.end(input ?? "", "utf8");
  }

  if (!streamInput) return { child, done };

  return {
    child,
    done,
    /**
     * 插话入口。返回 {ok} 而不是抛错：Hub 要把它翻译成错误码 + 中文原因，
     * 抛错会在 hook 边界上丢失上下文。
     */
    async steer(text) {
      const body = String(text ?? "").trim();
      if (!body) return { ok: false, error: "插话内容不能为空" };
      // 用户又要说话了：先取消空闲收口，否则可能刚好把 stdin 关掉。
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      try {
        await writeLine(formatInput(body));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : STDIN_CLOSED };
      }
    },
    /** 给预算告警用：当前（最近一轮）结果事件，里面带 cost/turns。 */
    latestResult: () => state.finalEvent,
    closeInput,
  };
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
