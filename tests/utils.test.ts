import { describe, expect, it } from "vitest";

import {
  chunkText,
  countTokens,
  locateCommentInDocument,
  parseCommentsFromList,
  parseReviewResponse,
  splitIntoParagraphs,
} from "../src/index.js";

describe("countTokens", () => {
  it("returns positive count for non-empty text", () => {
    expect(countTokens("hello world")).toBeGreaterThan(0);
  });

  it("returns 0 for empty text", () => {
    expect(countTokens("")).toBe(0);
  });
});

describe("chunkText", () => {
  it("keeps short text as a single chunk", () => {
    const text = "Short text.";
    const chunks = chunkText(text, 1000, 100);
    expect(chunks).toEqual([text]);
  });

  it("splits long text with each chunk within limits", () => {
    const text = "word ".repeat(5000);
    const chunks = chunkText(text, 500, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(countTokens(c)).toBeLessThanOrEqual(510);
    }
  });
});

describe("splitIntoParagraphs", () => {
  it("splits on blank lines", () => {
    const text =
      "First paragraph.\n\nSecond paragraph that is long enough to stand on its own easily.";
    expect(splitIntoParagraphs(text, 10)).toHaveLength(2);
  });

  it("merges short paragraphs into the next", () => {
    const text =
      "Hi.\n\nThis is a much longer paragraph that should absorb the short one above.";
    expect(splitIntoParagraphs(text, 100)).toHaveLength(1);
  });
});

describe("locateCommentInDocument", () => {
  it("finds exact substring matches", () => {
    const paragraphs = [
      "The cat sat on the mat and looked around the room with great curiosity.",
      "The dog chased the ball across the wide green field on a sunny afternoon.",
    ];
    expect(locateCommentInDocument("dog chased the ball", paragraphs)).toBe(1);
  });

  it("returns null when nothing matches", () => {
    const paragraphs = [
      "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH IIII JJJJ KKKK LLLL MMMM NNNN",
    ];
    expect(
      locateCommentInDocument("xxxx yyyy zzzz wwww 1234 5678 9012 3456", paragraphs),
    ).toBeNull();
  });

  it("handles long markdown-table paragraphs via sliding windows", () => {
    const paragraphs = [
      "Short intro paragraph.",
      "prefix " +
        "filler ".repeat(150) +
        "| ||Instruction|**TS1:** The goal described in the plan fle matches the input stated goal.| " +
        "|||**TS2:** The goal described in the plan fle matches the input stated goal.|",
    ];
    const quote =
      "**TS1:** The goal described in the plan fle matches the input stated goal.\n\n" +
      "**TS2:** The goal described in the plan fle matches the input stated goal.";
    expect(locateCommentInDocument(quote, paragraphs)).toBe(1);
  });
});

describe("parseCommentsFromList", () => {
  it("parses well-formed items", () => {
    const comments = parseCommentsFromList([
      { title: "Wrong sign", quote: "x = -y", explanation: "Should be positive.", type: "technical" },
      { title: "Overclaim", quote: "we prove", explanation: "Not actually proven.", type: "logical" },
    ]);
    expect(comments).toHaveLength(2);
    expect(comments[0].title).toBe("Wrong sign");
    expect(comments[0].commentType).toBe("technical");
    expect(comments[1].commentType).toBe("logical");
  });

  it("infers type from keywords when unrecognized", () => {
    const comments = parseCommentsFromList([
      { title: "Wrong formula", quote: "x", explanation: "bad", type: "other" },
    ]);
    expect(comments[0].commentType).toBe("technical");
  });
});

describe("parseReviewResponse", () => {
  it("parses a JSON object with overall_feedback", () => {
    const response = JSON.stringify({
      overall_feedback: "Good paper.",
      comments: [{ title: "Issue", quote: "text", explanation: "problem", type: "technical" }],
    });
    const { overallFeedback, comments } = parseReviewResponse(response);
    expect(overallFeedback).toBe("Good paper.");
    expect(comments).toHaveLength(1);
  });

  it("parses a bare JSON array", () => {
    const response = JSON.stringify([
      { title: "Issue", quote: "text", explanation: "problem", type: "logical" },
    ]);
    const { overallFeedback, comments } = parseReviewResponse(response);
    expect(overallFeedback).toBe("");
    expect(comments).toHaveLength(1);
  });

  it("strips markdown fences", () => {
    const response =
      '```json\n[{"title": "Bug", "quote": "x", "explanation": "y", "type": "technical"}]\n```';
    expect(parseReviewResponse(response).comments).toHaveLength(1);
  });

  it("returns empty for non-JSON text", () => {
    expect(parseReviewResponse("No JSON here at all.").comments).toEqual([]);
  });

  it("salvages malformed JSON-ish output with unescaped quotes", () => {
    const response = `\`\`\`json
{
  "overall_feedback": "Good paper overall.",
  "comments": [
    {
      "title": "Quoted phrase breaks strict JSON",
      "quote": "the [n] "setting-sun" diagram",
      "explanation": "Still a valid review comment.",
      "type": "technical"
    }
  ]
}
\`\`\``;
    const { overallFeedback, comments } = parseReviewResponse(response);
    expect(overallFeedback).toBe("Good paper overall.");
    expect(comments).toHaveLength(1);
    expect(comments[0].title).toBe("Quoted phrase breaks strict JSON");
    expect(comments[0].quote).toBe('the [n] "setting-sun" diagram');
  });
});
