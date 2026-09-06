"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Hex } from "viem";
import type { UTCTimestamp } from "lightweight-charts";
import type { TokenData } from "@/hooks/useTokenData";
import { ADDRESSES, START_BLOCK } from "@/lib/addresses";
import { IS_DEVNET } from "@/lib/chain";
import { DEMO } from "@/lib/demoTransport";
import { fmtPrice } from "@/lib/format";
import { tokenPriceInQuote } from "@/lib/pool";
import { Panel } from "../ui";

/** The pool manager's swap log. `id` is the v4 pool id, so one topic filter finds every trade of one pool. */
const SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
/** Blocks per log query, and how many queries back from the tip. Public nodes cap a query's range; twelve of
 *  these cover a coin's whole life on a testnet and its last day or two on Robinhood Chain. */
const CHUNK = 20_000n;
const MAX_CHUNKS = 12;

/** Only the public chain is indexed by the chart sites. */
const dexScreenerEmbed = (poolId: string) => `https://dexscreener.com/robinhood/${poolId}?embed=1&theme=dark&trades=0&info=0`;

type Point = { time: UTCTimestamp; value: number };
type Series = { points: Point[]; fromBlock: bigint; complete: boolean; swaps: number; interpolated: boolean };

/**
 * The coin's price in its quote, drawn from the pool's own swaps: every Swap the pool manager logged for this
 * pool id, priced from its sqrtPriceX96 exactly as the figures above are. It asks nothing of an indexer, so it
 * draws on a fork, on a testnet and in the first minute after a launch. On Robinhood Chain the DexScreener view
 * sits one tab over, once that site has picked the pool up.
 */
