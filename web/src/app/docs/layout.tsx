import { DocsShell } from "@/components/docs/DocsShell";
import { ALL_DOCS } from "@/lib/docsNav";
import { buildDocsIndex } from "@/lib/docsIndex";

export const metadata = { title: "docs · tickr" };

/**
 * A document masthead, not a hero: what this is, what it covers, what chain it describes, on one line above
 * a hairline. The page's own title belongs to the page.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  // built here, on the server, from the markdown itself: nothing to fetch and no endpoint to drift
  const index = buildDocsIndex();
  return (
    <div>
      <header className="docs-mast">
        <div className="docs-mast-l">
          <span className="docs-mast-name">tickr</span>
          <span className="docs-mast-kind">protocol specification</span>
        </div>
        <div className="docs-mast-r">
          <span>
            <span className="num">{ALL_DOCS.length + 1}</span> sections
          </span>
          <span className="docs-mast-sep" aria-hidden="true" />
          <span>
            <span className="cap">Robinhood Chain</span> <span className="num">4663</span>
          </span>
        </div>
        {/* The site renders the repository's markdown, so the markdown is the better artefact for anything
            that reads rather than looks. These are the three shapes that get asked for. */}
        <div className="docs-mast-ai">
          <span className="docs-mast-ai-k">for an llm</span>
          <a href="/llms.txt">llms.txt</a>
          <a href="/llms-full.txt">every page, one file</a>
          <a href="/tickr-docs.md" download>
            download .md
          </a>
        </div>
      </header>
      <DocsShell index={index}>{children}</DocsShell>
    </div>
  );
}
