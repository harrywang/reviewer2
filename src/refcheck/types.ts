/** Types for the reference accuracy check. */

export type ReferenceKind = "paper" | "book" | "web" | "thesis" | "software" | "other";

/** One bibliography entry as extracted from the paper (verbatim fields). */
export interface ExtractedReference {
  /** 0-based position in the extracted bibliography. */
  index: number;
  /** The entry's printed label (e.g. "12" from "[12]", or "Smith2020"). */
  label: string | null;
  /** Complete verbatim text of the entry. */
  raw: string;
  title: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  kind: ReferenceKind;
}

/** A record retrieved from a bibliographic database. */
export interface ReferenceCandidate {
  /** Source name, e.g. "crossref". */
  source: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
  /** How this candidate was retrieved (exact-id fetches carry more weight). */
  matchedBy?: "doi" | "arxiv" | "search";
}

/** Shared per-run context passed to every source call. */
export interface SourceContext {
  mailto?: string;
  s2ApiKey?: string;
  /** Candidates to request per search. */
  topK: number;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
  /** Mutable counter of HTTP requests per source (includes retries). */
  apiCalls: Record<string, number>;
}

/**
 * A bibliographic database. Implement this to plug in a custom source
 * (internal corpus, DBLP, PubMed, ...) via ReferenceCheckOptions.customSources.
 * All lookups must resolve (return null / []) on "not found" and throw only
 * on infrastructure failure — errors mark the source as unavailable rather
 * than the reference as missing.
 */
export interface ReferenceSource {
  name: string;
  byDoi?(doi: string, ctx: SourceContext): Promise<ReferenceCandidate | null>;
  byArxivId?(arxivId: string, ctx: SourceContext): Promise<ReferenceCandidate | null>;
  search?(ref: ExtractedReference, ctx: SourceContext): Promise<ReferenceCandidate[]>;
}

/** The database record a reference was matched against (for citing/linking). */
export interface MatchedRecord {
  source: string;
  title: string;
  year: number | null;
  doi: string | null;
  /** Canonical link: doi.org, arxiv.org/abs, or the source's own URL. */
  url: string | null;
}

/** Per-entry outcome of a reference check run, in bibliography order. */
export interface CheckedReference {
  index: number;
  label: string | null;
  raw: string;
  title: string | null;
  status: import("../types.js").ReferenceStatus;
  /** The identified record (set for verified and mismatch entries). */
  match: MatchedRecord | null;
  /** Human-readable metadata problems (mismatch entries). */
  problems: string[];
}

export interface MatchThresholds {
  /** Combined score at/above which a candidate is accepted as the cited work. */
  verified: number;
  /** Combined score below which the entry counts as not found; scores in
   *  [ambiguous, verified) go to LLM adjudication. */
  ambiguous: number;
  /** Title similarity that alone establishes identity (metadata then compared). */
  titleStrong: number;
}

export const DEFAULT_MATCH_THRESHOLDS: MatchThresholds = {
  verified: 0.8,
  ambiguous: 0.45,
  titleStrong: 0.9,
};

export interface ReferenceCheckOptions {
  /** Built-in source names to use, in order. Default: ["crossref", "openalex", "arxiv"]
   *  ("semanticscholar" is appended automatically when s2ApiKey is set). */
  sources?: string[];
  /** Additional user-implemented sources (not JSON-serializable — for the
   *  in-process API; durable-execution callers should wrap lookups themselves). */
  customSources?: ReferenceSource[];
  /** Email for the Crossref/OpenAlex polite pools (not a credential). */
  mailto?: string;
  /** Optional Semantic Scholar API key; enables the S2 source. */
  s2ApiKey?: string;
  /** Max references checked in parallel. Default 4. */
  concurrency?: number;
  /** Search candidates requested per source. Default 5. */
  topK?: number;
  /** LLM tie-breaker for ambiguous entries. Default true. */
  llmAdjudication?: boolean;
  thresholds?: Partial<MatchThresholds>;
  /** Model for extraction/adjudication calls; defaults to the review model.
   *  A cheaper model is usually sufficient here. */
  model?: string;
  /** Per-request timeout. Default 15000 ms. */
  timeoutMs?: number;
  /** Injectable fetch (tests, proxies). Default: global fetch. */
  fetchImpl?: typeof fetch;
}
