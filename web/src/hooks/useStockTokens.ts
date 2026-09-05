"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { StockQuoteLauncherAbi } from "@/lib/abis";
import { ADDRESSES, isZero } from "@/lib/addresses";
import { useQuoteAssets } from "./useQuoteAssets";

export type StockToken = { address: Address; ticker: string; issuer: string; symbol: string; decimals: number; priceUsd?: number };

/**
 * Every official Stock Token registered and active in the AnchorRegistry. `priceUsd` is present only when the asset
 * has a live Chainlink feed, which is what the launcher uses to size the threshold. Assets without one are still
 * listed, because they are official, but they cannot be quoted until a feed is published for them.
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
      const prices = await client.multicall({
        contracts: stocks.map(
          (s) => ({ abi: StockQuoteLauncherAbi, address: launcher, functionName: "stockPrice", args: [s.address] }) as const,
        ),
        allowFailure: true,
      });
      const out: StockToken[] = stocks.map((s, i) => {
        const r = prices[i];
        const base = { address: s.address, ticker: s.ticker, issuer: s.issuer, symbol: s.symbol, decimals: s.decimals };
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
