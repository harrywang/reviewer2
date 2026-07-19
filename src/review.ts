/** High-level review orchestrator producing viz-compatible JSON. */

import { computeCost, type PricingTable } from "./cost.js";
import { reviewLocal } from "./methods/local.js";
import { reviewProgressive, type ProgressiveOptions } from "./methods/progressive.js";
import { reviewZeroShot } from "./methods/zeroShot.js";
import { warnPromptOverrides } from "./prompts.js";
import {
  reviewReferences,
  type CheckedReference,
  type ReferenceCheckOptions,
} from "./refcheck/index.js";
import { splitIntoParagraphs } from "./textutils.js";
import type {
  PaperCommentJson,
  PaperMethodJson,
  PaperReviewJson,
  ReferenceCheckStats,
  ReviewMethod,
  ReviewOptions,
  ReviewResult,
} from "./types.js";

export const OCR_DISCLAIMER =
  "This document was extracted by OCR engine and could contain mistakes.";

/** Convert a name to a URL-friendly slug. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/** Extract the short model name from a provider/model string. */
export function modelShortName(model: string): string {
  return model.includes("/") ? model.split("/").pop()! : model;
}

/** Build a unique key for a method+model combination. */
export function methodKey(method: string, model: string): string {
  return `${method}__${modelShortName(model)}`;
}

/** Build the viz-compatible method block for one ReviewResult. */
export function buildMethodJson(
  result: ReviewResult,
  key: string,
  pricing?: PricingTable,
): PaperMethodJson {
  const comments: PaperCommentJson[] = result.comments.map((c, i) => ({
    id: `${key}_${i}`,
    title: c.title,
    quote: c.quote,
    explanation: c.explanation,
    comment_type: c.commentType,
    paragraph_index: c.paragraphIndex,
  }));

  const short = result.model ? modelShortName(result.model) : "";
  let label = result.method.replaceAll("_", " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
  if (short) label = `${label} (${short})`;

  return {
    label,
    model: result.model,
    overall_feedback: result.overallFeedback,
    comments,
    cost_usd: Math.round(computeCost(result, pricing) * 10_000) / 10_000,
    prompt_tokens: result.totalPromptTokens,
    completion_tokens: result.totalCompletionTokens,
  };
}

/** Build the viz-compatible paper JSON for one or more results. */
export function buildPaperJson(args: {
  slug: string;
  title: string;
  paragraphs: string[];
  results: ReviewResult[];
  wasOcr?: boolean;
  /** Merge into an existing paper JSON (adds/replaces method blocks). */
  existing?: PaperReviewJson;
  /** Pricing table for cost_usd (e.g. from fetchLivePricing). Default: static table. */
  pricing?: PricingTable;
}): PaperReviewJson {
  const paragraphs = args.wasOcr ? [...args.paragraphs, OCR_DISCLAIMER] : args.paragraphs;

  const methods: Record<string, PaperMethodJson> = { ...(args.existing?.methods ?? {}) };
  for (const result of args.results) {
    const key = methodKey(result.method, result.model);
    methods[key] = buildMethodJson(result, key, args.pricing);
  }

  return {
    slug: args.existing?.slug ?? args.slug,
    title: args.existing?.title ?? args.title,
    paragraphs:
      args.existing?.paragraphs ?? paragraphs.map((text, index) => ({ index, text })),
    methods,
  };
}

export interface ReviewPaperOptions extends ProgressiveOptions {
  method?: ReviewMethod;
  /** Paper slug (default: slugified title). */
  slug?: string;
  /** Paper title shown in the UI (default: first heading / first line). */
  title?: string;
  /** Pricing table for cost_usd (e.g. from fetchLivePricing). Default: static table. */
  pricing?: PricingTable;
  /**
   * Verify bibliography entries against bibliographic databases (Crossref,
   * OpenAlex, arXiv — keyless) to catch hallucinated or inaccurate
   * references. Default OFF: when false, no extra LLM or HTTP calls are made.
   */
  checkReferences?: boolean;
  /** Tuning for the reference check (sources, mailto, thresholds, model...). */
  references?: ReferenceCheckOptions;
}

export interface ReviewPaperOutput {
  /** Viz-compatible JSON — feed this straight to a web UI or viz/index.html. */
  paper: PaperReviewJson;
  /** The primary result (consolidated, for progressive). */
  result: ReviewResult;
  /** Pre-consolidation result (progressive only). */
  fullResult?: ReviewResult;
  /**
   * Reference check result (only when checkReferences is true). Its token
   * usage and cost are tracked separately from the content review — it also
   * appears as its own method block ("reference_check__<model>") in `paper`.
   */
  referenceResult?: ReviewResult;
  /** Reference check accounting (per-source API calls, verdict counts). */
  referenceStats?: ReferenceCheckStats;
  /**
   * Per-entry reference check breakdown in bibliography order, including the
   * matched database record and its link for verified/mismatched entries.
   */
  checkedReferences?: CheckedReference[];
}

/**
 * Review a paper's plain text and return visualization-ready JSON.
 *
 * `documentText` is the already-extracted paper text (use parseDocument /
 * parseDocumentBuffer for PDFs, DOCX, arXiv URLs, etc.).
 */
export async function reviewPaper(
  documentText: string,
  options: ReviewPaperOptions = {},
): Promise<ReviewPaperOutput> {
  warnPromptOverrides(options.prompts);
  const method = options.method ?? "progressive";
  const title =
    options.title ??
    documentText
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean)
      ?.replace(/^#+\s*/, "")
      .slice(0, 200) ??
    "Untitled";
  const slug = options.slug ?? slugify(title) ?? "paper";

  let result: ReviewResult;
  let fullResult: ReviewResult | undefined;

  if (method === "zero_shot") {
    result = await reviewZeroShot(slug, documentText, options);
  } else if (method === "local") {
    result = await reviewLocal(slug, documentText, options);
  } else {
    const { consolidated, full } = await reviewProgressive(slug, documentText, options);
    if (method === "progressive_full") {
      result = full;
    } else {
      result = consolidated;
      full.method = "progressive_original";
      fullResult = full;
    }
  }

  // Opt-in reference accuracy check — separate result, separate cost.
  let referenceResult: ReviewResult | undefined;
  let referenceStats: ReferenceCheckStats | undefined;
  let checkedReferences: CheckedReference[] | undefined;
  if (options.checkReferences) {
    const refCheck = await reviewReferences(slug, documentText, options);
    referenceResult = refCheck.result;
    referenceStats = refCheck.stats;
    checkedReferences = refCheck.references;
  }

  const paragraphs = splitIntoParagraphs(documentText);
  const results = [result, ...(fullResult ? [fullResult] : []), ...(referenceResult ? [referenceResult] : [])];
  const paper = buildPaperJson({
    slug,
    title,
    paragraphs,
    results,
    wasOcr: options.ocr,
    pricing: options.pricing,
  });

  return { paper, result, fullResult, referenceResult, referenceStats, checkedReferences };
}
