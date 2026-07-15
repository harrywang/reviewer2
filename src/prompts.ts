/** All review prompts in one place (port of prompts.py). */

/* ── Shared building blocks ─────────────────────────────────────────────── */

const REVIEWER_PREAMBLE = (currentDate: string) =>
  `You are a thoughtful reviewer checking a passage from an academic paper. ` +
  `Today's date is ${currentDate}. ` +
  `Engage deeply with the material. For each potential issue, first try to understand the authors' ` +
  `intent and check whether your concern is resolved by context before flagging it.`;

const CHECK_CRITERIA = `Check for:
1. Mathematical / formula errors: wrong formulas, sign errors, missing factors, incorrect derivations, subscript or index errors
2. Notation inconsistencies: symbols used in a way that contradicts their earlier definition
3. Inconsistency between text and formal definitions: prose says one thing but the equation says another
4. Parameter / numerical inconsistencies: stated values contradict what can be derived from definitions or tables elsewhere
5. Insufficient justification: a key derivation step is skipped where the result is non-trivial
6. Questionable claims: statements that overstate what has actually been shown
7. Ambiguity that could mislead: flag only if a careful reader could reasonably reach an incorrect conclusion
8. Underspecified methods: an algorithm, procedure, or modification is described too vaguely for a reader to reproduce — key choices, boundary conditions, or parameter settings are left implicit`;

const EXPLANATION_STYLE = `For each issue, write like a careful reader thinking aloud. Describe what initially confused or \
concerned you, what you checked to resolve it, and what specifically remains problematic. \
Acknowledge what the authors got right before noting the issue. Reference standard results \
or conventions in the field when relevant.`;

const LENIENCY_RULES = `Be lenient with:
- Introductory and overview sections, which intentionally simplify or gloss over details
- Forward references — symbols or claims that may be defined or justified later in the paper
- Informal prose that paraphrases a formal result without repeating every qualifier`;

export const OCR_CAVEAT = `NOTE: This text was extracted from a PDF via OCR. While automatic corrections \
have been applied, some notation errors may remain. If you spot a symbol that \
appears inconsistent with surrounding usage (e.g. a variable that appears once \
with a different letter than everywhere else), consider whether it is an OCR \
misread rather than an author error. Flag it only if it would be a real issue \
even assuming the most plausible intended symbol.`;

const DO_NOT_FLAG_BASE = `Do NOT flag:
- Formatting, typesetting, or capitalization issues
- References to equations or sections not shown in the context (they exist elsewhere)
- Trivial observations that any reader in the field would immediately resolve`;

const DO_NOT_FLAG_CHUNKED = `${DO_NOT_FLAG_BASE}
- Incomplete text at passage boundaries`;

const DO_NOT_FLAG_PROGRESSIVE = `${DO_NOT_FLAG_CHUNKED}
- Notation not yet in the summary — it may be introduced later`;

const JSON_ARRAY_OUTPUT = `Return ONLY a JSON array (can be []). Each item:
- "title": concise title of the issue
- "quote": the exact verbatim text (preserving LaTeX)
- "explanation": deep reasoning — what you initially thought, whether context resolves it, and what specifically remains problematic
- "type": "technical" or "logical"
`;

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

/* ── Deep-check prompts (local and progressive methods) ─────────────────── */

export function deepCheckPrompt(args: {
  context: string;
  passage: string;
  currentDate: string;
  ocrCaveat: string;
  progressive?: boolean;
}): string {
  const doNotFlag = args.progressive ? DO_NOT_FLAG_PROGRESSIVE : DO_NOT_FLAG_CHUNKED;
  return `${REVIEWER_PREAMBLE(args.currentDate)}

${args.ocrCaveat}
FULL PAPER CONTEXT (relevant sections):
${args.context}

---

PASSAGE TO CHECK:
${args.passage}

---

${CHECK_CRITERIA}

${EXPLANATION_STYLE}

${LENIENCY_RULES}

${doNotFlag}

${JSON_ARRAY_OUTPUT}`;
}

/* ── Zero-shot prompts ──────────────────────────────────────────────────── */

export function zeroShotPrompt(args: {
  paperText: string;
  currentDate: string;
  ocrCaveat: string;
}): string {
  return `You are a thoughtful reviewer reading the following academic paper. \
Today's date is ${args.currentDate}. \
Engage deeply with the material. For each potential issue, first try to understand the authors' \
intent and check whether your concern is resolved by context before flagging it.

Carefully ${CHECK_CRITERIA.charAt(0).toLowerCase()}${CHECK_CRITERIA.slice(1)}

${EXPLANATION_STYLE}

${LENIENCY_RULES}

${DO_NOT_FLAG_BASE}

${JSON_OBJECT_OUTPUT("One paragraph high-level assessment of the paper's quality and main issues", "")}

${args.ocrCaveat}
---

PAPER:

${args.paperText}
`;
}

export function largePaperChunkPrompt(args: {
  chunkNum: number;
  totalChunks: number;
  chunkText: string;
  currentDate: string;
  ocrCaveat: string;
}): string {
  return `You are a thoughtful reviewer checking a section of an academic paper. \
Today's date is ${args.currentDate}. \
Engage deeply with the material. For each potential issue, first try to understand the authors' \
intent and check whether your concern is resolved by context before flagging it.

Carefully ${CHECK_CRITERIA.charAt(0).toLowerCase()}${CHECK_CRITERIA.slice(1)}

${EXPLANATION_STYLE}

${LENIENCY_RULES}

${DO_NOT_FLAG_CHUNKED}

${JSON_OBJECT_OUTPUT("brief assessment of this section", " (comments can be [] if no issues found)")}

${args.ocrCaveat}
---

SECTION ${args.chunkNum} of ${args.totalChunks}:

${args.chunkText}
`;
}

/* ── Progressive-only prompts ───────────────────────────────────────────── */

export function summaryUpdatePrompt(args: {
  currentSummary: string;
  passageText: string;
  passageIdx: number;
  totalPassages: number;
}): string {
  return `You are maintaining a concise running summary of an academic paper's key technical content. \
This summary will be used as context when reviewing later sections of the paper.

CURRENT SUMMARY:
${args.currentSummary}

---

NEW PASSAGE (section ${args.passageIdx} of ${args.totalPassages}):
${args.passageText}

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

Return the updated summary directly (no JSON, no code fences).`;
}

export function technicalFilterPrompt(passage: string): string {
  return `Does this passage from an academic paper contain technical content worth checking for errors? \
Technical content includes: equations, proofs, derivations, theorems, algorithms, \
specific quantitative claims, or formal definitions.

Non-technical content includes: introductions, related work surveys, acknowledgments, \
reference lists, author bios, general motivation, or high-level overviews without formal claims.

PASSAGE:
${passage}

Answer with ONLY "yes" or "no".`;
}

export function consolidationPrompt(issuesJson: string): string {
  return `You are reviewing the complete list of issues found in an academic paper. \
Your job is to consolidate this list: remove duplicates and merge closely related issues.

Remove issues that:
- Flag the same underlying problem as another issue (keep the better-explained one)
- Flag standard conventions, notational shorthands, or well-known results

ISSUES FOUND:
${issuesJson}

Return a JSON array containing the consolidated issues (same format as input). \
Return [] if none survive filtering.`;
}

/* ── Overall feedback (shared by local and progressive) ─────────────────── */

export function overallFeedbackPrompt(paperStart: string): string {
  return `You are an expert academic reviewer. Based on the beginning of the paper below, \
write one paragraph of high-level feedback on the paper's quality, clarity, \
and most significant issues.

PAPER (first 8000 characters):
${paperStart}
`;
}
