import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../src/store.mjs";
import { AgentHub } from "../src/hub.mjs";
import { createHubServer } from "../src/server.mjs";

const STREAM_STUB = fileURLToPath(new URL("./fake-claude-stream.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function waitFor(predicate, timeoutMs = 10_000, label = "条件") {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolvePromise(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`等待${label}超时`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function makeHub(options = {}) {
  const directory = tempDir("agent-hub-side-");
  const dataDir = join(directory, "data");
  const store = new TaskStore(dataDir).init();
  const workers = {
    "claude-1": {
      name: "Claude 一号",
      kind: "claude-cli",
      command: process.execPath,
      argsPrefix: [STREAM_STUB],
      cwd: ROOT,
      permissionMode: "acceptEdits",
      steerIdleMs: 400,
      ...(options.worker || {}),
    },
  };
  const hub = new AgentHub({ store, workers, steerWatchdogMs: 0 });
  return {
    hub,
    store,
    workers,
    dataDir,
    directory,
    cleanup: async () => {
      await hub.stopAll();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("侧问：只读新会话、不写回会话记忆、可被 ?role=side 查到", async () => {
  const ctx = makeHub();
  try {
    // 先跑一个主任务，建立会话记忆
    const main = ctx.hub.dispatch({ prompt: "第一个任务：建立记忆" });
    const mainDone = await ctx.hub.waitTask(main.id, 15);
    assert.equal(mainDone.status, "completed");
    const cwd = mainDone.cwd;
    const mainSession = ctx.store.getWorkerSession("claude-1", cwd);
    assert.ok(mainSession, "主任务应该留下会话记忆");

    const side = ctx.hub.askSide({ parentTaskId: main.id, question: "这个仓库的构建命令是什么" });
    assert.equal(side.task.role, "side");
    assert.equal(side.task.parentTaskId, main.id);
    assert.equal(side.task.sideQuestion, "这个仓库的构建命令是什么");
    assert.equal(side.task.readOnly, true, "侧问必须只读");
    assert.equal(side.task.newSession, true, "侧问必须用新会话");
    assert.equal(side.task.resumeSessionId, null);
    assert.match(side.task.prompt, /【侧问】/);
    assert.match(side.task.prompt, /不要修改任何文件/);
    assert.match(side.note, /只读/);

    const sideDone = await ctx.hub.waitTask(side.task.id, 15);
    assert.equal(sideDone.status, "completed");
    assert.match(sideDone.result, /TURN 1/);

    // ★ 最关键的一条：侧问绝不能把主任务的会话记忆冲掉
    const afterSession = ctx.store.getWorkerSession("claude-1", cwd);
    assert.equal(afterSession, mainSession, "侧问前后主任务的 sessionId 必须完全不变");
    assert.notEqual(sideDone.sessionId, mainSession, "侧问自己的 session 应该是新的");

    // 侧问不进主列表
    assert.equal(ctx.store.listTasks({ role: "main" }).some((item) => item.id === side.task.id), false);
    assert.equal(ctx.store.listTasks({ role: "side" }).length, 1);
    assert.equal(ctx.store.listTasks({ role: "all" }).length, 2);
    // 列表投影里也要有 readOnly：面板靠它比 role 更准地识别"只读侧问"
    assert.equal(ctx.store.listTasks({ role: "side" })[0].readOnly, true);
    assert.equal(ctx.store.listTasks({ role: "main" })[0].readOnly, false);

    // counts：侧问单独计数，不撑起主阶段
    const counts = ctx.store.counts();
    assert.equal(counts.side, 1);
    assert.equal(counts.stages.done, 1, "主阶段只算主任务");
  } finally {
    await ctx.cleanup();
  }
});

test("侧问并发上限：同一员工同时只能答一条", async () => {
  const ctx = makeHub();
  try {
    const main = ctx.hub.dispatch({ prompt: "第一个任务：占位" });
    await ctx.hub.waitTask(main.id, 15);

    const first = ctx.hub.askSide({ parentTaskId: main.id, question: "SILENT 先说一句别回答" });
    await waitFor(() => ctx.store.getTask(first.task.id).status === "running", 10_000, "侧问开跑");

    assert.throws(
      () => ctx.hub.askSide({ parentTaskId: main.id, question: "再问一条" }),
      (error) => {
        assert.equal(error.code, "SIDE_BUSY");
        assert.match(error.message, /正在回答上一条侧问/);
        return true;
      },
    );

    ctx.hub.stopTask(first.task.id);
    await ctx.hub.waitTask(first.task.id, 10);
    // 释放后再问就允许了
    const second = ctx.hub.askSide({ parentTaskId: main.id, question: "换个问题" });
    assert.ok(second.task.id);
    await ctx.hub.waitTask(second.task.id, 15);
  } finally {
    await ctx.cleanup();
  }
});

test("侧问超时：到点截停并说明，不静默挂着", async () => {
  const ctx = makeHub({ worker: { sideTimeoutMs: 1000 } });
  try {
    const main = ctx.hub.dispatch({ prompt: "第一个任务：超时用例" });
    await ctx.hub.waitTask(main.id, 15);

    const side = ctx.hub.askSide({ parentTaskId: main.id, question: "SILENT 这条不回" });
    const done = await ctx.hub.waitTask(side.task.id, 15);
    assert.equal(done.status, "failed");
    assert.match(done.error, /侧问超过 1 秒，已停下/);
    assert.equal(done.stage, "waiting");
  } finally {
    await ctx.cleanup();
  }
});

test("侧问不占 activeByWorker：主任务可以同时跑", async () => {
  const ctx = makeHub();
  try {
    const first = ctx.hub.dispatch({ prompt: "第一个任务：先跑一个" });
    await ctx.hub.waitTask(first.id, 15);

    const side = ctx.hub.askSide({ parentTaskId: first.id, question: "SILENT 别回答，占住侧问位" });
    await waitFor(() => ctx.store.getTask(side.task.id).status === "running", 10_000, "侧问开跑");
    assert.equal(ctx.hub.activeByWorker.has("claude-1"), false, "侧问不能占用主任务槽位");

    const second = ctx.hub.dispatch({ prompt: "第二个任务：和侧问并行" });
    const done = await ctx.hub.waitTask(second.id, 15);
    assert.equal(done.status, "completed", "侧问在跑时主任务必须能正常执行");
    assert.equal(ctx.store.getTask(side.task.id).status, "running", "此时侧问还没结束");
  } finally {
    await ctx.cleanup();
  }
});

test("侧问参数校验：NO_PARENT / QUESTION_EMPTY / WORKER_UNAVAILABLE", async () => {
  const ctx = makeHub();
  try {
    assert.throws(
      () => ctx.hub.askSide({ parentTaskId: "task_nope", question: "在吗" }),
      (error) => error.code === "NO_PARENT" && /没有找到/.test(error.message),
    );
    assert.throws(
      () => ctx.hub.askSide({ question: "   " }),
      (error) => error.code === "QUESTION_EMPTY" && /要问什么/.test(error.message),
    );
    ctx.workers["claude-1"].disabled = true;
    assert.throws(
      () => ctx.hub.askSide({ workerId: "claude-1", question: "在吗" }),
      (error) => error.code === "WORKER_UNAVAILABLE" && /停用/.test(error.message),
    );
  } finally {
    await ctx.cleanup();
  }
});

async function startHttpHub(workers) {
  const directory = tempDir("agent-hub-side-http-");
  const config = { port: 0, dataDir: join(directory, "data"), workers };
  const context = await createHubServer({ config, logger: { warn() {}, error() {}, log() {} } });
  await new Promise((resolvePromise, reject) => {
    context.server.once("error", reject);
    context.server.listen(0, "127.0.0.1", resolvePromise);
  });
  const base = `http://127.0.0.1:${context.server.address().port}`;
  const call = (path, { method = "GET", body } = {}) => fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  return {
    context,
    call,
    async cleanup() {
      await context.channelManager.stopAll();
      await context.hub.stopAll();
      await new Promise((resolvePromise) => context.server.close(resolvePromise));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("HTTP /say：steer 成功、auto 降级 side、显式 steer 不支持时 400 + fallback", async () => {
  const workers = {
    "claude-1": {
      name: "Claude 流式",
      kind: "claude-cli",
      command: process.execPath,
      argsPrefix: [STREAM_STUB],
      cwd: ROOT,
      permissionMode: "acceptEdits",
      streamInput: true,
      steerIdleMs: 800,
    },
    "claude-plain": {
      name: "Claude 未开插话",
      kind: "claude-cli",
      command: process.execPath,
      argsPrefix: [STREAM_STUB],
      cwd: ROOT,
      permissionMode: "acceptEdits",
      steerIdleMs: 800,
    },
  };
  const harness = await startHttpHub(workers);
  try {
    // 1) 流式员工：mode=steer 成功
    const created = await harness.call("/api/tasks", {
      method: "POST",
      body: { workerId: "claude-1", prompt: "第一个任务：HTTP 插话" },
    });
    assert.equal(created.status, 202);
    const taskId = created.body.task.id;
    await waitFor(() => harness.context.hub.steerables.has(taskId), 10_000, "流式句柄就绪");

    const steered = await harness.call(`/api/tasks/${taskId}/say`, {
      method: "POST",
      body: { text: "顺手把图也换掉", mode: "steer" },
    });
    assert.equal(steered.status, 200);
    assert.equal(steered.body.delivered, "steer");
    assert.equal(steered.body.task.steers.length, 1);
    assert.equal(steered.body.task.steers[0].text, "顺手把图也换掉");

    // 2) mode=side：另起只读任务
    const side = await harness.call(`/api/tasks/${taskId}/say`, {
      method: "POST",
      body: { text: "这个仓库怎么构建", mode: "side" },
    });
    assert.equal(side.status, 200);
    assert.equal(side.body.delivered, "side");
    assert.ok(side.body.sideTaskId);
    assert.match(side.body.note, /只读/);

    // 3) 没开「允许插话」→ 显式 steer 要 400 + fallback
    const plain = harness.context.store.createTask({
      workerId: "claude-plain",
      kind: "claude-cli",
      title: "未开插话的任务",
      prompt: "占位",
      cwd: ROOT,
    });
    harness.context.store.updateTask(plain.id, { status: "running", startedAt: new Date().toISOString() });

    const rejected = await harness.call(`/api/tasks/${plain.id}/say`, {
      method: "POST",
      body: { text: "追加一句", mode: "steer" },
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, "STEER_UNSUPPORTED");
    assert.equal(rejected.body.fallback, "side");
    assert.match(rejected.body.error, /允许插话/);
    // 文案一处一份：message 与 error 同值，前端直接显示，不用自己拼
    assert.equal(rejected.body.message, rejected.body.error);

    // 4) mode=auto：同样的任务自动降级为侧问，并带 note
    const auto = await harness.call(`/api/tasks/${plain.id}/say`, {
      method: "POST",
      body: { text: "那帮我查个问题" , mode: "auto" },
    });
    assert.equal(auto.status, 200);
    assert.equal(auto.body.delivered, "side");
    assert.ok(auto.body.sideTaskId);
    assert.ok(auto.body.note, "降级必须带说明，不能让用户以为插进去了");

    // 5) 任务不存在 / 空内容
    const missing = await harness.call("/api/tasks/task_nope/say", {
      method: "POST",
      body: { text: "在吗" },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "NO_TASK");

    const empty = await harness.call(`/api/tasks/${plain.id}/say`, {
      method: "POST",
      body: { text: "  " },
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, "STEER_EMPTY");

    // 6) role 过滤：默认只有主任务，?role=side 只给侧问，all 全给
    const mainList = await harness.call("/api/tasks");
    assert.equal(mainList.body.tasks.every((item) => item.role === "main"), true);
    const sideList = await harness.call("/api/tasks?role=side");
    assert.ok(sideList.body.tasks.length >= 1);
    assert.equal(sideList.body.tasks.every((item) => item.role === "side"), true);
    const allList = await harness.call("/api/tasks?role=all");
    assert.equal(allList.body.tasks.length, mainList.body.tasks.length + sideList.body.tasks.length);

    // 7) 详情里带 role / parentTaskId / steers / sideQuestion
    const detail = await harness.call(`/api/tasks/${taskId}`);
    assert.equal(detail.body.task.role, "main");
    assert.equal(Array.isArray(detail.body.task.steers), true);
    const sideDetail = await harness.call(`/api/tasks/${side.body.sideTaskId}`);
    assert.equal(sideDetail.body.task.role, "side");
    assert.equal(sideDetail.body.task.parentTaskId, taskId);
    assert.equal(sideDetail.body.task.sideQuestion, "这个仓库怎么构建");

    // 8) 适配器接口带 supportsSteer / steerHint；员工带 streamInput / steerable
    const adapters = await harness.call("/api/adapters");
    const claude = adapters.body.adapters.find((item) => item.kind === "claude-cli");
    assert.equal(claude.supportsSteer, true);
    assert.ok(claude.steerHint);
    const workersList = await harness.call("/api/workers");
    const streamWorker = workersList.body.workers.find((item) => item.id === "claude-1");
    assert.equal(streamWorker.streamInput, true);
    assert.equal(streamWorker.steerable, true);
    const plainWorker = workersList.body.workers.find((item) => item.id === "claude-plain");
    assert.equal(plainWorker.streamInput, false);
    assert.equal(plainWorker.steerable, false);
    assert.match(plainWorker.steerHint, /允许插话/);

    // 面板读的是 /api/overview 的员工对象，插话判定要的字段在里面也得有
    const overview = await harness.call("/api/overview");
    const overviewWorker = overview.body.workers.find((item) => item.id === "claude-1");
    assert.equal(overviewWorker.streamInput, true);
    assert.equal(overviewWorker.supportsSteer, true);
    assert.equal(overviewWorker.steerable, true);
  } finally {
    await harness.cleanup();
  }
});

test("侧问上继续追问：auto 降级为新侧问并挂回主任务；显式 steer 仍拒绝", async () => {
  const ctx = makeHub({ worker: { streamInput: true } });
  try {
    // 手工造「主任务 + 已回答完的侧问」，不真起进程，避免占住 activeSideByWorker。
    const main = ctx.store.createTask({
      workerId: "claude-1",
      kind: "claude-cli",
      title: "整理 README",
      prompt: "把 README 的目录补齐",
      cwd: ROOT,
    });
    ctx.store.updateTask(main.id, { status: "completed" });
    const answered = ctx.store.createTask({
      workerId: "claude-1",
      kind: "claude-cli",
      title: "侧问 · 构建命令",
      prompt: "【侧问】构建命令是什么",
      cwd: ROOT,
      role: "side",
      parentTaskId: main.id,
      sideQuestion: "构建命令是什么",
      readOnly: true,
    });
    ctx.store.updateTask(answered.id, { status: "completed", result: "npm run build" });

    // 面板里对着侧问按 Enter（mode:auto），必须是「继续追问」而不是死路。
    const followed = await ctx.hub.say(answered.id, "那测试命令呢", { mode: "auto", source: "panel" });
    assert.equal(followed.delivered, "side");
    assert.ok(followed.sideTaskId);
    assert.notEqual(followed.sideTaskId, answered.id);
    assert.match(followed.note, /只读/);

    const fresh = ctx.store.getTask(followed.sideTaskId);
    assert.equal(fresh.role, "side");
    assert.equal(fresh.parentTaskId, main.id, "追问出来的侧问要挂回主任务，不能 side→side 套娃");
    assert.equal(fresh.sideQuestion, "那测试命令呢");
    assert.equal(fresh.readOnly, true);
    assert.equal(fresh.newSession, true);
    assert.match(fresh.prompt, /把 README 的目录补齐/, "上下文摘要要取主任务，不是上一条侧问");

    // 显式 steer 保持原来的 409 拒绝，文案不动。
    await assert.rejects(
      () => ctx.hub.say(answered.id, "改一下答案", { mode: "steer" }),
      (error) => error.code === "STEER_NOT_RUNNING" && /不能插话/.test(error.message),
    );

    // 主任务没在跑时，auto 不能凭空多出一条侧问。
    await assert.rejects(
      () => ctx.hub.say(main.id, "再补一句", { mode: "auto" }),
      (error) => error.code === "STEER_NOT_RUNNING",
    );
    assert.equal(ctx.store.listTasks({ role: "side" }).length, 2, "不该额外多出侧问");

    await ctx.hub.waitTask(followed.sideTaskId, 15);
  } finally {
    await ctx.cleanup();
  }
});

test("HTTP /say：侧问任务按 Enter（mode:auto）降级追问，显式 steer 仍 409", async () => {
  const harness = await startHttpHub({
    "claude-1": {
      name: "Claude 流式",
      kind: "claude-cli",
      command: process.execPath,
      argsPrefix: [STREAM_STUB],
      cwd: ROOT,
      permissionMode: "acceptEdits",
      streamInput: true,
      steerIdleMs: 800,
    },
  });
  try {
    const main = harness.context.store.createTask({
      workerId: "claude-1",
      kind: "claude-cli",
      title: "整理 README",
      prompt: "把 README 的目录补齐",
      cwd: ROOT,
    });
    harness.context.store.updateTask(main.id, { status: "completed" });
    const answered = harness.context.store.createTask({
      workerId: "claude-1",
      kind: "claude-cli",
      title: "侧问 · 构建命令",
      prompt: "【侧问】构建命令是什么",
      cwd: ROOT,
      role: "side",
      parentTaskId: main.id,
      sideQuestion: "构建命令是什么",
      readOnly: true,
    });
    harness.context.store.updateTask(answered.id, { status: "completed", result: "npm run build" });

    // 面板对侧问按 Enter 发的就是 mode:auto，不能再是 409 死路。
    const followed = await harness.call(`/api/tasks/${answered.id}/say`, {
      method: "POST",
      body: { text: "那测试命令呢", mode: "auto" },
    });
    assert.equal(followed.status, 200, JSON.stringify(followed.body));
    assert.equal(followed.body.delivered, "side");
    assert.ok(followed.body.sideTaskId);
    assert.match(followed.body.note, /只读/);

    const fresh = await harness.call(`/api/tasks/${followed.body.sideTaskId}`);
    assert.equal(fresh.body.task.role, "side");
    assert.equal(fresh.body.task.parentTaskId, main.id, "追问不能挂在上一条侧问下面");
    assert.equal(fresh.body.task.sideQuestion, "那测试命令呢");

    // 显式点「插话」保持拒绝，且中文文案由后端一处给出。
    const rejected = await harness.call(`/api/tasks/${answered.id}/say`, {
      method: "POST",
      body: { text: "改一下答案", mode: "steer" },
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, "STEER_NOT_RUNNING");
    assert.equal(rejected.body.message, rejected.body.error);
    assert.match(rejected.body.message, /不能插话/);

    await harness.context.hub.waitTask(followed.body.sideTaskId, 15);
  } finally {
    await harness.cleanup();
  }
});
