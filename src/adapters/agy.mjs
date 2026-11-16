import { runStream, buildWorkerPrompt, stderrSummary } from "./shared.mjs";

/** agy 的模式名用连字符（accept-edits），配置里可能写驼峰，这里做一次兼容。 */
function normalizeMode(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "plan") return "plan";
  if (text === "auto" || text === "bypasspermissions") return "auto";
  if (text === "accept-edits" || text === "acceptedits" || text === "accept_edits") return "accept-edits";
  return "accept-edits";
}

function buildArgs(worker, task) {
  // 注意：agy 的 -p 需要紧跟任务内容（不像 Claude 的 -p 是开关、内容走 stdin）。
  const args = [
    ...(Array.isArray(worker.argsPrefix) ? worker.argsPrefix : []),
    "-p",
    buildWorkerPrompt(task.prompt, "反重力（Antigravity）"),
    "--output-format",
    "stream-json",
    "--mode",
    normalizeMode(worker.permissionMode),
  ];
  if (task.requestedModel || worker.model) {
    args.push("--model", task.requestedModel || worker.model);
  }
  if (task.requestedEffort || worker.effort) {
    args.push("--effort", task.requestedEffort || worker.effort);
  }
  if (!task.newSession && task.resumeSessionId) {
    args.push("--conversation", task.resumeSessionId);
  }
  for (const directory of Array.isArray(worker.addDirs) ? worker.addDirs : []) {
    args.push("--add-dir", directory);
  }
  return args;
}

function parseLine(event, state, { progress, hooks }) {
  if (event.event === "result" && event.result) {
    const result = event.result;
    state.finalEvent = result;

    if (result.conversation_id && result.conversation_id !== state.sessionId) {
      state.sessionId = result.conversation_id;
      hooks.onSession?.(state.sessionId);
    }
    if (result.response) state.lastAssistant = String(result.response);
    if (result.usage) state.usage = result.usage;
    if (result.status === "ERROR") {
      progress("agy 报告本轮失败", "error", { error: result.error || "未知错误" });
    }
    return;
  }

  // agy 的中间事件没有公开文档，这里只做宽松处理：能认出的就当进度。
  if (typeof event.event === "string" && event.event !== "result") {
    const label = String(event.event);
    if (label.includes("tool")) {
      progress(`调用工具：${event.tool || event.name || label}`);
    }
  }
}

function finalize(state, code) {
  const failed = state.finalEvent?.status === "ERROR";
  const isError = failed || code !== 0;
  const result = String(state.finalEvent?.response || state.lastAssistant || "").trim();
  const error = failed
    ? String(state.finalEvent?.error || "agy 返回失败")
    : code !== 0
      ? stderrSummary(state, code)
      : null;
  return {
    sessionId: state.sessionId,
    result,
    isError,
    error,
    exitCode: code,
    usage: state.usage,
    costUsd: null,
  };
}

export default {
  kind: "agy-cli",
  label: "反重力",
  binLabel: "Antigravity CLI",
  transport: "stream-json",
  supportsResume: true,
  supportsExtraDirs: true,
  /** 同 Codex：`-p <内容>` 是位置参数，一次性执行，没有持续输入入口。 */
  supportsSteer: false,
  steerHint: "反重力把任务当成 -p 的参数一次性执行，中途插不进话。想追加要求请用侧问（只读答疑），或 /停 后重新派。",
  commandHint: "C:\\Users\\你的用户名\\AppData\\Local\\agy\\bin\\agy.exe",
  defaultPermissionMode: "accept-edits",
  permissionModes: [
    { value: "accept-edits", label: "接受编辑（默认）", hint: "能改文件，需要额外授权时会被拒绝" },
    { value: "plan", label: "只读规划", hint: "只出方案，不改文件" },
    { value: "auto", label: "自动（放开审批）", hint: "不再询问，风险自负" },
  ],
  start(worker, task, hooks) {
    return runStream({
      worker,
      task,
      hooks,
      args: buildArgs(worker, task),
      // 任务内容已经在 -p 后面，stdin 立刻关掉。
      input: "",
      parseLine,
      finalize,
    });
  },
};
