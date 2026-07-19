# Document parsing

Getting paper text out of PDFs, DOCX, LaTeX, markdown, and URLs.
Back to the [README](../README.md).

```ts
import { parseDocumentBuffer } from "reviewer2";

const parsed = await parseDocumentBuffer(pdfBytes, "pdf", {
  maxPages: 30, // optional input-size cap
});
// parsed = { title, text, wasOcr, ocrEngine, ocrCorrections }
```

- **PDF** — pure-JS `unpdf` (pdf.js) with paragraph reflow and dehyphenation;
  OCR notation auto-correction is applied. Math symbols are not preserved —
  for math-heavy papers prefer LaTeX source, markdown, or arXiv HTML, or run
  your own OCR and feed the extracted text to `reviewPaper` directly.
- **DOCX** (mammoth), **LaTeX**, **TXT/MD** (frontmatter-aware).
- **arXiv** — `parseDocument("https://arxiv.org/abs/2310.06825")` parses the
  HTML version and falls back to the PDF.
- **Any file URL** — `parseDocument("https://…/paper.pdf?X-Amz-Signature=…")`
  fetches and routes by path extension or `Content-Type` (presigned S3/GCS
  links work; extension-less PDF URLs are detected via `Content-Type`).

Pass `ocr: parsed.wasOcr` to `reviewPaper` so prompts include the OCR caveat.
