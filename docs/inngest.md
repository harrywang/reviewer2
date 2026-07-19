# Long-running reviews in a Next.js app (Inngest)

A real review runs 20–60+ minutes — far beyond any serverless timeout.
Back to the [README](../README.md).

Don't run a review in a route handler; run it as a chain of **durable
steps** and treat the route as enqueue + status:

```
POST /api/reviews → DB row → inngest.send()          (returns 202 instantly)
Inngest fn: prepare → passage-0…N → feedback → consolidate → save JSON
GET /api/reviews?id → { status, progress, result? }  (poll or Inngest Realtime)
```

The `reviewer2/steps` entry point exposes the pipeline as step-sized,
JSON-serializable functions, so each passage becomes its own retryable,
checkpointed `step.run` — a failure at passage 37 never re-pays for passages
0–36:

```ts
import {
  prepareProgressive, runProgressivePassage,
  generateOverallFeedback, consolidateComments, buildPaperJson,
} from "reviewer2/steps";

const plan = await step.run("prepare", () => prepareProgressive(text));
let summary = "";
const all = [];
for (let i = 0; i < plan.passages.length; i++) {
  const out = await step.run(`passage-${i}`, () =>
    runProgressivePassage({ plan, passageIndex: i, runningSummary: summary, options }));
  summary = out.updatedSummary;
  all.push(...out.comments);
}
const feedback = await step.run("feedback", () => generateOverallFeedback(text, options));
const final = await step.run("consolidate", () => consolidateComments(all, options));
const paper = buildPaperJson({ slug, title, paragraphs: plan.paragraphs, results: [/*…*/] });
```

The [reference check](./reference-check.md) decomposes the same way:
`extractReferences` → one `checkReference` step per entry (or
`reviewReferences` as a single step for small bibliographies).

See **[`examples/inngest/`](../examples/inngest/)** for the complete function,
route handlers, progress reporting, and the step-state rules (4 MB step
output cap, JSON-only state, pinned `currentDate` for deterministic retries).
