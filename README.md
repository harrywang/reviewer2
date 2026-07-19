# reviewer2

AI-powered academic paper reviewer for Node/TypeScript — the reviewer #2
every paper deserves. Based on
[OpenAIReview](https://github.com/ChicagoHAI/OpenAIReview) (Python),
redesigned for web-app integration. On top of the original it adds:

- **Built for web apps** — headless and JSON-first: every review returns
  visualization-ready JSON you can render directly; no CLI, no result files
  to manage.
- **Survives long reviews** — a thorough review can run for an hour; the
  pipeline breaks into durable, retryable steps that drop into
  [Inngest](https://www.inngest.com/) (or any background-job runtime), with
  live progress updates and cancellation.
- **Reference accuracy check** — opt-in verification of every bibliography
  entry against Crossref/OpenAlex/arXiv (free, keyless) to catch
  hallucinated or inaccurate citations, with links to the matched records.
- **Any LLM provider** — OpenAI, OpenRouter, Anthropic, or Gemini out of
  the box, including per-user API keys for multi-tenant apps.
- **Easy prompt customization** — swap the review criteria, the tone, or
  entire prompts with plain-string overrides, and keep named presets per
  journal or track.
- **Cost tracking with live pricing** — every review reports what it cost
  in dollars, and you can pull current per-model prices from LiteLLM or
  OpenRouter instead of relying on a static table.
- **Papers from anywhere, running anywhere** — beyond the original's local
  files and arXiv links: any file URL (including presigned S3/GCS links) and
  in-memory buffers, parsed in pure JS so it runs on serverless with no
  system dependencies.

See [What reviewer2 adds on top of OpenAIReview](docs/comparison.md) for
the full list.

## Install

```bash
npm install reviewer2
```

Node ≥ 20, ESM and CJS builds included.

## Quick start

```bash
export OPENAI_API_KEY=sk-...   # or OPENROUTER_/ANTHROPIC_/GEMINI_API_KEY
```

```ts
import { parseDocument, reviewPaper } from "reviewer2";

// 1. Get the paper text (PDF/DOCX/TeX/MD file, or an arXiv URL)
const doc = await parseDocument("paper.pdf"); // or parseDocumentBuffer(bytes, "pdf")

// 2. Review it — returns viz-compatible JSON
const { paper, result } = await reviewPaper(doc.text, {
  title: doc.title,
  ocr: doc.wasOcr,
  method: "progressive",              // default; also: zero_shot | local
  model: "gpt-5.2",                   // default depends on provider
  checkReferences: true,              // opt-in: verify citations against Crossref/OpenAlex/arXiv
  onProgress: (e) => console.log(e),  // { stage: "passage", current, total, ... }
});

console.log(JSON.stringify(paper, null, 2));
```

Keys can also be passed explicitly per call (`{ provider, apiKey }`) for
multi-tenant apps — see [Providers & API keys](docs/providers.md).

## Documentation

| Guide | What's inside |
|---|---|
| [How it works](docs/how-it-works.md) | Output JSON contract, pipeline flowchart, the three review methods compared, building a UI |
| [Reference accuracy check](docs/reference-check.md) | Catching hallucinated/inaccurate citations: usage, per-entry results with source links, how matching works, tuning |
| [Customizing prompts](docs/prompts.md) | Block and template overrides, placeholders, presets per journal/track, validation |
| [Providers & API keys](docs/providers.md) | Env vars vs explicit keys, provider auto-detection, per-provider notes |
| [Document parsing](docs/parsing.md) | PDF/DOCX/LaTeX/MD, arXiv and file URLs, buffers, OCR handling |
| [Cost tracking](docs/cost-tracking.md) | Pricing tables, live pricing, per-model usage breakdown |
| [Long-running reviews (Inngest)](docs/inngest.md) | Durable step-by-step execution in a Next.js app |
| [vs. OpenAIReview](docs/comparison.md) | Everything reviewer2 adds on top of the original |

## Development

```bash
npm install
npm test          # vitest (110 tests, no API calls or network)
npm run build     # tsup → dist/ (ESM + CJS + d.ts)
npm run typecheck
```

## Agent skill

Prefer running reviews inside an AI coding agent instead of integrating the
library? **[harrywang/reviewer2-skill](https://github.com/harrywang/reviewer2-skill)**
packages the same review pipeline as an agent skill for Claude Code, Cursor,
Codex, and others — install with `npx skills add harrywang/reviewer2-skill`,
then run `/reviewer2 paper.pdf`. It produces the same viz-compatible JSON and
bundles a local web viewer.

## Credits

reviewer2 is based on
**[OpenAIReview](https://github.com/ChicagoHAI/OpenAIReview)** by
[ChicagoHAI](https://github.com/ChicagoHAI) (MIT licensed) — not a direct
port, but a TypeScript reimplementation that follows its review pipeline
design (progressive summary-based review, deep-check prompts,
consolidation), prompt set, and fuzzy quote-to-paragraph anchoring, then
extends it for web-app use (see
[what reviewer2 adds](docs/comparison.md)).

## License

MIT
