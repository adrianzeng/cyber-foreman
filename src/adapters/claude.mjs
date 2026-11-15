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

function buildArgs(worker, task) {
  const args = [
    ...(Array.isArray(worker.argsPrefix) ? worker.argsPrefix : []),
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    worker.permissionMode || "acceptEdits",
    "--permission-prompts",
    "none",
  ];
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

function parseLine(event, state, { progress, hooks }) {
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
  budgetHint: "每轮结束后才检查，超了就停下落进「等你」，所以实际最多会超出一轮的量。建议至少给 1～2。按 Claude 牌价估，不是真实账单。",
  commandHint: "C:\\Users\\你的用户名\\.local\\bin\\claude.exe",
  defaultPermissionMode: "acceptEdits",
  permissionModes: [
    { value: "acceptEdits", label: "接受编辑（推荐）", hint: "能改文件；需要额外授权的命令会被拒绝，不会卡住" },
    { value: "plan", label: "只读规划", hint: "只出方案，不改任何文件" },
    { value: "default", label: "每次询问", hint: "无人值守时会卡在确认上，不建议" },
  ],
  start(worker, task, hooks) {
    return runStream({
      worker,
      task,
      hooks,
      args: buildArgs(worker, task),
      input: buildWorkerPrompt(task.prompt, "Claude"),
      parseLine,
      finalize,
    });
  },
};
