"use client";

import { useState } from "react";
import type { Address } from "viem";
import { shortAddr } from "@/lib/format";

/**
 * An address, short, with the full value one click away. Printing 42 characters of hex in a table taught
 * the reader nothing and wrapped onto two lines; the short form plus copy is what anyone actually wanted.
 */
export function CopyAddr({ a, href }: { a: Address; href?: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="copy-addr">
      {href ? (
        <a className="num" href={href} target="_blank" rel="noreferrer" title={a}>
          {shortAddr(a)}
        </a>
      ) : (
        <span className="num" title={a}>
          {shortAddr(a)}
        </span>
      )}
      <button
        type="button"
        className="copy-btn"
        aria-label={done ? "copied" : `copy ${a}`}
        onClick={() => {
          navigator.clipboard?.writeText(a).then(
            () => {
              setDone(true);
              setTimeout(() => setDone(false), 1200);
            },
            () => {},
          );
        }}
      >
        {done ? "copied" : "copy"}
      </button>
    </span>
  );
}
