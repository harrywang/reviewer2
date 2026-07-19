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

export {
  DEFAULT_PROMPT_BLOCKS,
  defaultPromptTemplates,
  validatePromptOverrides,
  type PromptBlocks,
  type PromptOverrides,
  type PromptTemplates,
} from "./prompts.js";
export { splitIntoParagraphs } from "./textutils.js";
export { addUsage, type UsageAccumulator } from "./usage.js";

// Reference check steps: each is plain-JSON in/out, so a durable runtime can
// wrap extract → per-reference check → (optional) adjudication as retryable
// steps and assemble the ReviewResult itself, or run reviewReferences whole.
export {
  adjudicateReference,
  checkReference,
  classifyReference,
  extractReferences,
  findOverflowCitations,
  findReferencesSection,
  locateReferencesLlm,
  lookupReferenceCandidates,
  reviewReferences,
  type CheckedReference,
  type ExtractedReference,
  type ExtractReferencesOutput,
  type MatchedRecord,
  type ReferenceCandidate,
  type ReferenceCheckOptions,
  type ReferenceCheckOutput,
  type ReferenceSource,
  type ReviewReferencesOptions,
} from "./refcheck/index.js";

export type {
  PaperReviewJson,
  ReferenceCheckStats,
  ReferenceSectionSource,
  ReferenceStatus,
  ReviewComment,
  ReviewOptions,
  ReviewResult,
  TokenUsage,
} from "./types.js";
