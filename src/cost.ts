/** Cost estimation: static pricing table + optional live pricing sources. */

import type { ReviewResult, TokenUsage } from "./types.js";

export interface Pricing {
  /** USD per 1M prompt tokens. */
  prompt: number;
  /** USD per 1M completion tokens. */
  completion: number;
}

export type PricingTable = Record<string, Pricing>;

/**
 * Built-in static pricing (USD per 1M tokens) — the always-available
 * fallback. For fresh prices use fetchLivePricing().
 */
export const COST_PER_1M: PricingTable = {
  "anthropic/claude-opus-4-6": { prompt: 5.0, completion: 25.0 },
  "anthropic/claude-opus-4-5": { prompt: 5.0, completion: 25.0 },
  "google/gemini-3.1-pro-preview": { prompt: 2.0, completion: 12.0 },
  "google/gemini-3-flash-preview": { prompt: 0.5, completion: 3.0 },
  "z-ai/glm-5": { prompt: 0.8, completion: 2.56 },
  "z-ai/glm-4.6": { prompt: 0.39, completion: 1.9 },
  "qwen/qwen3-235b-a22b-2507": { prompt: 0.071, completion: 0.1 },
  "moonshotai/kimi-k2.5": { prompt: 0.45, completion: 2.2 },
  "openai/gpt-5.2-pro": { prompt: 21.0, completion: 168.0 },
  "openai/gpt-5.2": { prompt: 1.75, completion: 14.0 },
  "openai/gpt-5-mini": { prompt: 0.25, completion: 2.0 },
  "openai/gpt-5-nano": { prompt: 0.05, completion: 0.4 },
  "openai/gpt-5": { prompt: 1.25, completion: 10.0 },
};

export const DEFAULT_COST: Pricing = { prompt: 5.0, completion: 25.0 };

/**
 * Find pricing for a model id. Tries exact match (full id, then short name
 * without vendor prefix), then the longest key contained in the model id —
 * so "gpt-5-mini" beats "gpt-5" regardless of table order.
 */
function pricingFor(model: string, table: PricingTable): Pricing {
  if (table[model]) return table[model];
  const short = model.includes("/") ? model.split("/").pop()! : model;
  if (table[short]) return table[short];

  let best: Pricing | undefined;
  let bestLen = 0;
  for (const [key, value] of Object.entries(table)) {
    const keyShort = key.includes("/") ? key.split("/").pop()! : key;
    if ((model.includes(key) || model.includes(keyShort)) && keyShort.length > bestLen) {
      best = value;
      bestLen = keyShort.length;
    }
  }
  return best ?? DEFAULT_COST;
}

/**
 * Estimate USD cost of a review. Pass a live table for fresh prices.
 * When the result carries a per-model breakdown (usageByModel), each model's
 * tokens are priced at that model's rate — exact for mixed-model runs.
 */
export function computeCost(
  result: Pick<ReviewResult, "model" | "totalPromptTokens" | "totalCompletionTokens"> & {
    usageByModel?: Record<string, TokenUsage>;
  },
  pricingTable?: PricingTable,
): number {
  const table = pricingTable ?? COST_PER_1M;

  if (result.usageByModel && Object.keys(result.usageByModel).length) {
    let total = 0;
    for (const [model, usage] of Object.entries(result.usageByModel)) {
      const p = pricingFor(model, table);
      total +=
        (usage.promptTokens / 1_000_000) * p.prompt +
        (usage.completionTokens / 1_000_000) * p.completion;
    }
    return total;
  }

  let pricing = pricingFor(result.model, table);

  // Blended "a+b" models (30/70 split), as in the Python original
  if (result.model.includes("+")) {
    const [a, b] = result.model.split("+");
    const pa = pricingFor(a, table);
    const pb = pricingFor(b, table);
    pricing = {
      prompt: 0.3 * pa.prompt + 0.7 * pb.prompt,
      completion: 0.3 * pa.completion + 0.7 * pb.completion,
    };
  }

  return (
    (result.totalPromptTokens / 1_000_000) * pricing.prompt +
    (result.totalCompletionTokens / 1_000_000) * pricing.completion
  );
}

/* ------------------------------------------------------------------ */
/* Live pricing                                                        */
/* ------------------------------------------------------------------ */

export interface LivePricingOptions {
  /**
   * "litellm": LiteLLM's community pricing DB (raw JSON on GitHub) — covers
   * native ids and prefixed ids for every provider.
   * "openrouter": the OpenRouter /models API — live pricing for all
   * OpenRouter-listed models (vendor-prefixed ids).
   * Default: "litellm".
   */
  source?: "litellm" | "openrouter";
  /** Cache lifetime. Default 24h. */
  ttlMs?: number;
  signal?: AbortSignal;
}

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

let pricingCache: { source: string; table: PricingTable; fetchedAt: number } | null = null;

/** Clear the in-memory live-pricing cache (mainly for tests). */
export function clearPricingCache(): void {
  pricingCache = null;
}

async function fetchLitellmTable(signal?: AbortSignal): Promise<PricingTable> {
  const resp = await fetch(LITELLM_URL, { signal });
  if (!resp.ok) throw new Error(`LiteLLM pricing fetch failed: HTTP ${resp.status}`);
  const data = (await resp.json()) as Record<
    string,
    { input_cost_per_token?: number; output_cost_per_token?: number }
  >;
  const table: PricingTable = {};
  for (const [model, spec] of Object.entries(data)) {
    if (model === "sample_spec") continue;
    const input = spec?.input_cost_per_token;
    const output = spec?.output_cost_per_token;
    if (typeof input === "number" && typeof output === "number" && input >= 0 && output >= 0) {
      table[model] = { prompt: input * 1_000_000, completion: output * 1_000_000 };
    }
  }
  return table;
}

async function fetchOpenRouterTable(signal?: AbortSignal): Promise<PricingTable> {
  const resp = await fetch(OPENROUTER_URL, { signal });
  if (!resp.ok) throw new Error(`OpenRouter pricing fetch failed: HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    data?: { id?: string; pricing?: { prompt?: string; completion?: string } }[];
  };
  const table: PricingTable = {};
  for (const model of data.data ?? []) {
    if (!model.id) continue;
    const prompt = Number.parseFloat(model.pricing?.prompt ?? "");
    const completion = Number.parseFloat(model.pricing?.completion ?? "");
    if (Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0) {
      table[model.id] = { prompt: prompt * 1_000_000, completion: completion * 1_000_000 };
    }
  }
  return table;
}

/**
 * Fetch a fresh pricing table (merged over the static one) and cache it
 * in memory. Never throws: on failure it returns the last cached table,
 * or the static table — cost_usd is informational, so a pricing outage
 * must never break a review.
 *
 * Usage:
 *   const pricing = await fetchLivePricing();
 *   const { paper } = await reviewPaper(text, { ...options, pricing });
 */
export async function fetchLivePricing(options: LivePricingOptions = {}): Promise<PricingTable> {
  const source = options.source ?? "litellm";
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;

  if (pricingCache && pricingCache.source === source && Date.now() - pricingCache.fetchedAt < ttlMs) {
    return pricingCache.table;
  }

  try {
    const live =
      source === "openrouter"
        ? await fetchOpenRouterTable(options.signal)
        : await fetchLitellmTable(options.signal);
    const table: PricingTable = { ...COST_PER_1M, ...live };
    pricingCache = { source, table, fetchedAt: Date.now() };
    return table;
  } catch {
    return pricingCache?.table ?? { ...COST_PER_1M };
  }
}
