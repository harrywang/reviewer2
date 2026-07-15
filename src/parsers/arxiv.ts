/** arXiv HTML parsing (LaTeXML ltx_* markup) via cheerio. */

import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

function classList(el: Element): string[] {
  const cls = el.attribs?.class;
  return cls ? cls.split(/\s+/).filter(Boolean) : [];
}

function hasExactClass(el: Element, ...targets: string[]): boolean {
  const classes = classList(el);
  return targets.some((t) => classes.includes(t));
}

function textOf($: cheerio.CheerioAPI, node: AnyNode): string {
  return $(node).text().replace(/\s+/g, " ").trim();
}

/** Convert an ltx_tabular element to a markdown table. */
function tabularToMarkdown($: cheerio.CheerioAPI, tableEl: AnyNode): string {
  const rows: string[][] = [];
  $(tableEl)
    .find("tr")
    .each((_, tr) => {
      const cells: string[] = [];
      $(tr)
        .find("td, th")
        .each((__, cell) => {
          cells.push(textOf($, cell).replaceAll("|", "\\|").replaceAll("\n", " "));
        });
      if (cells.length) rows.push(cells);
    });

  if (!rows.length) return "";

  const ncols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(ncols - r.length).fill("")];

  const lines = [
    `| ${pad(rows[0]).join(" | ")} |`,
    `| ${Array(ncols).fill("---").join(" | ")} |`,
  ];
  for (const row of rows.slice(1)) {
    lines.push(`| ${pad(row).slice(0, ncols).join(" | ")} |`);
  }
  return lines.join("\n");
}

/** Convert an ltx_figure or ltx_table element to markdown text. */
function figureOrTableToMarkdown($: cheerio.CheerioAPI, figEl: Element): string {
  const captionEl = $(figEl).find(".ltx_caption").first();
  const caption = captionEl.length ? textOf($, captionEl[0]).replaceAll("\n", " ") : "";

  const tabular = $(figEl).find(".ltx_tabular").first();
  if (tabular.length) {
    const tableMd = tabularToMarkdown($, tabular[0]);
    if (!tableMd) return caption ? `**${caption}**` : "";
    return caption ? `**${caption}**\n\n${tableMd}` : tableMd;
  }

  // Image figure: keep the caption text only
  const imgs = $(figEl)
    .find("img.ltx_graphics")
    .filter((_, img) => {
      const width = parseInt(img.attribs?.width || "100", 10) || 100;
      return width >= 30;
    });
  if (!imgs.length) return caption ? `**${caption}**` : "";
  return caption ? `*${caption}*` : "";
}

/**
 * Fetch and parse an arXiv HTML page into { title, text }.
 * Works with URLs like https://arxiv.org/html/2310.06825.
 */
export async function parseArxivHtml(
  url: string,
  init?: { signal?: AbortSignal },
): Promise<{ title: string; text: string }> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "reviewer2/0.1" },
    signal: init?.signal,
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
  }
  const html = await resp.text();
  return parseArxivHtmlString(html);
}

/** Parse already-fetched arXiv/LaTeXML HTML. */
export function parseArxivHtmlString(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);

  let title = "";
  const titleEl = $(".ltx_title_document").first();
  if (titleEl.length) title = titleEl.text().trim().replace(/\s+/g, " ");
  if (!title) title = $("title").first().text().trim();

  // Main document body
  let doc = $(".ltx_document").first();
  if (!doc.length) doc = $("article").first();
  if (!doc.length) doc = $("body").first();
  if (!doc.length) throw new Error("Could not find paper content in HTML");

  // Remove bibliography, navigation, and other non-content elements
  for (const sel of [
    "nav",
    ".ltx_bibliography",
    ".ltx_TOC",
    "header",
    "footer",
    ".package-hierarchical-accordion",
    "#header",
    ".arxiv-watermark",
    ".ltx_role_affiliationtext",
  ]) {
    doc.find(sel).remove();
  }

  // Pre-process figures/tables: convert to markdown, replace with ltx_para
  // marker divs so they appear at the correct position in the flow.
  let insertedMarkers = false;
  doc.find("*").each((_, el) => {
    if (el.type !== "tag") return;
    if (!hasExactClass(el, "ltx_figure", "ltx_table")) return;
    // Skip if nested inside another figure/table we'll process
    const md = figureOrTableToMarkdown($, el);
    if (md) {
      const marker = `<div class="ltx_para" data-oar-content="${md
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")}"></div>`;
      $(el).replaceWith(marker);
      insertedMarkers = true;
    } else {
      $(el).remove();
    }
  });

  // Extract structured text using leaf content elements only.
  const sections: string[] = [];
  const contentPattern = /^ltx_(para$|title_|abstract$|theorem$|proof$)/;
  doc.find("*").each((_, el) => {
    if (el.type !== "tag") return;
    const classes = classList(el);
    if (!classes.some((c) => contentPattern.test(c))) return;

    // Figure/table markers: use pre-computed markdown directly
    const oarContent = el.attribs?.["data-oar-content"];
    if (oarContent !== undefined) {
      sections.push(oarContent);
      return;
    }

    const text = textOf($, el);
    if (!text) return;

    const clsStr = classes.join(" ");
    if (clsStr.includes("ltx_title_document")) {
      sections.push(`# ${text}`);
    } else if (clsStr.includes("ltx_title_section")) {
      sections.push(`\n## ${text}`);
    } else if (clsStr.includes("ltx_title_subsection")) {
      sections.push(`\n### ${text}`);
    } else if (clsStr.includes("ltx_title_subsubsection")) {
      sections.push(`\n#### ${text}`);
    } else if (clsStr.includes("ltx_title_appendix")) {
      sections.push(`\n## ${text}`);
    } else if (clsStr.includes("ltx_title_abstract")) {
      // Skip — handled by the ltx_abstract match
    } else if (classes.some((c) => c.startsWith("ltx_title"))) {
      sections.push(`\n**${text}**`);
    } else if (classes.includes("ltx_abstract")) {
      const abstractParas = $(el).find(".ltx_p");
      const abstractText = abstractParas.length
        ? abstractParas.map((__, p) => textOf($, p)).get().join("\n\n")
        : text;
      sections.push(`\n## Abstract\n${abstractText}`);
    } else {
      sections.push(text);
    }
  });

  let fullText = sections.join("\n\n");

  // Fallback: if structured extraction got very little, use plain text
  if (fullText.length < 500 && !insertedMarkers) {
    fullText = doc.text().trim();
  }

  if (!title) {
    for (const line of fullText.split("\n")) {
      if (line.trim()) {
        title = line.trim().slice(0, 200);
        break;
      }
    }
  }

  return { title, text: fullText };
}
