import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROMPT_BLOCKS,
  defaultPromptTemplates,
  interpolate,
  resolvePromptTemplates,
} from "../src/index.js";
import {
  consolidationPrompt,
  deepCheckPrompt,
  overallFeedbackPrompt,
  summaryUpdatePrompt,
  technicalFilterPrompt,
  zeroShotPrompt,
} from "../src/prompts.js";

describe("interpolate", () => {
  it("replaces known placeholders in a single pass", () => {
    expect(interpolate("Hi {name}, today is {date}.", { name: "Ada", date: "2026" })).toBe(
      "Hi Ada, today is 2026.",
    );
  });

  it("leaves unknown placeholders untouched", () => {
    expect(interpolate("keep {unknown} as-is", {})).toBe("keep {unknown} as-is");
  });

  it("never re-scans inserted values (LaTeX braces are safe)", () => {
    const out = interpolate("PASSAGE: {passage}", {
      passage: "let \\hat{x} = {context} and $f_{i}$",
    });
    // The literal "{context}" inside the passage must survive untouched
    expect(out).toBe("PASSAGE: let \\hat{x} = {context} and $f_{i}$");
  });
});

describe("default prompts (no overrides)", () => {
  it("deepCheckPrompt matches the classic structure", () => {
    const prompt = deepCheckPrompt({
      context: "CTX",
      passage: "PSG",
      currentDate: "2026-07-15",
      ocr: false,
      progressive: true,
    });
    expect(prompt).toContain("Today's date is 2026-07-15");
    expect(prompt).toContain("PASSAGE TO CHECK:\nPSG");
    expect(prompt).toContain("Check for:");
    expect(prompt).toContain("Notation not yet in the summary");
    expect(prompt).not.toContain("{ocrCaveat}");
    expect(prompt).not.toContain("OCR"); // no caveat when ocr=false
  });

  it("includes the OCR caveat when ocr=true", () => {
    const prompt = deepCheckPrompt({
      context: "CTX",
      passage: "PSG",
      currentDate: "2026-07-15",
      ocr: true,
    });
    expect(prompt).toContain("extracted from a PDF via OCR");
  });
});

describe("block overrides", () => {
  it("replaces the check criteria in every prompt that uses it", () => {
    const overrides = {
      blocks: { checkCriteria: "Check for:\n1. Only statistical validity issues" },
    };
    const deep = deepCheckPrompt({
      context: "c",
      passage: "p",
      currentDate: "d",
      overrides,
    });
    const zero = zeroShotPrompt({ paperText: "t", currentDate: "d", overrides });
    for (const prompt of [deep, zero]) {
      expect(prompt).toContain("Only statistical validity issues");
      expect(prompt).not.toContain("Mathematical / formula errors");
    }
    // Structure is preserved
    expect(deep).toContain("PASSAGE TO CHECK:");
  });

  it("replaces the OCR caveat text", () => {
    const prompt = deepCheckPrompt({
      context: "c",
      passage: "p",
      currentDate: "d",
      ocr: true,
      overrides: { blocks: { ocrCaveat: "CUSTOM OCR WARNING" } },
    });
    expect(prompt).toContain("CUSTOM OCR WARNING");
    expect(prompt).not.toContain("extracted from a PDF via OCR");
  });
});

describe("template overrides", () => {
  it("replaces a whole template with placeholder interpolation", () => {
    const prompt = summaryUpdatePrompt({
      currentSummary: "SUM",
      passageText: "PSG",
      passageIdx: 2,
      totalPassages: 9,
      overrides: {
        templates: {
          summaryUpdate: "Custom {passageIdx}/{totalPassages}: {currentSummary} + {passageText}",
        },
      },
    });
    expect(prompt).toBe("Custom 2/9: SUM + PSG");
  });

  it("template override wins over block override", () => {
    const prompt = consolidationPrompt("[]", {
      blocks: { checkCriteria: "IGNORED" },
      templates: { consolidation: "Dedup these: {issuesJson}" },
    });
    expect(prompt).toBe("Dedup these: []");
  });

  it("other templates keep defaults when only one is overridden", () => {
    const overrides = { templates: { overallFeedback: "Summarize: {paperStart}" } };
    expect(overallFeedbackPrompt("START", overrides)).toBe("Summarize: START");
    expect(technicalFilterPrompt("PSG", overrides)).toContain('Answer with ONLY "yes" or "no"');
  });
});

describe("resolvePromptTemplates / defaults export", () => {
  it("exposes all ten templates", () => {
    const templates = defaultPromptTemplates();
    expect(Object.keys(templates).sort()).toEqual([
      "consolidation",
      "deepCheck",
      "deepCheckProgressive",
      "largePaperChunk",
      "overallFeedback",
      "referenceExtraction",
      "referenceVerdict",
      "summaryUpdate",
      "technicalFilter",
      "zeroShot",
    ]);
  });

  it("recomposes templates from overridden blocks", () => {
    const templates = resolvePromptTemplates({
      blocks: { doNotFlag: "Do NOT flag:\n- anything about citations" },
    });
    expect(templates.deepCheck).toContain("anything about citations");
    expect(templates.deepCheck).toContain("Incomplete text at passage boundaries"); // structural line kept
  });

  it("overrides survive JSON round-trip (Inngest step safety)", () => {
    const overrides = {
      blocks: { checkCriteria: "custom" },
      templates: { zeroShot: "z {paperText}" },
    };
    expect(JSON.parse(JSON.stringify(overrides))).toEqual(overrides);
  });
});

describe("DEFAULT_PROMPT_BLOCKS", () => {
  it("is exported with all blocks present", () => {
    expect(DEFAULT_PROMPT_BLOCKS.checkCriteria).toContain("Check for:");
    expect(DEFAULT_PROMPT_BLOCKS.reviewerPreamble).toContain("{currentDate}");
  });
});
