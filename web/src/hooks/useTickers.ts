"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { TickerLauncherAbi, TickerTokenAbi } from "@/lib/abis";
import { ADDRESSES, isZero } from "@/lib/addresses";

/**
 * An invented ticker: a one-for-one wrapper of USDG with the symbol somebody typed. `counterAsset` is what it
 * wraps. Nobody owns it.
 */
export type InventedTicker = { quoteToken: Address; ticker: string; counterAsset: Address };

/** Every ticker invented so far, oldest first, straight from the launcher's list. */
export function useTickers() {
  const client = usePublicClient();
  const enabled = !!client && !isZero(ADDRESSES.tickerLauncher);
  return useQuery({
    queryKey: ["tickers"],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<InventedTicker[]> => {
      if (!client) return [];
      const launcher = { abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher } as const;
      const count = Number(await client.readContract({ ...launcher, functionName: "tickerCount" }));
      if (count === 0) return [];
      const at = await client.multicall({
        contracts: Array.from({ length: count }, (_, i) => ({ ...launcher, functionName: "tickerAt", args: [BigInt(i)] }) as const),
        allowFailure: true,
      });
      const addrs = at.flatMap((m) => (m.status === "success" ? [m.result as Address] : []));
      if (addrs.length === 0) return [];
      const info = await client.multicall({
        contracts: addrs.flatMap((a) => [
          { abi: TickerTokenAbi, address: a, functionName: "symbol" } as const,
          { abi: TickerTokenAbi, address: a, functionName: "counter" } as const,
        ]),
        allowFailure: true,
      });
      const out: InventedTicker[] = [];
      addrs.forEach((a, i) => {
        const sym = info[i * 2];
        const counter = info[i * 2 + 1];
        if (sym.status !== "success" || counter.status !== "success") return;
        out.push({ quoteToken: a, ticker: String(sym.result), counterAsset: counter.result as Address });
      });
      return out;
    },
  });
}
