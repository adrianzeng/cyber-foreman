import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../src/store.mjs";
import { AgentHub } from "../src/hub.mjs";
import { runStream } from "../src/adapters/shared.mjs";
import { listAdapters } from "../src/adapters/index.mjs";
import claudeAdapter from "../src/adapters/claude.mjs";

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
  const directory = tempDir("agent-hub-steer-");
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
      streamInput: true,
      // 测试里把空闲收口调短，不然每个用例都要等 3 秒。
      steerIdleMs: 400,
      ...(options.worker || {}),
    },
    ...(options.extraWorkers || {}),
  };
  const hub = new AgentHub({ store, workers, steerWatchdogMs: options.steerWatchdogMs ?? 0 });
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

/** 直接造一个指定状态的任务，用来验证状态拒绝矩阵（不需要真进程）。 */
function seedTask(store, status) {
  const task = store.createTask({
    workerId: "claude-1",
    kind: "claude-cli",
    title: `状态 ${status}`,
    prompt: "占位",
    cwd: ROOT,
  });
  if (status !== "queued") {
    store.updateTask(task.id, {
      status,
      startedAt: new Date().toISOString(),
      finishedAt: ["completed", "failed", "cancelled", "interrupted", "waiting"].includes(status)
        ? new Date().toISOString()
        : null,
    });
  }
  return store.getTask(task.id);
}

test("能力矩阵：只有 Claude 声明 supportsSteer，Codex/Antigravity 给出中文理由", () => {
  const adapters = listAdapters();
  const claude = adapters.find((item) => item.kind === "claude-cli");
  const codex = adapters.find((item) => item.kind === "codex-cli");
  const agy = adapters.find((item) => item.kind === "agy-cli");

  assert.equal(claude.supportsSteer, true);
  assert.match(claude.steerHint, /允许插话/);
  assert.equal(codex.supportsSteer, false);
  assert.match(codex.steerHint, /一次性执行|没法中途插话/);
  assert.equal(agy.supportsSteer, false);
  assert.match(agy.steerHint, /一次性执行|插不进/);

  const ctx = makeHub();
  return (async () => {
    try {
      const caps = ctx.hub.capabilities();
      assert.equal(caps.adapters.find((item) => item.kind === "claude-cli").supportsSteer, true);

      const worker = ctx.hub.listWorkers().find((item) => item.id === "claude-1");
      assert.equal(worker.supportsSteer, true);
      assert.equal(worker.streamInput, true);
      assert.equal(worker.steerable, true);

      // 没打开「允许插话」：类型支持也不能插，且 tooltip 要说清原因
      ctx.hub.replaceWorkers({
        ...ctx.workers,
        "claude-1": { ...ctx.workers["claude-1"], streamInput: false },
      });
      const off = ctx.hub.listWorkers().find((item) => item.id === "claude-1");
      assert.equal(off.supportsSteer, true);
      assert.equal(off.steerable, false);
      assert.match(off.steerHint, /允许插话/);
    } finally {
      await ctx.cleanup();
    }
  })();
});

test("状态拒绝矩阵：每种状态都有专属中文提示和错误码，绝不静默", async () => {
  const ctx = makeHub();
  try {
    const cases = {
      queued: /还在排队/,
      retrying: /等自动重试/,
      cancelling: /正在停止/,
      waiting: /已经停下|在等你/,
      failed: /已经停下/,
      interrupted: /已经停下/,
      completed: /已经结束/,
      cancelled: /已取消/,
    };
    for (const [status, pattern] of Object.entries(cases)) {
      const task = seedTask(ctx.store, status);
      await assert.rejects(
        () => ctx.hub.steerTask(task.id, "再改一下"),
        (error) => {
          assert.equal(error.code, "STEER_NOT_RUNNING", `${status} 应该是 STEER_NOT_RUNNING`);
          assert.ok(error.message.length > 4, `${status} 必须有中文原因`);
          assert.match(error.message, pattern, `${status} 的提示应能指导下一步`);
          // 文案会同时出现在手机 IM 和 Web 面板上，面板里没有输入框发斜杠命令，
          // 所以这些提示里不允许出现 `/xxx`。
          assert.equal(error.message.includes("/"), false, `${status} 的提示不能带斜杠命令`);
          return true;
        },
      );
    }
  } finally {
    await ctx.cleanup();
  }
});

