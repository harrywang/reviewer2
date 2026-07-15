/** Method: Zero-shot paper review. */

import { chat } from "../client.js";
import { mapWithConcurrency } from "../concurrency.js";
import { largePaperChunkPrompt, OCR_CAVEAT, zeroShotPrompt } from "../prompts.js";
import { parseReviewResponse } from "../parsing.js";
import { assignParagraphIndices } from "../textutils.js";
import { chunkText, countTokens } from "../tokens.js";
import type { ReviewComment, ReviewOptions, ReviewResult } from "../types.js";
import { chatOptionsFrom, resolveCurrentDate, resolveModel } from "./shared.js";

const MAX_TOKENS_SINGLE = 100_000; // use a single prompt if the paper fits

export async function reviewZeroShot(
  paperSlug: string,
  documentContent: string,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  const currentDate = resolveCurrentDate(options);
  const ocrCaveat = options.ocr ? OCR_CAVEAT : "";
  const chatOpts = chatOptionsFrom(options);

  const result: ReviewResult = {
    method: "zero_shot",
    paperSlug,
    comments: [],
    overallFeedback: "",
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    model: resolveModel(options),
    reasoningEffort: options.reasoningEffort ?? null,
  };

  const tokenCount = countTokens(documentContent);

  if (tokenCount <= MAX_TOKENS_SINGLE) {
    const prompt = zeroShotPrompt({ paperText: documentContent, currentDate, ocrCaveat });
    const { text, usage } = await chat([{ role: "user", content: prompt }], {
      ...chatOpts,
      maxTokens: 8192,
    });
    result.model = usage.model;
    result.totalPromptTokens += usage.promptTokens;
    result.totalCompletionTokens += usage.completionTokens;
    const { overallFeedback, comments } = parseReviewResponse(text);
    result.overallFeedback = overallFeedback;
    result.comments = comments;
    await options.onProgress?.({
      stage: "chunk",
      current: 1,
      total: 1,
      newComments: comments.length,
      totalComments: comments.length,
    });
  } else {
    const chunks = chunkText(documentContent, 80_000);
    let done = 0;
    const chunkResults = await mapWithConcurrency(chunks, options.concurrency ?? 1, async (chunk, i) => {
      const prompt = largePaperChunkPrompt({
        chunkNum: i + 1,
        totalChunks: chunks.length,
        chunkText: chunk,
        currentDate,
        ocrCaveat,
      });
      const { text, usage } = await chat([{ role: "user", content: prompt }], {
        ...chatOpts,
        maxTokens: 8192,
      });
      const parsed = parseReviewResponse(text);
      done += 1;
      await options.onProgress?.({
        stage: "chunk",
        current: done,
        total: chunks.length,
        newComments: parsed.comments.length,
        totalComments: -1,
      });
      return { parsed, usage };
    });

    const overallParts: string[] = [];
    const allComments: ReviewComment[] = [];
    for (const { parsed, usage } of chunkResults) {
      result.model = usage.model;
      result.totalPromptTokens += usage.promptTokens;
      result.totalCompletionTokens += usage.completionTokens;
      if (parsed.overallFeedback) overallParts.push(parsed.overallFeedback);
      allComments.push(...parsed.comments);
    }
    result.overallFeedback = overallParts.join("\n\n");
    result.comments = allComments;
  }

  assignParagraphIndices(result.comments, documentContent);
  await options.onProgress?.({ stage: "done", totalComments: result.comments.length });
  return result;
}
