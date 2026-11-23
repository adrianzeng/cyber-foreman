import { runStream, buildWorkerPrompt, stderrSummary } from "./shared.mjs";
import { fromAgy } from "../usage.mjs";

/**
 * Antigravity CLI（agy）适配器。
 *
 * 参数严格对齐 `agy --help`：
 *   -p <prompt>              非交互单轮执行
 *   --output-format stream-json
 *   --mode <accept-edits|auto|plan>
 *   --model <model>
 *   --effort <low|medium|high|xhigh|max>
 *   --conversation <id>
 *   --add-dir <dir>
 *
 * 绝不静默追加 `--dangerously-skip-permissions`；默认保持 `accept-edits`。
 */

/** agy 的模式名用连字符（accept-edits），配置里可能写驼峰，这里做一次兼容。 */
export function normalizeMode(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "plan" || text === "read-only" || text === "readonly") return "plan";
  if (text === "auto" || text === "bypasspermissions") return "auto";
  if (text === "accept-edits" || text === "acceptedits" || text === "accept_edits") return "accept-edits";
  return "accept-edits";
}

const AGY_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function buildArgs(worker, task) {
  // 侧问一律只读（plan），避免修改项目文件；其余按员工权限配置。
  const mode = task.readOnly === true ? "plan" : normalizeMode(worker.permissionMode);
  // 注意：agy 的 -p 需要紧跟任务内容（不像 Claude 的 -p 是开关、内容走 stdin）。
  const args = [
    ...(Array.isArray(worker.argsPrefix) ? worker.argsPrefix : []),
    "-p",
    buildWorkerPrompt(task.prompt, "Antigravity"),
    "--output-format",
    "stream-json",
    "--mode",
    mode,
  ];
  // Windows 宿主机无 agy 终端沙箱，单传 --mode auto 会被 agy 静默退回 request-review。
  // 因此仅在用户显式把该员工权限设为 auto（且非只读侧问）时附加 --dangerously-skip-permissions；
  // 默认 accept-edits 与 plan 绝不传此参数。
  if (mode === "auto" && task.readOnly !== true) {
    args.push("--dangerously-skip-permissions");
  }
  const model = String(task.requestedModel || worker.model || "").trim();
  if (model) {
    args.push("--model", model);
  }
  const effort = String(task.requestedEffort || worker.effort || "").trim().toLowerCase();
  if (effort && AGY_EFFORTS.has(effort)) {
    args.push("--effort", effort);
  }
  if (!task.newSession && task.resumeSessionId) {
    args.push("--conversation", task.resumeSessionId);
  }
  for (const directory of Array.isArray(worker.addDirs) ? worker.addDirs : []) {
    if (directory) args.push("--add-dir", directory);
  }
  return args;
}

function recordSession(state, hooks, conversationId) {
  if (!conversationId || conversationId === state.sessionId) return;
  state.sessionId = conversationId;
  hooks.onSession?.(state.sessionId);
}

