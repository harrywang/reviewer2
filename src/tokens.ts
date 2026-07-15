/** Token counting/truncation/chunking using js-tiktoken (o200k_base). */

import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

let encoding: Tiktoken | null | undefined;

function getEncoding(): Tiktoken | null {
  if (encoding === undefined) {
    try {
      encoding = new Tiktoken(o200k_base);
    } catch {
      encoding = null;
    }
  }
  return encoding;
}

export function countTokens(text: string): number {
  const enc = getEncoding();
  if (!enc) return Math.floor(text.length / 4);
  return enc.encode(text, "all").length;
}

/** Truncate text to at most maxTokens tokens. */
export function truncateText(text: string, maxTokens: number): string {
  const enc = getEncoding();
  if (!enc) return text.slice(0, maxTokens * 4);
  const tokens = enc.encode(text, "all").slice(0, maxTokens);
  return enc.decode(tokens);
}

/** Split text into chunks of at most maxTokens with overlap. */
export function chunkText(text: string, maxTokens = 6000, overlapTokens = 200): string[] {
  const enc = getEncoding();
  if (!enc) {
    const charsPerChunk = maxTokens * 4;
    const overlapChars = overlapTokens * 4;
    const chunks: string[] = [];
    let i = 0;
    while (i < text.length) {
      chunks.push(text.slice(i, i + charsPerChunk));
      i += charsPerChunk - overlapChars;
    }
    return chunks;
  }
  const tokens = enc.encode(text, "all");
  const chunks: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    chunks.push(enc.decode(tokens.slice(i, i + maxTokens)));
    i += maxTokens - overlapTokens;
  }
  return chunks;
}
