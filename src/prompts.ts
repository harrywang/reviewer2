/**
 * All review prompts — fully customizable.
 *
 * Two override levels, both plain strings (JSON-safe, so custom prompts can
 * live in a database and cross Inngest step boundaries):
 *
 * 1. `blocks` — replace a shared building block (e.g. just the check
 *    criteria) while keeping every prompt's overall structure.
 * 2. `templates` — replace an entire prompt template. Templates use
 *    `{placeholder}` interpolation; unknown placeholders are left as-is,
 *    and interpolation is single-pass so LaTeX braces in paper text are
 *    never re-scanned.
 *
 * Precedence: template override > block override > default.
 */

/* ------------------------------------------------------------------ */
/* Override types                                                      */
/* ------------------------------------------------------------------ */

/** Shared building blocks used to compose the default prompt templates. */
export interface PromptBlocks {
  /** Reviewer role/mindset opener. Placeholder: {currentDate}. */
  reviewerPreamble?: string;
  /** The numbered list of what to check for. */
  checkCriteria?: string;
  /** How to write each issue's explanation. */
  explanationStyle?: string;
  /** What to be lenient about. */
  leniencyRules?: string;
  /** Base "Do NOT flag" list (method-specific lines are appended after it). */
  doNotFlag?: string;
  /** Caveat injected when the text came from OCR. */
  ocrCaveat?: string;
  /**
   * Output-format instruction for array-shaped responses. If you change the
   * requested shape, the built-in parser still expects items with
   * title/quote/explanation/type — keep those field names.
   */
  jsonArrayOutput?: string;
  /** Reference check: what counts as a metadata mismatch. */
  referenceMatchCriteria?: string;
  /** Reference check: what to be lenient about when comparing records. */
  referenceLeniency?: string;
}

/**
 * Full prompt templates. Available placeholders per template:
 * - deepCheck / deepCheckProgressive: {currentDate} {ocrCaveat} {context} {passage}
 * - zeroShot:        {currentDate} {ocrCaveat} {paperText}
 * - largePaperChunk: {currentDate} {ocrCaveat} {chunkNum} {totalChunks} {chunkText}
 * - summaryUpdate:   {currentSummary} {passageText} {passageIdx} {totalPassages}
 * - technicalFilter: {passage} — the model must answer only "yes" or "no"
 * - consolidation:   {issuesJson}
 * - overallFeedback: {paperStart}
 * - referenceExtraction: {referencesText} {ocrCaveat}
 * - referenceVerdict:    {referenceJson} {candidatesJson}
 */
export interface PromptTemplates {
  deepCheck?: string;
  deepCheckProgressive?: string;
  zeroShot?: string;
  largePaperChunk?: string;
  summaryUpdate?: string;
  technicalFilter?: string;
  consolidation?: string;
  overallFeedback?: string;
  referenceExtraction?: string;
  referenceVerdict?: string;
}

export interface PromptOverrides {
  blocks?: PromptBlocks;
  templates?: PromptTemplates;
}

/* ------------------------------------------------------------------ */
/* Default building blocks                                             */
/* ------------------------------------------------------------------ */

