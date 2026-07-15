/** Local window review: deep-check each chunk with surrounding context. */

import { chat } from "../client.js";
import { mapWithConcurrency } from "../concurrency.js";
import { deepCheckPrompt, overallFeedbackPrompt } from "../prompts.js";
import { parseCommentsFromResponse } from "../parsing.js";
import {
  getWindowContext,
  locateCommentsInWindow,
  mergeIntoPassages,
  splitIntoParagraphs,
} from "../textutils.js";
import type { ReviewComment, ReviewOptions, ReviewResult } from "../types.js";
import { chatOptionsFrom, resolveCurrentDate, resolveModel } from "./shared.js";

export async function reviewLocal(
  paperSlug: string,
  documentContent: string,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  const currentDate = resolveCurrentDate(options);
  const windowSize = options.windowSize ?? 3;
  const chatOpts = chatOptionsFrom(options);

  const result: ReviewResult = {
    method: "local",
    paperSlug,
    comments: [],
    overallFeedback: "",
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    model: resolveModel(options),
    reasoningEffort: options.reasoningEffort ?? null,
  };

  const paragraphs = splitIntoParagraphs(documentContent);
  const chunks = mergeIntoPassages(paragraphs, 4000);
  await options.onProgress?.({
    stage: "prepared",
    paragraphs: paragraphs.length,
    passages: chunks.length,
    docTokens: -1,
  });

  let totalComments = 0;
  let done = 0;
  const perChunk = await mapWithConcurrency(chunks, options.concurrency ?? 4, async (chunk, chunkIdx) => {
    const context = getWindowContext(chunks, chunkIdx, windowSize);
    const prompt = deepCheckPrompt({
      context,
      passage: chunk.text,
      currentDate,
      ocr: options.ocr,
      overrides: options.prompts,
    });
    const { text, usage } = await chat([{ role: "user", content: prompt }], {
      ...chatOpts,
      maxTokens: 16384,
    });
    const comments = text.trim() ? parseCommentsFromResponse(text) : [];
    if (comments.length) {
      locateCommentsInWindow(comments, chunkIdx, chunks, paragraphs, windowSize);
    }
    done += 1;
    totalComments += comments.length;
    await options.onProgress?.({
      stage: "chunk",
      current: done,
      total: chunks.length,
      newComments: comments.length,
      totalComments,
    });
    return { comments, usage };
  });

  const allComments: ReviewComment[] = [];
  for (const { comments, usage } of perChunk) {
    result.model = usage.model;
    result.totalPromptTokens += usage.promptTokens;
    result.totalCompletionTokens += usage.completionTokens;
    allComments.push(...comments);
  }
  result.comments = allComments;

  // Overall feedback from the paper's beginning
  await options.onProgress?.({ stage: "overall_feedback" });
  const { text: feedback, usage } = await chat(
    [{ role: "user", content: overallFeedbackPrompt(documentContent.slice(0, 8000), options.prompts) }],
    { ...chatOpts, maxTokens: 2048 },
  );
  result.overallFeedback = feedback.trim();
  result.totalPromptTokens += usage.promptTokens;
  result.totalCompletionTokens += usage.completionTokens;

  await options.onProgress?.({ stage: "done", totalComments: result.comments.length });
  return result;
}
