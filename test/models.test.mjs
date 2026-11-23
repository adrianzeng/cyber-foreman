import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearModelCache, currentModels, listModels, modelOptionsFor, parseAgyModelsOutput } from "../src/models.mjs";

/**
 * 造一个假的本机环境，形态对齐真实机器：
 * 路由工具在后台把 Claude 的别名映射到具体模型，Hub 只读各 CLI 自己的配置并按 kind 严格隔离。
 */
function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), "hub-models-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  mkdirSync(join(home, ".kimi"), { recursive: true });
  mkdirSync(join(home, ".doubao"), { recursive: true });
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
    'model_provider = "custom"\nmodel = "codex-gpt-5"\nmodel_reasoning_effort = "high"\n',
    "utf8",
  );
  writeFileSync(
    join(home, ".gemini", "antigravity-cli", "settings.json"),
    JSON.stringify({ model: "Gemini 4 Neon (Medium)" }),
    "utf8",
  );
  writeFileSync(
    join(home, ".kimi", "config.json"),
    JSON.stringify({ model: "kimi-k2.5" }),
    "utf8",
  );
  writeFileSync(
    join(home, ".doubao", "config.json"),
    JSON.stringify({ model: "doubao-seed-code" }),
    "utf8",
  );
  return home;
}

test("读出各 CLI 当前实际在用的模型", () => {
  const home = makeFakeHome();
  try {
    const current = currentModels(home, { probeAgy: false });
    assert.equal(current["claude-cli"].model, "deepseek-flash[1M]");
    assert.equal(current["claude-cli"].baseUrl, "https://router.example/anthropic");
    assert.equal(current["codex-cli"].model, "codex-gpt-5");
    assert.equal(current["codex-cli"].effort, "high");
    assert.equal(current["agy-cli"].model, "Gemini 4 Neon (Medium)");
    assert.equal(current["kimi-cli"].model, "kimi-k2.5");
    assert.equal(current["doubao-cli"].model, "doubao-seed-code");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude 的别名映射被解析出来：sonnet → deepseek-v4-pro", () => {
  const home = makeFakeHome();
  try {
    const { aliases } = currentModels(home, { probeAgy: false })["claude-cli"];
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
    const { models } = listModels(home, { probeAgy: false });
    const ids = models.map((item) => item.id);
    assert.ok(ids.includes("sonnet"));
    assert.ok(ids.includes("deepseek-flash[1M]"));
    assert.ok(ids.includes("codex-gpt-5"));
    assert.ok(!ids.includes("claude-opus-5"), "不应引入 cc-switch 的模型");
    assert.ok(!ids.includes("gemini-9-ultra"), "不应引入 cc-switch 的模型");
    const sonnet = models.find((item) => item.id === "sonnet");
    assert.match(sonnet.label, /deepseek-v4-pro/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("当前生效的模型排最前，并说明来源", () => {
  const home = makeFakeHome();
  try {
    const cliDefault = modelOptionsFor("claude-cli", null, home, { probeAgy: false });
    assert.equal(cliDefault.current, "deepseek-flash[1M]");
    assert.equal(cliDefault.currentSource, "cli");
    assert.equal(cliDefault.models[0].id, "deepseek-flash[1M]");
    assert.equal(cliDefault.models[0].active, true);

    const overridden = modelOptionsFor("claude-cli", "sonnet", home, { probeAgy: false });
    assert.equal(overridden.current, "sonnet");
    assert.equal(overridden.currentSource, "worker");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("配置缺失时返回空列表，不抛异常", () => {
  const home = mkdtempSync(join(tmpdir(), "hub-models-empty-"));
  try {
    const result = listModels(home, { probeAgy: false });
    assert.deepEqual(result.models, []);
    const options = modelOptionsFor("claude-cli", null, home, { probeAgy: false });
    assert.equal(options.current, null);
    assert.deepEqual(options.models, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("严格按 kind 隔离模型候选：绝不把 Claude 的 deepseek-flash 串台到 Codex / Antigravity / Kimi / Doubao", () => {
  const home = makeFakeHome();
  try {
    const claude = modelOptionsFor("claude-cli", null, home, { probeAgy: false });
    const claudeIds = claude.models.map((item) => item.id);
    assert.ok(claudeIds.includes("sonnet"));
    assert.ok(claudeIds.includes("deepseek-flash[1M]"));
    assert.ok(!claudeIds.includes("codex-gpt-5"), "Claude 不应混入 Codex 模型");

    const codex = modelOptionsFor("codex-cli", null, home, { probeAgy: false });
    const codexIds = codex.models.map((item) => item.id);
    assert.deepEqual(codexIds, ["codex-gpt-5"], "Codex 只能出现 Codex 自己的模型");

    const agyRunner = () => [
      "Fetching available models...",
      "gemini-4-neon-high\tGemini 4 Neon (High)",
      "gemini-4-neon-medium\tGemini 4 Neon (Medium)",
    ].join("\n");
    const agy = modelOptionsFor("agy-cli", null, home, { probeAgy: true, agyModelsRunner: agyRunner });
    const agyIds = agy.models.map((item) => item.id);
    assert.equal(agy.current, "gemini-4-neon-medium", "settings 展示名应自动对齐到 agy CLI 模型 ID");
    assert.ok(agyIds.includes("gemini-4-neon-high"));
    assert.ok(!agyIds.includes("deepseek-flash[1M]"), "Antigravity 绝不能串入 Claude 模型");
    assert.ok(!agyIds.includes("codex-gpt-5"), "Antigravity 绝不能串入 Codex 模型");

    const kimi = modelOptionsFor("kimi-cli", null, home, { probeAgy: false });
    assert.deepEqual(kimi.models.map((item) => item.id), ["kimi-k2.5"]);

    const doubao = modelOptionsFor("doubao-cli", null, home, { probeAgy: false });
    assert.deepEqual(doubao.models.map((item) => item.id), ["doubao-seed-code"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("parseAgyModelsOutput 解析真实格式，且修改本地配置后刷新立刻读到最新模型", () => {
  clearModelCache();
  const parsed = parseAgyModelsOutput("Fetching...\ngemini-4-neon-high\tGemini 4 Neon (High)\n");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "gemini-4-neon-high");

  const home = makeFakeHome();
  try {
    const before = modelOptionsFor("codex-cli", null, home, { probeAgy: false });
    assert.equal(before.current, "codex-gpt-5");

    // 模拟用户在本地更新了 ~/.codex/config.toml，刷新后实时生效
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "o4-mini-latest"\n', "utf8");
    const after = modelOptionsFor("codex-cli", null, home, { probeAgy: false, refresh: true });
    assert.equal(after.current, "o4-mini-latest");
    assert.deepEqual(after.models.map((item) => item.id), ["o4-mini-latest"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
