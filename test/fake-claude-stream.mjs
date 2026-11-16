#!/usr/bin/env node
/**
 * 流式输入桩（只给测试用）。
 *
 * 两种模式和真 CLI 对齐：
 *   - 流式（argv 里有 --input-format）：stdin 每行一条 JSON user 消息 → 跑一轮，
 *     不关闭就一直等下一行。这正是"插话"要验证的契约。
 *   - 非流式（侧问、普通任务）：stdin 是纯文本 prompt，读完一次性回答。
 *
 * 几个开关（环境变量，避免污染参数）：
 *   FAKE_ARGS_FILE        把 argv 写进文件，测试用来断言启动参数
 *   FAKE_SESSION_PREFIX   会话 id 前缀（默认用 pid，保证每个进程唯一）
 *   FAKE_TURN_DELAY_MS    每轮延迟，模拟慢任务
 *   FAKE_COST_USD         每轮 total_cost_usd，用于预算告警测试
 *   FAKE_SILENT_FILE      命中 SILENT 时记一行，便于测试确认"确实没回应"
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const streaming = args.includes("--input-format");

if (process.env.FAKE_ARGS_FILE) {
  try {
    writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args), "utf8");
  } catch {
    // 测试用，写不进去也不影响主流程。
  }
}

const resumeIndex = args.indexOf("--resume");
const resumed = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
const prefix = process.env.FAKE_SESSION_PREFIX || "fake-stream";
const sessionId = resumed || `${prefix}-${process.pid}`;
const turnDelayMs = Number(process.env.FAKE_TURN_DELAY_MS || 0);
const cost = Number(process.env.FAKE_COST_USD || 0);

const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function textOf(line) {
  try {
    const event = JSON.parse(line);
    const content = event?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
    }
    return "";
  } catch {
    return line;
  }
}

send({ type: "system", subtype: "init", session_id: sessionId, model: "fake-claude-stream" });

let turn = 0;

function handleTurn(prompt) {
  if (prompt.includes("SILENT")) {
    try {
      appendFileSync(process.env.FAKE_SILENT_FILE || `${sessionId}.log`, `silent ${turn}\n`, "utf8");
    } catch {
      // 只用来给测试观测，写不进去无所谓。
    }
    // 返回 true：这条不回应（流式模式下就是"没新输出"，非流式模式下就是"卡住"）。
    return true;
  }

  turn += 1;
  if (prompt.includes("FAIL_TURN")) {
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "这一轮故意失败",
      session_id: sessionId,
      total_cost_usd: cost,
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    return false;
  }
  send({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: `第 ${turn} 轮已收到` }] },
    session_id: sessionId,
  });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `TURN ${turn}: ${prompt}`,
    session_id: sessionId,
    total_cost_usd: cost || 0.01 * turn,
    num_turns: turn,
    usage: { input_tokens: 10 * turn, output_tokens: 5 * turn },
  });
  return false;
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
const buffered = [];

reader.on("line", (line) => {
  if (streaming) {
    if (!line.trim()) return;
    const prompt = textOf(line);
    if (turnDelayMs > 0) setTimeout(() => handleTurn(prompt), turnDelayMs);
    else handleTurn(prompt);
    return;
  }
  buffered.push(line);
});

reader.on("close", () => {
  let held = false;
  if (!streaming) {
    const prompt = buffered.join("\n");
    if (prompt.trim()) held = handleTurn(prompt);
  }
  if (held) {
    // 模拟"员工卡住不回应"：进程活着但不出结果，交给 Hub 的超时逻辑处理。
    setInterval(() => {}, 1000);
    return;
  }
  // stdin 关闭 → 正常退出。真 CLI 也是这个行为，`done` 契约保持不变。
  setTimeout(() => process.exit(0), 20);
});
