import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const resumeIndex = args.indexOf("--resume");
const resumed = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
const sessionId = resumed || "fake-session-1";
const budgetIndex = args.indexOf("--max-budget-usd");
const budget = budgetIndex >= 0 ? args[budgetIndex + 1] : null;

/** 统一造一份 modelUsage，验证 Hub 会优先读它而不是顶层 usage。 */
function fakeModelUsage(costUSD) {
  return {
    "fake-model": {
      inputTokens: 1200,
      outputTokens: 640,
      cacheReadInputTokens: 48000,
      thinkingTokens: 300,
      costUSD,
      costBasis: "unknown",
    },
  };
}

/** FLAKY 模式用文件计数，模拟“前几次失败、之后成功”，不依赖时间。 */
function bumpCounter(file) {
  const previous = existsSync(file) ? Number(readFileSync(file, "utf8").trim() || 0) : 0;
  const next = previous + 1;
  writeFileSync(file, String(next), "utf8");
  return next;
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

  send({ type: "system", subtype: "init", session_id: sessionId, model: "fake-claude" });

  if (prompt.includes("FAIL_ME")) {
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "模拟失败：任务无法完成",
      session_id: sessionId,
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    setTimeout(() => process.exit(2), 20);
    return;
  }

  if (prompt.includes("FLAKY")) {
    const file = process.env.FAKE_COUNTER_FILE;
    const failTimes = Number(process.env.FAKE_FAIL_TIMES || 1);
    const attempt = file ? bumpCounter(file) : 1;
    if (attempt <= failTimes) {
      send({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: `模拟第 ${attempt} 次尝试失败`,
        session_id: sessionId,
        total_cost_usd: 0,
        usage: { input_tokens: 10, output_tokens: 4 },
      });
      setTimeout(() => process.exit(2), 20);
      return;
    }
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `FLAKY_OK:第 ${attempt} 次尝试成功`,
      session_id: sessionId,
      total_cost_usd: 0.002,
      usage: { input_tokens: 60, output_tokens: 20 },
    });
    setTimeout(() => process.exit(0), 20);
    return;
  }

  if (prompt.includes("BUDGET_ME")) {
    // 模拟真实行为：预算耗尽时 is_error 为 true，但已经产出部分内容。
    send({
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      terminal_reason: "budget_exhausted",
      result: `预算截停前已经写了一半的内容（budget=${budget}）`,
      session_id: sessionId,
      total_cost_usd: 2.5,
      num_turns: 12,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: fakeModelUsage(2.5),
      errors: ["Reached maximum budget ($2)"],
      budget_seen: budget,
    });
    setTimeout(() => process.exit(1), 20);
    return;
  }

  if (prompt.includes("SLOW_ME")) {
    send({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "开始处理慢任务" }] },
      session_id: sessionId,
    });
    setInterval(() => {}, 1000);
    return;
  }

  send({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "准备检查工作区" },
        { type: "tool_use", name: "Read", input: { file_path: "README.md" } },
      ],
    },
    session_id: sessionId,
  });

  setTimeout(() => {
    send({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已完成模拟任务，产物在 docs/result.md。" }],
      },
      session_id: sessionId,
    });
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `RECEIVED:${prompt.includes("第二个任务") ? "第二个任务" : "第一个任务"}\nRESUME:${resumed || "none"}\n已完成模拟任务，产物在 docs/result.md。`,
      session_id: sessionId,
      total_cost_usd: 0.001,
      num_turns: 3,
      usage: { input_tokens: 80, output_tokens: 30 },
      modelUsage: fakeModelUsage(0.001),
    });
    setTimeout(() => process.exit(0), 20);
  }, 40);
});
