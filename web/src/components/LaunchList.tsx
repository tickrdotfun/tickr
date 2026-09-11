"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { isAnyOfficialCoin } from "@/lib/addresses";
import { useMarketData, type Row, type WindowKey } from "@/hooks/useMarketData";
import { DEPLOYED } from "@/lib/addresses";
import { fmtNumber, fmtUsd, shortAddr } from "@/lib/format";
import { TokenArt } from "./TokenArt";
import { Spinner } from "./ui";
import { EmptyState, ErrorState } from "./art/States";
import { quoteClass } from "./QuoteChip";
import { MARKET_BASE_FEE_BPS } from "@/lib/marketLaunch";

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

/**
 * Which generation a coin belongs to, read off the pool fee its launch froze.
 *
 * v2 is the market release: a coin under a fixed-inventory name pays a base fee of 82 bps and no creator tax,
 * and `MarketTickerLauncher` reverts on anything else, so `(82 + 0) * 100` is exact and cannot be reached by a
 * v1 launch, whose base is 100 and whose tax only adds to it. Reading the fee rather than the configuration id
 * means a new configuration added later lands on the right side of the tab without anyone remembering to
 * update a list of ids.
 */
type VersionKey = "v2" | "v1";
const V2_POOL_FEE = MARKET_BASE_FEE_BPS * 100;
const versionOf = (r: Row): VersionKey => (r.launch.poolFee === V2_POOL_FEE ? "v2" : "v1");

const VERSIONS: { id: VersionKey; label: string }[] = [
  { id: "v2", label: "v2" },
  { id: "v1", label: "v1 (deprecated)" },
];

/** Every coin is live from its first block, so the grid is one list, newest first. */
export function LaunchList() {
  const [version, setVersion] = useState<VersionKey>("v2");
  const [sort, setSort] = useState<SortKey>("mcap");
  const [window, setWindow] = useState<WindowKey>("all");
  const [q, setQ] = useState("");
  const market = useMarketData(window);

  const partial = market.data?.partial ?? false;

  // both generations counted before the version filter, so each tab shows its own total and an empty v2 can
  // point at what is actually there
  const counts = useMemo(() => {
    const all = market.data?.rows ?? [];
    return { v2: all.filter((r) => versionOf(r) === "v2").length, v1: all.filter((r) => versionOf(r) === "v1").length };
  }, [market.data]);

  const rows = useMemo(() => {
    const all = (market.data?.rows ?? []).filter((r) => versionOf(r) === version);
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
  }, [market.data, q, sort, partial, version]);

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
      {/* The generation tab leads the controls: it decides what the rest of them are filtering. */}
      <div className="seg seg-version" role="group" aria-label="Generation">
        {VERSIONS.map((v) => (
          <button key={v.id} type="button" className="seg-item" data-active={version === v.id} onClick={() => setVersion(v.id)}>
            {v.label}
            <span className="seg-count num">{counts[v.id]}</span>
          </button>
        ))}
      </div>

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
            <EmptyState title="nothing matches that" body={`nothing in ${version} matches. try a shorter word, a ticker, or paste a token address.`} />
          ) : version === "v2" && counts.v1 > 0 ? (
            // the ordinary case on the day v2 opens: nothing here yet, and the older coins are one tab away
            <EmptyState
              title="no v2 coins yet"
              body={`nobody has launched under a fixed-inventory name on this chain. ${counts.v1} ${counts.v1 === 1 ? "coin" : "coins"} on v1.`}
              action={
                <span className="inline-flex items-center gap-2">
                  <Link href="/create" className="btn btn-sm no-underline hover:no-underline">
                    launch the first
                  </Link>
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => setVersion("v1")}>
                    see v1
                  </button>
                </span>
              }
            />
          ) : (
            <EmptyState
              title="no launches yet"
              body="the first invented name on this chain is still unclaimed."
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
        <Section title={`live ${version}`} count={rows.length}>
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
          {isAnyOfficialCoin(r.launch.token) && <span className="badge sw-green">official</span>}
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
