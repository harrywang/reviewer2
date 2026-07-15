/** Document parsers for PDF, DOCX, TeX, TXT/MD buffers and arXiv URLs. */

import { parseArxivHtml, parseArxivHtmlString } from "./arxiv.js";
import { fixOcrNotation, type OcrCorrection } from "./ocrPostprocess.js";
import { parsePdf, type ParsePdfOptions, type PdfEngine } from "./pdf.js";

export { parseArxivHtml, parseArxivHtmlString } from "./arxiv.js";
export { fixOcrNotation } from "./ocrPostprocess.js";
export { parsePdf, reflowPdfPage } from "./pdf.js";
export type { OcrCorrection, ParsePdfOptions, PdfEngine };

export type DocumentFormat = "pdf" | "docx" | "tex" | "txt" | "md";

export interface ParsedDocument {
  title: string;
  text: string;
  /** True if the text went through OCR (PDF parsing) — enables prompt caveats. */
  wasOcr: boolean;
  ocrEngine?: PdfEngine;
  ocrCorrections?: OcrCorrection[];
}

export interface ParseOptions extends ParsePdfOptions {}

export function isUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

/**
 * Parse a document from an in-memory buffer (the primary API for web apps —
 * e.g. a PDF downloaded from S3).
 */
export async function parseDocumentBuffer(
  buffer: Uint8Array,
  format: DocumentFormat,
  options: ParseOptions = {},
): Promise<ParsedDocument> {
  switch (format) {
    case "pdf": {
      const parsed = await parsePdf(buffer, options);
      const { text, corrections } = fixOcrNotation(parsed.text);
      return {
        title: parsed.title,
        text,
        wasOcr: true,
        ocrEngine: parsed.engine,
        ocrCorrections: corrections,
      };
    }
    case "docx": {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.extractRawText({
        buffer: Buffer.from(buffer),
      });
      const paragraphs = value
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean);
      const text = paragraphs.join("\n\n");
      const title = paragraphs[0]?.slice(0, 200) ?? "";
      return { title, text, wasOcr: false };
    }
    case "tex": {
      const raw = new TextDecoder("utf-8").decode(buffer);
      return { ...parseTex(raw), wasOcr: false };
    }
    case "txt":
    case "md": {
      const raw = new TextDecoder("utf-8").decode(buffer);
      return parseTextContent(raw);
    }
    default:
      throw new Error(`Unsupported document format: ${format satisfies never}`);
  }
}

/** Extract title and text from LaTeX source. */
export function parseTex(raw: string): { title: string; text: string } {
  let title = "";
  const titleMatch = raw.match(/\\title\{([^}]+)\}/);
  if (titleMatch) {
    title = titleMatch[1]
      .trim()
      .replace(/\\\\/g, " ")
      .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, "$1")
      .replace(/[{}]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (!title) {
    for (const line of raw.split("\n")) {
      if (line.trim()) {
        title = line.trim().slice(0, 200);
        break;
      }
    }
  }
  return { title, text: raw };
}

/**
 * Parse plain text / markdown, detecting YAML frontmatter with an
 * `ocr_engine` field (produced by a prior extract step).
 */
export function parseTextContent(raw: string): ParsedDocument {
  let wasOcr = false;
  let title = "";
  let text = raw;

  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---\n", 4);
    if (end !== -1) {
      const frontmatter = raw.slice(4, end);
      text = raw.slice(end + 5);
      for (const line of frontmatter.split("\n")) {
        if (line.startsWith("title:")) {
          title = line.slice("title:".length).trim().replace(/^"|"$/g, "");
        }
        if (line.startsWith("ocr_engine:")) {
          wasOcr = true;
        }
      }
    }
  }

  if (!title) {
    for (const line of text.split("\n")) {
      const stripped = line.trim();
      if (!stripped) continue;
      title = stripped.startsWith("#")
        ? stripped.replace(/^#+\s*/, "").trim()
        : stripped.slice(0, 200);
      break;
    }
  }

  return { title, text, wasOcr };
}

