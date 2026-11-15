import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { currentModels, listModels, modelOptionsFor } from "../src/models.mjs";

/**
 * 造一个假的本机环境，形态对齐真实机器：
 * 路由工具在后台把 Claude 的别名映射到具体模型，Hub 只读 CLI 自己的配置。
 */
function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), "hub-models-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  // 故意放一份 cc-switch 的价格表，验证 Hub 不会去读它。
  mkdirSync(join(home, ".cc-switch"), { recursive: true });
  writeFileSync(
    join(home, ".cc-switch", "model-pricing.json"),
    JSON.stringify({
      models: [
        { modelId: "claude-opus-5", displayName: "Claude Opus 5" },
        { modelId: "gemini-9-ultra", displayName: "Gemini 9 Ultra" },
      ],
    }),
    "utf8",
  );

  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://router.example/anthropic",
        ANTHROPIC_MODEL: "deepseek-flash[1M]",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro[1M]",
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-flash[1M]",
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "deepseek-flash",
        CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-flash[1M]",
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(home, ".codex", "config.toml"),
    'model_provider = "custom"\nmodel = "deepseek-flash"\nmodel_reasoning_effort = "high"\n',
    "utf8",
  );
  return home;
}

test("读出各 CLI 当前实际在用的模型", () => {
  const home = makeFakeHome();
  try {
    const current = currentModels(home);
    assert.equal(current["claude-cli"].model, "deepseek-flash[1M]");
    assert.equal(current["claude-cli"].baseUrl, "https://router.example/anthropic");
    assert.equal(current["codex-cli"].model, "deepseek-flash");
    assert.equal(current["codex-cli"].effort, "high");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude 的别名映射被解析出来：sonnet → deepseek-v4-pro", () => {
  const home = makeFakeHome();
  try {
    const { aliases } = currentModels(home)["claude-cli"];
    const sonnet = aliases.find((item) => item.alias === "sonnet");
    const opus = aliases.find((item) => item.alias === "opus");
    assert.equal(sonnet.model, "deepseek-v4-pro[1M]");
    assert.equal(sonnet.displayName, "deepseek-v4-pro");
    assert.equal(opus.model, "deepseek-flash[1M]");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("模型候选只来自 CLI 配置，绝不包含路由后台的模型库", () => {
  const home = makeFakeHome();
  try {
    const { models } = listModels(home);
    const ids = models.map((item) => item.id);
    // 来自 Claude / Codex 本身
    assert.ok(ids.includes("sonnet"));
    assert.ok(ids.includes("deepseek-flash[1M]"));
    assert.ok(ids.includes("deepseek-flash"));
    // 来自 cc-switch 价格表的模型一个都不能出现
    assert.ok(!ids.includes("claude-opus-5"), "不应引入 cc-switch 的模型");
    assert.ok(!ids.includes("gemini-9-ultra"), "不应引入 cc-switch 的模型");
    // 别名要带上它实际指向哪个模型，避免选了个不知道是啥的
    const sonnet = models.find((item) => item.id === "sonnet");
    assert.match(sonnet.label, /deepseek-v4-pro/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("当前生效的模型排最前，并说明来源", () => {
  const home = makeFakeHome();
  try {
    const cliDefault = modelOptionsFor("claude-cli", null, home);
    assert.equal(cliDefault.current, "deepseek-flash[1M]");
    assert.equal(cliDefault.currentSource, "cli");
    assert.equal(cliDefault.models[0].id, "deepseek-flash[1M]");
    assert.equal(cliDefault.models[0].active, true);

    const overridden = modelOptionsFor("claude-cli", "sonnet", home);
    assert.equal(overridden.current, "sonnet");
    assert.equal(overridden.currentSource, "worker");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("配置缺失时返回空列表，不抛异常", () => {
  const home = mkdtempSync(join(tmpdir(), "hub-models-empty-"));
  try {
    const result = listModels(home);
    assert.deepEqual(result.models, []);
    const options = modelOptionsFor("claude-cli", null, home);
    assert.equal(options.current, null);
    assert.deepEqual(options.models, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude 别名只出现在 Claude 员工的下拉里", () => {
  const home = makeFakeHome();
  try {
    const claude = modelOptionsFor("claude-cli", null, home);
    assert.ok(claude.models.some((item) => item.id === "sonnet"), "Claude 应该能选 sonnet 别名");

    const codex = modelOptionsFor("codex-cli", null, home);
    const ids = codex.models.map((item) => item.id);
    assert.ok(!ids.includes("sonnet"), "Codex 不该出现 Claude 的别名");
    assert.ok(!ids.includes("opus"), "Codex 不该出现 Claude 的别名");
    // 但真实模型名要在，Codex 用得上。
    assert.ok(ids.includes("deepseek-flash"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
