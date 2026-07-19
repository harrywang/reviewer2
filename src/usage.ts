/** Token-usage accumulation: per-result totals + per-model breakdown. */

import type { TokenUsage } from "./types.js";

/** The mutable usage fields shared by ReviewResult and step accumulators. */
export interface UsageAccumulator {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  usageByModel?: Record<string, TokenUsage>;
}

/**
 * Add one call's token usage to a result: bumps the totals and the per-model
 * breakdown. `model` falls back to `usage.model` (chat() responses carry it).
 * Mutates plain JSON fields only — safe across durable-execution boundaries.
 */
export function addUsage(
  target: UsageAccumulator,
  usage: TokenUsage & { model?: string },
  model?: string,
): void {
  target.totalPromptTokens += usage.promptTokens;
  target.totalCompletionTokens += usage.completionTokens;
  const m = model ?? usage.model;
  if (!m) return;
  const byModel = (target.usageByModel ??= {});
  const entry = (byModel[m] ??= { promptTokens: 0, completionTokens: 0 });
  entry.promptTokens += usage.promptTokens;
  entry.completionTokens += usage.completionTokens;
}
