import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore, stageOf } from "../src/store.mjs";
import { AgentHub } from "../src/hub.mjs";

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function makeHub({ worker = {}, extraWorkers = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-hub-test-"));
  const dataDir = join(directory, "data");
  const store = new TaskStore(dataDir).init();
  const workers = {
    "claude-main": {
      name: "Fake Claude",
      kind: "claude-cli",
      command: process.execPath,
      argsPrefix: [FAKE_CLAUDE],
      cwd: ROOT,
      permissionMode: "acceptEdits",
      ...worker,
    },
    ...extraWorkers,
  };
  const hub = new AgentHub({ store, workers });
  return {
    hub,
    store,
    workers,
    directory,
    dataDir,
    cleanup: async () => {
      await hub.stopAll();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("等待条件超时");
}

test("Claude 任务完成、结果回收、会话续接与持久化", async () => {
  const ctx = makeHub();
  try {
    const first = ctx.hub.dispatch({ prompt: "第一个任务：生成一份测试结果" });
    assert.equal(first.status, "queued");
    const completed = await ctx.hub.waitTask(first.id, 8);
    assert.equal(completed.status, "completed");
    assert.match(completed.result, /第一个任务/);
    assert.equal(completed.sessionId, "fake-session-1");
    assert.ok(completed.progress.some((entry) => entry.message === "调用工具：Read"));

    const second = ctx.hub.dispatch({ prompt: "第二个任务：在已有会话里继续" });
    assert.equal(second.resumeSessionId, "fake-session-1");
    const secondDone = await ctx.hub.waitTask(second.id, 8);
    assert.equal(secondDone.status, "completed");
    assert.match(secondDone.result, /RESUME:fake-session-1/);

    const reopened = new TaskStore(ctx.dataDir).init();
    assert.equal(reopened.getTask(first.id).status, "completed");
    // 会话按员工+工作目录记：用任务上真正落盘的 cwd 去取。
    assert.equal(reopened.getWorkerSession("claude-main", first.cwd), "fake-session-1");
  } finally {
    await ctx.cleanup();
  }
});

test("Claude 失败时保留错误并标记 failed", async () => {
  const ctx = makeHub();
  try {
    const task = ctx.hub.dispatch({ prompt: "FAIL_ME 故意失败" });
    const done = await ctx.hub.waitTask(task.id, 8);
    assert.equal(done.status, "failed");
    assert.match(done.error, /模拟失败/);
    assert.equal(done.exitCode, 2);
  } finally {
    await ctx.cleanup();
  }
});

test("停止执行中的任务后队列继续跑下一个", async () => {
  const ctx = makeHub();
  try {
    const slow = ctx.hub.dispatch({ prompt: "SLOW_ME 长任务" });
    await waitFor(() => ctx.store.getTask(slow.id)?.status === "running");
    const next = ctx.hub.dispatch({ prompt: "第一个任务：排队后执行" });
    assert.equal(ctx.store.getTask(next.id).status, "queued");

    ctx.hub.stopTask(slow.id);
    const stopped = await ctx.hub.waitTask(slow.id, 8);
    assert.ok(["cancelled", "failed"].includes(stopped.status));
    const nextDone = await ctx.hub.waitTask(next.id, 8);
    assert.equal(nextDone.status, "completed");
  } finally {
    await ctx.cleanup();
  }
});

test("排队中的任务可以直接取消", async () => {
  const ctx = makeHub();
  try {
    const slow = ctx.hub.dispatch({ prompt: "SLOW_ME 占住员工" });
    await waitFor(() => ctx.store.getTask(slow.id)?.status === "running");
    const queued = ctx.hub.dispatch({ prompt: "第一个任务：本应被取消" });
    ctx.hub.stopTask(queued.id);
    const cancelled = ctx.store.getTask(queued.id);
    assert.equal(cancelled.status, "cancelled");
    ctx.hub.stopTask(slow.id);
    await ctx.hub.waitTask(slow.id, 8);
  } finally {
    await ctx.cleanup();
  }
});

test("工单阶段：失败进入「等你」，标记已处理后归入结束", async () => {
  const ctx = makeHub();
  try {
    const task = ctx.hub.dispatch({ prompt: "FAIL_ME 阶段测试" });
    const failed = await ctx.hub.waitTask(task.id, 8);
    assert.equal(failed.status, "failed");
    assert.equal(failed.stage, "waiting");
    assert.equal(ctx.store.counts().stages.waiting, 1);
    assert.equal(ctx.store.listTasks({ stage: "waiting" }).length, 1);
    assert.equal(ctx.store.listTasks({ stage: "done" }).length, 0);

    ctx.hub.acknowledgeTask(task.id);
    const acknowledged = ctx.store.getTask(task.id);
    assert.equal(acknowledged.status, "failed", "标记已处理不改变原始状态");
    assert.equal(stageOf(acknowledged), "done");
    assert.equal(ctx.store.listTasks({ stage: "waiting" }).length, 0);
    assert.equal(ctx.store.listTasks({ stage: "done" }).length, 1);
    const again = ctx.hub.acknowledgeTask(task.id);
    assert.equal(again.acknowledgedAt, acknowledged.acknowledgedAt, "重复标记已处理是幂等的");
  } finally {
    await ctx.cleanup();
  }
});

test("失败自动重试：第二次尝试成功", async () => {
  const counterDir = mkdtempSync(join(tmpdir(), "agent-hub-flaky-"));
  const ctx = makeHub({
    worker: {
      retry: { maxAttempts: 2, baseDelayMs: 30, maxDelayMs: 60 },
      env: { FAKE_COUNTER_FILE: join(counterDir, "count.txt"), FAKE_FAIL_TIMES: "1" },
    },
  });
  try {
    const task = ctx.hub.dispatch({ prompt: "FLAKY 自动重试测试" });
    const done = await ctx.hub.waitTask(task.id, 10);
    assert.equal(done.status, "completed");
    assert.equal(done.attempts, 2);
    assert.match(done.result, /FLAKY_OK:第 2 次尝试成功/);
    assert.ok(done.progress.some((entry) => /自动重试/.test(entry.message)));
    assert.equal(ctx.store.counts().stages.done, 1);
  } finally {
    await ctx.cleanup();
    rmSync(counterDir, { recursive: true, force: true });
  }
});

test("重试耗尽后停在 failed，人工重派会重置额度", async () => {
  const counterDir = mkdtempSync(join(tmpdir(), "agent-hub-flaky2-"));
  const ctx = makeHub({
    worker: {
      retry: { maxAttempts: 2, baseDelayMs: 20, maxDelayMs: 40 },
      env: { FAKE_COUNTER_FILE: join(counterDir, "count.txt"), FAKE_FAIL_TIMES: "5" },
    },
  });
  try {
    const task = ctx.hub.dispatch({ prompt: "FLAKY 重试耗尽测试" });
    const failed = await ctx.hub.waitTask(task.id, 10);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 2);
    assert.equal(failed.nextRetryAt, null);
    assert.match(failed.error, /第 2 次尝试失败/);
    assert.equal(failed.stage, "waiting");

    // 修好之后人工重派：额度重置、重新跑成功。
    ctx.workers["claude-main"].env.FAKE_FAIL_TIMES = "0";
    const requeued = ctx.hub.retryTask(task.id);
    assert.ok(["queued", "running"].includes(requeued.status));
    assert.equal(requeued.manualRetries, 1);
    const done = await ctx.hub.waitTask(task.id, 10);
    assert.equal(done.status, "completed");
    assert.equal(done.attempts, 1);
    assert.equal(done.manualRetries, 1);
  } finally {
    await ctx.cleanup();
    rmSync(counterDir, { recursive: true, force: true });
  }
});

test("配置类错误不自动重试", async () => {
  const ctx = makeHub({
    extraWorkers: {
      broken: {
        name: "坏员工",
        kind: "claude-cli",
        command: join(tmpdir(), "definitely-not-here", "claude.exe"),
        cwd: ROOT,
        retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20 },
      },
    },
  });
  try {
    const task = ctx.hub.dispatch({ workerId: "broken", prompt: "不该重试" });
    const failed = await ctx.hub.waitTask(task.id, 6);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.match(failed.error, /找不到/);
    assert.ok(!failed.progress.some((entry) => /自动重试/.test(entry.message)));
  } finally {
    await ctx.cleanup();
  }
});


test("预算截停：保留已产出的内容，落进「等你」，且不自动重试", async () => {
  const ctx = makeHub({ worker: { maxBudgetUsd: 2 } });
  try {
    const task = ctx.hub.dispatch({ prompt: "BUDGET_ME 预算上限测试" });
    const done = await ctx.hub.waitTask(task.id, 10);

    assert.equal(done.status, "failed");
    assert.equal(done.stage, "waiting", "预算截停要人看一眼，不能自己重试");
    assert.match(done.error, /预算上限/);
    assert.match(done.error, /12 轮/, "错误里要带上跑了多少轮");
    assert.match(done.result, /一半/, "已经产出的内容不能丢");
    assert.match(done.result, /budget=2/, "上限要真的传到 CLI");
    assert.equal(done.attempts, 1);
    assert.equal(done.usage.turns, 12);
    assert.equal(done.usage.costUsd, 2.5);
  } finally {
    await ctx.cleanup();
  }
});

test("没配预算上限时，不往 CLI 传 --max-budget-usd", async () => {
  const ctx = makeHub();
  try {
    const task = ctx.hub.dispatch({ prompt: "BUDGET_ME 但员工没配额" });
    const done = await ctx.hub.waitTask(task.id, 10);
    assert.match(done.result, /budget=null/);
    assert.equal(done.maxBudgetUsd, null);
  } finally {
    await ctx.cleanup();
  }
});

test("完成的任务带上归一化用量，且成本标明是会话累计", async () => {
  const ctx = makeHub();
  try {
    const task = ctx.hub.dispatch({ prompt: "普通任务，验证用量" });
    const done = await ctx.hub.waitTask(task.id, 10);
    assert.equal(done.status, "completed");
    assert.equal(done.usage.turns, 3);
    // 假的 CLI 顶层 usage 写的是 80 / 30，modelUsage 是 1200 / 640。
    // 必须取顶层那个（本次），不能拿会话累计。
    assert.equal(done.usage.inputTokens, 80);
    assert.equal(done.usage.outputTokens, 30);
    assert.equal(done.usage.costBasis, "estimate");
    assert.equal(done.usage.costScope, "session");
  } finally {
    await ctx.cleanup();
  }
});
