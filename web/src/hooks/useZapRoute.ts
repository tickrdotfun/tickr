"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { FactoryAbi, TickerLauncherAbi } from "@/lib/abis";
import { poolManagerAbi as PoolManagerAbi, v3FactoryAbi, v3PoolAbi } from "@/lib/extraAbis";
import { ADDRESSES, ZERO, isZero, sameAddr } from "@/lib/addresses";
import { FEE_TIERS, V3_FEES, ethUsdgKey, idOf, keyOf, liquiditySlot, v3Hop, v4Hop, wrapHop, type Hop, type V4Key } from "@/lib/route";
import { isManagedHookWired, managedKey } from "@/lib/activation";
import { previewZapOnce, previewZapSellOnce } from "@/hooks/useZap";
import { reverseRoute } from "@/lib/route";

/** The trade size routes are compared at when the box is still empty. */
const DEFAULT_PROBE_WEI = 10_000_000_000_000_000n; // 0.01 ETH

export type ZapRoute = {
  /** ETH to the coin: the hops to its quote asset, then the coin's own pool last. Reversed, it is the sell
   *  route. Null when no route from ETH to the quote is known; the coin's own pool still trades in the quote. */
  path: Hop[] | null;
  /** the coin's own pool alone, for a trade paid in the quote asset */
  own: Hop;
  label: string;
};

/**
 * Works out how ETH reaches a coin, hop by hop, so the ZapRouter can buy it with ETH: first to the coin's quote
 * asset, then through the coin's own pool. When the quote asset has several markets against ETH, each one is
 * quoted for `probeWei` (the trade being typed, or a small default) and the one that pays the most coins wins:
 * a pool's liquidity number says nothing about the price it gives for a size, since liquidity can sit far from
 * the price. The previous route stays on screen while a new size is quoted.
 */
export function useZapRoute(token?: Address, pairToken?: Address, probeWei?: bigint, from?: Address, side: "buy" | "sell" = "buy", sellAmount?: bigint) {
  const client = usePublicClient();
  const enabled = !!client && !!token && !!pairToken && !isZero(ADDRESSES.zapRouter);
  const probe = probeWei && probeWei > 0n ? probeWei : DEFAULT_PROBE_WEI;
  // a sell is compared at the coins being sold, in its own direction; without an amount or a wallet the buy probe stands in
  const sellProbe = side === "sell" && sellAmount && sellAmount > 0n && from ? sellAmount : undefined;

  return useQuery({
    queryKey: ["zapRoute", token, pairToken, probe.toString(), from, sellProbe?.toString() ?? ""],
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<ZapRoute | null> => {
      if (!client || !token || !pairToken) return null;
      const own = v4Hop(await ownPoolKey(client, token));
      const toQuote = await routesToAsset(client, pairToken);
      if (!toQuote || toQuote.paths.length === 0) return { path: null, own, label: "no route from ETH" };
      let path: Hop[];
      if (toQuote.paths.length === 1) path = toQuote.paths[0];
      else if (sellProbe && from) path = await bestBySellQuote(client, token, own, toQuote.paths, sellProbe, from);
      else path = await bestByQuote(client, token, own, toQuote.paths, probe, from);
      return { path: [...path, own], own, label: `${toQuote.label} → coin` };
    },
  });
}

/** Among several ways out to ETH, the one that pays the most ETH for these coins, quoted for real as a sell. */
async function bestBySellQuote(client: Client, token: Address, own: Hop, paths: Hop[][], amountIn: bigint, from: Address): Promise<Hop[]> {
  const quotes = await Promise.all(paths.map((p) => previewZapSellOnce(client, token, reverseRoute([...p, own]), amountIn, from, ZERO).catch(() => null)));
  let best = -1;
  let bestOut = -1n;
  quotes.forEach((q, i) => {
    if (q && q.amountOut > bestOut) {
      bestOut = q.amountOut;
      best = i;
    }
  });
  return best >= 0 ? paths[best] : paths[0];
}

/**
 * Among several ways to the quote asset, the one that pays the most coins for this trade, quoted for real
 * through the zap. Candidates whose quote fails are dropped; if every quote fails, the deepest stays.
 */
async function bestByQuote(client: Client, token: Address, own: Hop, paths: Hop[][], probe: bigint, from?: Address): Promise<Hop[]> {
  const quotes = await Promise.all(paths.map((p) => previewZapOnce(client, token, [...p, own], probe, from).catch(() => null)));
  let best = -1;
  let bestOut = -1n;
  quotes.forEach((q, i) => {
    if (q && q.tokensOut > bestOut) {
      bestOut = q.tokensOut;
      best = i;
    }
  });
  return best >= 0 ? paths[best] : paths[0];
}

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

async function ownPoolKey(client: Client, token: Address): Promise<V4Key> {
  const key = await client.readContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "poolKeyOf", args: [token] });
  return { ...key, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing) };
}

/**
 * The ways from ETH to `pair`, deepest first; one empty path when the pair is ETH itself. ETH, USDG, tickers and
 * coins launched here have exactly one way; a Stock Token or another ERC-20 may have a pool per fee tier.
 */
