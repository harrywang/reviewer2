import { beforeEach, describe, expect, it, vi } from "vitest";

const chatMock = vi.hoisted(() => vi.fn());

vi.mock("../src/client.js", () => ({
  chat: chatMock,
  defaultModelFor: () => "gpt-test",
  resolveProvider: () => ({
    provider: "openai",
    apiKey: "test-key",
    baseUrl: null,
    prefixToStrip: null,
  }),
}));

import { computeCost } from "../src/cost.js";
import {
  referenceExtractionPrompt,
  referenceVerdictPrompt,
  validatePromptOverrides,
} from "../src/prompts.js";
import { extractReferences, findReferencesSection } from "../src/refcheck/extract.js";
import {
  arxivIdFromDoi,
  authorOverlap,
  classifyReference,
  familyName,
  normalizeDoi,
  normalizeTitle,
  scoreCandidate,
  titleSimilarity,
  yearScore,
} from "../src/refcheck/match.js";
import { crossrefSource, openalexSource, arxivSource } from "../src/refcheck/sources.js";
import {
  findOverflowCitations,
  lookupReferenceCandidates,
  reviewReferences,
} from "../src/refcheck/index.js";
import {
  DEFAULT_MATCH_THRESHOLDS,
  type ExtractedReference,
  type ReferenceCandidate,
  type SourceContext,
} from "../src/refcheck/types.js";
import { reviewPaper } from "../src/review.js";
import { addUsage } from "../src/usage.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeRef(overrides: Partial<ExtractedReference> = {}): ExtractedReference {
  return {
    index: 0,
    label: "1",
    raw: "[1] A. Smith. Deep Widget Networks. Journal of Widgets, 2020.",
    title: "Deep Widget Networks",
    authors: ["A. Smith"],
    year: 2020,
    venue: "Journal of Widgets",
    doi: null,
    arxivId: null,
    kind: "paper",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<ReferenceCandidate> = {}): ReferenceCandidate {
  return {
    source: "crossref",
    title: "Deep Widget Networks",
    authors: ["Alice Smith"],
    year: 2020,
    venue: "Journal of Widgets",
    doi: null,
    arxivId: null,
    url: null,
    matchedBy: "search",
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    headers: { get: () => null },
  } as unknown as Response;
}

