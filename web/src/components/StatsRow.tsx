"use client";

import { useMarketData } from "@/hooks/useMarketData";
import { fmtUsd } from "@/lib/format";

/** Scale, in four figures. Dollar totals cover the launches whose quote asset can be priced. */
export function StatsRow() {
  const m = useMarketData("all");
  const d = m.data;
  const items: { k: string; v: string; note?: string; cls: string }[] = [
    { k: "tickers invented", v: d ? String(d.tickersInvented) : "-", cls: "sw-yellow" },
    { k: "coins launched", v: d ? String(d.rows.length) : "-", cls: "sw-signal" },
    {
      k: "market cap",
      v: d ? fmtUsd(d.totalMarketCapUsd) : "-",
      note: d && d.pricedShare < 1 ? "of priced launches" : undefined,
      cls: "sw-orange",
    },
    {
      k: "pool volume",
      v: d ? fmtUsd(d.totalVolumeUsd) : "-",
      note: d && d.pricedShare < 1 ? "of priced launches" : undefined,
      cls: "sw-blue",
    },
  ];
  return (
    <dl className="stats-row">
      {items.map((i) => (
        <div key={i.k} className="stat-cell">
          <dd className={`stat-v num ${i.cls}`}>{i.v}</dd>
          <dt className="stat-k">{i.k}</dt>
          {i.note && <span className="stat-note">{i.note}</span>}
        </div>
      ))}
    </dl>
  );
}
