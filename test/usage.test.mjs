import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fromClaude, fromCodex, formatTokens, describeUsage, isBudgetExhausted } from "../src/usage.mjs";
import { TaskStore, startOfToday } from "../src/store.mjs";

test("Claude 用量优先读顶层 usage（本次），不被会话累计值带偏", () => {
  // 真实情况：续接会话时 modelUsage 和 total_cost_usd 是整个会话的累计值，
  // 顶层 usage 才是这一次的量。必须用后者。
  const usage = fromClaude({
    num_turns: 10,
    total_cost_usd: 6.005,
    usage: { input_tokens: 12000, output_tokens: 3481, cache_read_input_tokens: 1463168 },
    modelUsage: {
      "deepseek-flash[1m]": {
        inputTokens: 69480,
        outputTokens: 90792,
        cacheReadInputTokens: 6628608,
        thinkingTokens: 51470,
        costUSD: 6.005,
      },
    },
  });
  assert.equal(usage.turns, 10);
  assert.equal(usage.outputTokens, 3481, "要的是本次，不是会话累计的 90792");
  assert.equal(usage.inputTokens, 12000);
  assert.equal(usage.cacheReadTokens, 1463168);
  assert.equal(usage.costScope, "session", "金额是会话累计，必须标出来");
});

test("顶层 usage 全 0 时才退回 modelUsage 兜底", () => {
  // 预算截停时 CLI 的顶层 usage 可能是空的，但 modelUsage 有数。
  const usage = fromClaude({
    num_turns: 76,
    total_cost_usd: 5.11,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {
      "deepseek-flash[1m]": {
        inputTokens: 69480,
        outputTokens: 87311,
        cacheReadInputTokens: 5165440,
        thinkingTokens: 49534,
        costUSD: 5.11,
      },
    },
  });
  assert.equal(usage.turns, 76);
  assert.equal(usage.inputTokens, 69480);
  assert.equal(usage.outputTokens, 87311);
  assert.equal(usage.cacheReadTokens, 5165440);
  assert.equal(usage.thinkingTokens, 49534);
});

test("没有 modelUsage 时直接用顶层 usage", () => {
  const usage = fromClaude({
    num_turns: 5,
    total_cost_usd: 0.02,
    usage: { input_tokens: 800, output_tokens: 300, cache_read_input_tokens: 1200 },
  });
  assert.equal(usage.inputTokens, 800);
  assert.equal(usage.outputTokens, 300);
  assert.equal(usage.cacheReadTokens, 1200);
  assert.equal(usage.turns, 5);
});

test("用量全是 0 或缺失时返回 null，不制造假数据", () => {
  assert.equal(fromClaude(null), null);
  assert.equal(fromClaude({ usage: { input_tokens: 0, output_tokens: 0 } }), null);
  assert.equal(fromClaude({ modelUsage: {} }), null);
});

test("Codex 的字段名被正确映射", () => {
  const usage = fromCodex({
    input_tokens: 66006,
    cached_input_tokens: 62976,
    output_tokens: 856,
    reasoning_output_tokens: 297,
  });
  assert.equal(usage.inputTokens, 66006);
  assert.equal(usage.cacheReadTokens, 62976);
  assert.equal(usage.outputTokens, 856);
  assert.equal(usage.thinkingTokens, 297);
  assert.equal(usage.turns, null, "Codex 不报轮数，不能编一个");
  assert.equal(fromCodex(null), null);
});

test("预算截停能被识别出来", () => {
  assert.equal(isBudgetExhausted({ budgetExhausted: true, usage: null }), true);
  assert.equal(isBudgetExhausted({ budgetExhausted: false, usage: { terminalReason: "budget_exhausted" } }), true);
  assert.equal(isBudgetExhausted({ budgetExhausted: false, usage: { terminalReason: "end_turn" } }), false);
  assert.equal(isBudgetExhausted(null), false);
});

test("token 数量按万压缩，描述里带上思考量", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(856), "856");
  assert.equal(formatTokens(87311), "87.3k");
  assert.equal(formatTokens(5165440), "5.2M");
  const text = describeUsage({ turns: 76, outputTokens: 87311, thinkingTokens: 49534, inputTokens: 69480, cacheReadTokens: 5165440 });
  assert.match(text, /76 轮/);
  assert.match(text, /含思考 49.5k/);
  assert.match(text, /5.2M/);
});

test("今日用量统计：只算今天、能按员工分、兼容旧格式", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-usage-"));
  try {
    const store = new TaskStore(join(directory, "data")).init();

    // 新格式：今天的任务
    const fresh = store.createTask({ workerId: "w1", kind: "claude-cli", title: "新", prompt: "新", cwd: directory });
    store.updateTask(fresh.id, {
      status: "completed",
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date().toISOString(),
      usage: { turns: 3, inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, thinkingTokens: 50, costUsd: 0.01 },
    });

    // 旧格式：升级前存的原始 usage
    const legacy = store.createTask({ workerId: "w1", kind: "claude-cli", title: "旧", prompt: "旧", cwd: directory });
    store.updateTask(legacy.id, {
      status: "completed",
      costUsd: 0.5,
      usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 3000 },
    });

    // 别的员工：不该算进 w1
    const other = store.createTask({ workerId: "w2", kind: "claude-cli", title: "别人", prompt: "别人", cwd: directory });
    store.updateTask(other.id, {
      status: "completed",
      usage: { turns: 9, inputTokens: 9999, outputTokens: 9999 },
    });

    const today = store.usageStats({ workerId: "w1" });
    assert.equal(today.tasks, 2);
    assert.equal(today.completed, 2);
    assert.equal(today.turns, 3, "旧任务没有轮数，不能瞎算");
    assert.equal(today.inputTokens, 1100);
    assert.equal(today.outputTokens, 2200);
    assert.equal(today.cacheReadTokens, 3300);
    assert.equal(today.costUsd, undefined, "不汇总金额：会话累加会重复计算");

    const all = store.usageStats();
    assert.equal(all.tasks, 3);
    assert.equal(all.turns, 12);
    assert.ok(startOfToday());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
