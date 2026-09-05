"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOC_GROUPS } from "@/lib/docsNav";
import type { DocSection } from "@/lib/docsSearch";
import { DocsSearch } from "./DocsSearch";
import { XIcon } from "../XIcon";
import { SOCIALS } from "@/lib/constants";

/**
 * The frame every docs page sits in.
 *
 * The index is a numbered margin index, the way a specification is indexed: the number carries the page's
 * place in the document, and the marker in the number gutter carries its group. No card, no pill, no
 * chrome. The page's own outline is rendered by the page, into the right column of `.docs-body`.
 */
export function DocsShell({ children, index }: { children: React.ReactNode; index: DocSection[] }) {
  const pathname = usePathname();
  const active = pathname.replace(/^\/docs\/?/, "") || "overview";
  return (
    <div className="docs-shell">
      <nav className="docs-rail" aria-label="Docs">
        <DocsSearch index={index} />

        <Link href="/docs" className={`docs-rail-row ${active === "overview" ? "is-active" : ""}`} style={{ ["--mk" as string]: "var(--tickr-signal)" }}>
          <span className="docs-rail-n num">0</span>
          <span>overview</span>
        </Link>

        {DOC_GROUPS.map((g) => (
          <div key={g.label} className="docs-rail-group" style={{ ["--mk" as string]: g.swatch }}>
            <div className="docs-rail-head">
              <span className="docs-rail-n num">{g.num}</span>
              <span>{g.label}</span>
            </div>
            {g.items.map((d, i) => (
              <Link key={d.slug} href={`/docs/${d.slug}`} className={`docs-rail-row ${active === d.slug ? "is-active" : ""}`}>
                <span className="docs-rail-n num">
                  {g.num}.{i + 1}
                </span>
                <span>{d.title}</span>
              </Link>
            ))}
          </div>
        ))}

        <a href={SOCIALS.x.href} target="_blank" rel="noreferrer" className="docs-rail-foot">
          <XIcon size={12} /> {SOCIALS.x.handle}
        </a>
      </nav>

      <div className="docs-body">{children}</div>
    </div>
  );
}
