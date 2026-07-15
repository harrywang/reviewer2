/**
 * Method: Progressive summary-based review (the default).
 *
 * Processes the paper sequentially, maintaining a running summary of
 * definitions, equations, theorems, and key claims. For each passage:
 *   1. (Optional) Pre-filter to skip non-technical content
 *   2. Deep-check: running summary + window context + passage → find errors
 *   3. Summary update: current summary + passage → updated summary
 * Then a post-hoc consolidation pass deduplicates and prunes issues.
 *
 * The per-passage work is exposed as standalone, JSON-serializable step
 * functions (prepareProgressive / runProgressivePassage / consolidate /
 * overall feedback) so a durable-execution runtime like Inngest can wrap
 * each one in its own retryable step.
 */

import { chat } from "../client.js";
import {
  consolidationPrompt,
  deepCheckPrompt,
  overallFeedbackPrompt,
  summaryUpdatePrompt,
  technicalFilterPrompt,
} from "../prompts.js";
import { parseCommentsFromResponse } from "../parsing.js";
import {
  getWindowContext,
  locateCommentsInWindow,
  mergeIntoPassages,
  splitIntoParagraphs,
  type Passage,
} from "../textutils.js";
import { countTokens } from "../tokens.js";
import type { ReviewComment, ReviewOptions, ReviewResult, TokenUsage } from "../types.js";
import { chatOptionsFrom, resolveCurrentDate, resolveModel } from "./shared.js";

/* ------------------------------------------------------------------ */
/* Step 0: deterministic preparation (no LLM calls)                    */
/* ------------------------------------------------------------------ */

export interface ProgressivePlan {
  paragraphs: string[];
  passages: Passage[];
  docTokens: number;
  maxSummaryTokens: number;
}

export function prepareProgressive(documentContent: string): ProgressivePlan {
  const paragraphs = splitIntoParagraphs(documentContent);
  const passages = mergeIntoPassages(paragraphs, 8000);
  const docTokens = countTokens(documentContent);
  // Scale summary budget with document length: ~10% of doc tokens, floor 4000
  const maxSummaryTokens = Math.max(4000, Math.floor(docTokens / 10));
  return { paragraphs, passages, docTokens, maxSummaryTokens };
}

/* ------------------------------------------------------------------ */
/* Per-passage step: deep-check + summary update                       */
/* ------------------------------------------------------------------ */

export interface PassageStepInput {
  plan: ProgressivePlan;
  passageIndex: number;
  runningSummary: string;
  options?: ReviewOptions;
}

export interface PassageStepOutput {
  comments: ReviewComment[];
  updatedSummary: string;
  usage: TokenUsage;
  skipped: boolean;
}

/**
 * Process one passage: optional technical pre-filter, deep-check, and
 * running-summary update. Input and output are plain JSON — safe to pass
 * across Inngest step boundaries.
 */
