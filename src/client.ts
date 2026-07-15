/**
 * Multi-provider chat client. Uses the OpenAI SDK for all providers via
 * base-URL swapping: OpenAI (default), OpenRouter, Anthropic, Gemini.
 */

import OpenAI from "openai";
import type { ChatOptions, ProviderName, ReasoningEffort, TokenUsage } from "./types.js";

interface ProviderSpec {
  envVar: string;
  baseUrl: string | null;
  /** Model prefix stripped when calling the native API (e.g. "anthropic/"). */
  prefixToStrip: string | null;
  defaultModel: string;
}

export const PROVIDERS: Record<ProviderName, ProviderSpec> = {
  openai: {
    envVar: "OPENAI_API_KEY",
    baseUrl: null,
    prefixToStrip: "openai/",
    defaultModel: "gpt-5.2",
  },
  openrouter: {
    envVar: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    prefixToStrip: null,
    defaultModel: "anthropic/claude-opus-4-6",
  },
  anthropic: {
    envVar: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1/",
    prefixToStrip: "anthropic/",
    defaultModel: "claude-opus-4-6",
  },
  gemini: {
    envVar: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    prefixToStrip: "google/",
    defaultModel: "gemini-3.1-pro-preview",
  },
};

/** Auto-detection priority order. OpenAI first (unlike the Python original). */
export const PROVIDER_PRIORITY: ProviderName[] = [
  "openai",
  "openrouter",
  "anthropic",
  "gemini",
];

/** Model prefix → native provider mapping (for smart auto-detection). */
const MODEL_VENDOR_TO_PROVIDER: Record<string, ProviderName> = {
  "anthropic/": "anthropic",
  "google/": "gemini",
  "openai/": "openai",
};

export class ProviderError extends Error {}

export interface ResolvedProvider {
  provider: ProviderName;
  apiKey: string;
  baseUrl: string | null;
  prefixToStrip: string | null;
}

/**
 * Resolve which provider to use.
 *
 * Resolution order:
 *   1. Explicit `provider` option
 *   2. REVIEW_PROVIDER env var
 *   3. Model-aware auto-detect: a vendor-prefixed model (e.g. "anthropic/...")
 *      prefers that vendor's native API when its key is available
 *   4. Fallback: first available API key in priority order (OpenAI first)
 */
