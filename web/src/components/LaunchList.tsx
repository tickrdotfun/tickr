"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { isOfficialCoin } from "@/lib/addresses";
import { useMarketData, type Row, type WindowKey } from "@/hooks/useMarketData";
import { DEPLOYED } from "@/lib/addresses";
import { fmtNumber, fmtUsd, shortAddr } from "@/lib/format";
import { TokenArt } from "./TokenArt";
import { Spinner } from "./ui";
import { EmptyState, ErrorState } from "./art/States";
import { quoteClass } from "./QuoteChip";

type SortKey = "new" | "mcap" | "volume" | "buys";

const SORTS: { id: SortKey; label: string }[] = [
  { id: "new", label: "newest" },
  { id: "mcap", label: "market cap" },
  { id: "volume", label: "volume" },
  { id: "buys", label: "recent buys" },
];
const WINDOW_LABELS: { id: WindowKey; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "all", label: "all time" },
];

/** Every coin is live from its first block, so the grid is one list, newest first. */
export function LaunchList() {
  const [sort, setSort] = useState<SortKey>("mcap");
  const [window, setWindow] = useState<WindowKey>("all");
  const [q, setQ] = useState("");
  const market = useMarketData(window);

  const partial = market.data?.partial ?? false;
  const rows = useMemo(() => {
    const all = market.data?.rows ?? [];
    const needle = q.trim().toLowerCase();
    const match = (r: Row) =>
      !needle ||
      (r.name ?? "").toLowerCase().includes(needle) ||
      (r.symbol ?? "").toLowerCase().includes(needle) ||
      r.launch.token.toLowerCase().includes(needle) ||
      r.quote.symbol.toLowerCase().includes(needle);
    const cmp = (a: Row, b: Row) => {
      if (sort === "mcap") {
        // dollars against dollars; a launch whose quote cannot be priced ranks after every priced one, by its own units
        if (a.marketCapUsd !== undefined && b.marketCapUsd !== undefined) return b.marketCapUsd - a.marketCapUsd;
        if (a.marketCapUsd !== undefined) return -1;
        if (b.marketCapUsd !== undefined) return 1;
        // two unpriced launches are in different units: newest first, no comparison pretended
        return Number(b.createdBlock - a.createdBlock) || b.launch.index - a.launch.index;
      }
      // with the swap history missing, volume and buys are unknown, not zero: fall back to newest
      if (sort === "volume" && !partial) return b.volumeUsd - a.volumeUsd || b.volumeQuote - a.volumeQuote;
      if (sort === "buys" && !partial) return Number(b.lastBuyBlock - a.lastBuyBlock) || b.buys - a.buys;
      return Number(b.createdBlock - a.createdBlock) || b.launch.index - a.launch.index;
    };
    return all.filter(match).sort(cmp);
  }, [market.data, q, sort, partial]);

  if (!DEPLOYED) return <div className="text-muted">nothing to show until the factory is deployed.</div>;
  if (market.isLoading)
    return (
      <div className="text-muted inline-flex items-center gap-2">
        <Spinner /> reading the factory…
      </div>
    );
  if (market.isError)
    return <ErrorState title="the factory did not answer" body="the chain call failed. it usually clears on its own; reload to try again." />;

  return (
    <div>
      {partial && <p className="detail-note detail-note-tight">the swap history did not load, so volume and buys are unknown right now; the list is newest first.</p>}
      <div className="grid-controls">
        <input className="grid-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="search name, ticker or address" aria-label="Search launches" />
        <div className="seg" role="group" aria-label="Sort">
          <span className="seg-k">sort</span>
          {SORTS.map((s) => (
            <button key={s.id} type="button" className="seg-item" data-active={sort === s.id} onClick={() => setSort(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Window">
          <span className="seg-k">over</span>
          {WINDOW_LABELS.map((w) => (
            <button key={w.id} type="button" className="seg-item" data-active={window === w.id} onClick={() => setWindow(w.id)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 && (
        <div className="mt-8">
          {q ? (
            <EmptyState title="nothing matches that" body="try a shorter word, a ticker, or paste a token address." />
          ) : (
            <EmptyState
              title="no launches yet"
              body="the first invented ticker on this chain is still unclaimed."
              action={
                <Link href="/create" className="btn btn-sm no-underline hover:no-underline">
                  invent one
                </Link>
              }
            />
          )}
        </div>
      )}

      {rows.length > 0 && (
        <Section title="live" count={rows.length}>
          {rows.map((r) => (
            <LaunchCard key={r.launch.token} r={r} window={window} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mt-14">
      <div className="flex items-baseline gap-2.5">
        <h3 className="section-title">{title}</h3>
        <span className="count-badge num">{count}</span>
      </div>
      <div className="card-grid mt-7">{children}</div>
    </section>
  );
}

function LaunchCard({ r, window }: { r: Row; window: WindowKey }) {
  const mcap = r.marketCapUsd !== undefined ? fmtUsd(r.marketCapUsd) : r.marketCap !== undefined ? `${fmtNumber(r.marketCap, { sig: 3 })} ${r.quote.symbol}` : "-";
  const vol = r.volumeUsd > 0 ? fmtUsd(r.volumeUsd) : r.volumeQuote > 0 ? `${fmtNumber(r.volumeQuote, { sig: 3 })} ${r.quote.symbol}` : "-";
  return (
    <Link href={`/t/${r.launch.token}`} className="coin-card st-signal no-underline hover:no-underline">
      <div className="coin-art">
        <TokenArt src={r.logo} symbol={r.symbol} />
        <span className="coin-state num">live</span>
      </div>
      <div className="coin-body">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="coin-name num truncate">
            {r.symbol ?? shortAddr(r.launch.token)}
            <span className="coin-pair-slash">/</span>
            <span className={quoteClass(r.quote.kind)}>{r.quote.kind === "ticker" ? `${r.quote.symbol}*` : r.quote.symbol}</span>
          </span>
          {isOfficialCoin(r.launch.token) && <span className="badge sw-green">official</span>}
        </div>
        <div className="coin-stats">
          <span>
            <span className="coin-stat-k">market cap</span>
            <span className="coin-stat-v num">{mcap}</span>
          </span>
          <span>
            <span className="coin-stat-k">volume {window === "all" ? "" : window}</span>
            <span className="coin-stat-v num">{vol}</span>
          </span>
        </div>
      </div>
    </Link>
  );
}
