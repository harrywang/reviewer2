/**
 * Reference accuracy check (opt-in).
 *
 * Verifies every bibliography entry against real bibliographic databases
 * (Crossref, OpenAlex, arXiv — all keyless; Semantic Scholar with a key) to
 * catch hallucinated or inaccurate citations:
 *   1. Extract structured entries from the references section (LLM)
 *   2. Look each entry up by DOI / arXiv id / title search (HTTP, no LLM)
 *   3. Classify deterministically; LLM-adjudicate only ambiguous cases,
 *      grounded on the retrieved records
 *   4. Emit ReviewComments for mismatches and not-found entries, plus a
 *      deterministic in-text citation numbering check
 *
 * Produces its own ReviewResult (method "reference_check") so token usage and
 * cost are tracked separately from the content review. Step functions take
 * and return plain JSON — safe across durable-execution boundaries.
 */

import { chat } from "../client.js";
import { mapWithConcurrency } from "../concurrency.js";
import { parseFirstJsonValue } from "../parsing.js";
import { referenceVerdictPrompt, warnPromptOverrides } from "../prompts.js";
import { assignParagraphIndices } from "../textutils.js";
import { addUsage } from "../usage.js";
import { chatOptionsFrom, resolveModel } from "../methods/shared.js";
import type {
  ReferenceCheckStats,
  ReferenceStatus,
  ReviewComment,
  ReviewOptions,
  ReviewResult,
  TokenUsage,
} from "../types.js";
import { extractReferences, findReferencesSection } from "./extract.js";
import {
  arxivIdFromDoi,
  classifyReference,
  normalizeDoi,
  normalizeTitle,
  titleSimilarity,
} from "./match.js";
import { buildReferenceSources } from "./sources.js";
import {
  DEFAULT_MATCH_THRESHOLDS,
  type CheckedReference,
  type ExtractedReference,
  type MatchedRecord,
  type MatchThresholds,
  type ReferenceCandidate,
  type ReferenceCheckOptions,
  type ReferenceSource,
  type SourceContext,
} from "./types.js";

export * from "./types.js";
export { extractReferences, findReferencesSection, type ExtractReferencesOutput } from "./extract.js";
export {
  arxivIdFromDoi,
  authorOverlap,
  classifyReference,
  normalizeDoi,
  normalizeTitle,
  scoreCandidate,
  titleSimilarity,
  type MatchResult,
} from "./match.js";
export {
  arxivSource,
  buildReferenceSources,
  BUILTIN_SOURCES,
  crossrefSource,
  normalizeArxivId,
  openalexSource,
  semanticScholarSource,
} from "./sources.js";

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

export interface LookupOutput {
  candidates: ReferenceCandidate[];
  /** Source names that were queried for this entry. */
  attempted: string[];
  /** Source names whose requests failed (network/HTTP errors). */
  errored: string[];
}

