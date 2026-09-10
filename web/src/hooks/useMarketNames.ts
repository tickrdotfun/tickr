"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { erc20Abi, type Address } from "viem";
import { ADDRESSES, isZero, sameAddr } from "@/lib/addresses";
import { MARKET_DEPLOYER_ABI as MarketDeployerAbi } from "@/lib/nameKind";
import { TokenAbi } from "@/lib/abis";
import { loadLaunches } from "@/lib/launches";
import { isHidden } from "@/lib/hidden";
import { robinhoodChain } from "@/lib/chain";

/** A fixed-inventory name a coin can be launched under, and how much is already priced in it. */
export type MarketName = { address: Address; symbol: string; name: string; coins: number; logo?: string };

/**
 * Every fixed-inventory name in use, newest activity first.
 *
 * Derived from the launches rather than from a separate scan: a name only matters here if a coin is priced in
 * it, and every name this launcher makes gets its first coin in the same transaction. That also gives the coin
 * count for free, which is the one figure worth showing beside a name.
 *
 * A name has no image of its own: only a coin is created with one. The first coin launched under a name stands
 * in for it, which is also how people recognise the name in practice.
 *
 * No capitalisation is reported: a name's whole supply sits in its own pool, so the naive figure is the same
 * near-half-billion for every one of them and separates nothing.
 */
export function useMarketNames() {
  const client = usePublicClient();
  const enabled = !!client && !isZero(ADDRESSES.marketTickerDeployer);
  return useQuery({
    queryKey: ["market-names", ADDRESSES.marketTickerDeployer],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<MarketName[]> => {
      if (!client) return [];
      const launches = await loadLaunches(client);

      const counts = new Map<string, number>();
      const firstCoin = new Map<string, Address>();
      for (const l of launches) {
        if (isZero(l.pairToken) || isHidden(robinhoodChain.id, l.pairToken)) continue;
        const k = l.pairToken.toLowerCase();
        counts.set(k, (counts.get(k) ?? 0) + 1);
        if (!firstCoin.has(k)) firstCoin.set(k, l.token);
      }
      const candidates = [...counts.keys()] as Address[];
      if (candidates.length === 0) return [];

      // only the ones this issuer actually made: it answers with the token it created at that address, or zero
      const made = await client.multicall({
        contracts: candidates.map(
          (a) => ({ abi: MarketDeployerAbi, address: ADDRESSES.marketTickerDeployer, functionName: "market", args: [a] }) as const,
        ),
        allowFailure: true,
      });
      const names = candidates.filter((a, i) => {
        const m = made[i];
        return m.status === "success" && sameAddr((m.result as { token: Address }).token, a);
      });
      if (names.length === 0) return [];

      const meta = await client.multicall({
        contracts: names.flatMap((a) => [
          { abi: erc20Abi, address: a, functionName: "symbol" } as const,
          { abi: erc20Abi, address: a, functionName: "name" } as const,
        ]),
        allowFailure: true,
      });

      // the picture is the first coin's: a name never carries one
      const logoOf = new Map<string, string>();
      const withCoin = names.filter((a) => firstCoin.has(a.toLowerCase()));
      if (withCoin.length > 0) {
        const logos = await client.multicall({
          contracts: withCoin.map(
            (a) => ({ abi: TokenAbi, address: firstCoin.get(a.toLowerCase())!, functionName: "logo" }) as const,
          ),
          allowFailure: true,
        });
        withCoin.forEach((a, i) => {
          const r = logos[i];
          if (r?.status === "success" && typeof r.result === "string" && r.result.length > 0) {
            logoOf.set(a.toLowerCase(), r.result);
          }
        });
      }

      return names
        .map((a, i) => ({
          address: a,
          symbol: meta[i * 2]?.status === "success" ? (meta[i * 2].result as string) : "",
          name: meta[i * 2 + 1]?.status === "success" ? (meta[i * 2 + 1].result as string) : "",
          coins: counts.get(a.toLowerCase()) ?? 0,
          logo: logoOf.get(a.toLowerCase()),
        }))
        .filter((n) => n.symbol.length > 0)
        .sort((x, y) => y.coins - x.coins || x.symbol.localeCompare(y.symbol));
    },
  });
}
