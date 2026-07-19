/** Data models for the reviewer. Mirrors the Python OpenAIReview JSON contract. */

export type CommentType = "technical" | "logical" | "reference";

/** A comment (issue) found by the reviewer. */
export interface ReviewComment {
  title: string;
  /** The flagged verbatim text from the paper. */
  quote: string;
  /** Reviewer's explanation. */
  explanation: string;
  commentType: CommentType;
  /** 0-based index into the split paragraphs, or null if it couldn't be located. */
  paragraphIndex: number | null;
}

export type ReviewMethod = "zero_shot" | "local" | "progressive" | "progressive_full";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Output of a review method. */
export interface ReviewResult {
  method: string;
  paperSlug: string;
  comments: ReviewComment[];
  overallFeedback: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /**
   * Per-model token breakdown. Present when the run tracked usage via
   * addUsage(); lets computeCost price mixed-model runs exactly.
   */
  usageByModel?: Record<string, TokenUsage>;
  model: string;
  reasoningEffort?: ReasoningEffort | null;
}

/* ------------------------------------------------------------------ */
/* Reference accuracy check                                            */
/* ------------------------------------------------------------------ */

/** Outcome of checking one bibliography entry against the databases. */
export type ReferenceStatus =
  | "verified" // a matching record was found and metadata agrees
  | "mismatch" // the work exists but the citation's metadata is wrong
  | "not_found" // no plausible record in any source — possible hallucination
  | "unverifiable" // books/URLs/theses etc., or all lookups failed — never flagged
  | "ambiguous"; // couldn't decide (adjudication off or inconclusive) — never flagged

/** Non-LLM accounting for a reference check run. */
export interface ReferenceCheckStats {
  entries: number;
  verified: number;
  mismatched: number;
  notFound: number;
  unverifiable: number;
  ambiguous: number;
  /** How many entries needed the LLM adjudication tie-breaker. */
  adjudicated: number;
  /** HTTP requests made per source (includes retries) — quota visibility. */
  apiCallsBySource: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* Viz-compatible output JSON (what `openaireview serve` renders)      */
/* ------------------------------------------------------------------ */

/** One comment in the viz JSON (snake_case, matches Python output exactly). */
export interface PaperCommentJson {
  id: string;
  title: string;
  quote: string;
  explanation: string;
  comment_type: CommentType;
  paragraph_index: number | null;
}

export interface PaperMethodJson {
  label: string;
  model: string;
  overall_feedback: string;
  comments: PaperCommentJson[];
  cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * The viz-compatible paper result JSON. This is the shape the bundled
 * visualization (viz/index.html) and any web UI should consume.
 */
export interface PaperReviewJson {
  slug: string;
  title: string;
  paragraphs: { index: number; text: string }[];
  methods: Record<string, PaperMethodJson>;
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

export type ProviderName = "openai" | "openrouter" | "anthropic" | "gemini";

export interface ProviderConfig {
  /** Which provider to use. Default: auto-detect (OpenAI first). */
  provider?: ProviderName;
  /** API key. Default: read from the provider's env var. */
  apiKey?: string;
  /** Override the base URL (e.g. Azure/EU endpoint for OpenAI). */
  baseUrl?: string;
}

/* ------------------------------------------------------------------ */
/* Progress reporting                                                  */
/* ------------------------------------------------------------------ */

export type ReviewProgressEvent =
  | { stage: "parsing"; message: string }
  | { stage: "prepared"; paragraphs: number; passages: number; docTokens: number }
  | {
      stage: "passage";
      current: number; // 1-based
      total: number;
      newComments: number;
      totalComments: number;
    }
  | { stage: "chunk"; current: number; total: number; newComments: number; totalComments: number }
  | { stage: "overall_feedback" }
  | { stage: "consolidation"; before: number; after?: number }
  | { stage: "references_extract"; entries: number; sectionFound: boolean }
  | { stage: "reference_lookup"; current: number; total: number; status: ReferenceStatus }
  | { stage: "references_done"; stats: ReferenceCheckStats }
  | { stage: "done"; totalComments: number };

export type ProgressCallback = (event: ReviewProgressEvent) => void | Promise<void>;

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface ChatOptions extends ProviderConfig {
  model?: string;
  temperature?: number | null;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort | null;
  retries?: number;
  signal?: AbortSignal;
}

import type { PromptOverrides } from "./prompts.js";

export interface ReviewOptions extends ProviderConfig {
  /** Model id, e.g. "gpt-5.2", "anthropic/claude-opus-4-6", "openai/gpt-5.2-pro". */
  model?: string;
  /**
   * Customize the prompts: override shared building blocks (e.g. just the
   * check criteria) and/or whole templates with {placeholder} interpolation.
   * Plain strings — JSON-safe for DB storage and Inngest step boundaries.
   */
  prompts?: PromptOverrides;
  reasoningEffort?: ReasoningEffort | null;
  /** True when the text came from OCR — adds an OCR caveat to prompts. */
  ocr?: boolean;
  /** Window of surrounding passages used as context (local/progressive). */
  windowSize?: number;
  /** Max parallel LLM calls for parallelizable methods (local, chunked zero-shot). */
  concurrency?: number;
  /** ISO date injected into prompts. Defaults to today; pass a fixed value for deterministic replays. */
  currentDate?: string;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}