export const DEFAULT_PROMPT_BLOCKS: Required<PromptBlocks> = {
  reviewerPreamble:
    `You are a thoughtful reviewer checking a passage from an academic paper. ` +
    `Today's date is {currentDate}. ` +
    `Engage deeply with the material. For each potential issue, first try to understand the authors' ` +
    `intent and check whether your concern is resolved by context before flagging it.`,

  checkCriteria: `Check for:
1. Mathematical / formula errors: wrong formulas, sign errors, missing factors, incorrect derivations, subscript or index errors
2. Notation inconsistencies: symbols used in a way that contradicts their earlier definition
3. Inconsistency between text and formal definitions: prose says one thing but the equation says another
4. Parameter / numerical inconsistencies: stated values contradict what can be derived from definitions or tables elsewhere
5. Insufficient justification: a key derivation step is skipped where the result is non-trivial
6. Questionable claims: statements that overstate what has actually been shown
7. Ambiguity that could mislead: flag only if a careful reader could reasonably reach an incorrect conclusion
8. Underspecified methods: an algorithm, procedure, or modification is described too vaguely for a reader to reproduce — key choices, boundary conditions, or parameter settings are left implicit`,

  explanationStyle: `For each issue, write like a careful reader thinking aloud. Describe what initially confused or \
concerned you, what you checked to resolve it, and what specifically remains problematic. \
Acknowledge what the authors got right before noting the issue. Reference standard results \
or conventions in the field when relevant.`,

  leniencyRules: `Be lenient with:
- Introductory and overview sections, which intentionally simplify or gloss over details
- Forward references — symbols or claims that may be defined or justified later in the paper
- Informal prose that paraphrases a formal result without repeating every qualifier`,

  doNotFlag: `Do NOT flag:
- Formatting, typesetting, or capitalization issues
- References to equations or sections not shown in the context (they exist elsewhere)
- Trivial observations that any reader in the field would immediately resolve`,

  ocrCaveat: `NOTE: This text was extracted from a PDF via OCR. While automatic corrections \
have been applied, some notation errors may remain. If you spot a symbol that \
appears inconsistent with surrounding usage (e.g. a variable that appears once \
with a different letter than everywhere else), consider whether it is an OCR \
misread rather than an author error. Flag it only if it would be a real issue \
even assuming the most plausible intended symbol.`,

  jsonArrayOutput: `Return ONLY a JSON array (can be []). Each item:
- "title": concise title of the issue
- "quote": the exact verbatim text (preserving LaTeX)
- "explanation": deep reasoning — what you initially thought, whether context resolves it, and what specifically remains problematic
- "type": "technical" or "logical"
`,

  referenceMatchCriteria: `A citation is a MISMATCH when, compared to the database record for the same work:
1. The publication year is off by more than one year
2. The author list is wrong: a different first author, invented co-authors, or most authors missing
3. The venue is a different journal or conference entirely (not just an abbreviation or renaming)
4. The title differs materially in meaning (not just formatting or subtitle truncation)`,

  referenceLeniency: `Be lenient with:
- arXiv preprint vs. published version: venue differences and a one-year gap are normal
- "et al." truncation of long author lists
- Abbreviated or renamed venues (e.g. "NeurIPS" vs "Advances in Neural Information Processing Systems")
- Formatting, capitalization, diacritics, and LaTeX or OCR artifacts`,
};

/** Kept out of PromptBlocks on purpose: these lines are structural. */
const DO_NOT_FLAG_CHUNKED_EXTRA = `- Incomplete text at passage boundaries`;
const DO_NOT_FLAG_PROGRESSIVE_EXTRA = `- Notation not yet in the summary — it may be introduced later`;

const JSON_OBJECT_OUTPUT = (feedbackDesc: string, emptyNote: string) => `Return a JSON object with this structure:
{
  "overall_feedback": "${feedbackDesc}",
  "comments": [
    {
      "title": "short descriptive title of the issue",
      "quote": "the exact verbatim text from the paper containing the issue (copy it exactly, preserving LaTeX)",
      "explanation": "deep reasoning — what you initially thought, whether context resolves it, and what specifically remains problematic",
      "type": "technical" or "logical"
    }
  ]
}

Return ONLY the JSON object${emptyNote}. No other text.`;

/* ------------------------------------------------------------------ */
/* Template composition + interpolation                                */
/* ------------------------------------------------------------------ */

