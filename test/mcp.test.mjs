import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHubClient, executeTool, MCP_TOOLS, resolveHubUrl } from "../src/mcp/server.mjs";

const MCP_BIN = fileURLToPath(new URL("../bin/dsh-agent-hub-mcp.mjs", import.meta.url));

async function startMockHub(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, body });

    const reply = await handler({ method: req.method, url: req.url, body });
    const status = reply.status || 200;
    const payload = JSON.stringify(reply.body ?? {});
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("resolveHubUrl 支持显式入参、DSH_HUB_URL 环境变量与默认地址", () => {
  const prev = process.env.DSH_HUB_URL;
  try {
    delete process.env.DSH_HUB_URL;
    assert.equal(resolveHubUrl(), "http://127.0.0.1:4647");
    assert.equal(resolveHubUrl("http://127.0.0.1:4999///"), "http://127.0.0.1:4999");
    process.env.DSH_HUB_URL = "http://127.0.0.1:4800/";
    assert.equal(resolveHubUrl(), "http://127.0.0.1:4800");
  } finally {
    if (prev === undefined) delete process.env.DSH_HUB_URL;
    else process.env.DSH_HUB_URL = prev;
  }
});

test("MCP 转发客户端在 Hub 未启动时返回清晰中文启动指引", async () => {
  const client = createHubClient({
    hubUrl: "http://127.0.0.1:1",
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    () => executeTool("list_workers", {}, client),
    (error) => error.code === "HUB_UNREACHABLE"
      && /未检测到运行中的本地 CyberForeman/.test(error.message)
      && /npm start/.test(error.message)
      && typeof error.hint === "string"
      && !/TypeError/.test(error.message),
  );
});

test("STDIO MCP 入口 bin/dsh-agent-hub-mcp.mjs 完整响应 tools/list 与 5 个 tools/call", async () => {
  const mockHub = await startMockHub(({ method, url, body }) => {
    if (method === "GET" && url === "/api/workers") {
      return {
        status: 200,
        body: {
          workers: [
            {
              id: "claude-main",
              name: "Claude 主员工",
              kind: "claude-cli",
              kindLabel: "Claude",
              enabled: true,
              available: true,
              cwd: "C:\\work\\cyber-foreman",
              activeTaskId: null,
              activeTaskTitle: null,
              queued: 0,
              effectiveModel: "deepseek-v4-pro",
              steerable: true,
              note: "总经理",
            },
            {
              id: "agy-main",
              name: "Antigravity 员工",
              kind: "agy-cli",
              kindLabel: "Antigravity",
              enabled: true,
              available: true,
              cwd: "C:\\work\\cyber-foreman",
              activeTaskId: "task_busy_1",
              activeTaskTitle: "正在巡检",
              queued: 1,
              effectiveModel: null,
              steerable: false,
              note: "AGY",
            },
          ],
        },
      };
    }

    if (method === "POST" && url === "/api/tasks") {
      return {
        status: 202,
        body: {
          task: {
            id: "task_mock_1001",
            workerId: body.workerId,
            title: body.prompt.slice(0, 40),
            status: "queued",
            stage: "queued",
            cwd: body.cwd || "C:\\work\\cyber-foreman",
            newSession: Boolean(body.newSession),
          },
        },
      };
    }

    if (method === "GET" && url === "/api/tasks/task_mock_1001") {
      return {
        status: 200,
        body: {
          task: {
            id: "task_mock_1001",
            workerId: "claude-main",
            kind: "claude-cli",
            title: "实现 MCP 转发层",
            stage: "done",
            status: "completed",
            cwd: "C:\\work\\cyber-foreman",
            attempts: 1,
            maxAttempts: 3,
            result: "已完成全部改动并通过测试。",
            error: null,
            progress: [{ time: "2026-11-22T07:00:00.000Z", message: "任务完成" }],
            createdAt: "2026-11-22T06:59:00.000Z",
            startedAt: "2026-11-22T06:59:01.000Z",
            finishedAt: "2026-11-22T07:00:00.000Z",
          },
        },
      };
    }

    if (method === "GET" && url === "/api/tasks/task_missing") {
      return { status: 404, body: { error: "没有任务 task_missing" } };
    }

    if (method === "POST" && url === "/api/tasks/task_mock_1001/say") {
      if (body.mode === "steer") {
        return {
          status: 409,
          body: {
            error: "任务已经结束了",
            message: "任务已经结束了",
            code: "STEER_NOT_RUNNING",
            fallback: "side",
          },
        };
      }
      return {
        status: 200,
        body: {
          delivered: body.mode === "side" ? "side" : "steer",
          sideTaskId: body.mode === "side" ? "task_side_9" : null,
          note: body.mode === "side" ? "侧问是只读的" : null,
          warning: null,
          task: { id: "task_mock_1001", stage: "running", status: "running" },
        },
      };
    }

    if (method === "POST" && url === "/api/tasks/task_mock_1001/stop") {
      return {
        status: 200,
        body: {
          task: {
            id: "task_mock_1001",
            workerId: "claude-main",
            title: "实现 MCP 转发层",
            stage: "done",
            status: "cancelled",
            finishedAt: "2026-11-22T07:01:00.000Z",
          },
        },
      };
    }

    return { status: 404, body: { error: `unexpected ${method} ${url}` } };
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    env: { ...process.env, DSH_HUB_URL: mockHub.baseUrl },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });

  try {
    await client.connect(transport);

    // 1. tools/list 校验 5 个核心工具与双语描述
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((t) => t.name),
      ["list_workers", "dispatch_task", "get_task_status", "say_to_task", "cancel_task"],
    );
    assert.equal(listed.tools.length, MCP_TOOLS.length);
    for (const tool of listed.tools) {
      assert.match(tool.description, /[\u4e00-\u9fa5]/, `${tool.name} 应含中文描述`);
      assert.match(tool.description, /[A-Za-z]{4,}/, `${tool.name} 应含英文描述`);
    }

    // 2. list_workers
    const workersRes = await client.callTool({ name: "list_workers", arguments: {} });
    assert.notEqual(workersRes.isError, true);
    const workersData = JSON.parse(workersRes.content[0].text);
    assert.equal(workersData.total, 2);
    assert.equal(workersData.workers[0].status, "idle");
    assert.equal(workersData.workers[1].status, "busy");
    assert.equal(workersData.workers[1].id, "agy-main");

    // 3. dispatch_task（校验 resetSession → newSession 映射）
    const dispatchRes = await client.callTool({
      name: "dispatch_task",
      arguments: {
        workerId: "claude-main",
        prompt: "检查 README 并更新接入说明",
        cwd: "C:\\work\\cyber-foreman",
        resetSession: true,
      },
    });
    assert.notEqual(dispatchRes.isError, true);
    const dispatchData = JSON.parse(dispatchRes.content[0].text);
    assert.equal(dispatchData.taskId, "task_mock_1001");
    assert.equal(dispatchData.newSession, true);

    const postTaskReq = mockHub.requests.find((r) => r.method === "POST" && r.url === "/api/tasks");
    assert.deepEqual(postTaskReq.body, {
      workerId: "claude-main",
      prompt: "检查 README 并更新接入说明",
      cwd: "C:\\work\\cyber-foreman",
      newSession: true,
    });

    // 4. get_task_status
    const statusRes = await client.callTool({
      name: "get_task_status",
      arguments: { taskId: "task_mock_1001" },
    });
    assert.notEqual(statusRes.isError, true);
    const statusData = JSON.parse(statusRes.content[0].text);
    assert.equal(statusData.stage, "done");
    assert.equal(statusData.status, "completed");
    assert.match(statusData.summary, /已完成全部改动/);

    // 5. say_to_task（正常 side 模式 + 错误 409 透传）
    const sayRes = await client.callTool({
      name: "say_to_task",
      arguments: { taskId: "task_mock_1001", text: "目前改了哪些文件？", mode: "side" },
    });
    assert.notEqual(sayRes.isError, true);
    const sayData = JSON.parse(sayRes.content[0].text);
    assert.equal(sayData.delivered, "side");
    assert.equal(sayData.sideTaskId, "task_side_9");

    const sayErr = await client.callTool({
      name: "say_to_task",
      arguments: { taskId: "task_mock_1001", text: "强行插话", mode: "steer" },
    });
    assert.equal(sayErr.isError, true);
    const sayErrData = JSON.parse(sayErr.content[0].text);
    assert.equal(sayErrData.code, "STEER_NOT_RUNNING");
    assert.equal(sayErrData.fallback, "side");

    // 6. cancel_task
    const cancelRes = await client.callTool({
      name: "cancel_task",
      arguments: { taskId: "task_mock_1001" },
    });
    assert.notEqual(cancelRes.isError, true);
    const cancelData = JSON.parse(cancelRes.content[0].text);
    assert.equal(cancelData.status, "cancelled");
    assert.equal(cancelData.stage, "done");

    // 7. 404 错误透传不崩溃
    const missingRes = await client.callTool({
      name: "get_task_status",
      arguments: { taskId: "task_missing" },
    });
    assert.equal(missingRes.isError, true);
    const missingData = JSON.parse(missingRes.content[0].text);
    assert.equal(missingData.status, 404);
    assert.match(missingData.error, /没有任务/);
  } finally {
    await client.close().catch(() => {});
    await mockHub.close();
  }
});
