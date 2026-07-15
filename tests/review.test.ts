import { describe, expect, it } from "vitest";

import {
  buildPaperJson,
  computeCost,
  detectFormat,
  fixOcrNotation,
  methodKey,
  modelShortName,
  parseArxivHtmlString,
  parseTextContent,
  prepareProgressive,
  reflowPdfPage,
  resolveProvider,
  slugify,
  type ReviewResult,
} from "../src/index.js";

describe("slugify / methodKey", () => {
  it("slugifies names", () => {
    expect(slugify("My Great Paper: A Study!")).toBe("my-great-paper-a-study");
  });

  it("builds method keys from method + short model name", () => {
    expect(methodKey("progressive", "anthropic/claude-opus-4-6")).toBe(
      "progressive__claude-opus-4-6",
    );
    expect(modelShortName("gpt-5.2")).toBe("gpt-5.2");
  });
});

describe("buildPaperJson", () => {
  const result: ReviewResult = {
    method: "progressive",
    paperSlug: "test-paper",
    comments: [
      {
        title: "Sign error",
        quote: "x = -y",
        explanation: "Should be +y.",
        commentType: "technical",
        paragraphIndex: 2,
      },
    ],
    overallFeedback: "Solid work.",
    totalPromptTokens: 1000,
    totalCompletionTokens: 500,
    model: "anthropic/claude-opus-4-6",
    reasoningEffort: null,
  };

  it("produces the viz-compatible shape (snake_case, ids, cost)", () => {
    const paper = buildPaperJson({
      slug: "test-paper",
      title: "Test Paper",
      paragraphs: ["Para one.", "Para two.", "x = -y"],
      results: [result],
    });

    expect(Object.keys(paper).sort()).toEqual(["methods", "paragraphs", "slug", "title"]);
    expect(paper.paragraphs[0]).toEqual({ index: 0, text: "Para one." });

    const key = "progressive__claude-opus-4-6";
    expect(paper.methods[key]).toBeDefined();
    const method = paper.methods[key];
    expect(method.label).toBe("Progressive (claude-opus-4-6)");
    expect(method.comments[0]).toEqual({
      id: `${key}_0`,
      title: "Sign error",
      quote: "x = -y",
      explanation: "Should be +y.",
      comment_type: "technical",
      paragraph_index: 2,
    });
    // 1000/1M * 5 + 500/1M * 25 = 0.005 + 0.0125 = 0.0175
    expect(method.cost_usd).toBeCloseTo(0.0175, 4);
  });

  it("appends the OCR disclaimer paragraph when wasOcr", () => {
    const paper = buildPaperJson({
      slug: "s",
      title: "t",
      paragraphs: ["Only para."],
      results: [result],
      wasOcr: true,
    });
    expect(paper.paragraphs).toHaveLength(2);
    expect(paper.paragraphs[1].text).toMatch(/OCR/);
  });

  it("merges into an existing paper JSON", () => {
    const first = buildPaperJson({
      slug: "s",
      title: "t",
      paragraphs: ["p"],
      results: [result],
    });
    const second = buildPaperJson({
      slug: "s",
      title: "t",
      paragraphs: ["p"],
      results: [{ ...result, model: "openai/gpt-5.2-pro" }],
      existing: first,
    });
    expect(Object.keys(second.methods)).toHaveLength(2);
  });
});

describe("computeCost", () => {
  it("uses known pricing", () => {
    expect(
      computeCost({
        model: "anthropic/claude-opus-4-6",
        totalPromptTokens: 1_000_000,
        totalCompletionTokens: 1_000_000,
      }),
    ).toBeCloseTo(30.0);
  });

  it("falls back to default pricing for unknown models", () => {
    expect(
      computeCost({
        model: "acme/unknown-model",
        totalPromptTokens: 1_000_000,
        totalCompletionTokens: 0,
      }),
    ).toBeCloseTo(5.0);
  });
});

describe("prepareProgressive", () => {
  it("splits into paragraphs and passages deterministically", () => {
    const text = Array.from(
      { length: 30 },
      (_, i) => `Paragraph ${i} with enough characters to stand alone as a paragraph in the document, repeated to be safe.`,
    ).join("\n\n");
    const plan = prepareProgressive(text);
    expect(plan.paragraphs.length).toBe(30);
    expect(plan.passages.length).toBeGreaterThan(0);
    expect(plan.maxSummaryTokens).toBeGreaterThanOrEqual(4000);
    // JSON-serializable (safe across Inngest step boundaries)
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });
});

describe("resolveProvider", () => {
  it("uses an explicit provider + apiKey without env vars", () => {
    const resolved = resolveProvider({ provider: "openrouter", apiKey: "sk-test" });
    expect(resolved.provider).toBe("openrouter");
    expect(resolved.baseUrl).toContain("openrouter.ai");
  });

  it("prefers the model's native vendor when its key is available", () => {
    const resolved = resolveProvider({
      model: "anthropic/claude-opus-4-6",
      apiKey: "sk-test",
    });
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.prefixToStrip).toBe("anthropic/");
  });

  it("defaults to openai when only an apiKey is given", () => {
    const resolved = resolveProvider({ apiKey: "sk-test", model: "gpt-5.2" });
    expect(resolved.provider).toBe("openai");
  });
});

