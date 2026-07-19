/**
 * Bibliographic database sources. All keyless except Semantic Scholar
 * (optional API key). Crossref and OpenAlex accept a `mailto` for their
 * faster "polite pools" — an email string, not a credential.
 */

import type {
  ExtractedReference,
  ReferenceCandidate,
  ReferenceCheckOptions,
  ReferenceSource,
  SourceContext,
} from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SourceRequestError extends Error {}

/**
 * Fetch with timeout, per-attempt call counting, and backoff on 429/5xx.
 * Returns null on 404 (a clean "not found"), the Response on 2xx.
 * Throws SourceRequestError on persistent failure — the caller marks the
 * source unavailable rather than the reference missing.
 */
async function sourceFetch(
  url: string,
  headers: Record<string, string>,
  ctx: SourceContext,
  sourceName: string,
): Promise<Response | null> {
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (ctx.signal?.aborted) throw new Error("aborted");
    ctx.apiCalls[sourceName] = (ctx.apiCalls[sourceName] ?? 0) + 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    const onOuterAbort = () => controller.abort();
    ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const resp = await ctx.fetchImpl(url, { headers, signal: controller.signal });
      if (resp.ok) return resp;
      if (resp.status === 404) return null;
      if ((resp.status === 429 || resp.status >= 500) && attempt < attempts - 1) {
        const retryAfter = Number(resp.headers?.get?.("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : 2 ** attempt * 500;
        await sleep(waitMs);
        continue;
      }
      throw new SourceRequestError(`${sourceName}: HTTP ${resp.status} for ${url}`);
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      if (err instanceof SourceRequestError) throw err;
      if (attempt === attempts - 1) {
        throw new SourceRequestError(`${sourceName}: request failed (${String(err)})`);
      }
      await sleep(2 ** attempt * 500);
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
  throw new SourceRequestError(`${sourceName}: retries exhausted for ${url}`);
}

async function sourceFetchJson(
  url: string,
  headers: Record<string, string>,
  ctx: SourceContext,
  sourceName: string,
): Promise<unknown | null> {
  const resp = await sourceFetch(url, headers, ctx, sourceName);
  if (!resp) return null;
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

function toYear(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1000 && n <= 2200 ? Math.trunc(n) : null;
}

function toStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
}

/* ------------------------------------------------------------------ */
/* Crossref                                                            */
/* ------------------------------------------------------------------ */

function mailtoParam(ctx: SourceContext, sep: "?" | "&"): string {
  return ctx.mailto ? `${sep}mailto=${encodeURIComponent(ctx.mailto)}` : "";
}

function crossrefWork(msg: Record<string, unknown> | null | undefined): ReferenceCandidate | null {
  if (!msg || typeof msg !== "object") return null;
  const title = toStrings(msg.title)[0];
  if (!title) return null;
  const authorsRaw = Array.isArray(msg.author) ? msg.author : [];
  const authors = authorsRaw
    .map((a: Record<string, unknown>) =>
      [a?.given, a?.family].filter(Boolean).map(String).join(" ").trim(),
    )
    .filter(Boolean);
  const issued = msg.issued as { "date-parts"?: unknown[][] } | undefined;
  return {
    source: "crossref",
    title,
    authors,
    year: toYear(issued?.["date-parts"]?.[0]?.[0]),
    venue: toStrings(msg["container-title"])[0] ?? (msg.publisher ? String(msg.publisher) : null),
    doi: msg.DOI ? String(msg.DOI) : null,
    arxivId: null,
    url: msg.URL ? String(msg.URL) : null,
  };
}

export const crossrefSource: ReferenceSource = {
  name: "crossref",
  async byDoi(doi, ctx) {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}${mailtoParam(ctx, "?")}`;
    const data = (await sourceFetchJson(url, {}, ctx, "crossref")) as {
      message?: Record<string, unknown>;
    } | null;
    return crossrefWork(data?.message);
  },
  async search(ref, ctx) {
    const query = ref.title ?? ref.raw.slice(0, 300);
    const url =
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}` +
      `&rows=${ctx.topK}${mailtoParam(ctx, "&")}`;
    const data = (await sourceFetchJson(url, {}, ctx, "crossref")) as {
      message?: { items?: Record<string, unknown>[] };
    } | null;
    return (data?.message?.items ?? [])
      .map(crossrefWork)
      .filter((c): c is ReferenceCandidate => c !== null);
  },
};

/* ------------------------------------------------------------------ */
/* OpenAlex (also indexes arXiv preprints)                             */
/* ------------------------------------------------------------------ */

function openalexWork(w: Record<string, unknown> | null | undefined): ReferenceCandidate | null {
  if (!w || typeof w !== "object") return null;
  const title = w.display_name ? String(w.display_name) : "";
  if (!title) return null;
  const authorships = Array.isArray(w.authorships) ? w.authorships : [];
  const authors = authorships
    .map((a: Record<string, unknown>) => {
      const author = a?.author as Record<string, unknown> | undefined;
      return author?.display_name ? String(author.display_name) : "";
    })
    .filter(Boolean);
  const primary = w.primary_location as
    | { source?: { display_name?: unknown }; landing_page_url?: unknown }
    | undefined;
  return {
    source: "openalex",
    title,
    authors,
    year: toYear(w.publication_year),
    venue: primary?.source?.display_name ? String(primary.source.display_name) : null,
    doi: w.doi ? String(w.doi) : null,
    arxivId: null,
    url: w.id ? String(w.id) : null,
  };
}

export const openalexSource: ReferenceSource = {
  name: "openalex",
  async byDoi(doi, ctx) {
    const url = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}${mailtoParam(ctx, "?")}`;
    const data = (await sourceFetchJson(url, {}, ctx, "openalex")) as Record<
      string,
      unknown
    > | null;
    return openalexWork(data);
  },
  async search(ref, ctx) {
    if (!ref.title) return [];
    const url =
      `https://api.openalex.org/works?search=${encodeURIComponent(ref.title)}` +
      `&per-page=${ctx.topK}${mailtoParam(ctx, "&")}`;
    const data = (await sourceFetchJson(url, {}, ctx, "openalex")) as {
      results?: Record<string, unknown>[];
    } | null;
    return (data?.results ?? [])
      .map(openalexWork)
      .filter((c): c is ReferenceCandidate => c !== null);
  },
};

