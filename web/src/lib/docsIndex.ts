import { ALL_DOCS, docNumber } from "./docsNav";
import { rawDoc } from "./docs";
import type { DocSection } from "./docsSearch";

/**
 * Builds the docs search index at build time from the same markdown the pages render.
 *
 * Kept apart from `docsSearch.ts` on purpose: this reads the filesystem, and the search box is a client
 * component. A single module would have dragged `node:fs` into the browser bundle, which is the same reason
 * `docsNav.ts` is free of node imports.
 *
 * One entry per section, not per page: the docs are long, and "where is the creator tax explained" wants the
 * heading it lives under, not the file it lives in.
 */
const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Strip the markdown that would only add noise to a match: fences, tables, links, emphasis, html. */
function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\|.*$/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildDocsIndex(): DocSection[] {
  const out: DocSection[] = [];

  for (const entry of ALL_DOCS) {
    const md = rawDoc(entry).replace(/^# .*\n+/, "");
    const num = docNumber(entry.slug);

    // split on h2/h3, keeping whatever preamble comes before the first heading
    const parts = md.split(/^(#{2,3})\s+(.+)$/gm);
    const sections: { heading: string; text: string }[] = [{ heading: "", text: parts[0] ?? "" }];
    for (let i = 1; i < parts.length; i += 3) {
      sections.push({ heading: parts[i + 1]?.trim() ?? "", text: parts[i + 2] ?? "" });
    }

    for (const s of sections) {
      const text = plain(s.text);
      if (!s.heading && !text) continue;
      const href = s.heading ? `/docs/${entry.slug}#${slugify(s.heading)}` : `/docs/${entry.slug}`;
      out.push({
        href,
        page: entry.title,
        num,
        heading: s.heading || entry.title,
        body: `${entry.title} ${entry.blurb} ${s.heading} ${text}`.toLowerCase(),
        snippet: (text || entry.blurb).slice(0, 190),
      });
    }
  }
  return out;
}

