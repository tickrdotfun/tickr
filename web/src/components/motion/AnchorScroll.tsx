"use client";

import { useEffect } from "react";
import { smoothScrollToElement } from "@/lib/motion";

/** Intercepts same-page anchor clicks so they are hand-driven rather than native-smooth. */
export function AnchorScroll() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      const a = target?.closest?.("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("#") || href.length < 2) return;
      const el = document.getElementById(href.slice(1));
      if (!el) return;
      e.preventDefault();
      smoothScrollToElement(el);
      history.replaceState(null, "", href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}
