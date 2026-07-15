/**
 * Step-level API for durable-execution runtimes (Inngest, Temporal, etc.).
 *
 * The progressive review is a sequential chain of LLM calls; wrapping each
 * passage in its own durable step gives you retries, resumability, and
 * progress reporting for free. Every function here takes and returns plain
 * JSON values, safe to pass across step boundaries (no Map/Set/Date/class
 * instances).
 *
 * Typical Inngest usage:
 *
 * ```ts
 * const plan = await step.run("prepare", () => prepareProgressive(text));
 * let summary = "";
 * const all: ReviewComment[] = [];
 * for (let i = 0; i < plan.passages.length; i++) {
 *   const out = await step.run(`passage-${i}`, () =>
 *     runProgressivePassage({ plan, passageIndex: i, runningSummary: summary, options }),
 *   );
 *   summary = out.updatedSummary;
 *   all.push(...out.comments);
 * }
 * const feedback = await step.run("feedback", () => generateOverallFeedback(text, options));
 * const final = await step.run("consolidate", () => consolidateComments(all, options));
 * const paper = buildPaperJson({ slug, title, paragraphs: plan.paragraphs, results: [...] });
 * ```
 */

export {
  consolidateComments,
  generateOverallFeedback,
  isTechnicalPassage,
  prepareProgressive,
  runProgressivePassage,
  type PassageStepInput,
  type PassageStepOutput,
  type ProgressivePlan,
} from "./methods/progressive.js";

export {
  buildMethodJson,
  buildPaperJson,
  methodKey,
  modelShortName,
  OCR_DISCLAIMER,
  slugify,
} from "./review.js";

export {
  computeCost,
  fetchLivePricing,
  type LivePricingOptions,
  type PricingTable,
} from "./cost.js";
export { splitIntoParagraphs } from "./textutils.js";
export type {
  PaperReviewJson,
  ReviewComment,
  ReviewOptions,
  ReviewResult,
  TokenUsage,
} from "./types.js";
