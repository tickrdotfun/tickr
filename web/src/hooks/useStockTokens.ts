"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { AnchorRegistryAbi, StockQuoteLauncherAbi } from "@/lib/abis";
import { ADDRESSES, isZero } from "@/lib/addresses";
import { useQuoteAssets } from "./useQuoteAssets";

export type StockToken = {
  address: Address;
  ticker: string;
  issuer: string;
  symbol: string;
  decimals: number;
  priceUsd?: number;
  /** a feed is published for this asset, whether or not its last price is fresh enough to launch against */
  hasFeed: boolean;
};

/**
 * Every official Stock Token registered and active in the AnchorRegistry. `hasFeed` says a feed is published for the
 * asset; `priceUsd` is present only when that feed's last answer is also fresh enough for the launcher to size a
 * threshold against. The two differ over a weekend or a market holiday, when the feed exists and simply has not
 * printed since the close, so the two states are read separately and worded separately.
 */
export function useEligibleStockTokens() {
  const client = usePublicClient();
  const anchors = useQuoteAssets();
  const stocks = (anchors.data ?? []).filter((a) => a.kind === 2 && a.active);
  const key = stocks.map((s) => s.address).join(",");
  const enabled = !!client && stocks.length > 0 && !isZero(ADDRESSES.stockQuoteLauncher);

  return useQuery({
    queryKey: ["eligibleStockTokens", key],
    enabled,
    refetchInterval: 30_000,
    queryFn: async (): Promise<StockToken[]> => {
      if (!client) return [];
      const launcher = ADDRESSES.stockQuoteLauncher;
      const [prices, feeds] = await Promise.all([
        client.multicall({
          contracts: stocks.map(
            (s) => ({ abi: StockQuoteLauncherAbi, address: launcher, functionName: "stockPrice", args: [s.address] }) as const,
          ),
          allowFailure: true,
        }),
        client.multicall({
          contracts: stocks.map(
            (s) => ({ abi: AnchorRegistryAbi, address: ADDRESSES.anchorRegistry, functionName: "feedOf", args: [s.address] }) as const,
          ),
          allowFailure: true,
        }),
      ]);
      const out: StockToken[] = stocks.map((s, i) => {
        const r = prices[i];
        const f = feeds[i];
        const hasFeed = f?.status === "success" && !isZero(f.result as Address);
        const base = { address: s.address, ticker: s.ticker, issuer: s.issuer, symbol: s.symbol, decimals: s.decimals, hasFeed };
        if (r?.status !== "success") return base;
        const [price, feedDecimals] = r.result as readonly [bigint, number];
        return { ...base, priceUsd: Number(price) / 10 ** Number(feedDecimals) };
      });
      // priced assets first, then the rest, each alphabetical
      return out.sort((a, b) => {
        const pa = a.priceUsd === undefined ? 1 : 0;
        const pb = b.priceUsd === undefined ? 1 : 0;
        return pa - pb || a.ticker.localeCompare(b.ticker);
      });
    },
  });
}
