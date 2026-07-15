import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPricingCache,
  computeCost,
  fetchLivePricing,
  COST_PER_1M,
} from "../src/index.js";

const LITELLM_FIXTURE = {
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0 },
  "gpt-5-mini": { input_cost_per_token: 0.00000025, output_cost_per_token: 0.000002 },
  "claude-opus-4-6": { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
  "some-free-model": { input_cost_per_token: 0, output_cost_per_token: 0 },
  "broken-model": { input_cost_per_token: "n/a" },
};

const OPENROUTER_FIXTURE = {
  data: [
    { id: "openai/gpt-5-mini", pricing: { prompt: "0.00000025", completion: "0.000002" } },
    { id: "anthropic/claude-opus-4-6", pricing: { prompt: "0.000005", completion: "0.000025" } },
    { id: "broken/no-pricing", pricing: {} },
  ],
};

describe("computeCost model matching (longest-match, order-independent)", () => {
  it("matches the most specific key, not a prefix", () => {
    // "gpt-5-mini" contains both "gpt-5" and "gpt-5-mini" keys — mini must win
    const cost = computeCost({
      model: "gpt-5-mini",
      totalPromptTokens: 1_000_000,
      totalCompletionTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.25 + 2.0);
  });

  it("matches bare gpt-5 to the gpt-5 entry", () => {
    const cost = computeCost({
      model: "gpt-5",
      totalPromptTokens: 1_000_000,
      totalCompletionTokens: 0,
    });
    expect(cost).toBeCloseTo(1.25);
  });

  it("uses an injected pricing table", () => {
    const cost = computeCost(
      { model: "acme/custom", totalPromptTokens: 1_000_000, totalCompletionTokens: 0 },
      { "acme/custom": { prompt: 1.0, completion: 2.0 } },
    );
    expect(cost).toBeCloseTo(1.0);
  });
});

describe("fetchLivePricing", () => {
  beforeEach(() => clearPricingCache());
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes the LiteLLM table to per-1M pricing and merges over static", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(LITELLM_FIXTURE)));
    vi.stubGlobal("fetch", fetchMock);

    const table = await fetchLivePricing({ source: "litellm" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(table["gpt-5-mini"]).toEqual({ prompt: 0.25, completion: 2.0 });
    expect(table["claude-opus-4-6"]).toEqual({ prompt: 5.0, completion: 25.0 });
    expect(table["some-free-model"]).toEqual({ prompt: 0, completion: 0 });
    expect(table["broken-model"]).toBeUndefined();
    // static entries survive the merge
    expect(table["openai/gpt-5.2-pro"]).toEqual(COST_PER_1M["openai/gpt-5.2-pro"]);
  });

  it("normalizes the OpenRouter table", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(OPENROUTER_FIXTURE))));

    const table = await fetchLivePricing({ source: "openrouter" });
    expect(table["openai/gpt-5-mini"]).toEqual({ prompt: 0.25, completion: 2.0 });
    expect(table["anthropic/claude-opus-4-6"]).toEqual({ prompt: 5.0, completion: 25.0 });
    expect(table["broken/no-pricing"]).toBeUndefined();
  });

  it("caches within the TTL (single fetch for two calls)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(LITELLM_FIXTURE)));
    vi.stubGlobal("fetch", fetchMock);

    await fetchLivePricing();
    await fetchLivePricing();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to the static table when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const table = await fetchLivePricing({ source: "litellm" });
    expect(table).toEqual(COST_PER_1M);
  });

  it("falls back to the cached table when a refresh fails", async () => {
    const good = vi.fn(async () => new Response(JSON.stringify(LITELLM_FIXTURE)));
    vi.stubGlobal("fetch", good);
    await fetchLivePricing({ source: "litellm" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const table = await fetchLivePricing({ source: "litellm", ttlMs: 0 });
    expect(table["gpt-5-mini"]).toEqual({ prompt: 0.25, completion: 2.0 });
  });

  it("feeds computeCost end to end", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(LITELLM_FIXTURE))));
    const pricing = await fetchLivePricing();
    const cost = computeCost(
      { model: "gpt-5-mini", totalPromptTokens: 73_405, totalCompletionTokens: 38_567 },
      pricing,
    );
    expect(cost).toBeCloseTo(0.0955, 3);
  });
});
