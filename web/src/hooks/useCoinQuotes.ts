"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { CoinQuoteLauncherAbi, TokenAbi } from "@/lib/abis";
import { ADDRESSES, isZero } from "@/lib/addresses";
import { useLaunches } from "./useLaunches";

export type QuoteCoin = { address: Address; name: string; symbol: string; logo: string };

/**
 * Coins that may currently be used as a quote: launched by this factory, with a live pool, and themselves
 * priced against a real anchor. `isEligibleQuote` never reverts, so the whole list can be filtered on-chain.
 */
export function useEligibleQuoteCoins() {
  const client = usePublicClient();
  const launches = useLaunches();
  const tokens = (launches.data ?? []).map((l) => l.token);
  const enabled = !!client && tokens.length > 0 && !isZero(ADDRESSES.coinQuoteLauncher);

  return useQuery({
    queryKey: ["eligibleQuoteCoins", tokens.join(",")],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<QuoteCoin[]> => {
      if (!client) return [];
      const eligible = await client.multicall({
        contracts: tokens.map(
          (t) =>
            ({
              abi: CoinQuoteLauncherAbi,
              address: ADDRESSES.coinQuoteLauncher,
              functionName: "isEligibleQuote",
              args: [t],
            }) as const,
        ),
        allowFailure: true,
      });
      const ok = tokens.filter((_, i) => eligible[i]?.status === "success" && eligible[i].result === true);
      if (ok.length === 0) return [];
      const meta = await client.multicall({
        contracts: ok.flatMap(
          (t) =>
            [
              { abi: TokenAbi, address: t, functionName: "name" } as const,
              { abi: TokenAbi, address: t, functionName: "symbol" } as const,
              { abi: TokenAbi, address: t, functionName: "logo" } as const,
            ] as const,
        ),
        allowFailure: true,
      });
      const read = (i: number) => (meta[i]?.status === "success" ? String(meta[i].result) : "");
      return ok.map((address, i) => ({
        address,
        name: read(i * 3) || address,
        symbol: read(i * 3 + 1),
        logo: read(i * 3 + 2),
      }));
    },
  });
}
