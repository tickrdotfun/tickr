import { marked } from "marked";

/**
 * The documentation is the markdown in the repository's `docs/` folder, rendered here at build time so the site
 * and the repo can never disagree. Nothing on these pages is written twice.
 */
import { ALL_DOCS, type DocEntry } from "./docsNav";
import { DOC_FILES } from "./docsFiles";
export { DOC_GROUPS, ALL_DOCS, type DocEntry, type DocGroup } from "./docsNav";

const FILE_TO_SLUG = new Map(ALL_DOCS.map((d) => [d.file, d.slug]));

/**
 * `docs/` is authored at the repository root. `scripts/sync-docs.mjs` copies it into `web/docs`, and
 * `scripts/build-docs-bundle.mjs` bakes those files into `docsFiles.ts` before every dev and build. The
 * markdown therefore travels inside the bundle, which is what a Cloudflare Worker needs: there is no
 * filesystem to read at render time.
 */
function read(file: string): string {
  const md = DOC_FILES[file];
  if (md === undefined) throw new Error(`docs: ${file} is not in the bundle. run scripts/build-docs-bundle.mjs`);
  return md;
}

/** The raw markdown of one page, exactly as it is authored in the repository. */
export function rawDoc(entry: DocEntry): string {
  const md = read(entry.file);
  // Figures exist for the rendered page. Anything reading the markdown instead of looking at it gets the
  // diagram's text form, which every figure carries as an `alt:` comment, rather than a screenful of SVG.
  return md.replace(
    /<figure\b[^>]*>\s*<!--\s*alt:\n?([\s\S]*?)-->[\s\S]*?<\/figure>/g,
    (_m, alt: string) => "```\n" + alt.replace(/\s+$/, "") + "\n```",
  );
}

export function docBySlug(slug: string): DocEntry | undefined {
  return ALL_DOCS.find((d) => d.slug === slug);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type RenderedDoc = { title: string; html: string; headings: { id: string; text: string; depth: number }[] };

export function renderDoc(entry: DocEntry): RenderedDoc {
  const raw = read(entry.file);
  // the page prints its own title, so the markdown's first h1 is dropped
  const body = raw.replace(/^# .*\n+/, "");
  let html = marked.parse(body, { gfm: true, async: false }) as string;

  // links between docs point at the rendered pages, not the .md files
  html = html.replace(/href="\.\/([^"#]+\.md)(#[^"]*)?"/g, (_m, file: string, hash: string = "") => {
    const slug = FILE_TO_SLUG.get(file);
    return slug ? `href="/docs/${slug}${hash}"` : `href="/docs"`; // a file outside the nav (the readme) goes to the index
  });

  // anchor ids on section headings, and a list of them for the page's own outline
  const headings: RenderedDoc["headings"] = [];
  html = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, d: string, inner: string) => {
    const id = slugify(inner);
    const text = inner
      .replace(/<[^>]+>/g, "")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
    headings.push({ id, text, depth: Number(d) });
    return `<h${d} id="${id}">${inner}</h${d}>`;
  });

  // wide tables scroll inside their own box, never the page
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");

  return { title: entry.title, html, headings };
}
