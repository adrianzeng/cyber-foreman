import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

export const DEFAULT_HUB_URL = "http://127.0.0.1:4647";
const MAX_RESULT_CHARS = 12_000;
const SUMMARY_CHARS = 600;

/** 解析本地服务地址：显式入参 > CYBER_FOREMAN_URL > DSH_HUB_URL > 默认 127.0.0.1:4647。 */
export function resolveHubUrl(value) {
  const raw = String(value || process.env.CYBER_FOREMAN_URL || process.env.DSH_HUB_URL || DEFAULT_HUB_URL).trim();
  return (raw || DEFAULT_HUB_URL).replace(/\/+$/, "");
}

function truncateText(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}…`, truncated: true };
}

/** 构造与 Hub 通信的极简 HTTP 转发客户端（不保存队列或状态机，不接触账号凭证）。 */
export function createHubClient({ hubUrl, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const baseUrl = resolveHubUrl(hubUrl);

  async function request(path, options = {}) {
    const signal = AbortSignal.timeout(options.timeoutMs || timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
    } catch (error) {
      const err = new Error(
        `未检测到运行中的本地 CyberForeman（赛博包工头）服务（${baseUrl}）。`
        + `请先运行 npx cyber-foreman 或 npm start（也可双击 start-hub.bat），待后台启动后再重试。`
        + ` / Local CyberForeman service is not running at ${baseUrl}. Start it with "npx cyber-foreman" or "npm start" first.`,
      );
      err.code = "HUB_UNREACHABLE";
      err.status = 503;
      err.hint = "请先启动本地 CyberForeman（赛博包工头）后台服务（npx cyber-foreman / npm start），确认 http://127.0.0.1:4647 可访问后再调用。";
      throw err;
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.message || data.error || `Agent Hub 返回 HTTP ${response.status}`;
      const err = new Error(message);
      err.code = data.code || `HTTP_${response.status}`;
      err.status = response.status;
      if (data.fallback) err.fallback = data.fallback;
      throw err;
    }
    return data;
  }

  return { baseUrl, request };
}

/** 5 个核心 MCP Tools 定义（中英双语描述，引导主控 Agent 拆解并派发任务）。 */
export const MCP_TOOLS = Object.freeze([
  {
    name: "list_workers",
    description:
      "查询本地 CyberForeman（赛博包工头）中的所有 CLI 员工（Claude / Codex / Antigravity / Kimi / Doubao 等），返回员工 ID、类型、绑定项目目录（cwd）、可用性以及当前空闲/忙碌/排队状态。派发任务前请先调用此工具，以便按项目目录和专长合理分工。"
      + "\nList all local CLI workers registered in CyberForeman, including workerId, kind, bound working directory (cwd), availability, and idle/busy/queued status. Always call this before dispatching tasks to pick the right worker and workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "dispatch_task",
    description:
      "向指定本地 CLI 员工派发一个子任务。任务将进入该员工的串行队列并立即返回 taskId；请将复杂需求拆分为目标明确、含文件路径与验收标准的子任务，派发后用 get_task_status 追踪四阶段状态与输出摘要。"
      + "\nDispatch a scoped subtask to a local CLI worker. Enqueues immediately and returns taskId. Break complex goals into clear subtasks with concrete file paths and acceptance criteria, then monitor via get_task_status.",
    inputSchema: {
      type: "object",
      properties: {
        workerId: {
          type: "string",
          description: "目标员工 ID（从 list_workers 获取，例如 claude-main / codex-main / agy-main） / Target worker ID from list_workers.",
        },
        prompt: {
          type: "string",
          description: "完整任务说明，写明目标、范围、预期改动路径与验收标准 / Full task prompt with goal, scope, paths, and acceptance criteria.",
        },
        cwd: {
          type: "string",
          description: "可选：覆盖本次任务的工作目录（必须为本机已存在的绝对路径）；省略时使用该员工默认绑定目录 / Optional absolute working directory override; defaults to the worker's bound cwd.",
        },
        resetSession: {
          type: "boolean",
          description: "可选：为 true 时清空该员工在此目录的会话记忆，从全新会话开始 / Optional: when true, clears session memory for this worker+cwd and starts fresh.",
        },
      },
      required: ["workerId", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "get_task_status",
    description:
      "查询单个任务的最新四阶段状态（queued 排队 / running 执行或重试中 / waiting 失败或中断待处理 / done 已完成或已取消）、进度记录、输出摘要与错误信息。"
      + "\nGet a task's four-stage status (queued / running / waiting / done), raw status, recent progress, output summary, and error details.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "由 dispatch_task 返回的任务 ID / Task ID returned by dispatch_task.",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "say_to_task",
    description:
      "向任务发送中途指令或追问。mode 支持：auto（默认，能插话就插话，不支持时自动降级为只读侧问）、steer（强制向运行中的流式员工插话，会改变任务走向）、side（发起只读侧问，不改文件且不污染主任务会话记忆）。"
      + "\nSend a mid-task instruction or read-only side question to a task. Modes: 'auto' (steer if supported, otherwise fall back to a read-only side question), 'steer' (inject into running stream-enabled worker), 'side' (read-only Q&A without altering files or main session memory).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "目标任务 ID / Target task ID.",
        },
        text: {
          type: "string",
          description: "要追加的要求或要问的问题 / Instruction to steer with or question to ask.",
        },
        mode: {
          type: "string",
          enum: ["auto", "steer", "side"],
          description: "对话模式：auto（默认）/ steer / side / Interaction mode: auto (default), steer, or side.",
        },
      },
      required: ["taskId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_task",
    description:
      "停止一个排队中、重试等待中或正在运行的任务。会结束对应的员工子进程树，但不会回滚已写入磁盘的文件。"
      + "\nStop a queued, retrying, or running task. Terminates the worker subprocess tree without rolling back files already written to disk.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "要停止的任务 ID / Task ID to cancel.",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
]);

function requireNonEmptyString(args, key) {
  const value = typeof args?.[key] === "string" ? args[key].trim() : "";
  if (!value) {
    const error = new Error(`缺少必填参数 ${key} / Missing required string parameter: ${key}`);
    error.code = "INVALID_PARAMS";
    throw error;
  }
  return value;
}

function summarizeWorker(worker) {
  const busy = Boolean(worker.activeTaskId);
  return {
    id: worker.id,
    name: worker.name,
    kind: worker.kind,
    kindLabel: worker.kindLabel,
    enabled: Boolean(worker.enabled),
    available: Boolean(worker.available),
    cwd: worker.cwd || null,
    status: !worker.enabled ? "disabled" : !worker.available ? "unavailable" : busy ? "busy" : "idle",
    activeTaskId: worker.activeTaskId || null,
    activeTaskTitle: worker.activeTaskTitle || null,
    queued: Number(worker.queued) || 0,
    effectiveModel: worker.effectiveModel || null,
    steerable: Boolean(worker.steerable),
    note: worker.note || null,
  };
}

function summarizeTask(task) {
  const progress = Array.isArray(task.progress) ? task.progress.slice(-5) : [];
  const rawResult = task.result ? String(task.result) : "";
  const capped = rawResult ? truncateText(rawResult, MAX_RESULT_CHARS) : { text: null, truncated: false };
  const summarySource = rawResult
    || (task.error ? `错误：${task.error}` : "")
    || (progress.length ? progress[progress.length - 1].message : "");
  const summary = summarySource ? truncateText(summarySource, SUMMARY_CHARS).text : null;

  return {
    taskId: task.id,
    workerId: task.workerId,
    kind: task.kind || null,
    title: task.title || null,
    stage: task.stage || null,
    status: task.status || null,
    cwd: task.cwd || null,
    attempts: Number(task.attempts) || 0,
    maxAttempts: Number(task.maxAttempts) || 1,
    summary,
    result: capped.text,
    ...(capped.truncated ? { resultTruncated: true } : {}),
    error: task.error || null,
    latestProgress: progress,
    createdAt: task.createdAt || null,
    startedAt: task.startedAt || null,
    finishedAt: task.finishedAt || null,
  };
}

/** 执行单个 MCP Tool：仅将参数映射到 Hub HTTP API 并整理返回结果。 */
export async function executeTool(name, args = {}, client) {
  switch (name) {
    case "list_workers": {
      const data = await client.request("/api/workers");
      const workers = Array.isArray(data.workers) ? data.workers.map(summarizeWorker) : [];
      return {
        hubUrl: client.baseUrl,
        total: workers.length,
        availableCount: workers.filter((w) => w.available).length,
        workers,
      };
    }

    case "dispatch_task": {
      const workerId = requireNonEmptyString(args, "workerId");
      const prompt = requireNonEmptyString(args, "prompt");
      const body = {
        workerId,
        prompt,
        ...(typeof args.cwd === "string" && args.cwd.trim() ? { cwd: args.cwd.trim() } : {}),
        ...(args.resetSession === true ? { newSession: true } : {}),
      };
      const data = await client.request("/api/tasks", { method: "POST", body });
      const task = data.task || {};
      return {
        taskId: task.id,
        workerId: task.workerId,
        title: task.title,
        stage: task.stage || "queued",
        status: task.status || "queued",
        cwd: task.cwd || null,
        newSession: Boolean(task.newSession),
        next: "Call get_task_status with this taskId to check progress and output.",
      };
    }

    case "get_task_status": {
      const taskId = requireNonEmptyString(args, "taskId");
      const data = await client.request(`/api/tasks/${encodeURIComponent(taskId)}`);
      return summarizeTask(data.task || {});
    }

    case "say_to_task": {
      const taskId = requireNonEmptyString(args, "taskId");
      const text = requireNonEmptyString(args, "text");
      const mode = ["auto", "steer", "side"].includes(args.mode) ? args.mode : "auto";
      const data = await client.request(`/api/tasks/${encodeURIComponent(taskId)}/say`, {
        method: "POST",
        body: { text, mode },
      });
      return {
        delivered: data.delivered || mode,
        taskId: data.task?.id || taskId,
        sideTaskId: data.sideTaskId || null,
        stage: data.task?.stage || null,
        status: data.task?.status || null,
        note: data.note || null,
        warning: data.warning || null,
      };
    }

    case "cancel_task": {
      const taskId = requireNonEmptyString(args, "taskId");
      const data = await client.request(`/api/tasks/${encodeURIComponent(taskId)}/stop`, {
        method: "POST",
        body: {},
      });
      const task = data.task || {};
      return {
        taskId: task.id || taskId,
        workerId: task.workerId || null,
        title: task.title || null,
        stage: task.stage || null,
        status: task.status || null,
        finishedAt: task.finishedAt || null,
      };
    }

    default: {
      const error = new Error(`未知工具：${name} / Unknown tool: ${name}`);
      error.code = "UNKNOWN_TOOL";
      throw error;
    }
  }
}

/** 创建标准 MCP Server 实例（不绑定传输层，方便 STDIO 入口和单元测试复用）。 */
export function createMcpServer(options = {}) {
  const client = options.client || createHubClient(options);
  const server = new Server(
    {
      name: "cyber-foreman",
      version: options.version || PACKAGE.version || "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params?.name;
    const args = request.params?.arguments || {};
    try {
      const result = await executeTool(toolName, args, client);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const payload = {
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || "MCP_TOOL_ERROR",
        ...(error?.status ? { status: error.status } : {}),
        ...(error?.hint ? { hint: error.hint } : {}),
        ...(error?.fallback ? { fallback: error.fallback } : {}),
      };
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
  });

  return { server, client };
}
