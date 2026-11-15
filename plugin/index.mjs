// 这个插件刻意不依赖 @deepseek-ai/dsh-tools：
// DSH 的远端插件运行时不一定能从 profile 的 node_modules 解析到它，
// 换成自带的等价实现后，插件本身零第三方依赖，装到任何 profile 都能加载。

const PARAMETER_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

function toParameterSchema(spec = {}) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    if (!value || typeof value !== "object") continue;
    const type = PARAMETER_TYPES.has(value.type) ? value.type : "string";
    const property = { type };
    if (value.description) property.description = value.description;
    if (Array.isArray(value.enum) && value.enum.length) property.enum = value.enum;
    properties[key] = property;
    if (value.required === true) required.push(key);
  }
  const schema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

function defineTool(options) {
  const render = options.output && options.output.render;
  return {
    name: options.name,
    description: options.description,
    parameters: toParameterSchema(options.parameters),
    output: {
      schema: { type: "object" },
      render(args, value) {
        if (render) return render(args, value);
        return [{
          type: "text",
          text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
        }];
      },
    },
    async execute(args, exec) {
      return options.execute(args, exec);
    },
  };
}

export const name = "dsh-agent-hub";
export const inject = ["tools"];

const DEFAULT_HUB_URL = "http://127.0.0.1:4647";

function hubUrl() {
  return (process.env.AGENT_HUB_URL || DEFAULT_HUB_URL).replace(/\/+$/, "");
}

async function request(path, options = {}) {
  const timeout = AbortSignal.timeout(options.timeoutMs || 12_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(`${hubUrl()}${path}`, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(
      `连不上 Agent Hub（${hubUrl()}）。先在这个项目的目录运行 npm start。${error instanceof Error ? ` 原因：${error.message}` : ""}`,
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Agent Hub 返回 ${response.status}`);
  return data;
}

function jsonTool(name, description, parameters, handler) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      }],
    },
    async execute(args, exec) {
      return handler(args, exec);
    },
  });
}

export function apply(ctx) {
  ctx.tools.register(jsonTool(
    "agent_hub_workers",
    "查看 Agent Hub 里的员工状态。派活前先调用。返回每个员工是否可用、工作目录、是否在忙和排队数；默认员工是列表里第一个启用的。",
    {},
    async () => request("/api/workers"),
  ));

  ctx.tools.register(jsonTool(
    "agent_hub_dispatch",
    "把任务派给某个 CLI 员工（Claude / Codex）。任务会进入独立 Hub 的后台队列，立即返回 taskId；失败会自动重试，最终结果用 agent_hub_result 收取。prompt 要写清目标、范围、产物路径和验收标准。",
    {
      prompt: { type: "string", required: true, description: "完整任务说明" },
      workerId: { type: "string", description: "员工 id；省略时用默认员工。写文案用 claude-main，改代码/跑命令用 codex-main" },
      cwd: { type: "string", description: "任务工作目录；省略时用员工默认目录" },
      model: { type: "string", description: "临时指定模型；省略时用员工默认" },
      effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "推理强度（仅 Claude 生效）" },
      newSession: { type: "boolean", description: "true 时不续接该员工之前的会话" },
    },
    async (args, exec) => {
      const data = await request("/api/tasks", {
        method: "POST",
        body: {
          prompt: args.prompt,
          workerId: args.workerId,
          cwd: args.cwd,
          model: args.model,
          effort: args.effort,
          newSession: args.newSession,
        },
        signal: exec.signal,
      });
      return {
        taskId: data.task.id,
        status: data.task.status,
        workerId: data.task.workerId,
        cwd: data.task.cwd,
        title: data.task.title,
        next: "调用 agent_hub_result（taskId 用这个值，waitSeconds 建议 60）等待并读取最终结果。",
      };
    },
  ));

  ctx.tools.register(jsonTool(
    "agent_hub_tasks",
    "列出 Hub 里的任务。按 stage（工单阶段）筛最实用：running=机器在干，waiting=卡在人身上（失败/中断，需要处理），queued=排队，done=已结束。要看完整结果用 agent_hub_result。",
    {
      stage: {
        type: "string",
        enum: ["running", "waiting", "queued", "done"],
        description: "按工单阶段筛选；省略时返回最近任务",
      },
      status: {
        type: "string",
        enum: ["queued", "running", "retrying", "cancelling", "waiting", "completed", "failed", "cancelled", "interrupted"],
        description: "按原始状态筛选，一般用 stage 就够",
      },
      limit: { type: "number", description: "最多返回几条，默认 20，最大 200" },
    },
    async (args, exec) => {
      const search = new URLSearchParams();
      if (args.stage) search.set("stage", args.stage);
      if (args.status) search.set("status", args.status);
      if (args.limit) search.set("limit", String(args.limit));
      return request(`/api/tasks${search.size ? `?${search}` : ""}`, { signal: exec.signal });
    },
  ));

  ctx.tools.register(jsonTool(
    "agent_hub_result",
    "读取任务状态和员工的最终回报。waitSeconds 大于 0 时会等待任务结束（最多 120 秒）；任务仍在跑（含自动重试）时返回 waitTimedOut=true，可稍后继续查。",
    {
      taskId: { type: "string", required: true, description: "agent_hub_dispatch 返回的 taskId" },
      waitSeconds: { type: "number", description: "最多等待几秒，0 表示立即返回；建议 60" },
    },
    async (args, exec) => {
      const waitSeconds = Math.max(0, Math.min(Number(args.waitSeconds) || 0, 120));
      const data = await request(`/api/tasks/${encodeURIComponent(args.taskId)}/wait`, {
        method: "POST",
        body: { timeoutSeconds: waitSeconds },
        timeoutMs: (waitSeconds + 12) * 1000,
        signal: exec.signal,
      });
      return data.task;
    },
  ));

  ctx.tools.register(jsonTool(
    "agent_hub_stop",
    "停止一个排队中、重试等待中或正在执行的 Hub 任务。员工进程树会被结束；已经写入磁盘的文件修改不会回滚。",
    {
      taskId: { type: "string", required: true, description: "要停止的 taskId" },
    },
    async (args, exec) => {
      const data = await request(`/api/tasks/${encodeURIComponent(args.taskId)}/stop`, {
        method: "POST",
        body: {},
        signal: exec.signal,
      });
      return data.task;
    },
  ));

  ctx.tools.register(jsonTool(
    "agent_hub_retry",
    "把已经结束的任务重新放回队列再跑一次（自动重试已经用尽、或你改好了前置条件时用）。重试额度会重置，会话会新开。",
    {
      taskId: { type: "string", required: true, description: "要重新派发的 taskId" },
    },
    async (args, exec) => {
      const data = await request(`/api/tasks/${encodeURIComponent(args.taskId)}/retry`, {
        method: "POST",
        body: {},
        signal: exec.signal,
      });
      return data.task;
    },
  ));
}
