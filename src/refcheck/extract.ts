/**
 * Bibliography extraction: locate the references section, parse via LLM.
 *
 * Section locating is layered, cheapest first:
 *   1. "heading"    — line scan tolerant of markdown, numbering, letter-
 *                     spaced OCR headings (R E F E R E N C E S), and
 *                     common non-English headings
 *   2. "structural" — no heading found: detect a run of bibliography-shaped
 *                     lines (years, DOIs, [n] labels, author patterns)
 *   3. "llm"        — one small locator call as a last resort; its tokens
 *                     are tracked in the reference-check usage/cost
 */

import { chat } from "../client.js";
import { parseFirstJsonValue } from "../parsing.js";
import { referenceExtractionPrompt, referenceLocatorPrompt } from "../prompts.js";
import type { ReferenceSectionSource, ReviewOptions, TokenUsage } from "../types.js";
import { chatOptionsFrom } from "../methods/shared.js";
import { normalizeDoi } from "./match.js";
import type { ExtractedReference, ReferenceKind } from "./types.js";

export interface ReferencesSection {
  /** Text of the references section (up to any appendix). */
  text: string;
  /** Character offset of the section body within the document. */
  offset: number;
  /** Which locating layer found it. */
  source: Exclude<ReferenceSectionSource, "none">;
}

/* ------------------------------------------------------------------ */
/* Layer 1: heading scan                                               */
/* ------------------------------------------------------------------ */

/** Keywords a heading line may normalize to (diacritics stripped). */
const SECTION_KEYWORDS = new Set([
  "references",
  "reference",
  "referencescited",
  "bibliography",
  "workscited",
  "literaturecited",
  "bibliographie",
  "bibliografia",
  "referencias",
  "literaturverzeichnis",
  "参考文献",
]);

/**
 * Normalize a candidate heading line: strip markdown/numbering/punctuation/
 * whitespace and diacritics so "## References", "6 References", "IV.
 * REFERENCES:", "R E F E R E N C E S" and "Références" all normalize to a
 * keyword. Roman-numeral prefixes are stripped before letter filtering.
 */
function normalizeHeadingLine(line: string): string {
  return line
    .replace(/^\s*[IVXLCivxlc]+[.)]\s+/, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\u4e00-\u9fff]+/g, "");
}

interface Line {
  text: string;
  offset: number;
}

function splitLines(documentText: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  for (const text of documentText.split("\n")) {
    lines.push({ text, offset });
    offset += text.length + 1;
  }
  return lines;
}

function findByHeading(documentText: string, lines: Line[]): ReferencesSection | null {
  let last: Line | null = null;
  for (const line of lines) {
    if (line.text.length > 80) continue;
    if (SECTION_KEYWORDS.has(normalizeHeadingLine(line.text))) last = line;
  }
  if (!last) return null;
  const offset = last.offset + last.text.length;
  const text = cutAtAppendix(documentText.slice(offset)).trim();
  if (!text || !looksLikeBibliography(text)) return null;
  return { text, offset, source: "heading" };
}

/* ------------------------------------------------------------------ */
/* Layer 2: structural detection                                       */
/* ------------------------------------------------------------------ */