export async function runProgressivePassage(input: PassageStepInput): Promise<PassageStepOutput> {
  const { plan, passageIndex, runningSummary } = input;
  const options = input.options ?? {};
  const currentDate = resolveCurrentDate(options);
  const chatOpts = chatOptionsFrom(options);
  const windowSize = options.windowSize ?? 3;
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

  const passage = plan.passages[passageIndex];

  // Build context: running summary + window
  const windowContext = getWindowContext(plan.passages, passageIndex, windowSize);
  const context = runningSummary
    ? `PAPER SUMMARY (key definitions, equations, and claims so far):\n${runningSummary}\n\n---\n\n${windowContext}`
    : windowContext;

  // Step 1: Deep-check
  const prompt = deepCheckPrompt({
    context,
    passage: passage.text,
    currentDate,
    ocr: options.ocr,
    progressive: true,
    overrides: options.prompts,
  });
  const deepCheck = await chat([{ role: "user", content: prompt }], {
    ...chatOpts,
    maxTokens: 16384,
  });
  usage.promptTokens += deepCheck.usage.promptTokens;
  usage.completionTokens += deepCheck.usage.completionTokens;

  let comments: ReviewComment[] = [];
  if (deepCheck.text.trim()) {
    comments = parseCommentsFromResponse(deepCheck.text);
    if (comments.length) {
      locateCommentsInWindow(comments, passageIndex, plan.passages, plan.paragraphs, windowSize);
    }
  }

  // Step 2: Update running summary
  const summaryPrompt = summaryUpdatePrompt({
    currentSummary: runningSummary || "(empty — this is the first passage)",
    passageText: passage.text,
    passageIdx: passageIndex,
    totalPassages: plan.passages.length,
    overrides: options.prompts,
  });
  const summaryResp = await chat([{ role: "user", content: summaryPrompt }], {
    ...chatOpts,
    maxTokens: 3000,
  });
  usage.promptTokens += summaryResp.usage.promptTokens;
  usage.completionTokens += summaryResp.usage.completionTokens;

  let updatedSummary = summaryResp.text.trim();
  if (countTokens(updatedSummary) > plan.maxSummaryTokens) {
    updatedSummary = updatedSummary.slice(0, plan.maxSummaryTokens * 4);
  }

  return { comments, updatedSummary, usage, skipped: false };
}

/** Ask the model whether a passage has technical content worth checking. */
export async function isTechnicalPassage(
  passageText: string,
  options: ReviewOptions = {},
): Promise<{ technical: boolean; usage: TokenUsage }> {
  const { text, usage } = await chat(
    [{ role: "user", content: technicalFilterPrompt(passageText.slice(0, 2000), options.prompts) }],
    { ...chatOptionsFrom(options), maxTokens: 8 },
  );
  return {
    technical: text.trim().toLowerCase().startsWith("yes"),
    usage,
  };
}

/* ------------------------------------------------------------------ */
/* Consolidation step                                                  */
/* ------------------------------------------------------------------ */

function commentToJson(c: ReviewComment): Record<string, unknown> {
  const d: Record<string, unknown> = {
    title: c.title,
    quote: c.quote,
    explanation: c.explanation,
    comment_type: c.commentType,
  };
  if (c.paragraphIndex !== null) d.paragraph_index = c.paragraphIndex;
  return d;
}

/** Post-hoc consolidation: deduplicate and prune low-quality issues. */
export async function consolidateComments(
  comments: ReviewComment[],
  options: ReviewOptions = {},
): Promise<{ comments: ReviewComment[]; usage: TokenUsage }> {
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  if (!comments.length) return { comments, usage };

  const issuesJson = JSON.stringify(comments.map(commentToJson), null, 2);
  const outputCap = countTokens(issuesJson) + 1024;
  const { text, usage: callUsage } = await chat(
    [{ role: "user", content: consolidationPrompt(issuesJson, options.prompts) }],
    { ...chatOptionsFrom(options), maxTokens: outputCap },
  );
  usage.promptTokens += callUsage.promptTokens;
  usage.completionTokens += callUsage.completionTokens;

  const consolidated = parseCommentsFromResponse(text);
  if (consolidated.length) {
    // Preserve paragraphIndex from original comments by matching quotes
    const origByQuote = new Map<string, number | null>();
    for (const c of comments) {
      origByQuote.set(c.quote.slice(0, 200), c.paragraphIndex);
    }
    for (const c of consolidated) {
      if (c.paragraphIndex === null) {
        c.paragraphIndex = origByQuote.get(c.quote.slice(0, 200)) ?? null;
      }
    }
    return { comments: consolidated, usage };
  }

  return { comments, usage }; // fallback: return originals if parsing fails
}

/* ------------------------------------------------------------------ */
/* Overall feedback step                                               */
/* ------------------------------------------------------------------ */

export async function generateOverallFeedback(
  documentContent: string,
  options: ReviewOptions = {},
): Promise<{ feedback: string; usage: TokenUsage }> {
  const { text, usage } = await chat(
    [{ role: "user", content: overallFeedbackPrompt(documentContent.slice(0, 8000), options.prompts) }],
    { ...chatOptionsFrom(options), maxTokens: 2048 },
  );
  return { feedback: text.trim(), usage };
}

