"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DocSection } from "@/lib/docsSearch";
import { searchDocs } from "@/lib/docsSearch";

/**
 * Search across the documentation.
 *
 * The index is built at build time from the same markdown the pages render and handed down as a prop, so
 * there is no request to make and no endpoint to keep in sync: typing filters an array that already shipped.
 * Results are sections, not pages, because "where is the creator tax explained" wants the heading it lives
 * under. Arrow keys move, enter opens, escape closes, and the whole thing is reachable from anywhere in the
 * docs with the usual slash key.
 */
export function DocsSearch({ index }: { index: DocSection[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => searchDocs(index, q), [index, q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, []);

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    router.push(href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[Math.min(cursor, results.length - 1)].href);
    }
  };

  return (
    <div className="docs-search" ref={boxRef}>
      <input
        ref={inputRef}
        className="docs-search-input"
        type="search"
        value={q}
        placeholder="search the docs"
        aria-label="Search the documentation"
        onChange={(e) => {
          setQ(e.target.value);
          setCursor(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {!q && (
        <span className="docs-search-key" aria-hidden="true">
          /
        </span>
      )}

      {open && q.trim().length >= 2 && (
        <div className="docs-search-out" role="listbox">
          {results.length === 0 ? (
            <div className="docs-search-none">nothing for “{q.trim()}”</div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.href + r.heading}
                type="button"
                role="option"
                aria-selected={i === cursor}
                data-active={i === cursor}
                className="docs-search-hit"
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(r.href)}
              >
                <span className="docs-search-hit-top">
                  <span className="docs-search-n num">{r.num}</span>
                  <span className="docs-search-h">{r.heading}</span>
                  <span className="docs-search-page">{r.page}</span>
                </span>
                <span className="docs-search-snip">{r.snippet}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
