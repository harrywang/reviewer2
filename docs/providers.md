# Providers & API keys

How reviewer2 picks an LLM provider and where keys come from.
Back to the [README](../README.md).

There are two ways to provide keys — pick per call site:

**1. Environment variables** (simplest — set one and every call just works):

```bash
export OPENAI_API_KEY=sk-...        # OpenAI (default provider)
# or any of:
export OPENROUTER_API_KEY=sk-or-... # OpenRouter (any model id)
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=...
```

The package reads `process.env` directly and does **not** load `.env` files
itself — Next.js loads `.env.local` automatically; in plain Node use
`node --env-file=.env` or `dotenv`.

**2. Explicit options** (no env vars needed — for multi-tenant apps passing
per-user/per-workspace keys):

```ts
await reviewPaper(text, {
  provider: "openrouter",              // openai | openrouter | anthropic | gemini
  apiKey: user.openrouterKey,
  model: "anthropic/claude-opus-4-6",
});
```

| Provider | Env var | Notes |
|---|---|---|
| **OpenAI** (default) | `OPENAI_API_KEY` | `OPENAI_BASE_URL` env or `baseUrl` option for Azure/EU/proxies |
| OpenRouter | `OPENROUTER_API_KEY` | any model id, e.g. `anthropic/claude-opus-4-6` |
| Anthropic | `ANTHROPIC_API_KEY` | native API |
| Google Gemini | `GEMINI_API_KEY` | native API |

**Which provider gets used** (first match wins):

1. Explicit `provider` option
2. `REVIEW_PROVIDER` env var (e.g. `REVIEW_PROVIDER=openrouter`)
3. Vendor-prefixed model id — `model: "anthropic/..."` uses the Anthropic
   native API when `ANTHROPIC_API_KEY` is set
4. First available key, in order: **OpenAI**, OpenRouter, Anthropic, Gemini

If a `model` isn't specified, each provider has a sensible default (OpenAI →
`gpt-5.2`, OpenRouter → `anthropic/claude-opus-4-6`, …). Missing or
misconfigured keys throw a `ProviderError` with a message saying exactly
which env var to set.
