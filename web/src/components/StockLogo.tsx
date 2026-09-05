"use client";

import { useState } from "react";

import { DARK_CHIP_TICKERS } from "@/lib/stockLogoChip";

const SWATCHES = ["var(--tickr-sw-blue-type)", "var(--tickr-sw-yellow)", "var(--tickr-sw-pink)", "var(--tickr-sw-red)", "var(--tickr-signal)"];

/** Deterministic per-ticker colour from the mark's palette, so an asset always looks the same. */
function swatchFor(ticker: string): string {
  let sum = 0;
  for (let i = 0; i < ticker.length; i++) sum += ticker.charCodeAt(i);
  return SWATCHES[sum % SWATCHES.length];
}

/**
 * Circular asset badge. Robinhood's asset API publishes the same image (its own feather) for all 194 Stock Tokens,
 * so the issuer marks are vendored under `public/logos/stock/<TICKER>.png` and served from our own origin. A ticker
 * with no file falls back to a monogram, so the list never shows a broken image.
 *
 * The marks sit on a light chip: many are dark glyphs on a transparent ground and would vanish on the ink surface.
 */
export function StockLogo({ ticker, src, size = 24 }: { ticker: string; src?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const upper = ticker.toUpperCase();
  const source = src ?? `/logos/stock/${upper}.png`;
  const showImage = !!source && !failed;
  if (showImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={source}
        alt=""
        width={size}
        height={size}
        className={`stock-logo ${DARK_CHIP_TICKERS.has(upper) ? "on-ink" : ""}`}
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
        loading="lazy"
      />
    );
  }
  return (
    <span
      className="stock-logo stock-logo-fallback"
      style={{ width: size, height: size, fontSize: size * 0.4, color: swatchFor(ticker), borderColor: swatchFor(ticker) }}
      aria-hidden="true"
    >
      {ticker.slice(0, 2)}
    </span>
  );
}
