/** Bibliography extraction: locate the references section, parse via LLM. */

import { chat } from "../client.js";
import { parseFirstJsonValue } from "../parsing.js";
import { referenceExtractionPrompt } from "../prompts.js";
import type { ReviewOptions, TokenUsage } from "../types.js";
import { chatOptionsFrom } from "../methods/shared.js";
import { normalizeDoi } from "./match.js";
import type { ExtractedReference, ReferenceKind } from "./types.js";

export interface ReferencesSection {
  /** Text of the references section (up to any appendix). */
  text: string;
  /** Character offset of the section body within the document. */
  offset: number;
}

/** Find the references/bibliography section (last matching heading wins). */
export function findReferencesSection(documentText: string): ReferencesSection | null {
  const headingRe =
    /^[ \t]*(?:#{1,6}[ \t]*)?(?:[IVXivx\d]+[.)][ \t]*)?(?:\*\*)?(references|bibliography|works cited|literature cited)(?:\*\*)?[ \t]*:?[ \t]*$/gim;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = headingRe.exec(documentText))) last = match;
  if (!last) return null;

  const offset = last.index + last[0].length;
  let text = documentText.slice(offset);
  const stop = text.search(/^[ \t]*(?:#{1,6}[ \t]*)?(appendix|appendices|supplementary)\b/im);
  if (stop > 0) text = text.slice(0, stop);
  text = text.trim();
  return text ? { text, offset } : null;
}

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
  usage: TokenUsage;
}

/**
 * Extract structured bibliography entries from a paper's text (one LLM call
 * per ~20k-char chunk of the references section). Plain JSON in and out —
 * safe as a durable-execution step.
 */
export async function extractReferences(
  documentText: string,
  options: ReviewOptions = {},
): Promise<ExtractReferencesOutput> {
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  const section = findReferencesSection(documentText);
  if (!section) return { references: [], sectionFound: false, usage };

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
  return { references, sectionFound: true, usage };
}
