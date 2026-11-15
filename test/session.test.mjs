import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../src/store.mjs";

function makeStore() {
  const directory = mkdtempSync(join(tmpdir(), "hub-session-"));
  const store = new TaskStore(join(directory, "data")).init();
  return {
    store,
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("会话按员工+目录隔离：换项目目录不会继承上一个项目的记忆", () => {
  const ctx = makeStore();
  try {
    ctx.store.setWorkerSession("w1", "C:/proj-a", "sess-a");
    assert.equal(ctx.store.getWorkerSession("w1", "C:/proj-a"), "sess-a");
    // 关键：同一个员工在另一个目录下必须是干净的开始。
    assert.equal(ctx.store.getWorkerSession("w1", "C:/proj-b"), null);
    // 不同员工同目录也不共享。
    assert.equal(ctx.store.getWorkerSession("w2", "C:/proj-a"), null);
  } finally {
    ctx.cleanup();
  }
});

test("同一员工在同一目录下继续沿用会话", () => {
  const ctx = makeStore();
  try {
    ctx.store.setWorkerSession("w1", "C:/proj-a", "sess-1");
    ctx.store.setWorkerSession("w1", "C:/proj-a", "sess-2");
    assert.equal(ctx.store.getWorkerSession("w1", "C:/proj-a"), "sess-2");
    assert.equal(ctx.store.listWorkerSessions().length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("旧格式（只按员工存）的会话会按最近任务的目录归位", () => {
  const ctx = makeStore();
  try {
    const task = ctx.store.createTask({
      workerId: "w1",
      kind: "claude-cli",
      title: "老任务",
      prompt: "老任务",
      cwd: "C:/legacy-proj",
    });
    // 模拟升级前的 state.json：sessions 直接挂在员工 id 上。
    writeFileSync(
      ctx.store.stateFile,
      JSON.stringify({ sessions: { w1: "sess-legacy" } }, null, 2),
      "utf8",
    );

    const reopened = new TaskStore(ctx.store.dataDir).init();
    assert.equal(reopened.getWorkerSession("w1", "C:/legacy-proj"), "sess-legacy");
    assert.equal(reopened.getWorkerSession("w1", "C:/other"), null);
    assert.ok(task.id);
  } finally {
    ctx.cleanup();
  }
});

test("可以主动忘掉某个目录下的记忆", () => {
  const ctx = makeStore();
  try {
    ctx.store.setWorkerSession("w1", "C:/proj-a", "sess-a");
    assert.equal(ctx.store.forgetWorkerSession("w1", "C:/proj-a"), true);
    assert.equal(ctx.store.getWorkerSession("w1", "C:/proj-a"), null);
    assert.equal(ctx.store.forgetWorkerSession("w1", "C:/proj-a"), false);
  } finally {
    ctx.cleanup();
  }
});
