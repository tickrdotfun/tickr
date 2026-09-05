import type { QuoteMeta } from "@/hooks/useQuoteAssets";

/** CSS class carrying the swatch for a kind of quote: a label, not decoration. */
export function quoteClass(kind?: string): string {
  if (kind === "ticker") return "sw-pink";
  if (kind === "official") return "sw-orange";
  if (kind === "native") return "sw-blue";
  return "sw-white";
}

export function QuoteChip({ meta, size = "sm" }: { meta?: QuoteMeta; size?: "sm" | "md" }) {
  if (!meta) return <span className="badge">…</span>;
  // A colour per kind of quote, drawn from the mark's swatches.
  const cls =
    meta.kind === "official"
      ? "sw-orange"
      : meta.kind === "ticker"
        ? "sw-pink"
        : meta.kind === "native"
          ? "sw-blue"
          : "sw-white";
  return (
    <span className={`badge cap ${cls} ${size === "md" ? "text-[12px] px-2.5" : ""}`} title={meta.kind === "official" ? "a Stock Token from the Robinhood Assets registry" : meta.kind === "ticker" ? "Issued by the launch creator" : meta.address}>
      {meta.label}
    </span>
  );
}

/** The pair is a Stock Token from the registry. Says so about the pair, never about the coin next to it. */
export function OfficialBadge() {
  return <span className="badge sw-yellow cap">Stock Token pair</span>;
}

export function CreatorIssuedBadge() {
  return <span className="badge sw-pink">creator-issued</span>;
}
