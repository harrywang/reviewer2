/** Deterministic reference-to-record matching (pure functions, no I/O). */

import { similarityRatio } from "../seqmatcher.js";
import type { ReferenceStatus } from "../types.js";
import type {
  ExtractedReference,
  MatchThresholds,
  ReferenceCandidate,
} from "./types.js";

/** Normalize a title for comparison: case, diacritics, LaTeX, punctuation. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[{}$]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a DOI: strip URL/prefix forms and ALL whitespace (PDF line
 * wrapping inserts spaces mid-DOI), lowercase. Returns null if not a DOI.
 */
export function normalizeDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  const d = doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  return d.startsWith("10.") ? d : null;
}

/** The arXiv id embedded in an arXiv DOI (10.48550/arxiv.<id>), if any. */
export function arxivIdFromDoi(doi: string | null | undefined): string | null {
  const normalized = normalizeDoi(doi);
  const m = normalized?.match(/^10\.48550\/arxiv\.(.+)$/);
  return m ? m[1] : null;
}

/** Extract a comparable family name from an author string. */
export function familyName(author: string): string {
  const a = author.replace(/\bet al\.?/gi, "").trim();
  if (!a) return "";
  // "Last, First" form
  const comma = a.indexOf(",");
  const base = comma > 0 ? a.slice(0, comma) : a;
  // Last token that isn't an initial ("J.", "A")
  const tokens = base
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}'-]/gu, ""))
    .filter((t) => t.length > 1);
  const name = tokens.length ? tokens[tokens.length - 1] : "";
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Fraction of the entry's author family names found in the candidate's. */
export function authorOverlap(entryAuthors: string[], candidateAuthors: string[]): number {
  const entryFams = entryAuthors.map(familyName).filter(Boolean);
  if (!entryFams.length) return 0;
  const candidateFams = new Set(candidateAuthors.map(familyName).filter(Boolean));
  const matched = entryFams.filter((f) => candidateFams.has(f)).length;
  return matched / entryFams.length;
}

export function titleSimilarity(a: string, b: string): number {
  return similarityRatio(normalizeTitle(a), normalizeTitle(b));
}

/** 1 for exact year, 0.8 for ±1 (preprint→published), 0.5 when unknown. */
export function yearScore(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0.5;
  const diff = Math.abs(a - b);
  if (diff === 0) return 1;
  if (diff === 1) return 0.8;
  return 0;
}

/** Combined identity score for one candidate. DOI equality is decisive. */
export function scoreCandidate(ref: ExtractedReference, candidate: ReferenceCandidate): number {
  const refDoi = normalizeDoi(ref.doi);
  const candidateDoi = normalizeDoi(candidate.doi);
  if (refDoi && candidateDoi && refDoi === candidateDoi) return 1;

  const title =
    ref.title && candidate.title ? titleSimilarity(ref.title, candidate.title) : 0;
  const year = yearScore(ref.year, candidate.year);
  const entryFams = ref.authors.map(familyName).filter(Boolean);
  if (!entryFams.length || !candidate.authors.length) {
    return 0.8 * title + 0.2 * year;
  }
  const authors = authorOverlap(ref.authors, candidate.authors);
  return 0.6 * title + 0.25 * authors + 0.15 * year;
}

export interface MatchResult {
  status: ReferenceStatus;
  best: ReferenceCandidate | null;
  score: number;
  /** Human-readable metadata problems (present when status is "mismatch"). */
  problems: string[];
}

/** Metadata disagreements once identity is established. Venue is deliberately
 *  skipped here (abbreviations/renames cause false positives) — it's left to
 *  LLM adjudication for ambiguous cases. */
function metadataProblems(ref: ExtractedReference, candidate: ReferenceCandidate): string[] {
  const problems: string[] = [];
  if (ref.year !== null && candidate.year !== null && Math.abs(ref.year - candidate.year) > 1) {
    problems.push(
      `cited year is ${ref.year}, but the ${candidate.source} record says ${candidate.year}`,
    );
  }
  const entryFams = ref.authors.map(familyName).filter(Boolean);
  if (entryFams.length && candidate.authors.length) {
    const overlap = authorOverlap(ref.authors, candidate.authors);
    if (overlap < 0.5) {
      problems.push(
        `cited authors (${ref.authors.slice(0, 4).join("; ")}) disagree with the ` +
          `${candidate.source} record (${candidate.authors.slice(0, 4).join("; ")})`,
      );
    }
  }
  const refDoi = normalizeDoi(ref.doi);
  const candidateDoi = normalizeDoi(candidate.doi);
  if (refDoi && candidateDoi && refDoi !== candidateDoi) {
    problems.push(`cited DOI is ${refDoi}, but the record's DOI is ${candidateDoi}`);
  }
  return problems;
}

/**
 * Classify one reference against its retrieved candidates.
 * Pure and JSON-serializable — safe as a durable-execution step.
 */
export function classifyReference(
  ref: ExtractedReference,
  candidates: ReferenceCandidate[],
  thresholds: MatchThresholds,
): MatchResult {
  if (!candidates.length) {
    return {
      status: "not_found",
      best: null,
      score: 0,
      problems: ["no matching record found in any source"],
    };
  }

  // An exact-id fetch (the entry's own DOI or arXiv id) settles identity:
  // either it's the cited work (check metadata) or the id points elsewhere.
  // With several exact fetches, trust the one closest to the cited title —
  // aggregators occasionally hold junk records for a valid identifier.
  const exacts = candidates.filter((c) => c.matchedBy === "doi" || c.matchedBy === "arxiv");
  let exact: ReferenceCandidate | undefined = exacts[0];
  if (exacts.length > 1 && ref.title) {
    exact = exacts.reduce((a, b) =>
      titleSimilarity(ref.title!, b.title) > titleSimilarity(ref.title!, a.title) ? b : a,
    );
  }
  if (exact && ref.title) {
    const sim = titleSimilarity(ref.title, exact.title);
    if (sim >= 0.5) {
      const problems = metadataProblems(ref, exact);
      return {
        status: problems.length ? "mismatch" : "verified",
        best: exact,
        score: scoreCandidate(ref, exact),
        problems,
      };
    }
    return {
      status: "mismatch",
      best: exact,
      score: scoreCandidate(ref, exact),
      problems: [
        `the cited ${exact.matchedBy === "doi" ? "DOI" : "arXiv id"} resolves to a ` +
          `different work: "${exact.title}" (${exact.year ?? "n.d."})`,
      ],
    };
  }

  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    const s = scoreCandidate(ref, candidate);
    if (s > bestScore) {
      best = candidate;
      bestScore = s;
    }
  }

  const strongTitle =
    ref.title !== null && titleSimilarity(ref.title, best.title) >= thresholds.titleStrong;

  if (bestScore >= thresholds.verified || strongTitle) {
    const problems = metadataProblems(ref, best);
    return {
      status: problems.length ? "mismatch" : "verified",
      best,
      score: bestScore,
      problems,
    };
  }
  if (bestScore >= thresholds.ambiguous) {
    return { status: "ambiguous", best, score: bestScore, problems: [] };
  }
  return {
    status: "not_found",
    best,
    score: bestScore,
    problems: ["no retrieved record plausibly matches the cited work"],
  };
}
