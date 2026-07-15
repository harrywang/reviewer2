# Next.js + Inngest integration

A paper review is a long chain of LLM calls (2 per passage + feedback +
consolidation — 20–60+ minutes for a real paper). That never fits in a
route handler or a single serverless invocation, so the pattern is:

```
POST /api/reviews ──► create DB row ──► inngest.send("paper/review.requested")
                                              │
        Inngest function (durable steps) ◄────┘
        ├─ step: prepare            (deterministic, no LLM)
        ├─ step: passage-0..N       (2 LLM calls each, checkpointed)
        ├─ step: overall-feedback
        ├─ step: consolidate
        └─ step: save-result        (viz-compatible JSON → DB)
                                              │
GET /api/reviews?id=... ◄── client polls ─────┘   (or Inngest Realtime)
```

## Files

- `functions/review-paper.ts` — the Inngest function using the `reviewer2/steps` API
- `app/api/reviews/route.ts` — enqueue (POST) and status/result (GET) handlers
- `lib/db.ts` — persistence stubs with a suggested Prisma model

## Why one `step.run` per passage

| Concern | How steps solve it |
|---|---|
| Serverless timeout (~5 min/invocation on Vercel) | Each passage is its own invocation; the function "sleeps" between steps |
| A flaky LLM call at passage 37 | Only that step retries — passages 0–36 come from Inngest's checkpoint, no re-spend |
| Progress UI | Update a DB row (or publish to Inngest Realtime) after each passage |
| Duplicate clicks | `concurrency: { key: event.data.paperId, limit: 1 }` |
| Cancellation | `inngest.send({ name: "paper/review.cancelled" })` + `cancelOn` in the function config |

## Step-state rules (Inngest memoizes step outputs)

- Everything crossing a step boundary must be plain JSON — the whole
  `reviewer2/steps` API takes/returns JSON-safe values only.
- Keep step outputs small (Inngest caps step output at 4 MB, total run
  state at 32 MB). Store the paper text and final result in *your* DB/S3;
  pass ids between steps where possible. `prepareProgressive`'s plan holds
  the paper text once — fine for typical papers (< 1 MB), but for very
  large documents persist the plan yourself and load it per step.
- Pin `currentDate` in options (as the example does) so retried steps
  build byte-identical prompts.

## Progress to the browser

Simplest (shown here): the function updates `AiReview.progress` after each
passage; the client polls `GET /api/reviews?id=...` with SWR every few
seconds. Swap in Inngest Realtime (`publish()` inside steps + `useRealtime`
in React) for push updates without polling — the step structure is
identical.

## Getting the paper text

Run extraction in an earlier step (or a separate function) so OCR is also
retried/checkpointed:

```ts
const parsed = await step.run("extract", async () => {
  const buffer = await getFileFromS3(paperFileKey); // your storage
  return parseDocumentBuffer(new Uint8Array(buffer), "pdf");
});
```
