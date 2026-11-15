import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHubServer } from "../src/server.mjs";

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("HTTP API 与面板静态文件可用", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-hub-server-test-"));
  const config = {
    port: 0,
    dataDir: join(directory, "data"),
    workers: {
      "claude-main": {
        name: "Fake Claude",
        kind: "claude-cli",
        command: process.execPath,
        argsPrefix: [FAKE_CLAUDE],
        cwd: ROOT,
        permissionMode: "acceptEdits",
      },
    },
  };
  const { server, hub } = await createHubServer({ config });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/api/health`).then((response) => response.json());
    assert.equal(health.service, "dsh-agent-hub");
    assert.equal(health.workers[0].id, "claude-main");

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent Hub/);
    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);

    const dispatched = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "第一个任务：通过 HTTP 派发" }),
    });
    assert.equal(dispatched.status, 202);
    const created = await dispatched.json();
    assert.ok(created.task.id);

    const waited = await fetch(`${base}/api/tasks/${created.task.id}/wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeoutSeconds: 8 }),
    }).then((response) => response.json());
    assert.equal(waited.task.status, "completed");
    assert.match(waited.task.result, /RECEIVED:第一个任务/);

    const invalid = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await hub.stopAll();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("阶段筛选、标记已处理、重新派发接口可用", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-hub-server-stage-"));
  const config = {
    port: 0,
    dataDir: join(directory, "data"),
    workers: {
      "claude-main": {
        name: "Fake Claude",
        kind: "claude-cli",
        command: process.execPath,
        argsPrefix: [FAKE_CLAUDE],
        cwd: ROOT,
        permissionMode: "acceptEdits",
      },
    },
  };
  const { server, hub } = await createHubServer({ config });
  let base = "";
  const post = (path, body = {}) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.json());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;

    const created = await post("/api/tasks", { prompt: "FAIL_ME 接口阶段测试" });
    const waited = await post(`/api/tasks/${created.task.id}/wait`, { timeoutSeconds: 8 });
    assert.equal(waited.task.status, "failed");
    assert.equal(waited.task.stage, "waiting");

    const waiting = await fetch(`${base}/api/tasks?stage=waiting`).then((response) => response.json());
    assert.equal(waiting.tasks.length, 1);
    assert.equal(waiting.counts.stages.waiting, 1);

    const acknowledged = await post(`/api/tasks/${created.task.id}/ack`);
    assert.ok(acknowledged.task.acknowledgedAt);
    assert.equal(acknowledged.task.stage, "done");
    const stillWaiting = await fetch(`${base}/api/tasks?stage=waiting`).then((response) => response.json());
    assert.equal(stillWaiting.tasks.length, 0);

    const ok = await post("/api/tasks", { prompt: "第一个任务：重派用" });
    await post(`/api/tasks/${ok.task.id}/wait`, { timeoutSeconds: 8 });
    const requeued = await post(`/api/tasks/${ok.task.id}/retry`);
    assert.ok(["queued", "running"].includes(requeued.task.status));
    assert.equal(requeued.task.manualRetries, 1);
    const rerun = await post(`/api/tasks/${ok.task.id}/wait`, { timeoutSeconds: 8 });
    assert.equal(rerun.task.status, "completed");
    assert.equal(rerun.task.stage, "done");

    const notWaiting = await fetch(`${base}/api/tasks/${ok.task.id}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(notWaiting.status, 400);
  } finally {
    await hub.stopAll();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
