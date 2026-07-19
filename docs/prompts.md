# Customizing prompts

Every prompt is customizable via the `prompts` option, at two levels. Both
are plain strings — JSON-safe, so custom prompts can be stored per
user/track in a database and passed through Inngest step boundaries.
Back to the [README](../README.md).

**1. Block overrides** — replace one shared building block, keep the prompt
structure. The most common tweak is the check criteria:

```ts
await reviewPaper(text, {
  prompts: {
    blocks: {
      checkCriteria: `Check for:
1. Statistical validity: p-hacking, underpowered samples, wrong tests
2. Reproducibility: missing data/code availability, underspecified methods
3. Overclaiming relative to the evidence presented`,
    },
  },
});
```

Available blocks: `reviewerPreamble`, `checkCriteria`, `explanationStyle`,
`leniencyRules`, `doNotFlag`, `ocrCaveat`, `jsonArrayOutput`,
`referenceMatchCriteria`, `referenceLeniency` — see `DEFAULT_PROMPT_BLOCKS`
for the default text of each.

**2. Template overrides** — replace an entire prompt. Templates use
`{placeholder}` interpolation (single-pass, so LaTeX braces in paper text
are never mangled; unknown placeholders are left as-is):

```ts
await reviewPaper(text, {
  prompts: {
    templates: {
      overallFeedback: `You are a harsh but fair Reviewer #2. In one paragraph,
assess the paper below and name its single biggest weakness.

PAPER (beginning):
{paperStart}`,
    },
  },
});
```

**A completely different review prompt** — replace `deepCheckProgressive`
(the main prompt of the default method). Reuse the default output-format
block so the built-in parser still understands the response:

```ts
import { DEFAULT_PROMPT_BLOCKS, reviewPaper } from "reviewer2";

const empiricalDeepCheck = `You are a methodologist reviewing an empirical
social-science paper. Today's date is {currentDate}.

{ocrCaveat}
CONTEXT (running summary + surrounding sections):
{context}

---

PASSAGE TO CHECK:
{passage}

---

Check ONLY for:
1. Identification problems: confounds, selection, reverse causality
2. Statistical issues: wrong test, multiple comparisons, p-hacking signs
3. Measurement validity: does the variable measure the claimed construct?
4. External validity claims beyond the sample

${DEFAULT_PROMPT_BLOCKS.jsonArrayOutput}`;

await reviewPaper(text, {
  prompts: { templates: { deepCheckProgressive: empiricalDeepCheck } },
});
```

**Switching prompt sets per run** — because overrides are plain JSON, you
can keep named presets (in code or a DB row) and pick one per paper/track:

```ts
import type { PromptOverrides } from "reviewer2";

const PRESETS: Record<string, PromptOverrides> = {
  theoretical: {},                                    // package defaults
  empirical: {
    blocks: { checkCriteria: "Check for:\n1. Statistical validity…" },
  },
  strict: {
    blocks: { leniencyRules: "Be lenient with nothing. Flag every issue." },
  },
};

await reviewPaper(text, { prompts: PRESETS[track.reviewStyle] });
```

| Template | Placeholders |
|---|---|
| `deepCheck` / `deepCheckProgressive` | `{currentDate}` `{ocrCaveat}` `{context}` `{passage}` |
| `zeroShot` | `{currentDate}` `{ocrCaveat}` `{paperText}` |
| `largePaperChunk` | `{currentDate}` `{ocrCaveat}` `{chunkNum}` `{totalChunks}` `{chunkText}` |
| `summaryUpdate` | `{currentSummary}` `{passageText}` `{passageIdx}` `{totalPassages}` |
| `technicalFilter` | `{passage}` (answer must be exactly "yes"/"no") |
| `consolidation` | `{issuesJson}` |
| `overallFeedback` | `{paperStart}` |
| `referenceExtraction` | `{referencesText}` `{ocrCaveat}` |
| `referenceVerdict` | `{referenceJson}` `{candidatesJson}` |
| `referenceLocator` | `{documentTail}` (answer: a verbatim line or "NONE") |

Precedence: template override > block override > default. Inspect the
defaults with `defaultPromptTemplates()` / `DEFAULT_PROMPT_BLOCKS` and use
`resolvePromptTemplates(overrides)` to preview the effective prompts.

⚠️ If you rewrite a template that asks for JSON (`deepCheck*`, `zeroShot`,
`largePaperChunk`, `consolidation`), keep the requested output shape —
items with `title` / `quote` / `explanation` / `type` — or the built-in
parser won't extract comments. `technicalFilter` must keep the yes/no
answer contract.

`validatePromptOverrides(overrides)` returns warnings for unknown template
names and custom templates missing a required placeholder (e.g. a
`referenceVerdict` override without `{candidatesJson}` would silently drop
the database records). `reviewPaper` runs it automatically and
`console.warn`s any problems.