export function PriceChart({ d }: { d: TokenData }) {
  const client = usePublicClient();
  const { launch, meta, quote, pool } = d;
  const poolId = pool.poolId;
  const live = !DEMO && !IS_DEVNET;
  const [view, setView] = useState<"pool" | "dexscreener">("pool");
  const td = meta.decimals ?? 18;
  const qd = quote?.decimals ?? 18;

  // the opening point needs the supply and both decimals; until they are in, there is nothing right to draw
  const ready = !!client && !!poolId && !!pool.key && !!launch && meta.totalSupply !== undefined && meta.decimals !== undefined && quote?.decimals !== undefined;
  const swaps = useQuery({
    queryKey: ["swaps", poolId, td, qd, meta.totalSupply?.toString()],
    enabled: ready,
    staleTime: 15_000,
    refetchInterval: 20_000,
    queryFn: async (): Promise<Series> => {
      if (!client || !poolId || !pool.key || !launch) return { points: [], fromBlock: 0n, complete: true, swaps: 0, interpolated: false };
      const latest = await client.getBlockNumber();
      const floor = START_BLOCK > 0n ? START_BLOCK : 0n;
      const ranges: [bigint, bigint][] = [];
      let hi = latest;
      while (hi >= floor && ranges.length < MAX_CHUNKS) {
        const lo = hi - CHUNK + 1n > floor ? hi - CHUNK + 1n : floor;
        ranges.unshift([lo, hi]);
        if (lo === floor) break;
        hi = lo - 1n;
      }
      const logs = (
        await Promise.all(ranges.map(([a, b]) => client.getLogs({ address: ADDRESSES.poolManager, event: SWAP, args: { id: poolId as Hex }, fromBlock: a, toBlock: b })))
      ).flat();
      logs.sort((x, y) => (x.blockNumber === y.blockNumber ? Number(x.logIndex ?? 0) - Number(y.logIndex ?? 0) : x.blockNumber < y.blockNumber ? -1 : 1));

      // the opening price, from the launch itself: what the pool held against the whole supply
      const opening = Number(launch.phantomQuote) / 10 ** qd / (Number(meta.totalSupply ?? 0n) / 10 ** td);
      const points: Point[] = [{ time: Number(launch.launchedAt ?? 0n) as UTCTimestamp, value: opening }];
      const fromBlock = ranges.length ? ranges[0][0] : latest; // what the chart covers: since the factory's start, or the most recent chunk
      let interpolated = false;
      if (logs.length) {
        // the clock comes from the blocks themselves: every block with a swap is read when there are few of them,
        // otherwise forty anchors spread across them, and a block between two anchors sits on the line between
        const blocks = [...new Set(logs.map((l) => l.blockNumber!))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const anchors = blocks.length <= 40 ? blocks : [...new Set(Array.from({ length: 40 }, (_, i) => blocks[Math.round((i * (blocks.length - 1)) / 39)]))];
        interpolated = anchors.length < blocks.length;
        const stamps = new Map<bigint, number>();
        const read = await Promise.all(anchors.map((b) => client.getBlock({ blockNumber: b }).then((blk) => [b, Number(blk.timestamp)] as const)));
        for (const [b, t] of read) stamps.set(b, t);
        const at = (b: bigint): number => {
          const hit = stamps.get(b);
          if (hit !== undefined) return hit;
          let lo = anchors[0];
          let hi = anchors[anchors.length - 1];
          for (const a of anchors) {
            if (a <= b) lo = a;
            if (a >= b) {
              hi = a;
              break;
            }
          }
          const tl = stamps.get(lo)!;
          const th = stamps.get(hi)!;
          return hi === lo ? tl : tl + (Number(b - lo) * (th - tl)) / Number(hi - lo);
        };
        for (const l of logs) {
          const sqrtP = l.args.sqrtPriceX96;
          if (!sqrtP) continue;
          points.push({ time: Math.floor(at(l.blockNumber!)) as UTCTimestamp, value: tokenPriceInQuote(sqrtP, pool.key.tokenIs0, td, qd) });
        }
        // the opening point is the launch itself; when the history shown starts later, the line starts where it starts
        if (fromBlock > floor && points.length > 1) points.shift();
      }
      // one point per second, the last price of that second: the chart wants strictly increasing times, and two
      // swaps in one block are one observation, not two a second apart
      const bySecond = new Map<number, Point>();
      for (const q of points) bySecond.set(q.time as number, q);
      const series = [...bySecond.values()].sort((a, b) => (a.time as number) - (b.time as number)).filter((q) => Number.isFinite(q.value));
      return { points: series, fromBlock, complete: fromBlock <= floor, swaps: logs.length, interpolated };
    },
  });

  const box = useRef<HTMLDivElement>(null);
  const data = swaps.data?.points;
  useEffect(() => {
    if (view !== "pool" || !box.current || !data || data.length === 0) return;
    let disposed = false;
    let remove: (() => void) | undefined;
    (async () => {
      const { createChart, AreaSeries, ColorType } = await import("lightweight-charts");
      if (disposed || !box.current) return;
      const css = getComputedStyle(document.documentElement);
      const signal = css.getPropertyValue("--tickr-signal").trim() || "#3ddc84";
      const dim = css.getPropertyValue("--dim").trim() || "#8a9a90";
      const chart = createChart(box.current, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: dim, attributionLogo: false, fontSize: 11 },
        grid: { vertLines: { color: "rgba(255,255,255,0.035)" }, horzLines: { color: "rgba(255,255,255,0.05)" } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
        handleScroll: { vertTouchDrag: false },
      });
      const series = chart.addSeries(AreaSeries, {
        lineColor: signal,
        lineWidth: 2,
        topColor: "rgba(61, 220, 132, 0.22)",
        bottomColor: "rgba(61, 220, 132, 0)",
        priceFormat: { type: "custom", formatter: (p: number) => fmtPrice(p), minMove: 1e-12 },
        priceLineVisible: true,
        lastValueVisible: true,
      });
      series.setData(data);
      chart.timeScale().fitContent();
      remove = () => chart.remove();
    })();
    return () => {
      disposed = true;
      remove?.();
    };
  }, [view, data]);

  if (!poolId) return null;
  const trades = swaps.data?.swaps; // the swaps in the window shown, counted from the logs, not from the points drawn
  return (
    <Panel>
      <div className="chart-head">
        <div className="fig-k">
          price, {quote?.symbol ?? "quote"} per {meta.symbol ?? "coin"}
          {trades !== undefined && (
            <span className="chart-count">
              {" "}· {swaps.data && !swaps.data.complete ? `${trades} ${trades === 1 ? "trade" : "trades"} since block ${swaps.data.fromBlock.toString()}` : `${trades} ${trades === 1 ? "trade" : "trades"} on chain`}
              {swaps.data?.interpolated ? ", times between anchors estimated" : ""}
            </span>
          )}
        </div>
        {live && (
          <div className="chart-tabs" role="tablist">
            <button className="chart-tab" data-active={view === "pool"} onClick={() => setView("pool")}>
              pool
            </button>
            <button className="chart-tab" data-active={view === "dexscreener"} onClick={() => setView("dexscreener")}>
              dexscreener
            </button>
          </div>
        )}
      </div>
      {view === "dexscreener" && live ? (
        <iframe className="chart-frame" src={dexScreenerEmbed(poolId)} title="dexscreener chart" loading="lazy" />
      ) : (
        <>
          <div ref={box} className="chart-box" />
          {swaps.isLoading && <div className="chart-empty">reading the pool&apos;s trades…</div>}
          {swaps.isError && <div className="chart-empty">the trades could not be read from this connection.</div>}
          {trades === 0 && <div className="chart-empty">no trades yet. the line starts at the opening price and follows every swap in the pool.</div>}
        </>
      )}
    </Panel>
  );
}