function makeCtx(fetchImpl: typeof fetch, overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    topK: 5,
    timeoutMs: 5000,
    fetchImpl,
    apiCalls: {},
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* findReferencesSection                                               */
/* ------------------------------------------------------------------ */

describe("findReferencesSection", () => {
  it("finds a markdown References heading", () => {
    const doc = "# Title\n\nBody text.\n\n## References\n\n[1] Some entry.\n[2] Another.";
    const section = findReferencesSection(doc);
    expect(section).not.toBeNull();
    expect(section!.text).toContain("[1] Some entry.");
    expect(doc.slice(section!.offset)).toContain("[1] Some entry.");
  });

  it("finds a bare 'References' line and stops at an appendix", () => {
    const doc = "Body.\n\nReferences\n\n[1] Entry one.\n\nAppendix A\n\nExtra material.";
    const section = findReferencesSection(doc);
    expect(section!.text).toContain("[1] Entry one.");
    expect(section!.text).not.toContain("Extra material");
  });

  it("uses the last heading when 'References' also appears in the body", () => {
    const doc =
      "Intro mentions:\n\nReferences\n\nare listed at the end.\n\nBibliography\n\n[1] Real entry.";
    const section = findReferencesSection(doc);
    expect(section!.text).toContain("[1] Real entry.");
  });

  it("returns null when there is no references section", () => {
    expect(findReferencesSection("Just a body with no bibliography.")).toBeNull();
  });

  it("finds letter-spaced OCR headings (R E F E R E N C E S)", () => {
    const doc =
      "Body text here.\n\nR E F E R E N C E S\n\n[1] A. Smith. Deep Widget Networks. Journal of Widgets, 2020.";
    const section = findReferencesSection(doc);
    expect(section?.source).toBe("heading");
    expect(section?.text).toContain("[1] A. Smith");
  });

  it("finds numbered headings without punctuation and heading variants", () => {
    const numbered = findReferencesSection(
      "Intro.\n\n6 References\n\n[1] A. Smith. Deep Widget Networks. Journal of Widgets, 2020.",
    );
    expect(numbered?.source).toBe("heading");
    const cited = findReferencesSection(
      "Intro.\n\nREFERENCES CITED:\n\n[1] A. Smith. Deep Widget Networks. Journal of Widgets, 2020.",
    );
    expect(cited?.source).toBe("heading");
  });

  it("rejects a heading followed by non-bibliography text", () => {
    expect(findReferencesSection("Body.\n\nReferences\n\nSee the appendix for details.")).toBeNull();
  });

  it("detects a bibliography structurally when the heading is missing", () => {
    const body = "Plain body prose without citations. ".repeat(20);
    const entries = Array.from(
      { length: 6 },
      (_, i) => `[${i + 1}] Author${i}, A. (20${10 + i}). Title ${i}. Journal of Things, ${i + 1}(2), 1-10.`,
    ).join("\n");
    const section = findReferencesSection(`${body}\n\n${entries}`);
    expect(section?.source).toBe("structural");
    expect(section?.text).toContain("[1] Author0");
  });
});

describe("extractReferences LLM locator fallback", () => {
  it("locates via one LLM call when deterministic locating fails, and tracks its cost", async () => {
    const entryLine = "Smith, A. (2020). Deep Widget Networks. Journal of Widgets.";
    // 3 author-year entries: too few for structural detection, no heading
    const doc =
      "Body prose without obvious citations. ".repeat(20) +
      `\n\n${entryLine}\nJones, B. (2019). Fast Gadget Learning. GadgetConf.\nChen, C. (2021). Widget Theory. Widget Press.`;

    chatMock.mockImplementation(async (messages: { content: string }[]) => {
      const content = messages[0].content;
      if (content.includes("final portion")) {
        return {
          text: entryLine,
          usage: { promptTokens: 20, completionTokens: 5, model: "gpt-test" },
          provider: "openai",
        };
      }
      return {
        text: JSON.stringify([
          {
            label: null,
            raw: entryLine,
            title: "Deep Widget Networks",
            authors: ["A. Smith"],
            year: 2020,
            venue: "Journal of Widgets",
            doi: null,
            arxiv_id: null,
            kind: "paper",
          },
        ]),
        usage: { promptTokens: 100, completionTokens: 50, model: "gpt-test" },
        provider: "openai",
      };
    });

    expect(findReferencesSection(doc)).toBeNull();
    const out = await extractReferences(doc);
    expect(out.sectionSource).toBe("llm");
    expect(out.references).toHaveLength(1);
    // locator (20/5) + extraction (100/50) both tracked
    expect(out.usage).toEqual({ promptTokens: 120, completionTokens: 55 });
  });

  it("gives up cleanly when the locator answers NONE", async () => {
    chatMock.mockImplementation(async () => ({
      text: "NONE",
      usage: { promptTokens: 15, completionTokens: 2, model: "gpt-test" },
      provider: "openai",
    }));
    const out = await extractReferences("Just a body with no bibliography.");
    expect(out.sectionSource).toBe("none");
    expect(out.references).toEqual([]);
    expect(out.usage.promptTokens).toBe(15); // locator cost still tracked
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

describe("match helpers", () => {
  it("normalizes DOIs from URL and prefix forms", () => {
    expect(normalizeDoi("https://doi.org/10.1234/ABC")).toBe("10.1234/abc");
    expect(normalizeDoi("doi: 10.1234/abc")).toBe("10.1234/abc");
    expect(normalizeDoi("not-a-doi")).toBeNull();
    expect(normalizeDoi(null)).toBeNull();
  });

  it("strips whitespace inside DOIs (PDF line-wrap artifacts)", () => {
    expect(normalizeDoi("10.1016/0007- 6813(84)90046-6")).toBe("10.1016/0007-6813(84)90046-6");
    expect(normalizeDoi("https://doi.org/10.1037/0033- 2909.100.3.349")).toBe(
      "10.1037/0033-2909.100.3.349",
    );
  });

  it("derives arXiv ids from arXiv DOIs", () => {
    expect(arxivIdFromDoi("10.48550/arXiv.2212.08073")).toBe("2212.08073");
    expect(arxivIdFromDoi("https://doi.org/10.48550/arXiv.2310.13548")).toBe("2310.13548");
    expect(arxivIdFromDoi("10.1038/nature14539")).toBeNull();
    expect(arxivIdFromDoi(null)).toBeNull();
  });

  it("normalizes titles across LaTeX, diacritics, and punctuation", () => {
    expect(normalizeTitle("\\emph{Über} Widget--Learning: A {Study}")).toBe(
      normalizeTitle("Uber Widget Learning A Study"),
    );
    expect(titleSimilarity("Deep Widget Networks", "deep widget networks")).toBe(1);
  });

  it("extracts family names from both name orders", () => {
    expect(familyName("A. Smith")).toBe("smith");
    expect(familyName("Smith, Alice")).toBe("smith");
    expect(familyName("van der Berg, J.")).toBe("berg");
  });

  it("computes author overlap on family names", () => {
    expect(authorOverlap(["A. Smith", "B. Jones"], ["Alice Smith", "Robert Jones"])).toBe(1);
    expect(authorOverlap(["A. Smith", "B. Jones"], ["Carol Chen"])).toBe(0);
  });

  it("scores years with preprint leniency", () => {
    expect(yearScore(2020, 2020)).toBe(1);
    expect(yearScore(2020, 2021)).toBe(0.8);
    expect(yearScore(2020, 2023)).toBe(0);
    expect(yearScore(null, 2020)).toBe(0.5);
  });

  it("treats DOI equality as decisive", () => {
    const ref = makeRef({ doi: "10.1234/abc", title: "Completely Different" });
    const candidate = makeCandidate({ doi: "https://doi.org/10.1234/abc", title: "Another Title" });
    expect(scoreCandidate(ref, candidate)).toBe(1);
  });
});

describe("classifyReference", () => {
  const th = DEFAULT_MATCH_THRESHOLDS;

  it("returns not_found with no candidates", () => {
    expect(classifyReference(makeRef(), [], th).status).toBe("not_found");
  });

  it("verifies a strong search match", () => {
    const result = classifyReference(makeRef(), [makeCandidate()], th);
    expect(result.status).toBe("verified");
    expect(result.problems).toEqual([]);
  });

  it("flags a year mismatch on a strong title match", () => {
    const result = classifyReference(makeRef({ year: 2016 }), [makeCandidate({ year: 2020 })], th);
    expect(result.status).toBe("mismatch");
    expect(result.problems.join(" ")).toContain("2016");
    expect(result.problems.join(" ")).toContain("2020");
  });

  it("flags an author mismatch on a strong title match", () => {
    const result = classifyReference(
      makeRef({ authors: ["Z. Nobody", "Q. Phantom"] }),
      [makeCandidate()],
      th,
    );
    expect(result.status).toBe("mismatch");
    expect(result.problems.join(" ")).toContain("authors");
  });

  it("flags a DOI that resolves to a different work", () => {
    const result = classifyReference(
      makeRef({ doi: "10.1234/abc" }),
      [makeCandidate({ matchedBy: "doi", title: "An Entirely Unrelated Treatise on Soup" })],
      th,
    );
    expect(result.status).toBe("mismatch");
    expect(result.problems.join(" ")).toContain("different work");
  });

  it("verifies via the entry's own DOI without needing search candidates", () => {
    const result = classifyReference(
      makeRef({ doi: "10.1234/abc" }),
      [makeCandidate({ matchedBy: "doi", doi: "10.1234/abc" })],
      th,
    );
    expect(result.status).toBe("verified");
  });

  it("returns ambiguous for a middling match", () => {
    const result = classifyReference(
      makeRef({ title: "Graph Networks", authors: ["Lee"], year: 2020 }),
      [
        makeCandidate({
          title: "Graph Networks and Beyond Extended",
          authors: ["Lee"],
          year: 2010,
        }),
      ],
      th,
    );
    expect(result.status).toBe("ambiguous");
  });

  it("returns not_found for a weak best match", () => {
    const result = classifyReference(
      makeRef({ title: "Quantum Soup Dynamics", authors: ["Kim"] }),
      [makeCandidate({ title: "Grilled Cheese Optimization", authors: ["Park"], year: 1999 })],
      th,
    );
    expect(result.status).toBe("not_found");
  });

  it("trusts the exact-id record closest to the cited title (junk aggregator records)", () => {
    const result = classifyReference(
      makeRef({ doi: "10.48550/arxiv.2212.08073", title: "Constitutional AI" }),
      [
        makeCandidate({
          matchedBy: "doi",
          source: "openalex",
          title: "Affective Coherence Monitoring for Transformer Models",
        }),
        makeCandidate({ matchedBy: "arxiv", source: "arxiv", title: "Constitutional AI" }),
      ],
      th,
    );
    expect(result.status).toBe("verified");
  });
});

describe("lookupReferenceCandidates", () => {
  it("resolves arXiv DOIs via arXiv byId, skipping aggregator DOI lookups", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("export.arxiv.org")) {
        return jsonResponse(
          `<feed><entry><id>http://arxiv.org/abs/2212.08073v1</id><title>Constitutional AI: Harmlessness from AI Feedback</title><published>2022-12-15</published><author><name>Yuntao Bai</name></author></entry></feed>`,
        );
      }
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch;

    const ref = makeRef({
      title: "Constitutional AI: Harmlessness from AI Feedback",
      doi: "10.48550/arXiv.2212.08073",
      arxivId: null,
    });
    const { candidates } = await lookupReferenceCandidates(
      ref,
      [crossrefSource, openalexSource, arxivSource],
      makeCtx(fetchImpl),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].matchedBy).toBe("arxiv");
    expect(urls.every((u) => u.includes("export.arxiv.org"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Overflow citations                                                  */
/* ------------------------------------------------------------------ */

describe("findOverflowCitations", () => {
  it("finds cited numbers above the bibliography maximum", () => {
    const body = "As shown in [1] and [2,3], also [5-7] and later [12].";
    expect(findOverflowCitations(body, 4)).toEqual([5, 6, 7, 12]);
  });

  it("returns empty when everything is in range or numbering is absent", () => {
    expect(findOverflowCitations("See [1] and [2].", 4)).toEqual([]);
    expect(findOverflowCitations("See [9].", 0)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Sources (fake fetch)                                                */
/* ------------------------------------------------------------------ */

describe("sources", () => {
  it("maps Crossref byDoi records and counts API calls", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        message: {
          title: ["Deep Widget Networks"],
          author: [
            { given: "Alice", family: "Smith" },
            { given: "Bob", family: "Jones" },
          ],
          issued: { "date-parts": [[2020, 6]] },
          "container-title": ["Journal of Widgets"],
          DOI: "10.1234/widget",
          URL: "https://doi.org/10.1234/widget",
        },
      })) as unknown as typeof fetch;
    const ctx = makeCtx(fetchImpl, { mailto: "test@example.com" });

    const candidate = await crossrefSource.byDoi!("10.1234/widget", ctx);
    expect(candidate).toMatchObject({
      source: "crossref",
      title: "Deep Widget Networks",
      authors: ["Alice Smith", "Bob Jones"],
      year: 2020,
      venue: "Journal of Widgets",
      doi: "10.1234/widget",
    });
    expect(ctx.apiCalls.crossref).toBe(1);
  });

  it("returns null on 404 (clean not-found)", async () => {
    const fetchImpl = (async () => jsonResponse("missing", 404)) as unknown as typeof fetch;
    expect(await crossrefSource.byDoi!("10.9999/nope", makeCtx(fetchImpl))).toBeNull();
  });

  it("throws on persistent HTTP errors so callers can mark the source unavailable", async () => {
    const fetchImpl = (async () => jsonResponse("bad request", 400)) as unknown as typeof fetch;
    await expect(crossrefSource.byDoi!("10.1/x", makeCtx(fetchImpl))).rejects.toThrow("400");
  });

  it("maps OpenAlex search results", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        results: [
          {
            id: "https://openalex.org/W123",
            display_name: "Fast Gadget Learning",
            publication_year: 2021,
            doi: "https://doi.org/10.9/fgl",
            authorships: [{ author: { display_name: "Carol Chen" } }],
            primary_location: { source: { display_name: "GadgetConf" } },
          },
        ],
      })) as unknown as typeof fetch;

    const results = await openalexSource.search!(makeRef({ title: "Fast Gadget Learning" }), makeCtx(fetchImpl));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: "openalex",
      title: "Fast Gadget Learning",
      authors: ["Carol Chen"],
      year: 2021,
      venue: "GadgetConf",
    });
  });

  it("parses arXiv Atom XML by id", async () => {
    const xml = `<?xml version="1.0"?><feed>
      <entry>
        <id>http://arxiv.org/abs/2301.12345v2</id>
        <title>Widget  Transformers</title>
        <published>2023-01-30T00:00:00Z</published>
        <author><name>Alice Smith</name></author>
        <author><name>Bob Jones</name></author>
      </entry></feed>`;
    const fetchImpl = (async () => jsonResponse(xml)) as unknown as typeof fetch;

    const candidate = await arxivSource.byArxivId!("arXiv:2301.12345v2", makeCtx(fetchImpl));
    expect(candidate).toMatchObject({
      source: "arxiv",
      title: "Widget Transformers",
      authors: ["Alice Smith", "Bob Jones"],
      year: 2023,
      arxivId: "2301.12345",
      venue: "arXiv",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Prompts: builders + validation                                      */
/* ------------------------------------------------------------------ */

describe("reference prompts", () => {
  it("builds the extraction prompt with the references text", () => {
    const prompt = referenceExtractionPrompt({ referencesText: "[1] X.", ocr: false });
    expect(prompt).toContain("REFERENCES SECTION:\n[1] X.");
    expect(prompt).toContain('"arxiv_id"');
    expect(prompt).not.toContain("{referencesText}");
  });

  it("builds the verdict prompt with entry and candidate JSON", () => {
    const prompt = referenceVerdictPrompt({
      referenceJson: '{"title": "T"}',
      candidatesJson: "[]",
    });
    expect(prompt).toContain('ENTRY AS CITED IN THE PAPER:\n{"title": "T"}');
    expect(prompt).toContain("MISMATCH when");
    expect(prompt).toContain("Be lenient with");
  });

  it("respects block overrides in reference templates", () => {
    const prompt = referenceVerdictPrompt({
      referenceJson: "{}",
      candidatesJson: "[]",
      overrides: { blocks: { referenceLeniency: "CUSTOM LENIENCY RULES" } },
    });
    expect(prompt).toContain("CUSTOM LENIENCY RULES");
    expect(prompt).not.toContain("et al.");
  });
});

describe("validatePromptOverrides", () => {
  it("accepts valid overrides", () => {
    expect(
      validatePromptOverrides({
        templates: { referenceVerdict: "Check {referenceJson} vs {candidatesJson}" },
      }),
    ).toEqual([]);
    expect(validatePromptOverrides(undefined)).toEqual([]);
  });

  it("warns about missing required placeholders", () => {
    const warnings = validatePromptOverrides({
      templates: { referenceVerdict: "no placeholders at all" },
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("{referenceJson}");
    expect(warnings[1]).toContain("{candidatesJson}");
  });

  it("warns about unknown template names", () => {
    const warnings = validatePromptOverrides({
      templates: { doesNotExist: "whatever" } as Record<string, string>,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("doesNotExist");
  });
});

/* ------------------------------------------------------------------ */
/* Cost: per-model breakdown                                           */
/* ------------------------------------------------------------------ */

describe("usage + cost", () => {
  it("addUsage tracks totals and per-model breakdown", () => {
    const result = { totalPromptTokens: 0, totalCompletionTokens: 0 };
    addUsage(result, { promptTokens: 100, completionTokens: 10 }, "model-a");
    addUsage(result, { promptTokens: 50, completionTokens: 5, model: "model-b" });
    expect(result.totalPromptTokens).toBe(150);
    expect(result.totalCompletionTokens).toBe(15);
    expect((result as { usageByModel?: object }).usageByModel).toEqual({
      "model-a": { promptTokens: 100, completionTokens: 10 },
      "model-b": { promptTokens: 50, completionTokens: 5 },
    });
  });

  it("computeCost prices each model separately when usageByModel is present", () => {
    const cost = computeCost({
      model: "openai/gpt-5.2",
      totalPromptTokens: 2_000_000,
      totalCompletionTokens: 1_000_000,
      usageByModel: {
        "openai/gpt-5.2": {
          promptTokens: 1_000_000,
          completionTokens: 0,
        },
        "openai/gpt-5-mini": {
          promptTokens: 0,
          completionTokens: 1_000_000,
        },
      },
    });
    // 1M prompt @ $1.75/1M + 1M completion @ $2.00/1M
    expect(cost).toBeCloseTo(3.75, 5);
  });
});

/* ------------------------------------------------------------------ */
/* Orchestrator (mocked chat + fake fetch)                             */
/* ------------------------------------------------------------------ */

const DOC = `# A Study of Things

Intro text citing [1] and [2], and also the phantom [7].

## References

[1] A. Smith, B. Jones. Deep Widget Networks. Journal of Widgets, 2020. doi:10.1234/widget
[2] C. Chen. Fast Gadget Learning. GadgetConf, 2018.
[3] D. Fake, E. Phantom. Imaginary Results on Nonexistent Data. Journal of Dreams, 2023.
`;

const EXTRACTED = [
  {
    label: "1",
    raw: "[1] A. Smith, B. Jones. Deep Widget Networks. Journal of Widgets, 2020. doi:10.1234/widget",
    title: "Deep Widget Networks",
    authors: ["A. Smith", "B. Jones"],
    year: 2020,
    venue: "Journal of Widgets",
    doi: "10.1234/widget",
    arxiv_id: null,
    kind: "paper",
  },
  {
    label: "2",
    raw: "[2] C. Chen. Fast Gadget Learning. GadgetConf, 2018.",
    title: "Fast Gadget Learning",
    authors: ["C. Chen"],
    year: 2018,
    venue: "GadgetConf",
    doi: null,
    arxiv_id: null,
    kind: "paper",
  },
  {
    label: "3",
    raw: "[3] D. Fake, E. Phantom. Imaginary Results on Nonexistent Data. Journal of Dreams, 2023.",
    title: "Imaginary Results on Nonexistent Data",
    authors: ["D. Fake", "E. Phantom"],
    year: 2023,
    venue: "Journal of Dreams",
    doi: null,
    arxiv_id: null,
    kind: "paper",
  },
];

const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("https://api.crossref.org/works/10.1234")) {
    return jsonResponse({
      message: {
        title: ["Deep Widget Networks"],
        author: [
          { given: "Alice", family: "Smith" },
          { given: "Bob", family: "Jones" },
        ],
        issued: { "date-parts": [[2020]] },
        "container-title": ["Journal of Widgets"],
        DOI: "10.1234/widget",
      },
    });
  }
  if (url.includes("query.bibliographic=Fast%20Gadget%20Learning")) {
    return jsonResponse({
      message: {
        items: [
          {
            title: ["Fast Gadget Learning"],
            author: [{ given: "Carol", family: "Chen" }],
            issued: { "date-parts": [[2021]] },
            "container-title": ["GadgetConf"],
            DOI: "10.9/fgl",
          },
        ],
      },
    });
  }
  if (url.includes("api.crossref.org/works?query.bibliographic")) {
    return jsonResponse({ message: { items: [] } });
  }
  if (url.includes("api.openalex.org")) {
    return jsonResponse({ results: [] });
  }
  throw new Error(`unexpected url: ${url}`);
}) as typeof fetch;

beforeEach(() => {
  chatMock.mockReset();
  chatMock.mockImplementation(async (messages: { content: string }[]) => {
    const content = messages[0].content;
    if (content.includes("REFERENCES SECTION")) {
      return {
        text: JSON.stringify(EXTRACTED),
        usage: { promptTokens: 100, completionTokens: 50, model: "gpt-test" },
        provider: "openai",
      };
    }
    if (content.includes("DATABASE RECORDS RETRIEVED")) {
      return {
        text: JSON.stringify({ verdict: "not_found", explanation: "No record matches." }),
        usage: { promptTokens: 10, completionTokens: 5, model: "gpt-test" },
        provider: "openai",
      };
    }
    if (content.includes("final portion")) {
      return {
        text: "NONE",
        usage: { promptTokens: 15, completionTokens: 2, model: "gpt-test" },
        provider: "openai",
      };
    }
    // zero-shot content review
    return {
      text: JSON.stringify({ overall_feedback: "Solid paper.", comments: [] }),
      usage: { promptTokens: 200, completionTokens: 20, model: "gpt-test" },
      provider: "openai",
    };
  });
});

describe("reviewReferences", () => {
  it("verifies, flags mismatches and hallucinations, and tracks stats + usage", async () => {
    const { result, stats, references } = await reviewReferences("test-paper", DOC, {
      references: { fetchImpl: fakeFetch, mailto: "test@example.com" },
    });

    expect(result.method).toBe("reference_check");
    expect(stats).toMatchObject({
      entries: 3,
      sectionSource: "heading",
      verified: 1,
      mismatched: 1,
      notFound: 1,
      unverifiable: 0,
      ambiguous: 0,
      adjudicated: 0,
    });
    expect(stats.apiCallsBySource.crossref).toBeGreaterThanOrEqual(3);
    expect(stats.apiCallsBySource.openalex).toBeGreaterThanOrEqual(2);

    // 2 reference comments + 1 overflow-citation comment ([7] > max label [3])
    expect(result.comments).toHaveLength(3);
    expect(result.comments.every((c) => c.commentType === "reference")).toBe(true);
    const titles = result.comments.map((c) => c.title).join(" | ");
    expect(titles).toContain("metadata mismatch");
    expect(titles).toContain("possible hallucination");
    expect(titles).toContain("In-text citations without bibliography entries");

    const overflow = result.comments.find((c) => c.title.includes("In-text"))!;
    expect(overflow.explanation).toContain("[7]");

    // The mismatch explanation must cite the actual database record
    const mismatch = result.comments.find((c) => c.title.includes("mismatch"))!;
    expect(mismatch.explanation).toContain("2021");
    expect(mismatch.quote).toBe(EXTRACTED[1].raw);

    // Token usage tracked with per-model breakdown (extraction only here)
    expect(result.totalPromptTokens).toBe(100);
    expect(result.totalCompletionTokens).toBe(50);
    expect(result.usageByModel).toEqual({
      "gpt-test": { promptTokens: 100, completionTokens: 50 },
    });

    expect(result.overallFeedback).toContain("Checked 3 references");

    // Per-entry breakdown with links to the matched database records
    expect(references).toHaveLength(3);
    expect(references[0]).toMatchObject({
      label: "1",
      status: "verified",
      match: {
        source: "crossref",
        title: "Deep Widget Networks",
        year: 2020,
        doi: "10.1234/widget",
        url: "https://doi.org/10.1234/widget",
      },
    });
    expect(references[1].status).toBe("mismatch");
    expect(references[1].match?.url).toBe("https://doi.org/10.9/fgl");
    expect(references[1].problems.join(" ")).toContain("2021");
    expect(references[2]).toMatchObject({ status: "not_found", match: null });

    // Mismatch comment carries the record's link too
    const mismatchComment = result.comments.find((c) => c.title.includes("mismatch"))!;
    expect(mismatchComment.explanation).toContain("https://doi.org/10.9/fgl");
  });

  it("reports progress events", async () => {
    const stages: string[] = [];
    await reviewReferences("test-paper", DOC, {
      references: { fetchImpl: fakeFetch },
      onProgress: (e) => {
        stages.push(e.stage);
      },
    });
    expect(stages[0]).toBe("references_extract");
    expect(stages.filter((s) => s === "reference_lookup")).toHaveLength(3);
    expect(stages[stages.length - 1]).toBe("references_done");
  });

  it("handles papers without a references section (one locator call, cost tracked)", async () => {
    const { result, stats } = await reviewReferences("no-refs", "Just body text.", {
      references: { fetchImpl: fakeFetch },
    });
    expect(stats.entries).toBe(0);
    expect(stats.sectionSource).toBe("none");
    expect(result.comments).toEqual([]);
    // Deterministic locating failed → exactly one LLM locator call, tracked
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(result.totalPromptTokens).toBe(15);
  });

  it("marks entries unverifiable instead of not_found when every source errors", async () => {
    const failingFetch = (async () => jsonResponse("boom", 400)) as typeof fetch;
    const { stats } = await reviewReferences("outage", DOC, {
      references: { fetchImpl: failingFetch },
    });
    // DOI entry + two search entries: all lookups fail → never accuse of hallucination
    expect(stats.notFound).toBe(0);
    expect(stats.mismatched).toBe(0);
    expect(stats.unverifiable).toBe(3);
  });
});

describe("reviewPaper integration", () => {
  it("is off by default: no reference method block, no fetches", async () => {
    const output = await reviewPaper(DOC, { method: "zero_shot" });
    expect(output.referenceResult).toBeUndefined();
    expect(output.referenceStats).toBeUndefined();
    expect(Object.keys(output.paper.methods)).toEqual(["zero_shot__gpt-test"]);
  });

  it("adds a separately-costed reference_check method block when enabled", async () => {
    const output = await reviewPaper(DOC, {
      method: "zero_shot",
      checkReferences: true,
      references: { fetchImpl: fakeFetch },
    });

    expect(output.referenceResult?.method).toBe("reference_check");
    expect(output.referenceStats?.entries).toBe(3);
    expect(output.checkedReferences).toHaveLength(3);
    expect(output.checkedReferences![0].match?.url).toBe("https://doi.org/10.1234/widget");

    const keys = Object.keys(output.paper.methods);
    expect(keys).toContain("zero_shot__gpt-test");
    expect(keys).toContain("reference_check__gpt-test");

    const refBlock = output.paper.methods["reference_check__gpt-test"];
    const reviewBlock = output.paper.methods["zero_shot__gpt-test"];
    // Reference-check cost is tracked on its own block, not mixed into the review
    expect(refBlock.prompt_tokens).toBe(100);
    expect(refBlock.completion_tokens).toBe(50);
    expect(reviewBlock.prompt_tokens).toBe(200);
    expect(refBlock.cost_usd).toBeGreaterThan(0);
    expect(refBlock.comments.length).toBe(3);
  });
});
