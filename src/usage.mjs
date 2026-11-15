/**
 * 用量归一化。
 *
 * 两个 CLI 报的字段名完全不一样，面板不该关心谁是谁：
 *   Claude: input_tokens / cache_read_input_tokens / output_tokens / output_tokens_details.thinking_tokens
 *   Codex:  input_tokens / cached_input_tokens / output_tokens / reasoning_output_tokens
 *
 * 还有两个坑：
 *   1. Claude 的顶层 usage 有时全是 0，真正的数在 modelUsage 里，必须从这里取。
 *   2. total_cost_usd 是按 Anthropic 牌价估的，跟实际账单无关，只能当相对参考。
 */

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function sumModels(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, costUsd: 0 };
  let seen = false;
  for (const info of Object.values(modelUsage)) {
    if (!info || typeof info !== "object") continue;
    seen = true;
    totals.inputTokens += num(info.inputTokens) ?? 0;
    totals.outputTokens += num(info.outputTokens) ?? 0;
    totals.cacheReadTokens += num(info.cacheReadInputTokens) ?? 0;
    totals.thinkingTokens += num(info.thinkingTokens) ?? 0;
    totals.costUsd += num(info.costUSD) ?? 0;
  }
  if (!seen) return null;
  // 明细全 0 时视为没有数据，别给面板一个假的 0。
  if (!totals.inputTokens && !totals.outputTokens && !totals.cacheReadTokens) return null;
  return totals;
}

/** Claude CLI 的 result 事件 → 统一用量。 */
export function fromClaude(finalEvent) {
  if (!finalEvent) return null;
  const raw = finalEvent.usage || {};
  const models = sumModels(finalEvent.modelUsage);

  // 顶层 usage 记的是「本次」的量；modelUsage 和 total_cost_usd 是「整个会话累计」。
  // 续接会话时这两个会差很多（第二次只跑几千 token，累计却把上一次也算进来），
  // 所以优先本次，累计值单独标出来，不能混着用。
  let input = num(raw.input_tokens);
  let output = num(raw.output_tokens);
  let cacheRead = num(raw.cache_read_input_tokens);
  let thinking = num(raw.output_tokens_details?.thinking_tokens);

  if (!input && !output && !cacheRead && models) {
    input = models.inputTokens;
    output = models.outputTokens;
    cacheRead = models.cacheReadTokens;
    thinking = models.thinkingTokens;
  }

  if (input === null && output === null && cacheRead === null) return null;
  // 全 0 也当没数据，别给面板一个假的 0。
  if (!input && !output && !cacheRead) return null;

  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    thinkingTokens: thinking,
    turns: num(finalEvent.num_turns),
    /** 整个会话的累计花费（含之前续接的对话），不是这一次单独的。 */
    costUsd: num(finalEvent.total_cost_usd),
    costScope: "session",
    // CLI 自己写了 costBasis: "unknown"，说明它也承认这个价是估的。
    costBasis: "estimate",
    terminalReason: finalEvent.terminal_reason || null,
  };
}

/** Codex 的 turn.completed 事件 → 统一用量。 */
export function fromCodex(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = num(raw.input_tokens);
  const output = num(raw.output_tokens);
  const cacheRead = num(raw.cached_input_tokens);
  if (input === null && output === null && cacheRead === null) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    thinkingTokens: num(raw.reasoning_output_tokens),
    // Codex 一个任务就是一个 turn，没有更有意义的轮数。
    turns: null,
    costUsd: null,
    costBasis: null,
    terminalReason: null,
  };
}

/** 是否被预算刹车截停。传进来的是适配器 finalize 的结果。 */
export function isBudgetExhausted(result) {
  if (!result) return false;
  if (result.budgetExhausted === true) return true;
  return result.usage?.terminalReason === "budget_exhausted";
}

/** 给人看的用量摘要，数字统一按“万”压缩。 */
export function describeUsage(usage) {
  if (!usage) return null;
  const parts = [];
  if (usage.turns) parts.push(`${usage.turns} 轮`);
  if (usage.outputTokens) {
    const thinking = usage.thinkingTokens
      ? `（含思考 ${formatTokens(usage.thinkingTokens)}）`
      : "";
    parts.push(`输出 ${formatTokens(usage.outputTokens)}${thinking}`);
  }
  if (usage.inputTokens) parts.push(`输入 ${formatTokens(usage.inputTokens)}`);
  if (usage.cacheReadTokens) parts.push(`缓存命中 ${formatTokens(usage.cacheReadTokens)}`);
  return parts.join(" · ") || null;
}

export function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
