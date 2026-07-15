/** Extract the first heading from markdown text as the title. */
export function extractTitleFromMarkdown(markdown: string): string {
  let fallback = "";
  for (const line of markdown.split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    if (stripped.startsWith("#")) {
      const title = stripped.replace(/^#+\s*/, "").trim();
      // Strip bold markers some extractors add to headings
      return title.replace(/\*\*(.+?)\*\*/g, "$1");
    }
    if (!fallback) fallback = stripped.slice(0, 200);
  }
  return fallback;
}
