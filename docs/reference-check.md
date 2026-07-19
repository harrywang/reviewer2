# Reference accuracy check (opt-in)

Verify every bibliography entry against real bibliographic databases to
catch **hallucinated or inaccurate references**. Off by default; no keys
needed beyond your LLM key — Crossref, OpenAlex, and arXiv are free and
keyless (Semantic Scholar joins in when you pass an API key).
Back to the [README](../README.md).

```ts
const { paper, referenceResult, referenceStats, checkedReferences } = await reviewPaper(text, {
  checkReferences: true,
  references: {
    mailto: "you@example.com",   // optional: Crossref/OpenAlex "polite pool" (just an email)
    model: "gpt-5-mini",         // optional: cheaper model for extraction/adjudication
  },
});

referenceStats;
// { entries: 40, sectionSource: "heading", verified: 33, mismatched: 2, notFound: 1,
//   unverifiable: 4, ambiguous: 0, adjudicated: 2,
//   apiCallsBySource: { crossref: 30, arxiv: 4, openalex: 6 } }

// Per-entry breakdown in bibliography order, with a link to the matched
// database record for every verified/mismatched entry:
checkedReferences;
// [
//   { label: "1", title: "Deep Widget Networks",
//     status: "verified", problems: [],
//     match: { source: "crossref", title: "Deep Widget Networks", year: 2020,
//              doi: "10.1234/widget", url: "https://doi.org/10.1234/widget" } },
//   { label: "2", title: "Fast Gadget Learning",
//     status: "mismatch", problems: ["cited year is 2018, but the crossref record says 2021"],
//     match: { source: "crossref", ..., url: "https://doi.org/10.9/fgl" } },
//   { label: "3", title: "Imaginary Results on Nonexistent Data",
//     status: "not_found", match: null, problems: [] },      // possible hallucination
//   { label: "4", title: "Some Well-Known Textbook",
//     status: "unverifiable", match: null, problems: [] },   // book — skipped, never flagged
//   ...
// ]
```

Rough expectations for a typical conference paper (~35 references): about a
minute end-to-end — one extraction call plus free database lookups
(adjudication calls only for ambiguous entries). Approximate cost by model:
≈ $0.21 with `gpt-5.6` (sol), ≈ $0.10 with `gpt-5.6-terra`, ≈ $0.04 with
`gpt-5.6-luna`.

## How it works

1. **Extract** — the references section is located by a layered strategy,
   cheapest first: a heading scan (tolerant of markdown, numbering,
   letter-spaced OCR headings like `R E F E R E N C E S`, and common
   non-English headings) → structural detection (a run of
   bibliography-shaped lines: years, DOIs, `[n]` labels, author patterns) →
   as a last resort, one small **LLM locator call** that quotes the first
   entry verbatim. `referenceStats.sectionSource` reports which layer won
   (`"heading" | "structural" | "llm" | "none"`); the locator's tokens are
   tracked in the reference-check usage/cost like every other call, so the
   extra cost — only incurred when deterministic locating fails — is always
   visible. One LLM call then parses the section into structured entries
   (title, authors, year, venue, DOI, arXiv id), copied verbatim.
2. **Look up** — each entry is resolved against the databases by arXiv id,
   DOI, or title search (plain HTTP — no LLM, so nothing can be hallucinated
   here). Lookups run concurrently with retries and per-source call counting.
   Battle-tested against real PDFs: DOIs are normalized across line-wrap
   artifacts (`10.1016/0007- 6813(...)` ≡ `10.1016/0007-6813(...)`), and
   arXiv ids — explicit or embedded in `10.48550/arXiv.*` DOIs — are resolved
   against **arXiv itself first**, since aggregators occasionally hold junk
   records under arXiv DOIs.
3. **Classify** — deterministic scoring (title similarity + author overlap +
   year, DOI decisive) marks each entry `verified`, `mismatch`, `not_found`,
   `unverifiable` (books/URLs/theses — never flagged), or `ambiguous`.
   Ambiguous cases get one **grounded** LLM adjudication call that compares
   the entry against the retrieved records only. If every database is
   unreachable, entries become `unverifiable`, never `not_found` — an outage
   must not produce hallucination accusations.
4. **Report** — every entry lands in `checkedReferences` with its status and
   the matched record's link (`doi.org` / `arxiv.org` / source URL), so
   verified citations are one click to confirm. Mismatches and not-found
   entries additionally become comments (`comment_type: "reference"`) quoting
   the verbatim entry and linking the record found (each carries a "verify
   manually" caveat, since database coverage has gaps), plus a free
   deterministic check for in-text citations like `[23]` that point past the
   end of the bibliography. The check produces its **own method block**
   (`reference_check__<model>`) with its own `cost_usd` — reference-check
   spend is never mixed into the content review's numbers.

## Tuning

Via the `references` option: `sources` (order/subset of
`crossref | openalex | arxiv | semanticscholar`), `customSources`
(implement the `ReferenceSource` interface to plug in DBLP, PubMed, or an
internal corpus), `concurrency`, `topK`, `thresholds`, `llmAdjudication:
false` to skip the tie-breaker, `s2ApiKey`, `timeoutMs`, `fetchImpl`.

Standalone use: `reviewReferences(slug, text, options)` runs just the
check and returns `{ result, stats, references }`; the step functions
(`extractReferences`, `checkReference`, ...) are exported individually for
durable-execution runtimes. The prompts are customizable
[like all others](./prompts.md): blocks `referenceMatchCriteria` /
`referenceLeniency`, templates `referenceExtraction` / `referenceVerdict` /
`referenceLocator`.