/**
 * Single-pass `{placeholder}` interpolation. Unknown placeholders are left
 * untouched; inserted values are never re-scanned (LaTeX braces are safe).
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? vars[name] : match,
  );
}

/** Compose the default templates from (possibly overridden) blocks. */
function composeTemplates(b: Required<PromptBlocks>): Required<PromptTemplates> {
  const deepCheckBody = (doNotFlag: string) => `${b.reviewerPreamble}

{ocrCaveat}
FULL PAPER CONTEXT (relevant sections):
{context}

---

PASSAGE TO CHECK:
{passage}

---

${b.checkCriteria}

${b.explanationStyle}

${b.leniencyRules}

${doNotFlag}

${b.jsonArrayOutput}`;

  return {
    deepCheck: deepCheckBody(`${b.doNotFlag}\n${DO_NOT_FLAG_CHUNKED_EXTRA}`),

    deepCheckProgressive: deepCheckBody(
      `${b.doNotFlag}\n${DO_NOT_FLAG_CHUNKED_EXTRA}\n${DO_NOT_FLAG_PROGRESSIVE_EXTRA}`,
    ),

    zeroShot: `You are a thoughtful reviewer reading the following academic paper. \
Today's date is {currentDate}. \
Engage deeply with the material. For each potential issue, first try to understand the authors' \
intent and check whether your concern is resolved by context before flagging it.

Carefully ${b.checkCriteria.charAt(0).toLowerCase()}${b.checkCriteria.slice(1)}

${b.explanationStyle}

${b.leniencyRules}

${b.doNotFlag}

${JSON_OBJECT_OUTPUT("One paragraph high-level assessment of the paper's quality and main issues", "")}

{ocrCaveat}
---

PAPER:

{paperText}
`,

    largePaperChunk: `You are a thoughtful reviewer checking a section of an academic paper. \
Today's date is {currentDate}. \
Engage deeply with the material. For each potential issue, first try to understand the authors' \
intent and check whether your concern is resolved by context before flagging it.

Carefully ${b.checkCriteria.charAt(0).toLowerCase()}${b.checkCriteria.slice(1)}

${b.explanationStyle}

${b.leniencyRules}

${b.doNotFlag}
${DO_NOT_FLAG_CHUNKED_EXTRA}

${JSON_OBJECT_OUTPUT("brief assessment of this section", " (comments can be [] if no issues found)")}

{ocrCaveat}
---

SECTION {chunkNum} of {totalChunks}:

{chunkText}
`,

    summaryUpdate: `You are maintaining a concise running summary of an academic paper's key technical content. \
This summary will be used as context when reviewing later sections of the paper.

CURRENT SUMMARY:
{currentSummary}

---

NEW PASSAGE (section {passageIdx} of {totalPassages}):
{passageText}

---

Update the summary to incorporate any NEW information from this passage. \
Keep the summary structured and concise. Include:

1. **Notation & Definitions**: Any new symbols, variables, or terms defined
2. **Key Equations**: Important equations or formulas introduced (write them out, preserving LaTeX)
3. **Theorems & Propositions**: Statements of theorems, lemmas, corollaries (brief statement, not proof)
4. **Assumptions**: Any stated assumptions or conditions
5. **Key Claims**: Important results or conclusions established

Rules:
- PRESERVE all existing summary content unless it is superseded by new information
- ADD new items from the passage
- Do NOT include commentary, proof details, or experimental results
- Do NOT include information not in the passage or existing summary
- Keep entries brief — one line per item where possible
- If the passage contains no new definitions, equations, or key claims, return the summary unchanged

Return the updated summary directly (no JSON, no code fences).`,

    technicalFilter: `Does this passage from an academic paper contain technical content worth checking for errors? \
Technical content includes: equations, proofs, derivations, theorems, algorithms, \
specific quantitative claims, or formal definitions.

Non-technical content includes: introductions, related work surveys, acknowledgments, \
reference lists, author bios, general motivation, or high-level overviews without formal claims.

PASSAGE:
{passage}

Answer with ONLY "yes" or "no".`,

    consolidation: `You are reviewing the complete list of issues found in an academic paper. \
Your job is to consolidate this list: remove duplicates and merge closely related issues.

Remove issues that:
- Flag the same underlying problem as another issue (keep the better-explained one)
- Flag standard conventions, notational shorthands, or well-known results

ISSUES FOUND:
{issuesJson}

Return a JSON array containing the consolidated issues (same format as input). \
Return [] if none survive filtering.`,

    overallFeedback: `You are an expert academic reviewer. Based on the beginning of the paper below, \
write one paragraph of high-level feedback on the paper's quality, clarity, \
and most significant issues.

PAPER (first 8000 characters):
{paperStart}
`,

    referenceExtraction: `You are extracting bibliography entries from an academic paper's references section.
{ocrCaveat}
REFERENCES SECTION:
{referencesText}

---

Extract EVERY entry. Copy each field exactly as written — do not invent, correct, or complete anything.

Return ONLY a JSON array. Each item:
- "label": the entry's printed label (e.g. "12" from "[12]", or "Smith2020"), or null
- "raw": the complete verbatim text of the entry
- "title": the cited work's title, or null
- "authors": array of author names as written (e.g. ["J. Smith", "A. Doe"])
- "year": publication year as a number, or null
- "venue": journal, conference, or publisher, or null
- "doi": the DOI if printed (e.g. "10.1234/abc"), or null
- "arxiv_id": the arXiv identifier if printed (e.g. "2301.12345"), or null
- "kind": "paper" | "book" | "web" | "thesis" | "software" | "other"`,

    referenceVerdict: `You are verifying one bibliography entry from an academic paper against records \
retrieved from real bibliographic databases. The records below are ground truth.

ENTRY AS CITED IN THE PAPER:
{referenceJson}

DATABASE RECORDS RETRIEVED:
{candidatesJson}

---

${b.referenceMatchCriteria}

${b.referenceLeniency}

Compare the entry ONLY against the records above — do not rely on your own knowledge of the literature.

Return ONLY a JSON object:
{"verdict": "verified" | "mismatch" | "not_found", "explanation": "one or two sentences citing the specific record and field(s)"}

- "verified": one record is clearly the cited work and the citation's metadata agrees with it
- "mismatch": one record is clearly the cited work, but the citation's metadata is wrong — name the exact field(s) and correct value(s)
- "not_found": none of the records are the cited work`,
  };
}

