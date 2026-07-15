/** PDF text extraction via unpdf (pdf.js) — pure JS, serverless-safe. */

import { extractTitleFromMarkdown } from "./title.js";

export type PdfEngine = "unpdf";

export interface ParsePdfOptions {
  /** Only process the first N pages (limits input size and cost). */
  maxPages?: number;
  signal?: AbortSignal;
}

export interface ParsedPdf {
  title: string;
  text: string;
  engine: PdfEngine;
  pages: number;
}

/** Write a new PDF containing only the first maxPages pages. */
async function truncatePdfPages(buffer: Uint8Array, maxPages: number): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  if (src.getPageCount() <= maxPages) return buffer;
  const out = await PDFDocument.create();
  const pages = await out.copyPages(
    src,
    Array.from({ length: maxPages }, (_, i) => i),
  );
  for (const p of pages) out.addPage(p);
  return out.save();
}

/**
 * Reflow one page of raw pdf.js line-broken text into paragraphs.
 *
 * pdf.js emits one line per text row with no paragraph structure. We join
 * lines (dehyphenating soft line-break hyphens) and insert paragraph breaks
 * where a line ends noticeably short of the page's typical line width —
 * the classic last-line-of-paragraph signal — or ends a sentence right
 * before a line that starts a new one. Over-splitting is harmless: the
 * reviewer's paragraph splitter merges fragments under 100 chars forward.
 */
export function reflowPdfPage(pageText: string): string {
  const lines = pageText.split("\n").map((l) => l.trim());
  const widths = lines.filter((l) => l.length > 30).map((l) => l.length);
  widths.sort((a, b) => a - b);
  const median = widths.length ? widths[Math.floor(widths.length / 2)] : 80;

  const paras: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) paras.push(cur.trim());
    cur = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      flush();
      continue;
    }
    if (cur.endsWith("-") && /^[a-z]/.test(line)) {
      cur = cur.slice(0, -1) + line; // rejoin hyphenated word split across lines
    } else {
      cur = cur ? `${cur} ${line}` : line;
    }

    const next = lines[i + 1] ?? "";
    const shortLine = line.length < 0.7 * median;
    const sentenceEnd = /[.?!:]["')\]]?$/.test(line);
    const nextStartsNew = !next || /^[A-Z0-9"'([]/.test(next);
    if (shortLine && (sentenceEnd || nextStartsNew)) {
      flush();
    } else if (sentenceEnd && nextStartsNew && line.length < 0.9 * median) {
      flush();
    }
  }
  flush();
  return paras.join("\n\n");
}

/**
 * Extract text from a PDF buffer using unpdf (pdf.js).
 *
 * Note: math notation is not preserved (pdf.js limitation). For math-heavy
 * papers, prefer LaTeX source, markdown, or arXiv HTML input — or run your
 * own OCR and pass the extracted text/markdown to the reviewer directly.
 */
export async function parsePdf(
  buffer: Uint8Array,
  options: ParsePdfOptions = {},
): Promise<ParsedPdf> {
  let pdfBytes = buffer;
  if (options.maxPages) {
    pdfBytes = await truncatePdfPages(buffer, options.maxPages);
  }

  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(pdfBytes));
  // mergePages strips ALL newlines — extract per page and reflow instead
  const { totalPages, text } = await extractText(doc, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text])
    .map(reflowPdfPage)
    .filter((p) => p.trim().length > 0);
  const merged = pages.join("\n\n").trim();
  if (!merged) {
    throw new Error("unpdf returned no text (scanned/image-only PDF?)");
  }
  return {
    title: extractTitleFromMarkdown(merged),
    text: merged,
    engine: "unpdf",
    pages: totalPages,
  };
}