const ENTRY_PATTERNS: RegExp[] = [
  /\b(1[89]|20)\d{2}[a-z]?\b/, // year
  /\bdoi\b|\barxiv\b|https?:\/\//i, // identifier or link
  /^\s*\[\d{1,3}\]/, // "[12]" label
  /\b(?:vol|no|pp?)\.\s*\d|\d+\(\d+\)/i, // journal loci: vol. 5, 12(3)
  /[A-Z][\p{L}'-]+,\s*(?:[A-Z]\.\s*)+/u, // "Smith, A." author pattern
];

/** How many bibliography-typical patterns a line matches. */
function entryScore(line: string): number {
  let score = 0;
  for (const re of ENTRY_PATTERNS) if (re.test(line)) score++;
  return score;
}

/** Weak sanity check: the slice contains at least one entry-ish line. */
function looksLikeBibliography(text: string): boolean {
  return text
    .split("\n")
    .slice(0, 50)
    .some((line) => entryScore(line) >= 1);
}

/**
 * Detect a bibliography with no usable heading: find the first line in the
 * back part of the document where a 10-line window holds ≥5 strongly
 * entry-shaped lines (score ≥ 2).
 */
function findByShape(documentText: string, lines: Line[]): ReferencesSection | null {
  const searchFrom = Math.floor(documentText.length * 0.4);
  const nonEmpty = lines.filter((l) => l.text.trim().length > 0);
  const scores = nonEmpty.map((l) => (entryScore(l.text) >= 2 ? 1 : 0));

  for (let i = 0; i < nonEmpty.length; i++) {
    if (nonEmpty[i].offset < searchFrom || !scores[i]) continue;
    const window = scores.slice(i, i + 10);
    if (window.reduce((a: number, b: number) => a + b, 0) >= 5) {
      const offset = nonEmpty[i].offset;
      const text = cutAtAppendix(documentText.slice(offset)).trim();
      return text ? { text, offset, source: "structural" } : null;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

function cutAtAppendix(text: string): string {
  const stop = text.search(/^[ \t]*(?:#{1,6}[ \t]*)?(appendix|appendices|supplementary)\b/im);
  return stop > 0 ? text.slice(0, stop) : text;
}

/**
 * Locate the references section deterministically: heading scan first,
 * bibliography-shape detection as fallback. Returns null when neither
 * finds it (callers may then try locateReferencesLlm).
 */
export function findReferencesSection(documentText: string): ReferencesSection | null {
  const lines = splitLines(documentText);
  return findByHeading(documentText, lines) ?? findByShape(documentText, lines);
}

/* ------------------------------------------------------------------ */
/* Layer 3: LLM locator (fallback only — costs one small call)         */
/* ------------------------------------------------------------------ */

const LOCATOR_TAIL_CHARS = 20_000;

/**
 * Ask the model to quote the first line of the first reference entry in the
 * document's tail, then anchor the section at that verbatim line. Used only
 * when deterministic locating fails; usage is returned for cost tracking.
 */
export async function locateReferencesLlm(
  documentText: string,
  options: ReviewOptions = {},
): Promise<{ section: ReferencesSection | null; usage: TokenUsage }> {
  const tail = documentText.slice(-LOCATOR_TAIL_CHARS);
  const resp = await chat(
    [{ role: "user", content: referenceLocatorPrompt({ documentTail: tail, overrides: options.prompts }) }],
    { ...chatOptionsFrom(options), maxTokens: 1024 },
  );
  const usage: TokenUsage = {
    promptTokens: resp.usage.promptTokens,
    completionTokens: resp.usage.completionTokens,
  };

  const line = resp.text.trim().split("\n")[0]?.trim() ?? "";
  if (!line || /^none$/i.test(line)) return { section: null, usage };

  let offset = documentText.lastIndexOf(line);
  if (offset < 0 && line.length > 40) offset = documentText.lastIndexOf(line.slice(0, 40));
  if (offset < 0) return { section: null, usage };

  const text = cutAtAppendix(documentText.slice(offset)).trim();
  if (!text || !looksLikeBibliography(text)) return { section: null, usage };
  return { section: { text, offset, source: "llm" }, usage };
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

/** Split references text into chunks of at most maxChars at line boundaries. */
function splitRefsText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

const KINDS: ReferenceKind[] = ["paper", "book", "web", "thesis", "software", "other"];

function coerceReference(raw: unknown): Omit<ExtractedReference, "index"> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const rawText = String(r.raw ?? r.text ?? "").trim();
  if (!rawText) return null;

  const yearN = Number(r.year);
  const kind = String(r.kind ?? "").toLowerCase() as ReferenceKind;
  const arxivRaw = r.arxiv_id ?? r.arxivId;
  return {
    label: r.label != null && String(r.label).trim() ? String(r.label).trim() : null,
    raw: rawText,
    title: r.title != null && String(r.title).trim() ? String(r.title).trim() : null,
    authors: Array.isArray(r.authors) ? r.authors.map((a) => String(a)).filter(Boolean) : [],
    year: Number.isFinite(yearN) && yearN >= 1500 && yearN <= 2200 ? Math.trunc(yearN) : null,
    venue: r.venue != null && String(r.venue).trim() ? String(r.venue).trim() : null,
    doi: normalizeDoi(r.doi != null ? String(r.doi) : null),
    arxivId:
      arxivRaw != null && String(arxivRaw).trim()
        ? String(arxivRaw).trim().replace(/^arxiv:\s*/i, "")
        : null,
    kind: KINDS.includes(kind) ? kind : "other",
  };
}

export interface ExtractReferencesOutput {
  references: ExtractedReference[];
  sectionFound: boolean;
  /** Which locating layer found the section ("none" if not found). */
  sectionSource: ReferenceSectionSource;
  usage: TokenUsage;
}

/**
 * Extract structured bibliography entries from a paper's text (one LLM call
 * per ~20k-char chunk of the references section; plus one locator call only
 * when deterministic locating fails). Plain JSON in and out — safe as a
 * durable-execution step.
 */
export async function extractReferences(
  documentText: string,
  options: ReviewOptions = {},
): Promise<ExtractReferencesOutput> {
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

  let section = findReferencesSection(documentText);
  if (!section) {
    const located = await locateReferencesLlm(documentText, options);
    usage.promptTokens += located.usage.promptTokens;
    usage.completionTokens += located.usage.completionTokens;
    section = located.section;
  }
  if (!section) return { references: [], sectionFound: false, sectionSource: "none", usage };

  const references: ExtractedReference[] = [];
  for (const chunk of splitRefsText(section.text, 20_000)) {
    const prompt = referenceExtractionPrompt({
      referencesText: chunk,
      ocr: options.ocr,
      overrides: options.prompts,
    });
    const resp = await chat([{ role: "user", content: prompt }], {
      ...chatOptionsFrom(options),
      maxTokens: 16384,
    });
    usage.promptTokens += resp.usage.promptTokens;
    usage.completionTokens += resp.usage.completionTokens;

    const parsed = parseFirstJsonValue(resp.text);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const ref = coerceReference(item);
        if (ref) references.push({ ...ref, index: references.length });
      }
    }
  }
  return { references, sectionFound: true, sectionSource: section.source, usage };
}