/* ------------------------------------------------------------------ */
/* Full method: sequential orchestration                               */
/* ------------------------------------------------------------------ */

export interface ProgressiveOptions extends ReviewOptions {
  /** Pre-filter non-technical passages with a cheap yes/no call. Default false. */
  skipNontechnical?: boolean;
}

/**
 * Review a paper using the progressive summary approach.
 * Returns { consolidated, full } — full holds all pre-consolidation comments.
 */
export async function reviewProgressive(
  paperSlug: string,
  documentContent: string,
  options: ProgressiveOptions = {},
): Promise<{ consolidated: ReviewResult; full: ReviewResult }> {
  const result: ReviewResult = {
    method: "progressive",
    paperSlug,
    comments: [],
    overallFeedback: "",
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    model: resolveModel(options),
    reasoningEffort: options.reasoningEffort ?? null,
  };

  const plan = prepareProgressive(documentContent);
  await options.onProgress?.({
    stage: "prepared",
    paragraphs: plan.paragraphs.length,
    passages: plan.passages.length,
    docTokens: plan.docTokens,
  });

  let runningSummary = "";
  const allComments: ReviewComment[] = [];

  for (let idx = 0; idx < plan.passages.length; idx++) {
    // Optional pre-filter
    if (options.skipNontechnical) {
      const { technical, usage } = await isTechnicalPassage(plan.passages[idx].text, options);
      result.totalPromptTokens += usage.promptTokens;
      result.totalCompletionTokens += usage.completionTokens;
      if (!technical) {
        // Still update the summary for skipped passages (may hold definitions)
        const summaryResp = await chat(
          [
            {
              role: "user",
              content: summaryUpdatePrompt({
                currentSummary: runningSummary || "(empty — this is the first passage)",
                passageText: plan.passages[idx].text,
                passageIdx: idx,
                totalPassages: plan.passages.length,
                overrides: options.prompts,
              }),
            },
          ],
          { ...chatOptionsFrom(options), maxTokens: 3000 },
        );
        result.totalPromptTokens += summaryResp.usage.promptTokens;
        result.totalCompletionTokens += summaryResp.usage.completionTokens;
        runningSummary = summaryResp.text.trim();
        continue;
      }
    }

    const step = await runProgressivePassage({
      plan,
      passageIndex: idx,
      runningSummary,
      options,
    });
    result.totalPromptTokens += step.usage.promptTokens;
    result.totalCompletionTokens += step.usage.completionTokens;
    allComments.push(...step.comments);
    runningSummary = step.updatedSummary;

    await options.onProgress?.({
      stage: "passage",
      current: idx + 1,
      total: plan.passages.length,
      newComments: step.comments.length,
      totalComments: allComments.length,
    });
  }

  // Overall feedback
  await options.onProgress?.({ stage: "overall_feedback" });
  const feedback = await generateOverallFeedback(documentContent, options);
  result.overallFeedback = feedback.feedback;
  result.totalPromptTokens += feedback.usage.promptTokens;
  result.totalCompletionTokens += feedback.usage.completionTokens;

  // Consolidation pass
  await options.onProgress?.({ stage: "consolidation", before: allComments.length });
  const consolidated = await consolidateComments(allComments, options);
  result.totalPromptTokens += consolidated.usage.promptTokens;
  result.totalCompletionTokens += consolidated.usage.completionTokens;
  result.comments = consolidated.comments;
  await options.onProgress?.({
    stage: "consolidation",
    before: allComments.length,
    after: consolidated.comments.length,
  });

  const full: ReviewResult = {
    ...result,
    method: "progressive_full",
    comments: allComments,
  };

  await options.onProgress?.({ stage: "done", totalComments: result.comments.length });
  return { consolidated: result, full };
}