function dedupeCandidates(candidates: ReferenceCandidate[]): ReferenceCandidate[] {
  const seen = new Set<string>();
  const out: ReferenceCandidate[] = [];
  for (const c of candidates) {
    const key = normalizeDoi(c.doi) ?? `${normalizeTitle(c.title)}|${c.year ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Retrieve candidate records for one entry: DOI lookups first (first source
 * that resolves it wins), then arXiv id, then title searches — skipped when
 * an exact-id fetch already strongly matches the cited title.
 */
export async function lookupReferenceCandidates(
  ref: ExtractedReference,
  sources: ReferenceSource[],
  ctx: SourceContext,
): Promise<LookupOutput> {
  const candidates: ReferenceCandidate[] = [];
  const attempted = new Set<string>();
  const errored = new Set<string>();

  const run = async <T>(source: ReferenceSource, fn: () => Promise<T>): Promise<T | null> => {
    attempted.add(source.name);
    try {
      return await fn();
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      errored.add(source.name);
      return null;
    }
  };

  // arXiv id — explicit, or embedded in a 10.48550/arxiv.* DOI — is the most
  // precise handle, and arXiv itself is authoritative for it (aggregators
  // sometimes hold junk records under arXiv DOIs). Check it first.
  const doi = normalizeDoi(ref.doi);
  const arxivId = ref.arxivId ?? arxivIdFromDoi(doi);
  if (arxivId) {
    for (const source of sources) {
      if (!source.byArxivId) continue;
      const c = await run(source, () => source.byArxivId!(arxivId, ctx));
      if (c) {
        candidates.push({ ...c, matchedBy: "arxiv" });
        break;
      }
    }
  }

  // Generic DOI lookup — skipped for an arXiv DOI that arXiv already resolved
  const arxivSettled =
    candidates.length > 0 &&
    (!ref.title || titleSimilarity(ref.title, candidates[0].title) >= 0.5);
  if (doi && !(arxivIdFromDoi(doi) && arxivSettled)) {
    for (const source of sources) {
      if (!source.byDoi) continue;
      const c = await run(source, () => source.byDoi!(doi, ctx));
      if (c) {
        candidates.push({ ...c, matchedBy: "doi" });
        break;
      }
    }
  }

  const exact = candidates[0];
  const exactSettles =
    exact !== undefined && (!ref.title || titleSimilarity(ref.title, exact.title) >= 0.5);
  if (!exactSettles) {
    for (const source of sources) {
      if (!source.search) continue;
      const found = await run(source, () => source.search!(ref, ctx));
      if (found) candidates.push(...found.map((c) => ({ ...c, matchedBy: "search" as const })));
    }
  }

  return {
    candidates: dedupeCandidates(candidates),
    attempted: [...attempted],
    errored: [...errored],
  };
}

/* ------------------------------------------------------------------ */
/* LLM adjudication (ambiguous cases only)                             */
/* ------------------------------------------------------------------ */

export interface AdjudicationOutput {
  verdict: "verified" | "mismatch" | "not_found" | null;
  explanation: string;
  usage: TokenUsage;
}

function refJson(ref: ExtractedReference): string {
  return JSON.stringify(
    {
      raw: ref.raw,
      title: ref.title,
      authors: ref.authors,
      year: ref.year,
      venue: ref.venue,
      doi: ref.doi,
      arxiv_id: ref.arxivId,
    },
    null,
    2,
  );
}

function candidatesJson(candidates: ReferenceCandidate[]): string {
  return JSON.stringify(
    candidates.slice(0, 8).map((c) => ({
      source: c.source,
      title: c.title,
      authors: c.authors,
      year: c.year,
      venue: c.venue,
      doi: c.doi,
      arxiv_id: c.arxivId,
    })),
    null,
    2,
  );
}

/**
 * Grounded LLM tie-breaker: the model only compares the cited entry against
 * the retrieved records — it cannot introduce outside knowledge as evidence.
 * Returns verdict null when the response can't be parsed (entry then stays
 * "ambiguous" and is never flagged).
 */
export async function adjudicateReference(
  ref: ExtractedReference,
  candidates: ReferenceCandidate[],
  options: ReviewOptions = {},
): Promise<AdjudicationOutput> {
  const prompt = referenceVerdictPrompt({
    referenceJson: refJson(ref),
    candidatesJson: candidatesJson(candidates),
    overrides: options.prompts,
  });
  const resp = await chat([{ role: "user", content: prompt }], {
    ...chatOptionsFrom(options),
    maxTokens: 4096,
  });
  const parsed = parseFirstJsonValue(resp.text) as Record<string, unknown> | undefined;
  const verdictRaw = String(parsed?.verdict ?? "").toLowerCase();
  const verdict =
    verdictRaw === "verified" || verdictRaw === "mismatch" || verdictRaw === "not_found"
      ? verdictRaw
      : null;
  return {
    verdict,
    explanation: parsed?.explanation ? String(parsed.explanation) : "",
    usage: resp.usage,
  };
}

/* ------------------------------------------------------------------ */
/* In-text citation numbering check (deterministic, free)              */
/* ------------------------------------------------------------------ */

/**
 * Numeric citations in the body text ([12], [3,7], [4-6]) that exceed the
 * highest bibliography label — a cited entry that doesn't exist. Only
 * meaningful for numerically-labeled bibliographies.
 */
export function findOverflowCitations(bodyText: string, maxLabel: number): number[] {
  if (maxLabel <= 0) return [];
  const cited = new Set<number>();
  const re = /\[(\d{1,3}(?:\s*[,;–—-]\s*\d{1,3})*)\]/g;
  for (const m of bodyText.matchAll(re)) {
    for (const part of m[1].split(/[,;]/)) {
      const bounds = part.split(/[–—-]/).map((s) => Number.parseInt(s.trim(), 10));
      if (
        bounds.length === 2 &&
        bounds.every(Number.isFinite) &&
        bounds[1] > bounds[0] &&
        bounds[1] - bounds[0] < 50
      ) {
        for (let n = bounds[0]; n <= bounds[1]; n++) cited.add(n);
      } else if (bounds.length === 1 && Number.isFinite(bounds[0])) {
        cited.add(bounds[0]);
      }
    }
  }
  return [...cited].filter((n) => n > maxLabel).sort((a, b) => a - b);
}

function maxNumericLabel(references: ExtractedReference[]): number {
  const labels = references
    .map((r) => (r.label && /^\d+$/.test(r.label) ? Number(r.label) : null))
    .filter((n): n is number => n !== null);
  // Require a mostly-numeric bibliography before trusting the check
  if (!labels.length || labels.length < references.length / 2) return 0;
  return Math.max(...labels);
}

/* ------------------------------------------------------------------ */
/* Matched-record links                                                */
/* ------------------------------------------------------------------ */

/** Canonical human-followable link for a database record. */
export function candidateLink(candidate: ReferenceCandidate): string | null {
  const doi = normalizeDoi(candidate.doi);
  if (doi) return `https://doi.org/${doi}`;
  if (candidate.arxivId) return `https://arxiv.org/abs/${candidate.arxivId}`;
  return candidate.url;
}

function toMatchedRecord(candidate: ReferenceCandidate): MatchedRecord {
  return {
    source: candidate.source,
    title: candidate.title,
    year: candidate.year,
    doi: normalizeDoi(candidate.doi),
    url: candidateLink(candidate),
  };
}

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

function shortTitle(ref: ExtractedReference): string {
  const t = ref.title ?? ref.raw;
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

function mismatchComment(
  ref: ExtractedReference,
  best: ReferenceCandidate | null,
  problems: string[],
  llmExplanation: string,
): ReviewComment {
  const link = best && candidateLink(best);
  const recordNote = best
    ? ` The record found is "${best.title}" (${best.source}${best.year ? `, ${best.year}` : ""}${link ? `, ${link}` : ""}).`
    : "";
  const detail = llmExplanation || (problems.length ? `${problems.join("; ")}.` : "");
  return {
    title: `Reference metadata mismatch: "${shortTitle(ref)}"`,
    quote: ref.raw,
    explanation:
      `This citation's metadata disagrees with the bibliographic record: ${detail}${recordNote}`.trim(),
    commentType: "reference",
    paragraphIndex: null,
  };
}

function notFoundComment(
  ref: ExtractedReference,
  best: ReferenceCandidate | null,
  score: number,
  sourceNames: string[],
  llmExplanation: string,
): ReviewComment {
  const closestLink = best && candidateLink(best);
  const closest =
    best && score > 0.2
      ? ` The closest match was "${best.title}" (${best.source}${best.year ? `, ${best.year}` : ""}${closestLink ? `, ${closestLink}` : ""}), which does not appear to be the cited work.`
      : "";
  const detail = llmExplanation ? ` ${llmExplanation}` : "";
  return {
    title: `Reference not found — possible hallucination: "${shortTitle(ref)}"`,
    quote: ref.raw,
    explanation:
      `No matching record was found in ${sourceNames.join(", ")}.${closest}${detail} ` +
      `Verify this reference manually — database coverage gaps are possible for very recent or niche venues.`,
    commentType: "reference",
    paragraphIndex: null,
  };
}

function overflowComment(overflow: number[], maxLabel: number): ReviewComment {
  const list = overflow.map((n) => `[${n}]`).join(", ");
  return {
    title: "In-text citations without bibliography entries",
    quote: list,
    explanation:
      `The text cites ${list}, but the bibliography's highest entry number is [${maxLabel}]. ` +
      `These citations point to references that do not exist in the reference list.`,
    commentType: "reference",
    paragraphIndex: null,
  };
}

/* ------------------------------------------------------------------ */
/* Per-entry check                                                     */
/* ------------------------------------------------------------------ */

function isCheckable(ref: ExtractedReference): boolean {
  if (ref.kind === "web" || ref.kind === "software" || ref.kind === "other") return false;
  if ((ref.kind === "book" || ref.kind === "thesis") && !normalizeDoi(ref.doi)) return false;
  return Boolean(ref.title || normalizeDoi(ref.doi) || ref.arxivId);
}

export interface ReferenceCheckOutput {
  status: ReferenceStatus;
  comment: ReviewComment | null;
  /** The identified database record (verified and mismatch statuses). */
  match: MatchedRecord | null;
  /** Metadata problems found deterministically (mismatch status). */
  problems: string[];
  usage: TokenUsage;
  adjudicated: boolean;
}

/** Check one extracted reference end-to-end (lookup → classify → adjudicate). */
export async function checkReference(
  ref: ExtractedReference,
  sources: ReferenceSource[],
  ctx: SourceContext,
  thresholds: MatchThresholds,
  refOpts: ReferenceCheckOptions,
  chatOpts: ReviewOptions,
): Promise<ReferenceCheckOutput> {
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  if (!isCheckable(ref)) {
    return { status: "unverifiable", comment: null, match: null, problems: [], usage, adjudicated: false };
  }

  const { candidates, attempted, errored } = await lookupReferenceCandidates(ref, sources, ctx);

  // Every queried source failed: an outage, not a hallucination.
  if (!candidates.length && errored.length && errored.length >= attempted.length) {
    return { status: "unverifiable", comment: null, match: null, problems: [], usage, adjudicated: false };
  }

  const match = classifyReference(ref, candidates, thresholds);
  let status: ReferenceStatus = match.status;
  let adjudicated = false;
  let llmExplanation = "";

  if (status === "ambiguous" && refOpts.llmAdjudication !== false) {
    const adj = await adjudicateReference(ref, candidates, chatOpts);
    usage.promptTokens += adj.usage.promptTokens;
    usage.completionTokens += adj.usage.completionTokens;
    adjudicated = true;
    if (adj.verdict) {
      status = adj.verdict;
      llmExplanation = adj.explanation;
    }
  }

  let comment: ReviewComment | null = null;
  if (status === "mismatch") {
    comment = mismatchComment(ref, match.best, match.problems, llmExplanation);
  } else if (status === "not_found") {
    const sourceNames = attempted.length ? attempted : sources.map((s) => s.name);
    comment = notFoundComment(ref, match.best, match.score, sourceNames, llmExplanation);
  }
  const matched =
    (status === "verified" || status === "mismatch") && match.best
      ? toMatchedRecord(match.best)
      : null;
  return {
    status,
    comment,
    match: matched,
    problems: status === "mismatch" ? match.problems : [],
    usage,
    adjudicated,
  };
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

export interface ReviewReferencesOptions extends ReviewOptions {
  references?: ReferenceCheckOptions;
}

const STATUS_TO_STAT: Record<ReferenceStatus, keyof ReferenceCheckStats> = {
  verified: "verified",
  mismatch: "mismatched",
  not_found: "notFound",
  unverifiable: "unverifiable",
  ambiguous: "ambiguous",
};

function statsSummary(stats: ReferenceCheckStats, sourceNames: string[]): string {
  if (!stats.entries) {
    return "No references section was found, so no reference accuracy check was performed.";
  }
  const parts = [
    `${stats.verified} verified`,
    `${stats.mismatched} with metadata mismatches`,
    `${stats.notFound} not found (possible hallucinations)`,
  ];
  if (stats.ambiguous) parts.push(`${stats.ambiguous} inconclusive`);
  if (stats.unverifiable) parts.push(`${stats.unverifiable} unverifiable (books, URLs, etc.)`);
  return `Checked ${stats.entries} references against ${sourceNames.join(", ")}: ${parts.join(", ")}.`;
}

/**
 * Run the full reference accuracy check on a paper's text.
 * Returns its own ReviewResult (method "reference_check") with separately
 * tracked token usage/cost, non-LLM stats (per-source API calls), and a
 * per-entry breakdown with links to the matched database records.
 */
export async function reviewReferences(
  paperSlug: string,
  documentText: string,
  options: ReviewReferencesOptions = {},
): Promise<{ result: ReviewResult; stats: ReferenceCheckStats; references: CheckedReference[] }> {
  warnPromptOverrides(options.prompts);
  const refOpts = options.references ?? {};
  const effOptions: ReviewOptions = refOpts.model ? { ...options, model: refOpts.model } : options;
  const model = resolveModel(effOptions);

  const result: ReviewResult = {
    method: "reference_check",
    paperSlug,
    comments: [],
    overallFeedback: "",
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    model,
    reasoningEffort: options.reasoningEffort ?? null,
  };
  const stats: ReferenceCheckStats = {
    entries: 0,
    verified: 0,
    mismatched: 0,
    notFound: 0,
    unverifiable: 0,
    ambiguous: 0,
    adjudicated: 0,
    apiCallsBySource: {},
  };

  const extraction = await extractReferences(documentText, effOptions);
  addUsage(result, extraction.usage, model);
  stats.entries = extraction.references.length;
  await options.onProgress?.({
    stage: "references_extract",
    entries: stats.entries,
    sectionFound: extraction.sectionFound,
  });

  const sources = buildReferenceSources(refOpts);
  const sourceNames = sources.map((s) => s.name);
  const references: CheckedReference[] = [];

  if (extraction.references.length) {
    const ctx: SourceContext = {
      mailto: refOpts.mailto,
      s2ApiKey: refOpts.s2ApiKey,
      topK: refOpts.topK ?? 5,
      timeoutMs: refOpts.timeoutMs ?? 15_000,
      signal: options.signal,
      fetchImpl: refOpts.fetchImpl ?? fetch,
      apiCalls: stats.apiCallsBySource,
    };
    const thresholds: MatchThresholds = { ...DEFAULT_MATCH_THRESHOLDS, ...refOpts.thresholds };

    let done = 0;
    const perRef = await mapWithConcurrency(
      extraction.references,
      refOpts.concurrency ?? 4,
      async (ref) => {
        const out = await checkReference(ref, sources, ctx, thresholds, refOpts, effOptions);
        done += 1;
        await options.onProgress?.({
          stage: "reference_lookup",
          current: done,
          total: extraction.references.length,
          status: out.status,
        });
        return out;
      },
    );

    for (let i = 0; i < perRef.length; i++) {
      const out = perRef[i];
      const ref = extraction.references[i];
      stats[STATUS_TO_STAT[out.status]]++;
      if (out.adjudicated) stats.adjudicated++;
      addUsage(result, out.usage, model);
      if (out.comment) result.comments.push(out.comment);
      references.push({
        index: ref.index,
        label: ref.label,
        raw: ref.raw,
        title: ref.title,
        status: out.status,
        match: out.match,
        problems: out.problems,
      });
    }

    // Deterministic in-text citation numbering check (body = text before refs)
    const sectionOffset = findReferencesSection(documentText)?.offset ?? null;
    const body = sectionOffset !== null ? documentText.slice(0, sectionOffset) : documentText;
    const maxLabel = maxNumericLabel(extraction.references);
    const overflow = findOverflowCitations(body, maxLabel);
    if (overflow.length) result.comments.push(overflowComment(overflow, maxLabel));

    assignParagraphIndices(result.comments, documentText);
  }

  result.overallFeedback = statsSummary(stats, sourceNames);
  await options.onProgress?.({ stage: "references_done", stats });
  return { result, stats, references };
}
