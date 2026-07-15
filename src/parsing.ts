/** Robust parsing of LLM review responses (port of utils.py parsing helpers). */

import type { CommentType, ReviewComment } from "./types.js";

const TECHNICAL_KEYWORDS = [
  "formula",
  "equation",
  "math",
  "proof",
  "calculation",
  "theorem",
  "incorrect",
  "wrong",
  "error",
  "sign",
  "factor",
  "variance",
  "derivation",
  "typo",
  "parameter",
];

/** Convert a list of raw objects into ReviewComment objects (alias-tolerant). */
export function parseCommentsFromList(items: unknown[]): ReviewComment[] {
  const comments: ReviewComment[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const title = String(raw.title ?? raw.name ?? "Untitled");
    const quote = String(raw.quote ?? raw.flagged_text ?? raw.text ?? "");
    const explanation = String(raw.explanation ?? raw.message ?? raw.comment ?? "");
    let commentType = String(raw.type ?? raw.comment_type ?? "logical").toLowerCase();
    if (commentType !== "technical" && commentType !== "logical") {
      const haystack = (title + explanation).toLowerCase();
      commentType = TECHNICAL_KEYWORDS.some((kw) => haystack.includes(kw))
        ? "technical"
        : "logical";
    }
    let paragraphIndex: number | null = null;
    if (raw.paragraph_index !== undefined && raw.paragraph_index !== null) {
      const n = Number(raw.paragraph_index);
      paragraphIndex = Number.isFinite(n) ? Math.trunc(n) : null;
    }
    comments.push({
      title,
      quote,
      explanation,
      commentType: commentType as CommentType,
      paragraphIndex,
    });
  }
  return comments;
}

/** Best-effort decode of a JSON-style string fragment. */
function decodeJsonishString(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isNaN(code) ? m : String.fromCharCode(code);
    })
    .replaceAll("\\/", "/")
    .replaceAll('\\"', '"')
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll("\\\\", "\\");
}

/** Recover overall_feedback from malformed JSON-ish output. */
function extractOverallFeedbackFallback(text: string): string {
  const match = text.match(/"overall_feedback"\s*:\s*"([\s\S]*?)"\s*,\s*"comments"\s*:/);
  if (!match) return "";
  return decodeJsonishString(match[1]).trim();
}

/** Recover comment objects from malformed JSON-ish output (schema-specific). */
function extractCommentsFallback(text: string): ReviewComment[] {
  const pattern =
    /\{\s*"title"\s*:\s*"([\s\S]*?)"\s*,\s*"quote"\s*:\s*"([\s\S]*?)"\s*,\s*"explanation"\s*:\s*"([\s\S]*?)"\s*,\s*"type"\s*:\s*"(technical|logical)"\s*\}/g;
  const items: Record<string, string>[] = [];
  for (const match of text.matchAll(pattern)) {
    items.push({
      title: decodeJsonishString(match[1]).trim(),
      quote: decodeJsonishString(match[2]).trim(),
      explanation: decodeJsonishString(match[3]).trim(),
      type: match[4].trim(),
    });
  }
  return parseCommentsFromList(items);
}

/**
 * Scan text for the first parseable top-level JSON object/array starting at
 * a `{` or `[`. Equivalent to Python's JSONDecoder.raw_decode loop.
 */
function scanForJson(text: string): unknown | undefined {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const candidate = tryParsePrefix(text, i);
    if (candidate === undefined) continue;
    if (Array.isArray(candidate)) {
      if (candidate.length === 0 || (typeof candidate[0] === "object" && candidate[0] !== null)) {
        return candidate;
      }
      continue;
    }
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      ("overall_feedback" in candidate || "comments" in candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Try to JSON.parse a balanced object/array starting at `start`.
 * Tracks string/escape state to find the matching close bracket.
 */
function tryParsePrefix(text: string, start: number): unknown | undefined {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Parse an LLM response returning { overallFeedback, comments }.
 *
 * Handles two formats:
 * - {"overall_feedback": "...", "comments": [...]}  (preferred)
 * - [...]  (bare array fallback)
 * plus markdown fences and malformed-JSON regex recovery.
 */
export function parseReviewResponse(response: string): {
  overallFeedback: string;
  comments: ReviewComment[];
} {
  let text = response.trim();
  text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();

  const obj = scanForJson(text);

  if (obj === undefined) {
    return {
      overallFeedback: extractOverallFeedbackFallback(text),
      comments: extractCommentsFallback(text),
    };
  }

  if (Array.isArray(obj)) {
    return { overallFeedback: "", comments: parseCommentsFromList(obj) };
  }

  const record = obj as Record<string, unknown>;
  const overallFeedback = typeof record.overall_feedback === "string" ? record.overall_feedback : "";
  const items = Array.isArray(record.comments) ? record.comments : [];
  return { overallFeedback, comments: parseCommentsFromList(items) };
}

/** Parse a JSON array of comments from an LLM response. */
export function parseCommentsFromResponse(response: string): ReviewComment[] {
  return parseReviewResponse(response).comments;
}