const FORMAT_BY_EXTENSION: Record<string, DocumentFormat> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".tex": "tex",
  ".txt": "txt",
  ".md": "md",
  ".markdown": "md",
};

const FORMAT_BY_CONTENT_TYPE: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/x-tex": "tex",
  "text/x-tex": "tex",
  "text/markdown": "md",
  "text/plain": "txt",
};

function formatFromExtension(path: string): DocumentFormat | undefined {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  return FORMAT_BY_EXTENSION[path.slice(dot).toLowerCase()];
}

/**
 * Detect a document format from a URL (path extension, query stripped —
 * works for presigned S3/GCS links) and/or an HTTP Content-Type header.
 * Returns undefined for HTML and unknown types.
 */
export function detectFormat(url: string, contentType?: string | null): DocumentFormat | undefined {
  try {
    const pathname = new URL(url).pathname;
    const byExt = formatFromExtension(pathname);
    if (byExt) return byExt;
  } catch {
    // not a valid URL — ignore
  }
  if (contentType) {
    const mime = contentType.split(";")[0].trim().toLowerCase();
    return FORMAT_BY_CONTENT_TYPE[mime];
  }
  return undefined;
}

/**
 * Parse a document from a local file path or URL (Node convenience wrapper).
 *
 * URLs:
 * - arXiv /abs/ URLs try the HTML version first, then fall back to the PDF.
 * - arXiv /html/ (and other HTML pages) go through the LaTeXML HTML parser.
 * - Any other file URL (e.g. a presigned S3 link to a PDF/DOCX/MD file) is
 *   fetched and routed by path extension or Content-Type.
 */
export async function parseDocument(
  source: string,
  options: ParseOptions = {},
): Promise<ParsedDocument> {
  if (isUrl(source)) {
    if (source.includes("arxiv.org/abs/")) {
      const htmlUrl = source.replace("arxiv.org/abs/", "arxiv.org/html/");
      try {
        const { title, text } = await parseArxivHtml(htmlUrl, options);
        return { title, text, wasOcr: false };
      } catch {
        // HTML version not available — fall back to the PDF
        return fetchAndParseUrl(source.replace("arxiv.org/abs/", "arxiv.org/pdf/"), options, "pdf");
      }
    }

    // Fast path: format evident from the URL path (presigned S3 links etc.)
    const byExt = detectFormat(source);
    if (byExt) {
      return fetchAndParseUrl(source, options, byExt);
    }

    // Otherwise fetch and decide by Content-Type; HTML goes to the arXiv/
    // LaTeXML parser (which has a plain-text fallback).
    return fetchAndParseUrl(source, options);
  }

  const { readFile } = await import("node:fs/promises");
  const format = formatFromExtension(source.toLowerCase());
  if (!format) {
    throw new Error(`Unsupported file format: ${source}`);
  }
  const buffer = await readFile(source);
  return parseDocumentBuffer(new Uint8Array(buffer), format, options);
}

/** Fetch a URL and parse the body, routing by known format or Content-Type. */
async function fetchAndParseUrl(
  url: string,
  options: ParseOptions,
  knownFormat?: DocumentFormat,
): Promise<ParsedDocument> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "reviewer2/0.1" },
    signal: options.signal,
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
  }

  const contentType = resp.headers.get("content-type");
  const format = knownFormat ?? detectFormat(url, contentType);
  if (format) {
    const buffer = new Uint8Array(await resp.arrayBuffer());
    return parseDocumentBuffer(buffer, format, options);
  }

  // HTML (or unknown): try the LaTeXML/arXiv HTML parser, which falls back
  // to plain-text extraction for non-LaTeXML pages.
  const mime = contentType?.split(";")[0].trim().toLowerCase();
  if (!mime || mime === "text/html" || mime === "application/xhtml+xml") {
    const { title, text } = parseArxivHtmlString(await resp.text());
    return { title, text, wasOcr: false };
  }

  throw new Error(`Unsupported Content-Type '${contentType}' for URL: ${url}`);
}
