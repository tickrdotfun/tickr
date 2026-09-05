"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { FactoryAbi, TickerLauncherAbi } from "@/lib/abis";
import { poolManagerAbi as PoolManagerAbi, v3FactoryAbi, v3PoolAbi } from "@/lib/extraAbis";
import { ADDRESSES, ZERO, isZero, sameAddr } from "@/lib/addresses";
import { FEE_TIERS, V3_FEES, ethUsdgKey, idOf, keyOf, liquiditySlot, v3Hop, v4Hop, wrapHop, type Hop, type V4Key } from "@/lib/route";

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
 * asset, then through the coin's own pool.
 */
export function useZapRoute(token?: Address, pairToken?: Address) {
  const client = usePublicClient();
  const enabled = !!client && !!token && !!pairToken && !isZero(ADDRESSES.zapRouter);

  return useQuery({
    queryKey: ["zapRoute", token, pairToken],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<ZapRoute | null> => {
      if (!client || !token || !pairToken) return null;
      const own = v4Hop(await ownPoolKey(client, token));
      const toQuote = await routeToAsset(client, pairToken);
      if (!toQuote) return { path: null, own, label: "no route from ETH" };
      return { path: [...toQuote.path, own], own, label: `${toQuote.label} → coin` };
    },
  });
}

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

async function ownPoolKey(client: Client, token: Address): Promise<V4Key> {
  const key = await client.readContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "poolKeyOf", args: [token] });
  return { ...key, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing) };
}

/** The hops from ETH to `pair`. Empty when the pair is ETH itself. */
async function routeToAsset(client: Client, pair: Address): Promise<{ path: Hop[]; label: string } | null> {
  if (isZero(pair)) return { path: [], label: "ETH" };
  if (sameAddr(pair, ADDRESSES.usdg)) return { path: [v4Hop(ethUsdgKey())], label: "ETH → USDG" };

  // An invented ticker is a one-for-one wrapper of USDG: reach USDG, then wrap. Nothing to price, nothing to route.
  if (!isZero(ADDRESSES.tickerLauncher)) {
    const isTicker = await client.readContract({ abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "isTicker", args: [pair] });
    if (isTicker) return { path: [v4Hop(ethUsdgKey()), wrapHop(pair)], label: "ETH → USDG → ticker" };
  }

  // Another coin launched here: through its own pool, which sits on ETH, USDG or a ticker (depth one).
  const rec = await client.readContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "getLaunchedToken", args: [pair] });
  if (rec.exists) {
    const k = await ownPoolKey(client, pair);
    const upstream = await routeToAsset(client, rec.pairToken);
    if (!upstream) return null;
    return { path: [...upstream.path, v4Hop(k)], label: `${upstream.label} → quote coin` };
  }

  // A Stock Token or other ERC-20: the deepest pool against ETH, native on v4 or WETH on v3.
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
  let best: { hop: Hop; l: bigint } | undefined;
  v4Liq.forEach((r, i) => {
    if (r.status !== "success") return;
    const l = BigInt(r.result as `0x${string}`);
    if (l > 0n && (!best || l > best.l)) best = { hop: v4Hop(candidates[i]), l };
  });
  v3Liq.forEach((r, i) => {
    if (r.status !== "success") return;
    const l = r.result as bigint;
    if (l > 0n && (!best || l > best.l)) best = { hop: v3Hop(pools[i]), l };
  });
  if (best) return { path: [best.hop], label: "ETH → asset" };
  // no ETH market: a v3 pool against USDG, reached through the canonical ETH/USDG pool
  if (isZero(ADDRESSES.v3Factory)) return null;
  const usdgPools = await client.multicall({
    contracts: V3_FEES.map((fee) => ({ abi: v3FactoryAbi, address: ADDRESSES.v3Factory, functionName: "getPool", args: [ADDRESSES.usdg, pair, fee] }) as const),
    allowFailure: true,
  });
  const up = usdgPools.map((r) => (r.status === "success" ? (r.result as Address) : ZERO)).filter((a) => !isZero(a));
  if (up.length === 0) return null;
  const upLiq = await client.multicall({ contracts: up.map((a) => ({ abi: v3PoolAbi, address: a, functionName: "liquidity" }) as const), allowFailure: true });
  let bestUsdg: { pool: Address; l: bigint } | undefined;
  upLiq.forEach((r, i) => {
    if (r.status !== "success") return;
    const l = r.result as bigint;
    if (l > 0n && (!bestUsdg || l > bestUsdg.l)) bestUsdg = { pool: up[i], l };
  });
  return bestUsdg ? { path: [v4Hop(ethUsdgKey()), v3Hop(bestUsdg.pool)], label: "ETH → USDG → asset" } : null;
}
