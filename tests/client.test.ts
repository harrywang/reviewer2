import { describe, expect, it } from "vitest";

import { isOpenAiReasoningModel } from "../src/client.js";

describe("isOpenAiReasoningModel", () => {
  it("covers o-series and GPT-5+ (incl. GPT-6)", () => {
    for (const m of ["o1", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini", "gpt-5.2", "gpt-5.6-luna", "gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]) {
      expect(isOpenAiReasoningModel(m), m).toBe(true);
    }
  });

  it("leaves legacy chat models on max_tokens", () => {
    for (const m of ["gpt-4o", "gpt-4.1", "gpt-4o-mini", "gpt-3.5-turbo"]) {
      expect(isOpenAiReasoningModel(m), m).toBe(false);
    }
  });
});