export function parseLine(event, state, { progress, hooks }) {
  if (!event || typeof event !== "object") return;

  if (event.conversation_id) {
    recordSession(state, hooks, event.conversation_id);
  }

  if (event.event === "init") {
    recordSession(state, hooks, event.conversation_id || event.init?.conversation_id);
    progress("Antigravity 会话已建立");
    return;
  }

  if (event.event === "step_update" && event.step_update) {
    const step = event.step_update;
    recordSession(state, hooks, step.conversation_id);

    if (step.step_type === "tool") {
      const toolName = String(step.tool_name || step.tool_info?.name || "").trim();
      if (step.state === "ACTIVE" && toolName && !state.seenTools.has(toolName)) {
        state.seenTools.add(toolName);
        progress(`调用工具：${toolName}`);
      }
      if (step.state === "ERROR") {
        const message = String(step.tool_info?.error?.message || "工具执行失败").split(/\r?\n/)[0];
        if (!Array.isArray(state.toolErrors)) state.toolErrors = [];
        state.toolErrors.push({ tool: toolName || "tool", message });
        progress(`工具受限或失败（${toolName || "tool"}）：${message.slice(0, 120)}`, "warn");
      }
      return;
    }

    if (step.step_type === "agent_response") {
      const text = String(step.text || step.response || step.content || "").trim();
      if (text) state.lastAssistant = text;
      if (step.usage) state.usage = fromAgy(step.usage, step.num_turns ?? null);
      return;
    }
    return;
  }

  if (event.event === "result" && event.result) {
    const result = event.result;
    state.finalEvent = result;
    recordSession(state, hooks, result.conversation_id);

    if (result.response) state.lastAssistant = String(result.response);
    if (result.usage) state.usage = fromAgy(result.usage, result.num_turns ?? null);
    if (Array.isArray(result.denied_actions) && result.denied_actions.length) {
      state.deniedActions = result.denied_actions;
    }
    if (result.status === "ERROR") {
      progress("Antigravity 报告本轮失败", "error", { error: result.error || "未知错误" });
    }
    return;
  }

  // 兜底兼容其它带 tool 字样的事件名。
  if (typeof event.event === "string" && event.event !== "result") {
    const label = String(event.event);
    if (label.includes("tool")) {
      progress(`调用工具：${event.tool || event.name || label}`);
    }
  }
}

export function finalize(state, code) {
  const failed = state.finalEvent?.status === "ERROR";
  const result = String(state.finalEvent?.response || state.lastAssistant || "").trim();
  const denied = Array.isArray(state.finalEvent?.denied_actions)
    ? state.finalEvent.denied_actions
    : Array.isArray(state.deniedActions)
      ? state.deniedActions
      : [];
  const headlessDenied = !result && (
    denied.length > 0 || /no output produced.*permission|cannot prompt for/i.test(String(state.stderrTail || ""))
  );
  const isError = failed || code !== 0 || headlessDenied;

  let error = null;
  if (failed) {
    error = String(state.finalEvent?.error || "Antigravity 返回失败");
  } else if (code !== 0) {
    error = stderrSummary(state, code);
  } else if (headlessDenied) {
    const names = denied
      .map((item) => item?.display_name || item?.action)
      .filter(Boolean)
      .join("、");
    const detail = names ? `（被拒权限：${names}）` : "";
    error = `Antigravity 在无头模式下被权限策略拦截${detail}，未产出回复。Windows 宿主机无终端沙箱，accept-edits 默认拦截命令执行；若信任该工作区，可在员工设置里将权限改为「自动（放开审批）」，或在 Antigravity 的 settings.json 里配置 permissions.allow 后重试。`;
  }

  return {
    sessionId: state.sessionId,
    result,
    isError,
    // 无头权限拦截是确定性策略拒绝，自动重试 3 次只会浪费 token 和时间。
    ...(headlessDenied ? { retryable: false } : {}),
    error,
    exitCode: code,
    usage: state.usage,
    costUsd: null,
  };
}

export default {
  kind: "agy-cli",
  label: "Antigravity",
  binLabel: "Antigravity CLI",
  transport: "stream-json",
  supportsResume: true,
  supportsExtraDirs: true,
  /** 同 Codex：`-p <内容>` 是位置参数，一次性执行，没有持续输入入口。 */
  supportsSteer: false,
  steerHint: "Antigravity 把任务当成 -p 的参数一次性执行，中途插不进话。想追加要求请用侧问（只读答疑），或 /停 后重新派。",
  defaultCommand: "agy",
  commandHint: "agy（或绝对路径 C:\\Users\\你的用户名\\AppData\\Local\\agy\\bin\\agy.exe）",
  defaultPermissionMode: "accept-edits",
  permissionModes: [
    { value: "accept-edits", label: "接受编辑（默认）", hint: "允许读写文件；无头模式下命令执行会被拦截" },
    { value: "plan", label: "只读规划", hint: "只出方案，不改文件" },
    { value: "auto", label: "自动（放开审批）", hint: "显式启用 --dangerously-skip-permissions，Windows 无头模式下允许执行命令，仅用于可信项目" },
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
