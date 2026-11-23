import { runStream, buildWorkerPrompt, stderrSummary } from "./shared.mjs";
import { fromAgy } from "../usage.mjs";

/**
 * Doubao CLI（doubao-cli）适配器。
 *
 * 合规边界：仅通过本机子进程调用已安装的 doubao 可执行文件，限定工作目录 cwd，
 * 不读取、不转发任何账号凭证。
 * 支持 stream-json 与纯文本输出兜底。
 */

export function normalizeMode(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "plan" || text === "read-only" || text === "readonly") return "plan";
  if (text === "auto" || text === "bypasspermissions") return "auto";
  return "accept-edits";
}

export function buildArgs(worker, task) {
  const mode = task.readOnly === true ? "plan" : normalizeMode(worker.permissionMode);
  const args = [
    ...(Array.isArray(worker.argsPrefix) ? worker.argsPrefix : []),
    "-p",
    buildWorkerPrompt(task.prompt, "Doubao"),
    "--output-format",
    "stream-json",
    "--mode",
    mode,
  ];
  const model = String(task.requestedModel || worker.model || "").trim();
  if (model) {
    args.push("--model", model);
  }
  if (!task.newSession && task.resumeSessionId) {
    args.push("--resume", task.resumeSessionId);
  }
  for (const directory of Array.isArray(worker.addDirs) ? worker.addDirs : []) {
    if (directory) args.push("--add-dir", directory);
  }
  return args;
}

function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function parseLine(event, state, { progress, hooks }) {
  if (!event || typeof event !== "object") return;

  const sessionId = event.session_id || event.sessionId || event.conversation_id || event.result?.session_id;
  if (sessionId && sessionId !== state.sessionId) {
    state.sessionId = String(sessionId);
    hooks.onSession?.(state.sessionId);
  }

  if (event.type === "system" || event.event === "init") {
    progress("Doubao 会话已建立");
    return;
  }

  if (event.type === "tool_use" || event.type === "tool_call") {
    const tool = String(event.name || event.tool || "tool");
    if (!state.seenTools.has(tool)) {
      state.seenTools.add(tool);
      progress(`调用工具：${tool}`);
    }
    return;
  }

  if (event.type === "assistant" || event.role === "assistant") {
    const text = extractText(event.message?.content ?? event.content ?? event.text);
    if (text) state.lastAssistant = text;
    return;
  }

  if (event.type === "result" || event.event === "result") {
    const payload = event.result && typeof event.result === "object" ? event.result : event;
    state.finalEvent = payload;
    const text = extractText(payload.response ?? payload.result ?? payload.text ?? payload.content);
    if (text) state.lastAssistant = text;
    if (payload.usage) state.usage = fromAgy(payload.usage, payload.num_turns ?? null);
    if (payload.is_error || payload.status === "ERROR") {
      progress("Doubao 报告本轮失败", "error", { error: payload.error || payload.result || "未知错误" });
    }
    return;
  }

  if (event.type === "error") {
    state.failure = String(event.error?.message || event.message || event.error || "Doubao 报告失败");
    progress("Doubao 报告本轮失败", "error", { error: state.failure });
  }
}

export function onPlainLine(line, state) {
  if (!Array.isArray(state.plainLines)) state.plainLines = [];
  state.plainLines.push(line);
}

export function finalize(state, code) {
  const failed = Boolean(state.failure)
    || Boolean(state.finalEvent?.is_error)
    || state.finalEvent?.status === "ERROR";
  const isError = failed || code !== 0;
  const plain = Array.isArray(state.plainLines) ? state.plainLines.join("\n").trim() : "";
  const result = String(state.lastAssistant || plain || "").trim();
  const error = isError
    ? String(state.failure || state.finalEvent?.error || stderrSummary(state, code))
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
  kind: "doubao-cli",
  label: "Doubao",
  binLabel: "Doubao CLI",
  transport: "stream-json",
  supportsResume: true,
  supportsExtraDirs: true,
  supportsSteer: false,
  steerHint: "Doubao CLI 以一次性参数方式执行，不支持中途插话；想追问请用侧问，或停止后重新派发。",
  defaultCommand: "doubao",
  commandHint: "doubao（或绝对路径 C:\\Users\\你的用户名\\AppData\\Local\\doubao\\bin\\doubao.exe）",
  defaultPermissionMode: "accept-edits",
  permissionModes: [
    { value: "accept-edits", label: "接受编辑（默认）", hint: "允许编辑当前工作区文件" },
    { value: "plan", label: "只读规划", hint: "只做分析与方案，不改文件" },
    { value: "auto", label: "自动审批", hint: "自动放行工具调用，适合无人值守" },
  ],
  start(worker, task, hooks) {
    return runStream({
      worker,
      task,
      hooks,
      args: buildArgs(worker, task),
      input: "",
      parseLine,
      onPlainLine,
      finalize,
    });
  },
};
