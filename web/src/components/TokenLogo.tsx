"use client";

import { useState } from "react";

import { isRenderableImage, resolveImage } from "@/lib/imageSrc";

export function TokenLogo({ src, symbol, size = 36 }: { src?: string; symbol?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const ok = isRenderableImage(src) && !failed;
  return (
    <div
      className="shrink-0 rounded-[16px] bg-black border border-border overflow-hidden flex items-center justify-center text-dim font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.32 }}
    >
      {ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={resolveImage(src ?? "")} alt={symbol ?? ""} width={size} height={size} className="object-cover w-full h-full" onError={() => setFailed(true)} />
      ) : (
        (symbol ?? "?").slice(0, 3).toUpperCase()
      )}
    </div>
  );
}
