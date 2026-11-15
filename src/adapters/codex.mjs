import { runStream, buildWorkerPrompt, stderrSummary } from "./shared.mjs";
import { fromCodex } from "../usage.mjs";

/** Codex 用沙箱等级表达权限，这里把配置里的模式映射过去。 */
function normalizeSandbox(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "read-only" || text === "readonly") return "read-only";
  if (text === "danger-full-access" || text === "full" || text === "bypasspermissions") return "danger-full-access";
  return "workspace-write";
}

function buildArgs(worker, task) {
  const sandbox = normalizeSandbox(worker.permissionMode);
  const common = [
    "--json",
    "--skip-git-repo-check",
    "-C",
    task.cwd,
  ];
  // codex 不允许 --sandbox 与 --approve-for-me 同时出现：
  // --approve-for-me 本身就是「workspace-write + 自动审批」，所以要二选一。
  if (sandbox === "workspace-write" && worker.autoApprove !== false) {
    common.push("--approve-for-me");
  } else {
    common.push("-s", sandbox);
  }
  if (task.requestedModel || worker.model) {
    common.push("-m", task.requestedModel || worker.model);
  }
  for (const directory of Array.isArray(worker.addDirs) ? worker.addDirs : []) {
    common.push("--add-dir", directory);
  }

  const prompt = buildWorkerPrompt(task.prompt, "Codex");
  const resumeId = task.newSession ? null : task.resumeSessionId;

  // codex 把 prompt 作为位置参数；resume 时 session id 在前、prompt 在后。
  const args = resumeId
    ? [...(Array.isArray(worker.argsPrefix) ? worker.argsPrefix : []), "exec", "resume", ...common, resumeId, prompt]
    : [...(Array.isArray(worker.argsPrefix) ? worker.argsPrefix : []), "exec", ...common, prompt];

  return args;
}

function parseLine(event, state, { progress, hooks }) {
  if (event.type === "thread.started" && event.thread_id) {
    state.sessionId = event.thread_id;
    hooks.onSession?.(state.sessionId);
    progress("Codex 会话已建立");
    return;
  }

  if (event.type === "turn.started") {
    progress("Codex 开始处理");
    return;
  }

  if (event.type === "item.completed" && event.item) {
    const item = event.item;
    if (item.type === "agent_message") {
      const text = String(item.text || "").trim();
      if (text) state.lastAssistant = text;
      return;
    }
    if (item.type === "command_execution") {
      const command = String(item.command || item.name || "shell").split(/\r?\n/)[0].slice(0, 60);
      progress(`执行命令：${command}`);
      return;
    }
    if (item.type === "file_change") {
      progress("修改了文件");
      return;
    }
    return;
  }

  if (event.type === "turn.completed") {
    state.finalEvent = event;
    if (event.usage) state.usage = event.usage;
    return;
  }

  if (event.type === "turn.failed" || event.type === "error") {
    state.failure = String(event.error?.message || event.message || "Codex 报告失败");
    progress("Codex 报告本轮失败", "error", { error: state.failure });
  }
}

function finalize(state, code) {
  const isError = Boolean(state.failure) || code !== 0;
  const result = String(state.lastAssistant || "").trim();
  return {
    sessionId: state.sessionId,
    result,
    isError,
    error: isError ? state.failure || stderrSummary(state, code) : null,
    exitCode: code,
    usage: fromCodex(state.usage),
  };
}

export default {
  kind: "codex-cli",
  label: "Codex",
  binLabel: "Codex CLI",
  transport: "jsonl",
  supportsResume: true,
  supportsExtraDirs: true,
  commandHint: "node",
  defaultPermissionMode: "workspace-write",
  permissionModes: [
    { value: "workspace-write", label: "只改项目目录（推荐）", hint: "能写工作区，出不去；配合自动审批可无人值守" },
    { value: "read-only", label: "只读", hint: "只看不改，适合让它审查代码" },
    { value: "danger-full-access", label: "全盘权限（危险）", hint: "能改电脑上任何文件，只在你完全信任任务时用" },
  ],
  start(worker, task, hooks) {
    return runStream({
      worker,
      task,
      hooks,
      args: buildArgs(worker, task),
      // prompt 已经在命令行参数里，stdin 立刻关掉，否则 codex 会一直等输入。
      input: "",
      parseLine,
      finalize,
    });
  },
};
