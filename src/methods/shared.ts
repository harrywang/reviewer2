import { defaultModelFor, resolveProvider } from "../client.js";
import type { ReviewOptions } from "../types.js";

/** Resolve the effective model id (explicit, or the resolved provider's default). */
export function resolveModel(options: ReviewOptions): string {
  if (options.model) return options.model;
  return defaultModelFor(resolveProvider(options).provider);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function resolveCurrentDate(options: ReviewOptions): string {
  return options.currentDate ?? today();
}

/** Extract the chat-relevant subset of ReviewOptions to pass through. */
export function chatOptionsFrom(options: ReviewOptions) {
  return {
    provider: options.provider,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    signal: options.signal,
  };
}
