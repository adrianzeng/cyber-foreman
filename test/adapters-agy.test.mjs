import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agy, { buildArgs, finalize, normalizeMode, parseLine } from "../src/adapters/agy.mjs";
import { TaskStore } from "../src/store.mjs";
import { AgentHub } from "../src/hub.mjs";

test("Antigravity 品牌标签与默认参数严格对齐 agy --help 规范", () => {
  assert.equal(agy.kind, "agy-cli");
  assert.equal(agy.label, "Antigravity");
  assert.equal(agy.defaultCommand, "agy");
  assert.equal(agy.defaultPermissionMode, "accept-edits");
  assert.doesNotMatch(agy.steerHint, /反重力/);

  assert.equal(normalizeMode("acceptEdits"), "accept-edits");
  assert.equal(normalizeMode("read-only"), "plan");
  assert.equal(normalizeMode("auto"), "auto");

  const args = buildArgs(
    {
      argsPrefix: [],
      permissionMode: "accept-edits",
      model: "gemini-4-neon-medium",
      effort: "high",
      addDirs: ["E:\\extra-a", "E:\\extra-b"],
    },
    {
      prompt: "检查 README",
      cwd: "C:\\work\\cyber-foreman",
      newSession: false,
      resumeSessionId: "conv-123",
      readOnly: false,
    },
  );

  assert.equal(args[0], "-p");
  assert.match(args[1], /Antigravity 员工/);
  assert.match(args[1], /检查 README/);
  assert.ok(args.includes("--output-format"));
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--mode") + 1], "accept-edits");
  assert.equal(args[args.indexOf("--model") + 1], "gemini-4-neon-medium");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args[args.indexOf("--conversation") + 1], "conv-123");
  assert.ok(!args.includes("--dangerously-skip-permissions"), "绝不静默跳过权限审批");

  const addDirIndices = args.reduce((acc, item, i) => (item === "--add-dir" ? [...acc, args[i + 1]] : acc), []);
  assert.deepEqual(addDirIndices, ["E:\\extra-a", "E:\\extra-b"]);

  // 显式选择 auto（非只读）时允许附带 --dangerously-skip-permissions 以解决 Windows 无终端沙箱退回问题
  const autoArgs = buildArgs(
    { permissionMode: "auto" },
    { prompt: "列出目录", readOnly: false },
  );
  assert.equal(autoArgs[autoArgs.indexOf("--mode") + 1], "auto");
  assert.ok(autoArgs.includes("--dangerously-skip-permissions"));

  // 非法 effort 不传给 agy，且只读侧问即使在 auto 员工下也强制 plan 且绝不跳过审批
  const safeArgs = buildArgs(
    { permissionMode: "auto", effort: "turbo-invalid" },
    { prompt: "测试只读侧问", readOnly: true, newSession: true, resumeSessionId: "conv-old" },
  );
  assert.equal(safeArgs[safeArgs.indexOf("--mode") + 1], "plan", "侧问强制降级为 plan");
  assert.ok(!safeArgs.includes("--dangerously-skip-permissions"), "只读侧问绝不跳过审批");
  assert.ok(!safeArgs.includes("--effort"));
  assert.ok(!safeArgs.includes("--conversation"));
});

test("Antigravity stream-json 解析：init / step_update / denied_actions 无头拦截不再静默成功", () => {
  const events = [];
  const sessions = [];
  const state = {
    sessionId: null,
    lastAssistant: "",
    finalEvent: null,
    stderrTail: 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.',
    seenTools: new Set(),
    usage: null,
  };
  const ctx = {
    progress: (message, type = "progress") => events.push({ message, type }),
    hooks: { onSession: (id) => sessions.push(id) },
  };

  parseLine({ event: "init", conversation_id: "conv-abc" }, state, ctx);
  parseLine({
    event: "step_update",
    step_update: { conversation_id: "conv-abc", step_type: "tool", state: "ACTIVE", tool_name: "run_command" },
  }, state, ctx);
  parseLine({
    event: "step_update",
    step_update: {
      conversation_id: "conv-abc",
      step_type: "tool",
      state: "ERROR",
      tool_name: "run_command",
      tool_info: { error: { message: "permission check failed for unsandboxed command" } },
    },
  }, state, ctx);
  parseLine({
    event: "result",
    result: {
      conversation_id: "conv-abc",
      status: "SUCCESS",
      response: "",
      num_turns: 1,
      usage: { input_tokens: 8683, output_tokens: 205, thinking_tokens: 92, cache_read_tokens: 0 },
      denied_actions: [{ action: "command", display_name: "Bash" }],
    },
  }, state, ctx);

  assert.deepEqual(sessions, ["conv-abc"]);
  assert.ok(events.some((e) => e.message === "Antigravity 会话已建立"));
  assert.ok(events.some((e) => e.message === "调用工具：run_command"));
  assert.ok(events.some((e) => e.type === "warn" && /run_command/.test(e.message)));

  const out = finalize(state, 0);
  assert.equal(out.isError, true, "无头权限拦截导致的空响应必须标错，不能静默 completed");
  assert.equal(out.retryable, false, "无头权限拦截为确定性策略拒绝，不应自动重试浪费额度");
  assert.match(out.error, /Bash/);
  assert.match(out.error, /放开审批/);
  assert.equal(out.usage.inputTokens, 8683);
  assert.equal(out.usage.outputTokens, 205);
  assert.equal(out.usage.thinkingTokens, 92);
  assert.equal(out.usage.turns, 1);
});

test("Antigravity 假 CLI 端到端派活：参数正确传递、拿到回复与归一化用量", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-agy-e2e-"));
  const fakeAgy = join(dir, "fake-agy.mjs");
  writeFileSync(
    fakeAgy,
    [
      'const args = process.argv.slice(2);',
      'const pIdx = args.indexOf("-p");',
      'const prompt = pIdx >= 0 ? args[pIdx + 1] : "";',
      'const mode = args[args.indexOf("--mode") + 1];',
      'const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");',
      'out({ event: "init", conversation_id: "agy-conv-42" });',
      'out({ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "read_file" } });',
      'out({ event: "result", result: { conversation_id: "agy-conv-42", status: "SUCCESS", num_turns: 2, response: `MODE=${mode};CWD=${process.cwd()};OK=${prompt.includes("检查项目")}`, usage: { input_tokens: 500, output_tokens: 120, thinking_tokens: 30, cache_read_tokens: 100 } } });',
    ].join("\n"),
    "utf8",
  );

  const store = new TaskStore(join(dir, "data")).init();
  const hub = new AgentHub({
    store,
    workers: {
      "agy-1": {
        name: "AGY测试员",
        kind: "agy-cli",
        command: process.execPath,
        argsPrefix: [fakeAgy],
        cwd: dir,
        permissionMode: "auto",
      },
    },
  });

  try {
    const task = hub.dispatch({ workerId: "agy-1", prompt: "检查项目结构" });
    const done = await hub.waitTask(task.id, 8);
    assert.equal(done.status, "completed");
    assert.equal(done.sessionId, "agy-conv-42");
    assert.match(done.result, /MODE=auto/);
    assert.match(done.result, /OK=true/);
    assert.equal(done.usage.inputTokens, 500);
    assert.equal(done.usage.outputTokens, 120);
    assert.equal(done.usage.turns, 2);
  } finally {
    await hub.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