/**
 * Resolve the effective prompt templates: defaults, recomposed from any
 * overridden blocks, with whole-template overrides applied on top.
 */
export function resolvePromptTemplates(overrides?: PromptOverrides): Required<PromptTemplates> {
  const blocks = { ...DEFAULT_PROMPT_BLOCKS, ...overrides?.blocks };
  const composed = composeTemplates(blocks);
  if (!overrides?.templates) return composed;
  const templates = Object.fromEntries(
    Object.entries(overrides.templates).filter(([, v]) => typeof v === "string"),
  );
  return { ...composed, ...templates };
}

/** The default templates with their placeholders — export for discoverability. */
export function defaultPromptTemplates(): Required<PromptTemplates> {
  return composeTemplates(DEFAULT_PROMPT_BLOCKS);
}

function resolveOcrCaveat(ocr: boolean | undefined, overrides?: PromptOverrides): string {
  if (!ocr) return "";
  return overrides?.blocks?.ocrCaveat ?? DEFAULT_PROMPT_BLOCKS.ocrCaveat;
}

/* ------------------------------------------------------------------ */
/* Prompt builders (used by the review methods)                        */
/* ------------------------------------------------------------------ */

export function deepCheckPrompt(args: {
  context: string;
  passage: string;
  currentDate: string;
  ocr?: boolean;
  progressive?: boolean;
  overrides?: PromptOverrides;
}): string {
  const t = resolvePromptTemplates(args.overrides);
  return interpolate(args.progressive ? t.deepCheckProgressive : t.deepCheck, {
    context: args.context,
    passage: args.passage,
    currentDate: args.currentDate,
    ocrCaveat: resolveOcrCaveat(args.ocr, args.overrides),
  });
}

export function zeroShotPrompt(args: {
  paperText: string;
  currentDate: string;
  ocr?: boolean;
  overrides?: PromptOverrides;
}): string {
  const t = resolvePromptTemplates(args.overrides);
  return interpolate(t.zeroShot, {
    paperText: args.paperText,
    currentDate: args.currentDate,
    ocrCaveat: resolveOcrCaveat(args.ocr, args.overrides),
  });
}

export function largePaperChunkPrompt(args: {
  chunkNum: number;
  totalChunks: number;
  chunkText: string;
  currentDate: string;
  ocr?: boolean;
  overrides?: PromptOverrides;
}): string {
  const t = resolvePromptTemplates(args.overrides);
  return interpolate(t.largePaperChunk, {
    chunkNum: String(args.chunkNum),
    totalChunks: String(args.totalChunks),
    chunkText: args.chunkText,
    currentDate: args.currentDate,
    ocrCaveat: resolveOcrCaveat(args.ocr, args.overrides),
  });
}

