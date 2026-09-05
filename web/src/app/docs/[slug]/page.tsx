import { notFound } from "next/navigation";
import Link from "next/link";
import { ALL_DOCS, docBySlug, renderDoc } from "@/lib/docs";
import { docNumber } from "@/lib/docsNav";

export function generateStaticParams() {
  return ALL_DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = docBySlug(slug);
  return { title: entry ? `${entry.title} · tickr docs` : "docs · tickr" };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = docBySlug(slug);
  if (!entry) notFound();
  const doc = renderDoc(entry);
  const i = ALL_DOCS.findIndex((d) => d.slug === slug);
  const prev = ALL_DOCS[i - 1];
  const next = ALL_DOCS[i + 1];
  const outline = doc.headings.filter((h) => h.depth === 2);
  return (
    <>
      <article className="docs-article">
        <header className="docs-head">
          <span className="docs-head-n num">§ {docNumber(slug)}</span>
          <h1 className="docs-head-t">{doc.title}</h1>
          <p className="docs-head-d">{entry.blurb}</p>
          <a className="docs-head-md" href={`/docs/${slug}.md`}>
            this page as markdown
          </a>
        </header>
        <div className="prose-docs" dangerouslySetInnerHTML={{ __html: doc.html }} />
        <nav className="docs-pager">
          {prev ? (
            <Link href={`/docs/${prev.slug}`}>
              <span className="docs-pager-k num">§ {docNumber(prev.slug)}</span>
              {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={`/docs/${next.slug}`} className="text-right">
              <span className="docs-pager-k num">§ {docNumber(next.slug)}</span>
              {next.title}
            </Link>
          )}
        </nav>
      </article>

      {outline.length > 1 && (
        <aside className="docs-onthis" aria-label="On this page">
          <div className="docs-onthis-k">on this page</div>
          {outline.map((h) => (
            <a key={h.id} href={`#${h.id}`}>
              {h.text}
            </a>
          ))}
        </aside>
      )}
    </>
  );
}
