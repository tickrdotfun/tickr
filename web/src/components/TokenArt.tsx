"use client";

import { useState } from "react";
import { isRenderableImage, resolveImage } from "@/lib/imageSrc";
import { TickerObject } from "./art/TickerObject";

/**
 * A launch's artwork. The creator's uploaded image when there is one, otherwise a coloured field built from the
 * ticker itself, so a grid of coins without images still reads as a grid of distinct things.
 */
export function TokenArt({ src, symbol, className = "" }: { src?: string; symbol?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const ticker = (symbol ?? "?").toUpperCase();

  if (isRenderableImage(src) && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={resolveImage(src ?? "")} alt="" className={`token-art ${className}`} onError={() => setFailed(true)} loading="lazy" />
    );
  }
  return <TickerObject ticker={ticker} className={`token-art ${className}`} />;
}