async function routesToAsset(client: Client, pair: Address): Promise<{ paths: Hop[][]; label: string } | null> {
  if (isZero(pair)) return { paths: [[]], label: "ETH" };
  if (sameAddr(pair, ADDRESSES.usdg)) return { paths: [[v4Hop(ethUsdgKey())]], label: "ETH → USDG" };

  // An invented ticker is a one-for-one wrapper of USDG with a pool of its own: reach USDG, then wrap one for one
  // or trade through the name's pool, whichever pays more for this size
  if (!isZero(ADDRESSES.tickerLauncher)) {
    const isTicker = await client.readContract({ abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "isTicker", args: [pair] });
    if (isTicker) {
      const ways: Hop[][] = [[v4Hop(ethUsdgKey()), wrapHop(pair)]];
      if (isManagedHookWired()) ways.push([v4Hop(ethUsdgKey()), v4Hop(managedKey(pair))]);
      return { paths: ways, label: "ETH → USDG → ticker" };
    }
  }

  // Another coin launched here: through its own pool, which sits on ETH, USDG or a ticker (depth one).
  const rec = await client.readContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "getLaunchedToken", args: [pair] });
  if (rec.exists) {
    const k = await ownPoolKey(client, pair);
    const upstream = await routesToAsset(client, rec.pairToken);
    if (!upstream) return null;
    return { paths: upstream.paths.map((p) => [...p, v4Hop(k)]), label: `${upstream.label} → quote coin` };
  }

  // A Stock Token or other ERC-20: every pool against ETH, native on v4 or WETH on v3, deepest first.
  const candidates = FEE_TIERS.map((t) => keyOf(ZERO, pair, t.fee, t.tickSpacing));
  const [v4Liq, v3Pools] = await Promise.all([
    client.multicall({
      contracts: candidates.map((k) => ({ abi: PoolManagerAbi, address: ADDRESSES.poolManager, functionName: "extsload", args: [liquiditySlot(idOf(k))] }) as const),
      allowFailure: true,
    }),
    isZero(ADDRESSES.v3Factory)
      ? Promise.resolve([])
      : client.multicall({
          contracts: V3_FEES.map((fee) => ({ abi: v3FactoryAbi, address: ADDRESSES.v3Factory, functionName: "getPool", args: [ADDRESSES.weth, pair, fee] }) as const),
          allowFailure: true,
        }),
  ]);
  const pools = v3Pools.map((r) => (r.status === "success" ? (r.result as Address) : ZERO)).filter((a) => !isZero(a));
  const v3Liq = pools.length
    ? await client.multicall({ contracts: pools.map((a) => ({ abi: v3PoolAbi, address: a, functionName: "liquidity" }) as const), allowFailure: true })
    : [];
  const ways: { hop: Hop; l: bigint }[] = [];
  v4Liq.forEach((r, i) => {
    if (r.status !== "success") return;
    const l = BigInt(r.result as `0x${string}`);
    if (l > 0n) ways.push({ hop: v4Hop(candidates[i]), l });
  });
  v3Liq.forEach((r, i) => {
    if (r.status !== "success") return;
    const l = r.result as bigint;
    if (l > 0n) ways.push({ hop: v3Hop(pools[i]), l });
  });
  const direct = ways.sort((a, b) => (b.l > a.l ? 1 : b.l < a.l ? -1 : 0)).map((w) => [w.hop]);
  // the ways through USDG are candidates too, quoted against the direct ones: a v3 pool against USDG, reached
  // through the canonical ETH/USDG pool. only when there is no ETH pool at all are they the only ways
  if (isZero(ADDRESSES.v3Factory)) return direct.length ? { paths: direct, label: "ETH → asset" } : null;
  const usdgPools = await client.multicall({
    contracts: V3_FEES.map((fee) => ({ abi: v3FactoryAbi, address: ADDRESSES.v3Factory, functionName: "getPool", args: [ADDRESSES.usdg, pair, fee] }) as const),
    allowFailure: true,
  });
  const up = usdgPools.map((r) => (r.status === "success" ? (r.result as Address) : ZERO)).filter((a) => !isZero(a));
  if (up.length === 0) return direct.length ? { paths: direct, label: "ETH → asset" } : null;
  const upLiq = await client.multicall({ contracts: up.map((a) => ({ abi: v3PoolAbi, address: a, functionName: "liquidity" }) as const), allowFailure: true });
  const viaUsdg: { pool: Address; l: bigint }[] = [];
  upLiq.forEach((r, i) => {
    if (r.status !== "success") return;
    const l = r.result as bigint;
    if (l > 0n) viaUsdg.push({ pool: up[i], l });
  });
  const viaPaths = viaUsdg.sort((a, b) => (b.l > a.l ? 1 : b.l < a.l ? -1 : 0)).map((w) => [v4Hop(ethUsdgKey()), v3Hop(w.pool)]);
  if (direct.length === 0 && viaPaths.length === 0) return null;
  if (direct.length === 0) return { paths: viaPaths, label: "ETH → USDG → asset" };
  return { paths: [...direct, ...viaPaths], label: viaPaths.length ? "ETH → asset, or through USDG" : "ETH → asset" };
}