export function resolveProvider(options: {
  provider?: ProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): ResolvedProvider {
  const env = typeof process !== "undefined" ? process.env : ({} as Record<string, string>);

  const build = (name: ProviderName, apiKey?: string): ResolvedProvider => {
    const spec = PROVIDERS[name];
    const key = apiKey ?? options.apiKey ?? env[spec.envVar];
    if (!key) {
      throw new ProviderError(
        `Provider '${name}' selected but no API key found. Set ${spec.envVar} or pass apiKey.`,
      );
    }
    let baseUrl = options.baseUrl ?? spec.baseUrl;
    if (name === "openai" && !options.baseUrl && env.OPENAI_BASE_URL) {
      baseUrl = env.OPENAI_BASE_URL;
    }
    return { provider: name, apiKey: key, baseUrl, prefixToStrip: spec.prefixToStrip };
  };

  const requested =
    options.provider ?? (env.REVIEW_PROVIDER?.toLowerCase().trim() as ProviderName | undefined);
  if (requested) {
    if (!(requested in PROVIDERS)) {
      throw new ProviderError(
        `Unknown provider '${requested}'. Available: ${Object.keys(PROVIDERS).join(", ")}`,
      );
    }
    return build(requested);
  }

  // Model-aware auto-detect
  if (options.model) {
    for (const [prefix, providerName] of Object.entries(MODEL_VENDOR_TO_PROVIDER)) {
      if (options.model.startsWith(prefix)) {
        const spec = PROVIDERS[providerName];
        if (options.apiKey ?? env[spec.envVar]) {
          return build(providerName);
        }
        break; // prefix matched but key missing — fall through
      }
    }
  }

  // First available API key in priority order
  for (const name of PROVIDER_PRIORITY) {
    if (env[PROVIDERS[name].envVar]) {
      return build(name);
    }
  }

  // apiKey provided without a provider: assume OpenAI (the default)
  if (options.apiKey) {
    return build("openai");
  }

  throw new ProviderError(
    "No API key found. Set one of: OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, " +
      "GEMINI_API_KEY — or pass { provider, apiKey } explicitly.",
  );
}

/** Default model for the resolved provider when none is specified. */
export function defaultModelFor(provider: ProviderName): string {
  return PROVIDERS[provider].defaultModel;
}

const REASONING_EFFORT_RATIO: Record<string, number> = {
  none: 0,
  low: 0.1,
  medium: 0.5,
  high: 0.8,
};

const EMPTY_RESPONSE_MAX_RETRIES = 3;
const EMPTY_RESPONSE_TOKEN_MULTIPLIER = 2;

function applyReasoning(
  kwargs: Record<string, unknown>,
  provider: ProviderName,
  reasoningEffort: ReasoningEffort,
  maxTokens: number,
): void {
  const ratio = REASONING_EFFORT_RATIO[reasoningEffort] ?? 0.5;
  const budget = Math.max(Math.floor(maxTokens * ratio), 1024);

  if (provider === "openrouter") {
    kwargs.reasoning = { max_tokens: budget };
  } else if (provider === "anthropic" || provider === "gemini") {
    kwargs.thinking = { type: "enabled", budget_tokens: budget };
  } else if (provider === "openai") {
    kwargs.reasoning_effort = reasoningEffort;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  text: string;
  usage: TokenUsage & { model: string };
  provider: ProviderName;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Call a chat API. Returns the response text plus accumulated token usage.
 *
 * Retries transient errors with exponential backoff; retries empty responses
 * (reasoning consumed all tokens) with doubled maxTokens.
 */
export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
  const resolved = resolveProvider(options);
  const model = options.model ?? defaultModelFor(resolved.provider);
  const {
    temperature = 0.0,
    maxTokens = 16384,
    reasoningEffort = null,
    retries = 3,
    signal,
  } = options;

  const client = new OpenAI({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl ?? undefined,
    maxRetries: 0, // we own retry logic (and so does Inngest when wrapped in steps)
  });

  let apiModel = model;
  if (resolved.prefixToStrip && apiModel.startsWith(resolved.prefixToStrip)) {
    apiModel = apiModel.slice(resolved.prefixToStrip.length);
  }

  let currentMaxTokens = maxTokens;
  const totalUsage = { promptTokens: 0, completionTokens: 0, model };

  for (let emptyAttempt = 0; emptyAttempt < EMPTY_RESPONSE_MAX_RETRIES; emptyAttempt++) {
    let gotResponse = false;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // OpenAI o-series and GPT-5+ models require max_completion_tokens
        const needsCompletionTokens =
          resolved.provider === "openai" &&
          (/^o[134]/.test(apiModel) || apiModel.startsWith("gpt-5"));
        const tokenKey = needsCompletionTokens ? "max_completion_tokens" : "max_tokens";

        const kwargs: Record<string, unknown> = {
          model: apiModel,
          messages,
          [tokenKey]: currentMaxTokens,
        };
        // OpenAI reasoning models (o-series, GPT-5 family) reject explicit temperature
        if (temperature !== null && temperature !== undefined && !needsCompletionTokens) {
          kwargs.temperature = temperature;
        }
        if (reasoningEffort && reasoningEffort !== "none") {
          applyReasoning(kwargs, resolved.provider, reasoningEffort, currentMaxTokens);
        }

        const resp = await client.chat.completions.create(
          kwargs as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
          { signal },
        );

        totalUsage.promptTokens += resp.usage?.prompt_tokens ?? 0;
        totalUsage.completionTokens += resp.usage?.completion_tokens ?? 0;

        const content = resp.choices?.[0]?.message?.content ?? "";
        if (content.trim()) {
          return { text: content, usage: totalUsage, provider: resolved.provider };
        }

        gotResponse = true;
        break; // empty response — break to the outer loop to increase maxTokens
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt === retries - 1) throw err;
        await sleep(2 ** attempt * 1000);
      }
    }
    if (!gotResponse) {
      throw new Error("All retries exhausted");
    }
    currentMaxTokens *= EMPTY_RESPONSE_TOKEN_MULTIPLIER;
  }

  // All empty-response retries exhausted — return empty text with usage
  return { text: "", usage: totalUsage, provider: resolved.provider };
}