test("参数校验：NO_TASK / STEER_EMPTY / STEER_TOO_LONG 都有码和中文", async () => {
  const ctx = makeHub();
  try {
    await assert.rejects(
      () => ctx.hub.steerTask("task_not_exist", "内容"),
      (error) => error.code === "NO_TASK" && /没有找到/.test(error.message),
    );
    const running = seedTask(ctx.store, "running");
    await assert.rejects(
      () => ctx.hub.steerTask(running.id, "   "),
      (error) => error.code === "STEER_EMPTY",
    );
    await assert.rejects(
      () => ctx.hub.steerTask(running.id, "字".repeat(4001)),
      (error) => error.code === "STEER_TOO_LONG" && /4000/.test(error.message),
    );
  } finally {
    await ctx.cleanup();
  }
});

test("类型不支持：Codex 返回 STEER_UNSUPPORTED + fallback:side；没开开关也说清楚", async () => {
  const ctx = makeHub({
    worker: { streamInput: false },
    extraWorkers: {
      "codex-1": {
        name: "Codex 一号",
        kind: "codex-cli",
        command: process.execPath,
        argsPrefix: [],
        cwd: ROOT,
        streamInput: true,
      },
    },
  });
  try {
    // Claude 没开「允许插话」
    const claudeTask = seedTask(ctx.store, "running");
    await assert.rejects(
      () => ctx.hub.steerTask(claudeTask.id, "追加一句"),
      (error) => {
        assert.equal(error.code, "STEER_UNSUPPORTED");
        assert.equal(error.fallback, "side");
        assert.match(error.message, /允许插话/);
        return true;
      },
    );

    // Codex 就算开了开关也不行（结构上不支持）
    const codexTask = ctx.store.createTask({
      workerId: "codex-1",
      kind: "codex-cli",
      title: "Codex 任务",
      prompt: "占位",
      cwd: ROOT,
    });
    ctx.store.updateTask(codexTask.id, { status: "running", startedAt: new Date().toISOString() });
    await assert.rejects(
      () => ctx.hub.steerTask(codexTask.id, "追加一句"),
      (error) => {
        assert.equal(error.code, "STEER_UNSUPPORTED");
        assert.equal(error.fallback, "side");
        assert.match(error.message, /Codex 不支持插话/);
        return true;
      },
    );
  } finally {
    await ctx.cleanup();
  }
});

