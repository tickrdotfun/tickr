"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { erc20Abi, type Address } from "viem";
import { FactoryAbi, StockQuoteLauncherAbi, TickerLauncherAbi, TickerTokenAbi } from "@/lib/abis";
import { ADDRESSES, isZero } from "@/lib/addresses";
import stocks from "@/data/stocks.json";

/** What the explorer and Robinhood's registry say about an address: see app/api/pair/[address]/route.ts. */
export type PairApi = {
  address: string;
  genuine: { symbol: string; name: string; isin: string; feed: string; issuer: string; registry: string; syncedAt: string } | null;
  looksOfficial: boolean;
  lookalike: boolean;
  token: { name?: string; symbol?: string; decimals?: number; holders?: number; totalSupply?: string; priceUsd?: number; volume24hUsd?: number; marketCapUsd?: number; icon?: string } | null;
  contract: { isContract?: boolean; verified?: boolean; creator?: string; creationTx?: string; createdAt?: string };
  lookalikes: { count: number; holders: number; sample: { address: string; name: string; holders: number }[] };
};

export type PairKind = "stock" | "ticker" | "coin" | "usdg" | "native" | "other";

export type PairOnChain = {
  kind: PairKind;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  hasCode: boolean;
  /** stock: the launcher's feed price, if the asset has a feed */
  feedPriceUsd?: number;
  /** ticker: what the wrapper holds and has issued, and how many coins are under it */
  reserve?: bigint;
  coinsUnder?: number;
  /** coin: the launch record */
  pairToken?: Address;
  creator?: Address;
  phantomQuote?: bigint;
  launchedAt?: number;
};

export function usePairApi(address?: Address) {
  return useQuery({
    queryKey: ["pair-api", address?.toLowerCase()],
    enabled: !!address,
    staleTime: 60_000,
    queryFn: async (): Promise<PairApi> => {
      const r = await fetch(`/api/pair/${address}`);
      if (!r.ok) throw new Error(`explorer lookup failed (${r.status})`);
      return (await r.json()) as PairApi;
    },
  });
}

/**
 * The chain's own view of an address as a pair: which of tickr's pair kinds it is, and the facts that kind
 * carries. Everything is read live from the contracts; nothing here trusts a name.
 */
export function usePairOnChain(address?: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["pair-chain", address?.toLowerCase()],
    enabled: !!client && !!address,
    staleTime: 15_000,
    queryFn: async (): Promise<PairOnChain> => {
      if (!client || !address) throw new Error("no client");
      if (isZero(address)) return { kind: "native", symbol: "ETH", name: "native ETH", decimals: 18, hasCode: false };
      const code = await client.getCode({ address }).catch(() => undefined);
      const hasCode = !!code && code !== "0x";
      const meta = await client.multicall({
        contracts: [
          { abi: erc20Abi, address, functionName: "name" },
          { abi: erc20Abi, address, functionName: "symbol" },
          { abi: erc20Abi, address, functionName: "decimals" },
          { abi: erc20Abi, address, functionName: "totalSupply" },
        ],
        allowFailure: true,
      });
      const g = <T,>(i: number) => (meta[i]?.status === "success" ? (meta[i].result as T) : undefined);
      const base: PairOnChain = { kind: "other", name: g<string>(0), symbol: g<string>(1), decimals: g<number>(2), totalSupply: g<bigint>(3), hasCode };
      if (address.toLowerCase() === ADDRESSES.usdg.toLowerCase()) return { ...base, kind: "usdg" };

      const inRegistry = stocks.assets.some((s) => s.address.toLowerCase() === address.toLowerCase());
      if (inRegistry) {
        let feedPriceUsd: number | undefined;
        if (!isZero(ADDRESSES.stockQuoteLauncher)) {
          const p = await client
            .readContract({ abi: StockQuoteLauncherAbi, address: ADDRESSES.stockQuoteLauncher, functionName: "stockPrice", args: [address] })
            .catch(() => undefined);
          if (p) feedPriceUsd = Number(p[0]) / 10 ** Number(p[1]);
        }
        return { ...base, kind: "stock", feedPriceUsd };
      }

      if (!isZero(ADDRESSES.tickerLauncher)) {
        const isTicker = await client.readContract({ abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "isTicker", args: [address] }).catch(() => false);
        if (isTicker) {
          const [reserve, count] = await Promise.all([
            client.readContract({ abi: TickerTokenAbi, address, functionName: "reserve" }).catch(() => 0n),
            client.readContract({ abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "pairCount", args: [address] }).catch(() => 0n),
          ]);
          return { ...base, kind: "ticker", reserve, coinsUnder: Number(count) };
        }
      }

      if (!isZero(ADDRESSES.factory)) {
        const l = await client.readContract({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "getLaunchedToken", args: [address] }).catch(() => undefined);
        if (l?.exists) return { ...base, kind: "coin", pairToken: l.pairToken, creator: l.creatorFeeRecipient, phantomQuote: l.phantomQuote, launchedAt: Number(l.launchedAt) };
      }
      return base;
    },
  });
}
