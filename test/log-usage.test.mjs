import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { usageFromLog } from "../src/log-usage.mjs";

/** 造一份和真实日志同格式的内容：`[时间] stdout {...}`。 */
function logLine(event) {
  return `[2026-11-13T11:27:16.143Z] stdout ${JSON.stringify(event)}`;
}

test("从日志尾部捞回轮数和用量（旧任务没有这些字段）", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-logusage-"));
  try {
    const id = "task_old_1";
    const content = [
      logLine({ type: "system", subtype: "init", session_id: "s1" }),
      logLine({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "干活中" }] } }),
      logLine({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "做完了",
        num_turns: 76,
        total_cost_usd: 5.11,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {
          "deepseek-flash[1m]": {
            inputTokens: 69480,
            outputTokens: 87311,
            cacheReadInputTokens: 5165440,
            thinkingTokens: 49534,
            costUSD: 5.11,
          },
        },
      }),
      "",
    ].join("\n");
    writeFileSync(join(directory, `${id}.log`), content, "utf8");

    const usage = usageFromLog(directory, id);
    assert.ok(usage, "应该能捞到用量");
    assert.equal(usage.turns, 76);
    assert.equal(usage.outputTokens, 87311);
    assert.equal(usage.cacheReadTokens, 5165440);
    assert.equal(usage.thinkingTokens, 49534);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("日志不存在或没有 result 事件时返回 null", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-logusage-empty-"));
  try {
    assert.equal(usageFromLog(directory, "not_exist"), null);
    writeFileSync(join(directory, "task_2.log"), logLine({ type: "system" }), "utf8");
    assert.equal(usageFromLog(directory, "task_2"), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("日志末尾被截断成半行时，继续往前找完整的那条", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-logusage-cut-"));
  try {
    const id = "task_cut";
    const good = logLine({
      type: "result",
      subtype: "success",
      num_turns: 9,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
    });
    writeFileSync(join(directory, `${id}.log`), `${good}\n[2026-11-13T11:28:00.000Z] stdout {"type":"result","num_tur`, "utf8");
    const usage = usageFromLog(directory, id);
    assert.ok(usage);
    assert.equal(usage.turns, 9);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