test("流式闭环：派活 → 插话 2 条 → 收口 → completed，attempts 不变、三处记录齐全", async () => {
  const ctx = makeHub();
  try {
    const task = ctx.hub.dispatch({ prompt: "第一个任务：流式闭环" });
    await waitFor(() => ctx.hub.steerables.has(task.id), 10_000, "流式句柄就绪");
    assert.equal(ctx.store.getTask(task.id).status, "running");

    const first = await ctx.hub.steerTask(task.id, "把图也换掉", { source: "panel" });
    assert.equal(first.delivered, "steer");
    assert.equal(first.warning, null);
    const second = await ctx.hub.steerTask(task.id, "再加一段说明", {
      source: "telegram",
      actor: { chatId: "tg:1", senderName: "@ade" },
    });
    assert.equal(second.delivered, "steer");

    const done = await ctx.hub.waitTask(task.id, 15);
    assert.equal(done.status, "completed");
    // 3 轮：首条 prompt + 两条插话
    assert.match(done.result, /TURN 3/);
    assert.match(done.result, /再加一段说明/);
    assert.equal(done.attempts, 1, "插话不是重试，attempts 不能变");
    assert.equal(done.steerCount, 2);
    assert.equal(done.steers.length, 2);
    assert.equal(done.steers[1].source, "telegram");
    assert.equal(done.steers[1].actor.senderName, "@ade");
    assert.equal(done.steers[0].delivered, true);
    assert.ok(done.progress.some((item) => item.message.startsWith("主控插话：把图也换掉")));

    // events.jsonl 里也要能 grep 到
    const events = readFileSync(join(ctx.dataDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const steerEvents = events.filter((event) => event.type === "steer");
    assert.equal(steerEvents.length, 2);
    assert.equal(steerEvents[0].source, "panel");
    assert.equal(steerEvents[1].chatId, "tg:1");

    // 用量/耗时统计照旧（cost 来自最后一轮 result）
    assert.ok(done.usage);
    assert.equal(done.usage.turns, 3);
  } finally {
    await ctx.cleanup();
  }
});

test("串行写：3 条插话同时发也不交错，轮次顺序正确", async () => {
  const ctx = makeHub({ worker: { steerIdleMs: 800 } });
  try {
    const task = ctx.hub.dispatch({ prompt: "第一个任务：串行写" });
    await waitFor(() => ctx.hub.steerables.has(task.id), 10_000, "流式句柄就绪");

    const results = await Promise.all([
      ctx.hub.steerTask(task.id, "第一条"),
      ctx.hub.steerTask(task.id, "第二条"),
      ctx.hub.steerTask(task.id, "第三条"),
    ]);
    assert.equal(results.length, 3);
    for (const result of results) assert.equal(result.delivered, "steer");

    const done = await ctx.hub.waitTask(task.id, 15);
    assert.equal(done.status, "completed");
    assert.match(done.result, /TURN 4/);
    assert.equal(done.steers.length, 3);
    assert.deepEqual(done.steers.map((item) => item.text), ["第一条", "第二条", "第三条"]);
  } finally {
    await ctx.cleanup();
  }
});

test("写 stdin 失败 → STEER_WRITE_FAILED（模拟进程已退出）", async () => {
  const ctx = makeHub();
  try {
    const task = ctx.hub.dispatch({ prompt: "第一个任务：写失败" });
    await waitFor(() => ctx.hub.steerables.has(task.id), 10_000, "流式句柄就绪");
    const live = ctx.hub.steerables.get(task.id);
    ctx.hub.steerables.set(task.id, { ...live, steer: async () => ({ ok: false, error: "员工进程已经结束，插话没送进去" }) });
    await assert.rejects(
      () => ctx.hub.steerTask(task.id, "写不进去"),
      (error) => {
        assert.equal(error.code, "STEER_WRITE_FAILED");
        assert.match(error.message, /插话没送进去/);
        return true;
      },
    );
  } finally {
    await ctx.cleanup();
  }
});

test("runStream: streamInput=false 时返回值里没有 steer；true 时写失败要报中文", async () => {
  const task = { cwd: ROOT, resumeSessionId: null, prompt: "hello" };
  const hooks = { onProgress() {}, onLog() {}, onSession() {} };
  const parseLine = () => {};
  const finalize = () => ({ isError: false, result: "" });

  const plain = runStream({
    worker: { command: process.execPath, argsPrefix: ["-e", ""], env: {} },
    task,
    hooks,
    args: ["-e", ""],
    input: "",
    parseLine,
    finalize,
  });
  assert.equal(typeof plain.steer, "undefined", "默认关闭时不能暴露 steer");
  assert.equal(typeof plain.latestResult, "undefined");
  await plain.done;

  const failed = runStream({
    worker: { command: process.execPath, argsPrefix: ["-e", ""], env: {} },
    task,
    hooks,
    args: ["-e", ""],
    input: "",
    parseLine,
    finalize,
    streamInput: true,
  });
  await failed.done;
  const result = await failed.steer("再写一句");
  assert.equal(result.ok, false);
  assert.match(result.error, /插话没送进去/);
});

test("预算告警：超过 80% 时返回 warning 但不阻止插话", async () => {
  const ctx = makeHub({
    worker: { maxBudgetUsd: 4, env: { FAKE_COST_USD: "3.5" }, steerIdleMs: 800 },
  });
  try {
    const task = ctx.hub.dispatch({ prompt: "第一个任务：预算告警" });
    await waitFor(() => ctx.hub.steerables.has(task.id), 10_000, "流式句柄就绪");
    await waitFor(() => {
      const live = ctx.hub.steerables.get(task.id);
      const usage = live?.usage?.();
      return usage && usage.costUsd > 0 ? usage : null;
    }, 10_000, "第一轮 result 到达");

    const result = await ctx.hub.steerTask(task.id, "继续加活");
    assert.equal(result.delivered, "steer", "预算告警不能阻止插话");
    assert.ok(result.warning, "必须给 warning");
    assert.match(result.warning, /已用 \$3\.5/);
    assert.match(result.warning, /上限 \$4\.0/);
    assert.match(result.warning, /到顶就停/);
  } finally {
    await ctx.cleanup();
  }
});

test("90 秒无响应保护：插话后没有新输出只提醒，不杀进程", async () => {
  const ctx = makeHub({ steerWatchdogMs: 120, worker: { steerIdleMs: 5000 } });
  try {
    const task = ctx.hub.dispatch({ prompt: "第一个任务：无响应" });
    await waitFor(() => ctx.hub.steerables.has(task.id), 10_000, "流式句柄就绪");
    // 先等第一轮跑完：否则 baseline 还是 0，第一轮的结果会被当成"插话后的新输出"。
    await waitFor(() => (ctx.hub.turnCounts.get(task.id) || 0) >= 1, 10_000, "第一轮完成");
    await ctx.hub.steerTask(task.id, "SILENT 这句不要回应");

    const warned = await waitFor(
      () => ctx.store.getTask(task.id).progress.find((item) => /没有新输出/.test(item.message)),
      10_000,
      "无响应提醒",
    );
    assert.match(warned.message, /员工可能没在响应/);
    assert.equal(ctx.store.getTask(task.id).status, "running", "只提醒，不自动杀");
  } finally {
    await ctx.cleanup();
  }
});

test("Claude 适配器：只读侧问走 plan 且不开流式；普通任务才加 --input-format", async () => {
  const directory = tempDir("agent-hub-steer-args-");
  const argsFile = join(directory, "args.json");
  const hooks = { onProgress() {}, onLog() {}, onSession() {} };
  try {
    const worker = {
      command: process.execPath,
      argsPrefix: [STREAM_STUB],
      cwd: ROOT,
      permissionMode: "acceptEdits",
      streamInput: true,
      env: { FAKE_ARGS_FILE: argsFile, FAKE_SILENT_FILE: join(directory, "silent.log") },
    };

    // 普通流式任务
    const mainLaunched = claudeAdapter.start(worker, {
      cwd: ROOT,
      prompt: "hello",
      newSession: true,
      resumeSessionId: null,
      readOnly: false,
    }, hooks);
    await waitFor(() => {
      try {
        return JSON.parse(readFileSync(argsFile, "utf8"));
      } catch {
        return null;
      }
    }, 5000, "参数落盘");
    const mainArgs = JSON.parse(readFileSync(argsFile, "utf8"));
    assert.ok(mainArgs.includes("--input-format"));
    assert.ok(mainArgs.includes("stream-json"));
    assert.equal(mainArgs[mainArgs.indexOf("--permission-mode") + 1], "acceptEdits");
    mainLaunched.closeInput?.();
    await mainLaunched.done;

    // 只读侧问：plan 权限、不开流式（避免进程一直等 stdin）
    const sideLaunched = claudeAdapter.start(worker, {
      cwd: ROOT,
      prompt: "侧问",
      newSession: true,
      resumeSessionId: null,
      readOnly: true,
    }, hooks);
    await waitFor(() => {
      try {
        const args = JSON.parse(readFileSync(argsFile, "utf8"));
        return args.includes("--permission-mode") && args[args.indexOf("--permission-mode") + 1] === "plan";
      } catch {
        return null;
      }
    }, 5000, "侧问参数落盘");
    const sideArgs = JSON.parse(readFileSync(argsFile, "utf8"));
    assert.equal(sideArgs[sideArgs.indexOf("--permission-mode") + 1], "plan");
    assert.equal(sideArgs.includes("--input-format"), false, "侧问不该开流式输入");
    assert.equal(typeof sideLaunched.steer, "undefined");
    await sideLaunched.done;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
