"use client";

import { useState, type KeyboardEvent, type MouseEvent } from "react";

/**
 * Copies a coin's contract address from wherever the coin is shown, for pasting into a wallet, a bot or an explorer.
 *
 * A span with a button's role rather than a `<button>`: the launch list's cards are links, and a button may not sit
 * inside a link. The click stops at the icon, so copying never opens the card underneath it.
 */
export function CopyIcon({ address, size = 14, className = "" }: { address: string; size?: number; className?: string }) {
  const [done, setDone] = useState(false);
  const copy = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard?.writeText(address).then(
      () => {
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      },
      () => {},
    );
  };
  return (
    <span
      role="button"
      tabIndex={0}
      title={done ? "copied" : `copy contract address ${address}`}
      aria-label={done ? "copied" : "copy contract address"}
      onClick={copy}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") copy(e);
      }}
      className={`inline-flex shrink-0 items-center justify-center self-center cursor-pointer text-dim hover:text-white transition-colors ${className}`}
    >
      {done ? (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      ) : (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2.5" />
          <path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" />
        </svg>
      )}
    </span>
  );
}
