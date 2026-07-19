# What reviewer2 adds on top of OpenAIReview

The review pipeline, default prompts, and output contract are a faithful
port of [OpenAIReview](https://github.com/ChicagoHAI/OpenAIReview). On top
of that, reviewer2 adds what a Node/TypeScript web app needs.
Back to the [README](../README.md).

**Integration & API**
- **JSON-first API** — `reviewPaper()` returns the viz-compatible JSON
  directly as a typed object; no CLI, no result files to read back.
- **Step API for durable execution** (`reviewer2/steps`) — the progressive
  pipeline decomposed into JSON-safe step functions
  (`prepareProgressive` / `runProgressivePassage` / `consolidateComments` /
  `buildPaperJson`) that drop into Inngest `step.run` with checkpointed
  retries; `currentDate` can be pinned so retried steps build identical
  prompts. Includes a complete Next.js + Inngest example.
- **Structured progress events** — an `onProgress` callback
  (`prepared` / `passage` / `consolidation` / `done`) instead of stdout
  prints, ready to drive a progress UI.
- **`AbortSignal` cancellation** through the client, parsers, and methods.

**Reference checking**
- **Reference accuracy check** (opt-in, [docs](./reference-check.md)) —
  verifies every bibliography entry against Crossref/OpenAlex/arXiv
  (keyless) to catch hallucinated or inaccurate citations; per-entry
  verdicts with links to the matched records, layered section locating
  with an LLM fallback, pluggable sources, and separate cost accounting.
  Not present in the original.

**Prompts**
- **Customizable prompts** — every prompt is overridable via the
  [`prompts` option](./prompts.md), at two levels (shared blocks
  like `checkCriteria`, or whole templates); the original's prompts are
  fixed module constants. Overrides are plain strings — JSON-safe, so
  named presets can live in a database (per user, journal, or track) and
  pass through Inngest step boundaries.

**Providers**
- **OpenAI as the default provider** (the original prefers OpenRouter),
  alongside OpenRouter, Anthropic, and Gemini (any other vendor's models
  are reachable through OpenRouter).
- **Explicit `{ provider, apiKey }` injection** — no env vars required, so
  multi-tenant apps can pass per-user keys.
- **GPT-5 / o-series handling** — `max_completion_tokens` and no explicit
  `temperature` for OpenAI reasoning models (the original errors on these).

**Inputs**
- **Buffer-based parsing** (`parseDocumentBuffer`) for files already in
  memory (e.g. downloaded from S3) — no filesystem needed.
- **Any file URL as input** — presigned S3/GCS links, extension-less PDF
  URLs (routed by `Content-Type`), not just arXiv URLs.
- **Pure-JS PDF extraction** (`unpdf` + line-reflow paragraph
  reconstruction and dehyphenation) instead of native PyMuPDF, so it runs
  in serverless environments with no system dependencies.

**Cost**
- **Live pricing** — `fetchLivePricing()` pulls current per-model prices
  from LiteLLM's community DB or the OpenRouter API (cached, never throws),
  and pricing tables are injectable into `computeCost`/`reviewPaper`;
  model lookup is longest-match instead of table-order-dependent.
- **Per-model usage breakdown** (`usageByModel`) — exact dollar costs for
  mixed-model runs.

**Performance**
- **Concurrent chunk review** for the `local` method and chunked
  `zero_shot` (`concurrency` option); the original runs strictly
  sequentially.