export function summaryUpdatePrompt(args: {
  currentSummary: string;
  passageText: string;
  passageIdx: number;
  totalPassages: number;
  overrides?: PromptOverrides;
}): string {
  const t = resolvePromptTemplates(args.overrides);
  return interpolate(t.summaryUpdate, {
    currentSummary: args.currentSummary,
    passageText: args.passageText,
    passageIdx: String(args.passageIdx),
    totalPassages: String(args.totalPassages),
  });
}

export function technicalFilterPrompt(passage: string, overrides?: PromptOverrides): string {
  const t = resolvePromptTemplates(overrides);
  return interpolate(t.technicalFilter, { passage });
}

export function consolidationPrompt(issuesJson: string, overrides?: PromptOverrides): string {
  const t = resolvePromptTemplates(overrides);
  return interpolate(t.consolidation, { issuesJson });
}

export function overallFeedbackPrompt(paperStart: string, overrides?: PromptOverrides): string {
  const t = resolvePromptTemplates(overrides);
  return interpolate(t.overallFeedback, { paperStart });
}

export function referenceExtractionPrompt(args: {
  referencesText: string;
  ocr?: boolean;
  overrides?: PromptOverrides;
}): string {
  const t = resolvePromptTemplates(args.overrides);
  return interpolate(t.referenceExtraction, {
    referencesText: args.referencesText,
    ocrCaveat: resolveOcrCaveat(args.ocr, args.overrides),
  });
}

export function referenceVerdictPrompt(args: {
  referenceJson: string;
  candidatesJson: string;
  overrides?: PromptOverrides;
}): string {
  const t = resolvePromptTemplates(args.overrides);
  return interpolate(t.referenceVerdict, {
    referenceJson: args.referenceJson,
    candidatesJson: args.candidatesJson,
  });
}

/* ------------------------------------------------------------------ */
/* Override validation                                                 */
/* ------------------------------------------------------------------ */

/** Placeholders a custom template must contain for the pipeline to work. */
const REQUIRED_PLACEHOLDERS: Record<keyof Required<PromptTemplates>, string[]> = {
  deepCheck: ["context", "passage"],
  deepCheckProgressive: ["context", "passage"],
  zeroShot: ["paperText"],
  largePaperChunk: ["chunkText"],
  summaryUpdate: ["currentSummary", "passageText"],
  technicalFilter: ["passage"],
  consolidation: ["issuesJson"],
  overallFeedback: ["paperStart"],
  referenceExtraction: ["referencesText"],
  referenceVerdict: ["referenceJson", "candidatesJson"],
};

/**
 * Validate prompt overrides: unknown template names and custom templates
 * missing a required placeholder (the model would silently receive a prompt
 * without its input data). Returns human-readable warnings; empty = OK.
 */
export function validatePromptOverrides(overrides?: PromptOverrides): string[] {
  const warnings: string[] = [];
  for (const [name, template] of Object.entries(overrides?.templates ?? {})) {
    if (typeof template !== "string") continue;
    const required = REQUIRED_PLACEHOLDERS[name as keyof PromptTemplates];
    if (!required) {
      warnings.push(
        `unknown prompt template '${name}' — known templates: ${Object.keys(REQUIRED_PLACEHOLDERS).join(", ")}`,
      );
      continue;
    }
    for (const ph of required) {
      if (!template.includes(`{${ph}}`)) {
        warnings.push(`prompt template '${name}' is missing required placeholder {${ph}}`);
      }
    }
  }
  return warnings;
}

const warnedOverrides = new WeakSet<object>();

/** console.warn each validation warning, once per overrides object. */
export function warnPromptOverrides(overrides?: PromptOverrides): void {
  if (!overrides || warnedOverrides.has(overrides)) return;
  warnedOverrides.add(overrides);
  for (const warning of validatePromptOverrides(overrides)) {
    console.warn(`reviewer2: ${warning}`);
  }
}

/** Default OCR caveat text (kept as a named export for convenience). */
export const OCR_CAVEAT = DEFAULT_PROMPT_BLOCKS.ocrCaveat;
