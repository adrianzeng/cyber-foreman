import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kimi, { buildArgs as buildKimiArgs } from "../src/adapters/kimi.mjs";
import doubao, { buildArgs as buildDoubaoArgs } from "../src/adapters/doubao.mjs";
import { adapterKinds, getAdapter } from "../src/adapters/index.mjs";
import { CLI_PROBES, detectCliCommand } from "../src/fsutil.mjs";
import { TaskStore } from "../src/store.mjs";
import { AgentHub } from "../src/hub.mjs";

test("v0.9.0 注册表与 CLI_PROBES 包含 kimi-cli 和 doubao-cli", () => {
  assert.ok(adapterKinds().includes("kimi-cli"));
  assert.ok(adapterKinds().includes("doubao-cli"));
  assert.equal(getAdapter("kimi-cli").label, "Kimi");
  assert.equal(getAdapter("doubao-cli").label, "Doubao");
  assert.ok(CLI_PROBES["kimi-cli"]);
  assert.ok(CLI_PROBES["doubao-cli"]);

  const dir = mkdtempSync(join(tmpdir(), "agent-hub-kimi-doubao-probe-"));
  try {
    const kimiExe = join(dir, "kimi.exe");
    const doubaoExe = join(dir, "doubao.exe");
    writeFileSync(kimiExe, "", "utf8");
    writeFileSync(doubaoExe, "", "utf8");

    const k = detectCliCommand("kimi-cli", { platform: "win32", env: { PATH: dir }, homeDir: dir });
    assert.equal(k.found, true);
    assert.equal(k.command, kimiExe);

    const d = detectCliCommand("doubao-cli", { platform: "win32", env: { PATH: dir }, homeDir: dir });
    assert.equal(d.found, true);
    assert.equal(d.command, doubaoExe);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kimi-cli 与 doubao-cli 参数组装与权限边界正确", () => {
  const kArgs = buildKimiArgs(
    { permissionMode: "accept-edits", model: "kimi-k2" },
    { prompt: "写接口文档", cwd: "E:\\repo", newSession: false, resumeSessionId: "ks-1" },
  );
  assert.ok(kArgs.includes("--print"));
  assert.equal(kArgs[kArgs.indexOf("--work-dir") + 1], "E:\\repo");
  assert.equal(kArgs[kArgs.indexOf("--model") + 1], "kimi-k2");
  assert.equal(kArgs[kArgs.indexOf("--session") + 1], "ks-1");
  assert.ok(!kArgs.includes("--yolo"), "默认模式不传 --yolo");

  const kAuto = buildKimiArgs(
    { permissionMode: "auto" },
    { prompt: "跑单测", cwd: "E:\\repo", readOnly: false },
  );
  assert.ok(kAuto.includes("--yolo"));

  const kSide = buildKimiArgs(
    { permissionMode: "auto" },
    { prompt: "只读侧问", cwd: "E:\\repo", readOnly: true },
  );
  assert.ok(!kSide.includes("--yolo"), "只读侧问绝不传 --yolo");

  const dArgs = buildDoubaoArgs(
    { permissionMode: "accept-edits", model: "doubao-seed-code", addDirs: ["E:\\ref"] },
    { prompt: "重构组件", cwd: "E:\\repo", newSession: false, resumeSessionId: "db-9" },
  );
  assert.equal(dArgs[0], "-p");
  assert.equal(dArgs[dArgs.indexOf("--mode") + 1], "accept-edits");
  assert.equal(dArgs[dArgs.indexOf("--model") + 1], "doubao-seed-code");
  assert.equal(dArgs[dArgs.indexOf("--resume") + 1], "db-9");
  assert.equal(dArgs[dArgs.indexOf("--add-dir") + 1], "E:\\ref");

  const dSide = buildDoubaoArgs(
    { permissionMode: "auto" },
    { prompt: "只读侧问", cwd: "E:\\repo", readOnly: true },
  );
  assert.equal(dSide[dSide.indexOf("--mode") + 1], "plan");
});

test("kimi-cli（JSONL）与 doubao-cli（纯文本兜底）假 CLI 端到端闭环", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-kd-e2e-"));
  const fakeKimi = join(dir, "fake-kimi.mjs");
  const fakeDoubao = join(dir, "fake-doubao.mjs");

  writeFileSync(
    fakeKimi,
    [
      'process.stdout.write(JSON.stringify({ type: "system", session_id: "kimi-sess-7" }) + "\\n");',
      'process.stdout.write(JSON.stringify({ type: "tool_use", name: "Read" }) + "\\n");',
      'process.stdout.write(JSON.stringify({ type: "result", session_id: "kimi-sess-7", response: "KIMI_DONE", usage: { input_tokens: 300, output_tokens: 80 } }) + "\\n");',
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    fakeDoubao,
    [
      'process.stdout.write("DOUBAO_PLAIN_LINE_1\\nDOUBAO_PLAIN_LINE_2\\n");',
    ].join("\n"),
    "utf8",
  );

  const store = new TaskStore(join(dir, "data")).init();
  const hub = new AgentHub({
    store,
    workers: {
      "kimi-1": {
        name: "Kimi 员工",
        kind: kimi.kind,
        command: process.execPath,
        argsPrefix: [fakeKimi],
        cwd: dir,
        permissionMode: "accept-edits",
      },
      "doubao-1": {
        name: "Doubao 员工",
        kind: doubao.kind,
        command: process.execPath,
        argsPrefix: [fakeDoubao],
        cwd: dir,
        permissionMode: "accept-edits",
      },
    },
  });

  try {
    const tk = hub.dispatch({ workerId: "kimi-1", prompt: "分析目录" });
    const td = hub.dispatch({ workerId: "doubao-1", prompt: "整理要点" });
    const [rk, rd] = await Promise.all([hub.waitTask(tk.id, 8), hub.waitTask(td.id, 8)]);

    assert.equal(rk.status, "completed");
    assert.equal(rk.sessionId, "kimi-sess-7");
    assert.equal(rk.result, "KIMI_DONE");
    assert.equal(rk.usage.outputTokens, 80);

    assert.equal(rd.status, "completed");
    assert.equal(rd.result, "DOUBAO_PLAIN_LINE_1\nDOUBAO_PLAIN_LINE_2");
  } finally {
    await hub.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
