import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 模型清单。
 *
 * 一条硬规矩：**只读各 CLI 自己的配置**，不去读路由工具（cc-switch）的后台数据。
 * 路由配的是「这个 harness 用哪个模型」，那是人家的事；Hub 只负责如实显示和临时覆盖。
 *
 * 数据来源：
 *   - Claude：~/.claude/settings.json 的 ANTHROPIC_MODEL、以及 ANTHROPIC_DEFAULT_*_MODEL
 *     （后者是别名 → 实际模型的映射，比如 sonnet → deepseek-v4-pro[1M]）
 *   - Codex：~/.codex/config.toml 的 model、model_reasoning_effort
 *
 * 读不到就返回空，面板退化成可手填，不影响使用。
 */

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 从 codex 的 config.toml 里抠配置，不引入 TOML 解析依赖。 */
function readCodexConfig(file) {
  try {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    const pick = (key) => {
      const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m").exec(text);
      return match?.[1] || null;
    };
    return {
      model: pick("model"),
      effort: pick("model_reasoning_effort"),
      provider: pick("model_provider"),
    };
  } catch {
    return null;
  }
}

/** Claude 的别名映射：别名 → 它实际指向的模型。 */
const CLAUDE_ALIASES = ["sonnet", "opus", "haiku", "fable"];

function readClaudeSettings(file) {
  const data = readJson(file);
  if (!data || typeof data !== "object") return null;
  const env = data.env && typeof data.env === "object" ? data.env : {};

  const aliases = [];
  for (const alias of CLAUDE_ALIASES) {
    const key = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;
    const target = env[key];
    if (!target) continue;
    aliases.push({
      alias,
      model: target,
      // _NAME 是不带上下文后缀的短名，只用来显示。
      displayName: env[`${key}_NAME`] || target,
    });
  }

  return {
    model: env.ANTHROPIC_MODEL || data.model || null,
    baseUrl: env.ANTHROPIC_BASE_URL || null,
    subagentModel: env.CLAUDE_CODE_SUBAGENT_MODEL || null,
    aliases,
  };
}

/** 每种员工当前真正会用到的模型。 */
export function currentModels(home = homedir()) {
  const claude = readClaudeSettings(join(home, ".claude", "settings.json"));
  const codex = readCodexConfig(join(home, ".codex", "config.toml"));
  return {
    "claude-cli": {
      model: claude?.model || null,
      baseUrl: claude?.baseUrl || null,
      aliases: claude?.aliases || [],
    },
    "codex-cli": {
      model: codex?.model || null,
      effort: codex?.effort || null,
      provider: codex?.provider || null,
    },
    "agy-cli": { model: null, aliases: [] },
  };
}

/**
 * 本机已知的模型名。
 * 只来自两个 harness 自己的配置，不引入任何外部清单。
 */
export function listModels(home = homedir()) {
  const collected = new Map();
  const add = (id, label, source, claudeOnly = false) => {
    const key = String(id || "").trim();
    if (!key) return;
    const existing = collected.get(key);
    if (existing) {
      if (!existing.label && label) existing.label = label;
      if (source && !existing.sources.includes(source)) existing.sources.push(source);
      // 只要有一个来源说明它通用，就不再限定 Claude。
      if (!claudeOnly) existing.claudeOnly = false;
      return;
    }
    collected.set(key, { id: key, label: label || key, sources: source ? [source] : [], claudeOnly });
  };

  const current = currentModels(home);
  const claude = current["claude-cli"];
  const codex = current["codex-cli"];

  // Claude 的别名（sonnet / opus …）是 Claude CLI 特有的，Codex 用不了。
  for (const item of claude.aliases || []) {
    add(item.alias, `${item.alias} → ${item.displayName}`, "claude-alias", true);
  }
  // 当前默认模型直接用自身名字显示，不额外加标签，免得看不出填的是什么。
  add(claude.model, null, "claude");
  for (const item of claude.aliases || []) {
    add(item.model, item.displayName, "claude-alias");
  }
  if (claude.subagentModel) add(claude.subagentModel, null, "claude-subagent");

  // Codex：它自己 config.toml 里那个。
  add(codex.model, null, "codex");

  const models = [...collected.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { current, models };
}

/** 面板下拉用的形态：按员工类型给出「当前模型 + 候选列表」。 */
export function modelOptionsFor(kind, workerModel, home = homedir()) {
  const { current, models } = listModels(home);
  const info = current[kind] || { model: null };
  const effective = workerModel || info.model || null;

  const candidates = models
    .filter((item) => kind === "claude-cli" || !item.claudeOnly)
    .map((item) => ({
      id: item.id,
      // 别名这类 label 已经写清了指向，不再重复拼 id。
      label: item.label || item.id,
      active: item.id === effective,
    }));
  candidates.sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id));

  return {
    kind,
    current: effective,
    currentSource: workerModel ? "worker" : info.model ? "cli" : "unknown",
    baseUrl: info.baseUrl || null,
    effort: info.effort || null,
    provider: info.provider || null,
    aliases: info.aliases || [],
    models: candidates,
  };
}
