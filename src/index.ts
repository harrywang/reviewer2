/**
 * reviewer2 — AI-powered academic paper reviewer.
 *
 * TypeScript port of OpenAIReview. Reviews a paper's text with a
 * multi-provider LLM pipeline and returns structured, visualization-ready
 * JSON ({ slug, title, paragraphs, methods }).
 */

// High-level API
export {
  buildMethodJson,
  buildPaperJson,
  methodKey,
  modelShortName,
  OCR_DISCLAIMER,
  reviewPaper,
  slugify,
  type ReviewPaperOptions,
  type ReviewPaperOutput,
} from "./review.js";

// Review methods
export { reviewZeroShot } from "./methods/zeroShot.js";
export { reviewLocal } from "./methods/local.js";
export {
  reviewProgressive,
  prepareProgressive,
  runProgressivePassage,
  consolidateComments,
  generateOverallFeedback,
  isTechnicalPassage,
  type PassageStepInput,
  type PassageStepOutput,
  type ProgressiveOptions,
  type ProgressivePlan,
} from "./methods/progressive.js";

// Document parsing
export {
  detectFormat,
  isUrl,
  parseArxivHtml,
  parseArxivHtmlString,
  parseDocument,
  parseDocumentBuffer,
  parsePdf,
  parseTex,
  reflowPdfPage,
  parseTextContent,
  fixOcrNotation,
  type DocumentFormat,
  type OcrCorrection,
  type ParseOptions,
  type ParsedDocument,
  type ParsePdfOptions,
  type PdfEngine,
} from "./parsers/index.js";

// LLM client
export {
  chat,
  defaultModelFor,
  resolveProvider,
  PROVIDER_PRIORITY,
  PROVIDERS,
  ProviderError,
  type ChatMessage,
  type ChatResponse,
  type ResolvedProvider,
} from "./client.js";

// Reference accuracy check (opt-in)
export {
  adjudicateReference,
  arxivIdFromDoi,
  arxivSource,
  authorOverlap,
  buildReferenceSources,
  BUILTIN_SOURCES,
  candidateLink,
  checkReference,
  classifyReference,
  crossrefSource,
  DEFAULT_MATCH_THRESHOLDS,
  extractReferences,
  findOverflowCitations,
  findReferencesSection,
  locateReferencesLlm,
  lookupReferenceCandidates,
  normalizeArxivId,
  normalizeDoi,
  normalizeTitle,
  openalexSource,
  reviewReferences,
  scoreCandidate,
  semanticScholarSource,
  titleSimilarity,
  type AdjudicationOutput,
  type CheckedReference,
  type ExtractedReference,
  type ExtractReferencesOutput,
  type LookupOutput,
  type MatchedRecord,
  type MatchResult,
  type MatchThresholds,
  type ReferenceCandidate,
  type ReferenceCheckOptions,
  type ReferenceCheckOutput,
  type ReferenceKind,
  type ReferencesSection,
  type ReferenceSource,
  type ReviewReferencesOptions,
  type SourceContext,
} from "./refcheck/index.js";

// Prompts (customizable)
export {
  DEFAULT_PROMPT_BLOCKS,
  defaultPromptTemplates,
  interpolate,
  referenceExtractionPrompt,
  referenceLocatorPrompt,
  referenceVerdictPrompt,
  resolvePromptTemplates,
  validatePromptOverrides,
  warnPromptOverrides,
  type PromptBlocks,
  type PromptOverrides,
  type PromptTemplates,
} from "./prompts.js";

// Utilities
export {
  clearPricingCache,
  computeCost,
  COST_PER_1M,
  DEFAULT_COST,
  fetchLivePricing,
  type LivePricingOptions,
  type Pricing,
  type PricingTable,
} from "./cost.js";
export { countTokens, truncateText, chunkText } from "./tokens.js";
export { addUsage, type UsageAccumulator } from "./usage.js";
export {
  assignParagraphIndices,
  getWindowContext,
  locateCommentInDocument,
  locateCommentsInWindow,
  mergeIntoPassages,
  splitIntoParagraphs,
  type Passage,
} from "./textutils.js";
export {
  parseCommentsFromList,
  parseCommentsFromResponse,
  parseFirstJsonValue,
  parseReviewResponse,
} from "./parsing.js";

// Types
export type {
  ChatOptions,
  CommentType,
  PaperCommentJson,
  PaperMethodJson,
  PaperReviewJson,
  ProgressCallback,
  ProviderConfig,
  ProviderName,
  ReasoningEffort,
  ReferenceCheckStats,
  ReferenceSectionSource,
  ReferenceStatus,
  ReviewComment,
  ReviewMethod,
  ReviewOptions,
  ReviewProgressEvent,
  ReviewResult,
  TokenUsage,
} from "./types.js";
