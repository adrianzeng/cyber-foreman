import { runStream, buildWorkerPrompt, stderrSummary } from "./shared.mjs";
import { fromClaude } from "../usage.mjs";

function assistantText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function assistantTools(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block && block.type === "tool_use" && typeof block.name === "string")
    .map((block) => block.name);
}

function buildArgs(worker, task, streaming) {
  const args = [
    ...(Array.isArray(worker.argsPrefix) ? worker.argsPrefix : []),
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    // 侧问一律只读：只答疑，不改文件，这样"不打断主任务"才有实际保证。
    task.readOnly === true ? "plan" : worker.permissionMode || "acceptEdits",
    "--permission-prompts",
    "none",
  ];
  // 双向流式输入：stdin 保持打开，逐行写 user 消息就能触发新一轮。
  if (streaming) {
    args.push("--input-format", "stream-json");
  }
  if (task.requestedModel || worker.model) {
    args.push("--model", task.requestedModel || worker.model);
  }
  if (task.requestedEffort || worker.effort) {
    args.push("--effort", task.requestedEffort || worker.effort);
  }
  if (!task.newSession && task.resumeSessionId) {
    args.push("--resume", task.resumeSessionId);
  }
  for (const directory of Array.isArray(worker.addDirs) ? worker.addDirs : []) {
    args.push("--add-dir", directory);
  }
  // 单任务花费上限。按 Claude 牌价算，不是真实账单，作用是给长任务踩刹车。
  const budget = Number(task.maxBudgetUsd ?? worker.maxBudgetUsd ?? 0);
  if (Number.isFinite(budget) && budget > 0) {
    args.push("--max-budget-usd", String(budget));
  }
  return args;
}

/** stream-json 模式下 stdin 只认 JSON 行，首条 prompt 也要包成 user 消息。 */
export function claudeUserLine(text) {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: String(text ?? "") }],
    },
  });
}

function parseLine(event, state, context) {
  const { progress, hooks, turnEnd } = context;
  if (event.session_id && event.session_id !== state.sessionId) {
    state.sessionId = event.session_id;
    hooks.onSession?.(state.sessionId);
  }

  if (event.type === "system" && event.subtype === "init") {
    progress("Claude 会话已建立");
    return;
  }

  if (event.type === "assistant") {
    const text = assistantText(event.message);
    if (text) state.lastAssistant = text;
    for (const tool of assistantTools(event.message)) {
      if (state.seenTools.has(tool)) continue;
      state.seenTools.add(tool);
      progress(`调用工具：${tool}`);
    }
    return;
  }

  if (event.type === "result") {
    state.finalEvent = event;
    if (event.result) state.lastAssistant = String(event.result);
    if (event.is_error) {
      progress("Claude 报告本轮失败", "error", { error: event.result || event.subtype });
    }
    // 这一轮结束了：流式模式下开始空闲收口计时，3 秒没人插话就关 stdin。
    turnEnd?.();
  }
}

function finalize(state, code) {
  const finalEvent = state.finalEvent;
  const usage = fromClaude(finalEvent);
  const budgetExhausted = finalEvent?.terminal_reason === "budget_exhausted"
    || finalEvent?.subtype === "error_max_budget_usd";
  const result = String(finalEvent?.result || state.lastAssistant || "").trim();
  // 预算截停时 CLI 会把 is_error 设成 true，但内容可能已经写完，
  // 所以这一条单独标出来，交给上层决定算完成还是算失败。
  const isError = Boolean(finalEvent?.is_error) || code !== 0;

  if (isError && !result && !budgetExhausted) {
    return {
      sessionId: state.sessionId,
      result: "",
      isError: true,
      error: stderrSummary(state, code),
      exitCode: code,
      usage,
    };
  }
  return {
    sessionId: state.sessionId,
    result,
    isError,
    budgetExhausted,
    error: isError && !budgetExhausted
      ? String(finalEvent?.result || finalEvent?.subtype || `退出码 ${code}`)
      : null,
    exitCode: code,
    usage,
  };
}

export default {
  kind: "claude-cli",
  label: "Claude",
  binLabel: "Claude CLI",
  transport: "stream-json",
  supportsResume: true,
  supportsExtraDirs: true,
  supportsBudget: true,
  /** Claude 是唯一能插话的类型：-p 是开关、prompt 走 stdin，加 --input-format 后可继续写。 */
  supportsSteer: true,
  steerHint: "Claude 支持插话：在员工设置里打开「允许插话」后，任务在跑时可以直接追加要求。",
  budgetHint: "每轮结束后才检查，超了就停下落进「等你」，所以实际最多会超出一轮的量。建议至少给 1～2。按 Claude 牌价估，不是真实账单。",
  commandHint: "C:\\Users\\你的用户名\\.local\\bin\\claude.exe",
  defaultPermissionMode: "acceptEdits",
  permissionModes: [
    { value: "acceptEdits", label: "接受编辑（推荐）", hint: "能改文件；需要额外授权的命令会被拒绝，不会卡住" },
    { value: "plan", label: "只读规划", hint: "只出方案，不改任何文件" },
    { value: "default", label: "每次询问", hint: "无人值守时会卡在确认上，不建议" },
  ],
  start(worker, task, hooks) {
    // 侧问任务永远走"写一次就关"的老路径：它是只读短任务，不需要中途插话。
    const streaming = worker.streamInput === true && task.readOnly !== true;
    const launched = runStream({
      worker,
      task,
      hooks,
      args: buildArgs(worker, task, streaming),
      input: buildWorkerPrompt(task.prompt, "Claude"),
      parseLine,
      finalize,
      streamInput: streaming,
      formatInput: claudeUserLine,
      // 让 Hub 知道"又跑完一轮了"，它用这个判断插话后有没有新输出。
      onTurnEnd: () => hooks.onTurnEnd?.(),
    });
    if (!streaming) return launched;
    return { ...launched, usage: () => fromClaude(launched.latestResult()) };
  },
};