describe("fixOcrNotation", () => {
  it("fixes a singleton confusable accent against a frequent neighbor", () => {
    const text =
      "We define \\hat{i} once. Later \\hat{t} appears and \\hat{t} again, " +
      "then \\hat{t} a third time.";
    const { text: fixed, corrections } = fixOcrNotation(text);
    expect(corrections.length).toBe(1);
    expect(fixed).not.toContain("\\hat{i}");
    expect(corrections[0].new).toBe("\\hat{t}");
  });

  it("leaves consistent notation alone", () => {
    const text = "\\hat{x} and \\hat{x} and \\hat{y} and \\hat{y}";
    const { corrections } = fixOcrNotation(text);
    expect(corrections).toHaveLength(0);
  });
});

describe("parseTextContent", () => {
  it("reads YAML frontmatter title and ocr_engine", () => {
    const raw = '---\ntitle: "My Paper"\nocr_engine: "external"\n---\n\n# Heading\n\nBody text.';
    const parsed = parseTextContent(raw);
    expect(parsed.title).toBe("My Paper");
    expect(parsed.wasOcr).toBe(true);
    expect(parsed.text.trim().startsWith("# Heading")).toBe(true);
  });

  it("falls back to first heading", () => {
    const parsed = parseTextContent("# The Title\n\nBody.");
    expect(parsed.title).toBe("The Title");
    expect(parsed.wasOcr).toBe(false);
  });
});

describe("parseArxivHtmlString", () => {
  it("extracts title, headings, abstract, and tables from LaTeXML markup", () => {
    const html = `
      <html><head><title>fallback</title></head><body>
      <article class="ltx_document">
        <h1 class="ltx_title ltx_title_document">A Great Paper</h1>
        <div class="ltx_abstract">
          <h6 class="ltx_title ltx_title_abstract">Abstract</h6>
          <p class="ltx_p">We study things deeply and report interesting findings.</p>
        </div>
        <section class="ltx_section">
          <h2 class="ltx_title ltx_title_section">1 Introduction</h2>
          <div class="ltx_para"><p class="ltx_p">Intro paragraph text goes here with details.</p></div>
        </section>
        <figure class="ltx_table">
          <figcaption class="ltx_caption">Table 1: Results</figcaption>
          <table class="ltx_tabular">
            <tr><th>Model</th><th>Score</th></tr>
            <tr><td>Ours</td><td>0.9</td></tr>
          </table>
        </figure>
        <nav class="ltx_TOC">should be removed</nav>
      </article>
      </body></html>`;
    const { title, text } = parseArxivHtmlString(html);
    expect(title).toBe("A Great Paper");
    expect(text).toContain("# A Great Paper");
    expect(text).toContain("## 1 Introduction");
    expect(text).toContain("## Abstract");
    expect(text).toContain("| Model | Score |");
    expect(text).toContain("**Table 1: Results**");
    expect(text).not.toContain("should be removed");
  });
});

describe("detectFormat", () => {
  it("detects format from URL path extension, ignoring query strings", () => {
    expect(
      detectFormat("https://bucket.s3.amazonaws.com/papers/abc.pdf?X-Amz-Signature=xyz&X-Amz-Expires=300"),
    ).toBe("pdf");
    expect(detectFormat("https://example.com/files/paper.docx")).toBe("docx");
    expect(detectFormat("https://example.com/notes.md")).toBe("md");
  });

  it("falls back to Content-Type when the path has no known extension", () => {
    expect(detectFormat("https://example.com/download/123", "application/pdf")).toBe("pdf");
    expect(detectFormat("https://example.com/download/123", "text/plain; charset=utf-8")).toBe("txt");
  });

  it("returns undefined for HTML and unknown types", () => {
    expect(detectFormat("https://arxiv.org/html/2310.06825", "text/html")).toBeUndefined();
    expect(detectFormat("https://example.com/thing", "application/octet-stream")).toBeUndefined();
  });
});

describe("reflowPdfPage", () => {
  it("joins wrapped lines into one paragraph and dehyphenates", () => {
    const page = [
      "Proponents argue that PSL improves public health outcomes by reducing presen-",
      "teeism and provides crucial income security for vulnerable workers across approx-",
      "imately sixteen states that adopted mandates between 2012 and 2022 in the US.",
    ].join("\n");
    const out = reflowPdfPage(page);
    expect(out).toContain("presenteeism");
    expect(out).toContain("approximately");
    expect(out.split("\n\n")).toHaveLength(1);
  });

  it("breaks paragraphs at short sentence-ending lines", () => {
    const page = [
      "This is the first paragraph of the page and it continues across the full width",
      "of the column until it reaches the end. It ends.",
      "The second paragraph then begins with a fresh sentence that also continues on",
      "for a while across the full column width before wrapping to its final line",
      "and stopping short.",
    ].join("\n");
    const paras = reflowPdfPage(page).split("\n\n");
    expect(paras.length).toBe(2);
    expect(paras[0].endsWith("It ends.")).toBe(true);
  });

  it("separates a heading-like short line", () => {
    const page = [
      "1 Introduction",
      "Mandatory paid sick leave has emerged as one of the most significant labor",
      "policy debates of the past decade in the United States and beyond it too.",
    ].join("\n");
    const paras = reflowPdfPage(page).split("\n\n");
    expect(paras[0]).toBe("1 Introduction");
  });
});
