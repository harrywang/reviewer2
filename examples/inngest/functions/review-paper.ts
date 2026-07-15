/**
 * Inngest function: run a long paper review as a chain of durable steps.
 *
 * Why steps instead of one big `step.run`:
 * - Each serverless invocation has a hard timeout (~5 min per step on Vercel).
 *   A full progressive review makes 2 LLM calls per passage and can run
 *   20–60+ minutes for a real paper — it can never fit in one invocation.
 * - Each `step.run` is checkpointed. If a later LLM call fails, Inngest
 *   retries only that step; completed passages are never re-paid for.
 * - Steps give natural progress reporting (n of N passages done).
 *
 * State passed between steps is plain JSON (the package's step API is
 * designed for this). Keep step outputs small: this function stores the
 * final result in your own DB and returns only ids/counts.
 */
import { Inngest } from "inngest";
import {
  buildPaperJson,
  consolidateComments,
  generateOverallFeedback,
  prepareProgressive,
  runProgressivePassage,
  type ReviewComment,
  type ReviewOptions,
  type ReviewResult,
} from "reviewer2/steps";

export const inngest = new Inngest({ id: "my-app" });

// Replace these with your own persistence (Prisma, Drizzle, ...)
import { loadPaperText, saveReviewResult, updateReviewProgress } from "../lib/db.js";

export const reviewPaperFn = inngest.createFunction(
  {
    id: "review-paper",
    // One review at a time per paper; drop duplicate requests
    concurrency: [{ key: "event.data.paperId", limit: 1 }],
    retries: 3,
  },
  { event: "paper/review.requested" },
  async ({ event, step }) => {
    const { paperId, reviewId } = event.data as { paperId: string; reviewId: string };

    const options: ReviewOptions = {
      // Default: OPENAI_API_KEY from env. Pass provider/model per tenant if needed:
      // provider: "openrouter", model: "anthropic/claude-opus-4-6", apiKey: ...
      model: process.env.REVIEW_MODEL ?? "gpt-5-mini",
      // Pin the prompt date so retried/replayed steps build identical prompts
      currentDate: new Date(event.ts ?? Date.now()).toISOString().slice(0, 10),
    };

    // Step 0 — load the extracted text (extract it in an earlier step/function
    // with parseDocumentBuffer if you only have the PDF).
    const { text, title, slug } = await step.run("load-paper", () => loadPaperText(paperId));

    // Step 1 — deterministic plan: paragraphs + passages (no LLM calls).
    const plan = await step.run("prepare", () => prepareProgressive(text));

    // Step 2 — one durable step per passage (2 LLM calls each, sequential
    // because the running summary threads through).
    let runningSummary = "";
    const allComments: ReviewComment[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    for (let i = 0; i < plan.passages.length; i++) {
      const out = await step.run(`passage-${i}`, () =>
        runProgressivePassage({ plan, passageIndex: i, runningSummary, options }),
      );
      runningSummary = out.updatedSummary;
      allComments.push(...out.comments);
      promptTokens += out.usage.promptTokens;
      completionTokens += out.usage.completionTokens;

      await step.run(`progress-${i}`, () =>
        updateReviewProgress(reviewId, {
          done: i + 1,
          total: plan.passages.length,
          commentsSoFar: allComments.length,
        }),
      );
    }

    // Step 3 — overall feedback + consolidation.
    const feedback = await step.run("overall-feedback", () =>
      generateOverallFeedback(text, options),
    );
    const consolidated = await step.run("consolidate", () =>
      consolidateComments(allComments, options),
    );
    promptTokens += feedback.usage.promptTokens + consolidated.usage.promptTokens;
    completionTokens += feedback.usage.completionTokens + consolidated.usage.completionTokens;

    // Step 4 — assemble the viz-compatible JSON and persist it.
    const result: ReviewResult = {
      method: "progressive",
      paperSlug: slug,
      comments: consolidated.comments,
      overallFeedback: feedback.feedback,
      totalPromptTokens: promptTokens,
      totalCompletionTokens: completionTokens,
      model: options.model!,
      reasoningEffort: null,
    };
    const paper = buildPaperJson({ slug, title, paragraphs: plan.paragraphs, results: [result] });

    await step.run("save-result", () => saveReviewResult(reviewId, paper));

    return { reviewId, comments: consolidated.comments.length };
  },
);
