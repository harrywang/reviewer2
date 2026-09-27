# Cost tracking

Every review reports what it cost in dollars, per method block.
Back to the [README](../README.md).

`cost_usd` in the output is computed from a built-in static pricing table
(USD per 1M tokens). Current OpenAI prices covered by the static table
(as of September 2026, per OpenAI's API pricing page):

| Model                     | Input $/1M | Output $/1M |
| ------------------------- | ---------- | ----------- |
| `gpt-6-astra`             | 10.00      | 50.00       |
| `gpt-6-sol`               | 2.00       | 10.00       |
| `gpt-6-luna`              | 0.10       | 0.50        |
| `gpt-5.6` / `gpt-5.6-sol` | 4.00       | 20.00       |
| `gpt-5.6-terra`           | 2.00       | 12.00       |
| `gpt-5.6-luna`            | 0.20       | 1.20        |

`gpt-5.6-sol` is at a promotional price through at least Nov 21 2026 (list
price 5.00 / 30.00). `gpt-5`, `gpt-5-mini`, and `gpt-5-nano` shut down on
Dec 11 2026 — move to a 5.6 or 6 model.

(Other OpenAI, Anthropic, Gemini, and OpenRouter models are in the static
table too — see `COST_PER_1M` in `src/cost.ts`.) For fresh prices, fetch a
live table and pass it through:

```ts
import { fetchLivePricing, reviewPaper } from "reviewer2";

const pricing = await fetchLivePricing();          // LiteLLM community DB (default)
// or: await fetchLivePricing({ source: "openrouter" })  // OpenRouter /models API
const { paper } = await reviewPaper(text, { ...options, pricing });
```

`fetchLivePricing` caches in memory (24 h TTL by default) and **never
throws** — on failure it returns the last cached table or the static one,
so a pricing outage can't break a review. `computeCost(result, pricing?)`
accepts the same table directly. Model lookup is longest-match, so
`gpt-5.6-luna` resolves to its own entry rather than `gpt-5.6`.

Results also carry a per-model breakdown in `usageByModel`
(`{ "gpt-5.2": { promptTokens, completionTokens }, ... }`). When present,
`computeCost` prices each model's tokens at that model's rate — exact costs
for mixed-model runs, e.g. a `gpt-6-luna`
[reference check](./reference-check.md) alongside a `gpt-5.2` review.