/* ------------------------------------------------------------------ */
/* arXiv (by-id only; title search is covered by OpenAlex, and arXiv   */
/* asks for very low request rates)                                    */
/* ------------------------------------------------------------------ */

/** Strip "arXiv:" prefix and version suffix from an arXiv id. */
export function normalizeArxivId(id: string): string {
  return id
    .trim()
    .replace(/^arxiv:\s*/i, "")
    .replace(/v\d+$/i, "");
}

function xmlText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

export const arxivSource: ReferenceSource = {
  name: "arxiv",
  async byArxivId(arxivId, ctx) {
    const id = normalizeArxivId(arxivId);
    if (!id) return null;
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
    const resp = await sourceFetch(url, {}, ctx, "arxiv");
    if (!resp) return null;
    let xml: string;
    try {
      xml = await resp.text();
    } catch {
      return null;
    }
    const entry = xml.split(/<entry[>\s]/)[1];
    if (!entry) return null;
    const title = xmlText(entry, "title");
    // The API reports bad ids as an entry titled "Error"
    if (!title || /^error/i.test(title)) return null;
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) =>
      m[1].replace(/\s+/g, " ").trim(),
    );
    const published = entry.match(/<published>(\d{4})/);
    const idUrl = entry.match(/<id>\s*(https?:\/\/arxiv\.org\/abs\/[^<\s]+)\s*<\/id>/);
    return {
      source: "arxiv",
      title,
      authors,
      year: published ? toYear(published[1]) : null,
      venue: "arXiv",
      doi: null,
      arxivId: id,
      url: idUrl ? idUrl[1] : null,
    };
  },
};

/* ------------------------------------------------------------------ */
/* Semantic Scholar (optional; unauthenticated pool is heavily         */
/* rate-limited, so it's only enabled with an API key or explicitly)   */
/* ------------------------------------------------------------------ */

const S2_FIELDS = "title,authors,year,venue,externalIds,url";

function s2Work(p: Record<string, unknown> | null | undefined): ReferenceCandidate | null {
  if (!p || typeof p !== "object" || !p.title) return null;
  const authorsRaw = Array.isArray(p.authors) ? p.authors : [];
  const external = (p.externalIds ?? {}) as Record<string, unknown>;
  return {
    source: "semanticscholar",
    title: String(p.title),
    authors: authorsRaw
      .map((a: Record<string, unknown>) => (a?.name ? String(a.name) : ""))
      .filter(Boolean),
    year: toYear(p.year),
    venue: p.venue ? String(p.venue) : null,
    doi: external.DOI ? String(external.DOI) : null,
    arxivId: external.ArXiv ? String(external.ArXiv) : null,
    url: p.url ? String(p.url) : null,
  };
}

function s2Headers(ctx: SourceContext): Record<string, string> {
  return ctx.s2ApiKey ? { "x-api-key": ctx.s2ApiKey } : {};
}

export const semanticScholarSource: ReferenceSource = {
  name: "semanticscholar",
  async byDoi(doi, ctx) {
    const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=${S2_FIELDS}`;
    const data = (await sourceFetchJson(url, s2Headers(ctx), ctx, "semanticscholar")) as Record<
      string,
      unknown
    > | null;
    return s2Work(data);
  },
  async search(ref, ctx) {
    if (!ref.title) return [];
    const url =
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(ref.title)}` +
      `&limit=${ctx.topK}&fields=${S2_FIELDS}`;
    const data = (await sourceFetchJson(url, s2Headers(ctx), ctx, "semanticscholar")) as {
      data?: Record<string, unknown>[];
    } | null;
    return (data?.data ?? []).map(s2Work).filter((c): c is ReferenceCandidate => c !== null);
  },
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const BUILTIN_SOURCES: Record<string, ReferenceSource> = {
  crossref: crossrefSource,
  openalex: openalexSource,
  arxiv: arxivSource,
  semanticscholar: semanticScholarSource,
};

/** Resolve the source list from options (built-in names + custom sources). */
export function buildReferenceSources(refOpts: ReferenceCheckOptions): ReferenceSource[] {
  const names =
    refOpts.sources ??
    ["crossref", "openalex", "arxiv", ...(refOpts.s2ApiKey ? ["semanticscholar"] : [])];
  const sources = names.map((name) => {
    const source = BUILTIN_SOURCES[name];
    if (!source) {
      throw new Error(
        `Unknown reference source '${name}'. Built-ins: ${Object.keys(BUILTIN_SOURCES).join(", ")}`,
      );
    }
    return source;
  });
  return [...sources, ...(refOpts.customSources ?? [])];
}
