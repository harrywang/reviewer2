/** Paragraph/passage splitting and fuzzy quote-to-paragraph localization. */

import { getMatchingBlocks } from "./seqmatcher.js";
import { countTokens } from "./tokens.js";
import type { ReviewComment } from "./types.js";

/** A passage: merged adjacent paragraphs with their original indices. */
export interface Passage {
  paragraphIndices: number[];
  text: string;
}

/** Split document into paragraphs, merging short ones with the next. */
export function splitIntoParagraphs(text: string, minChars = 100): string[] {
  const raw = text
    .split("\n\n")
    .map((p) => p.trim())
    .filter(Boolean);
  const paragraphs: string[] = [];
  let carry = "";
  for (let p of raw) {
    if (carry) {
      p = carry + "\n\n" + p;
      carry = "";
    }
    if (p.length < minChars) {
      carry = p;
    } else {
      paragraphs.push(p);
    }
  }
  if (carry) {
    if (paragraphs.length) {
      paragraphs[paragraphs.length - 1] = paragraphs[paragraphs.length - 1] + "\n\n" + carry;
    } else {
      paragraphs.push(carry);
    }
  }
  return paragraphs;
}

/** Merge adjacent paragraphs into passages of ~targetChars. */
export function mergeIntoPassages(paragraphs: string[], targetChars = 8000): Passage[] {
  const passages: Passage[] = [];
  let currentIndices: number[] = [];
  let currentText = "";

  paragraphs.forEach((para, i) => {
    if (currentText && currentText.length + para.length > targetChars) {
      passages.push({ paragraphIndices: currentIndices, text: currentText });
      currentIndices = [];
      currentText = "";
    }
    currentIndices.push(i);
    currentText = (currentText + "\n\n" + para).trim();
  });

  if (currentText) {
    passages.push({ paragraphIndices: currentIndices, text: currentText });
  }
  return passages;
}

/** Get surrounding passages as context (asymmetric: more before, less after). */
export function getWindowContext(
  passages: Passage[],
  passageIdx: number,
  window = 3,
  maxTokens = 6000,
): string {
  const before = window + 2;
  const after = Math.max(1, window - 1);
  const start = Math.max(0, passageIdx - before);
  const end = Math.min(passages.length, passageIdx + after + 1);
  const parts: string[] = [];
  for (let i = start; i < end; i++) {
    const marker = i === passageIdx ? ">>> " : "    ";
    parts.push(`${marker}[section ${i}] ${passages[i].text}`);
  }
  let context = parts.join("\n\n");
  if (countTokens(context) > maxTokens) {
    context = context.slice(0, maxTokens * 4);
  }
  return context;
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("<br>", " ")
    .replaceAll("|", " ")
    .replaceAll("*", "")
    .replaceAll("_", "")
    .replaceAll("’", "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fraction of the quote covered by matching blocks in the window.
 * Divides only by quote length so extra window content isn't penalized.
 */
function quoteCoverage(quote: string, window: string): number {
  if (!quote) return 0;
  const matched = getMatchingBlocks(quote, window).reduce((sum, b) => sum + b.size, 0);
  return matched / quote.length;
}

/**
 * Find the paragraph index that best matches a quote via fuzzy matching.
 * Returns null if no paragraph scores above the threshold.
 */
export function locateCommentInDocument(
  quote: string,
  paragraphs: string[],
  threshold = 0.3,
): number | null {
  if (!quote || !paragraphs.length) return null;

  const quoteNorm = normalizeForMatch(quote).slice(0, 1000);
  let bestIdx: number | null = null;
  let bestScore = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const paraNorm = normalizeForMatch(paragraphs[i]);
    if (quoteNorm && paraNorm.includes(quoteNorm)) return i;

    // Compare against sliding windows so long table-like paragraphs still match.
    let windows: string[];
    if (paraNorm.length <= quoteNorm.length + 200) {
      windows = [paraNorm];
    } else {
      const windowSize = Math.min(paraNorm.length, Math.max(quoteNorm.length + 200, 400));
      const step = Math.max(Math.floor(windowSize / 2), 100);
      windows = [];
      for (let start = 0; start <= paraNorm.length - windowSize; start += step) {
        windows.push(paraNorm.slice(start, start + windowSize));
      }
      if ((paraNorm.length - windowSize) % step) {
        windows.push(paraNorm.slice(-windowSize));
      }
    }

    const score = Math.max(...windows.map((w) => quoteCoverage(quoteNorm, w)));
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestScore >= threshold ? bestIdx : null;
}

/** Set paragraphIndex on each comment by matching within the context window. */
export function locateCommentsInWindow(
  comments: ReviewComment[],
  chunkIdx: number,
  chunks: Passage[],
  paragraphs: string[],
  windowSize = 3,
): void {
  const before = windowSize + 2;
  const after = Math.max(1, windowSize - 1);
  const winStart = Math.max(0, chunkIdx - before);
  const winEnd = Math.min(chunks.length, chunkIdx + after + 1);
  const windowParaIndices: number[] = [];
  for (let wi = winStart; wi < winEnd; wi++) {
    windowParaIndices.push(...chunks[wi].paragraphIndices);
  }
  const windowParas = windowParaIndices.map((i) => paragraphs[i]);
  for (const c of comments) {
    const located = locateCommentInDocument(c.quote, windowParas);
    if (located !== null && located < windowParaIndices.length) {
      c.paragraphIndex = windowParaIndices[located];
    } else {
      c.paragraphIndex = null;
    }
  }
}

/** Set paragraphIndex on each comment by locating its quote in the whole document. */
export function assignParagraphIndices(comments: ReviewComment[], documentContent: string): void {
  const paragraphs = splitIntoParagraphs(documentContent);
  for (const comment of comments) {
    comment.paragraphIndex = locateCommentInDocument(comment.quote, paragraphs);
  }
}
