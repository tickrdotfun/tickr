"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { erc20Abi, type Address } from "viem";
import { AnchorRegistryAbi, FactoryAbi, TickerLauncherAbi } from "@/lib/abis";
import { ADDRESSES, DEPLOYED, ZERO, isZero, sameAddr } from "@/lib/addresses";

export type AnchorKind = 0 | 1 | 2; // native, stable, official stock

export type QuoteAsset = {
  address: Address;
  ticker: string;
  issuer: string;
  kind: AnchorKind;
  active: boolean;
  approved: boolean; // factory.approvedPairTokens
  decimals: number;
  symbol: string;
};

/** Every anchor in the registry with its factory approval + ERC-20 metadata. */
export function useQuoteAssets() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["quoteAssets", ADDRESSES.anchorRegistry],
    enabled: !!client && DEPLOYED && !isZero(ADDRESSES.anchorRegistry),
    staleTime: 60_000,
    queryFn: async (): Promise<QuoteAsset[]> => {
      if (!client) return [];
      const reg = ADDRESSES.anchorRegistry;
      const count = Number(await client.readContract({ abi: AnchorRegistryAbi, address: reg, functionName: "anchorCount" }));
      if (count === 0) return [];
      const addrs = await client.multicall({
        contracts: Array.from({ length: count }, (_, i) => ({ abi: AnchorRegistryAbi, address: reg, functionName: "anchorAt", args: [BigInt(i)] } as const)),
        allowFailure: false,
      });
      const anchors = await client.multicall({
        contracts: addrs.map((a) => ({ abi: AnchorRegistryAbi, address: reg, functionName: "anchorOf", args: [a] } as const)),
        allowFailure: false,
      });
      const approved = await client.multicall({
        contracts: addrs.map((a) => ({ abi: FactoryAbi, address: ADDRESSES.factory, functionName: "approvedPairTokens", args: [a] } as const)),
        allowFailure: true,
      });
      const meta = await client.multicall({
        contracts: addrs.flatMap((a) =>
          isZero(a)
            ? []
            : [
                { abi: erc20Abi, address: a, functionName: "decimals" } as const,
                { abi: erc20Abi, address: a, functionName: "symbol" } as const,
              ],
        ),
        allowFailure: true,
      });
      let m = 0;
      return addrs.map((address, i) => {
        const a = anchors[i];
        let decimals = 18;
        let symbol = a.ticker;
        if (!isZero(address)) {
          const d = meta[m++];
          const s = meta[m++];
          if (d.status === "success") decimals = Number(d.result);
          if (s.status === "success") symbol = String(s.result);
        }
        return {
          address,
          ticker: a.ticker,
          issuer: a.issuer,
          kind: a.kind as AnchorKind,
          active: a.active,
          approved: approved[i].status === "success" ? Boolean(approved[i].result) : isZero(address),
          decimals,
          symbol,
        };
      });
    },
  });
}

export type QuoteMeta = {
  address: Address;
  symbol: string;
  decimals: number;
  kind: "native" | "stable" | "official" | "ticker" | "erc20";
  ticker: string; // anchor ticker (official) or the invented ticker's symbol
  label: string; // short chip text
};

/** Resolve what a launch's pair token is: ETH / USDG / official stock / an invented ticker. */
export function useQuoteMeta(pairToken?: Address, memeToken?: Address) {
  const client = usePublicClient();
  const anchors = useQuoteAssets();
  return useQuery({
    queryKey: ["quoteMeta", pairToken, memeToken, anchors.data?.length ?? 0],
    enabled: !!client && !!pairToken && (isZero(pairToken) || anchors.isFetched || anchors.isError || isZero(ADDRESSES.anchorRegistry)),
    staleTime: 60_000,
    queryFn: async (): Promise<QuoteMeta> => {
      if (!client || !pairToken) throw new Error("no pair");
      if (isZero(pairToken)) return { address: ZERO, symbol: "ETH", decimals: 18, kind: "native", ticker: "ETH", label: "ETH" };
      const anchor = anchors.data?.find((a) => sameAddr(a.address, pairToken));
      if (anchor) {
        const kind = anchor.kind === 1 ? "stable" : anchor.kind === 2 ? "official" : "erc20";
        return { address: pairToken, symbol: anchor.symbol, decimals: anchor.decimals, kind, ticker: anchor.ticker, label: anchor.ticker };
      }
      // Not an anchor: an invented ticker (a coin born in its pool) or a plain ERC-20 approved for this launch only.
      const [dec, sym, tick] = await client.multicall({
        contracts: [
          { abi: erc20Abi, address: pairToken, functionName: "decimals" },
          { abi: erc20Abi, address: pairToken, functionName: "symbol" },
          { abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "isTicker", args: [pairToken] },
        ],
        allowFailure: true,
      });
      const decimals = dec.status === "success" ? Number(dec.result) : 18;
      const symbol = sym.status === "success" ? String(sym.result) : "QUOTE";
      const isTicker = !isZero(ADDRESSES.tickerLauncher) && tick.status === "success" && tick.result === true;
      if (isTicker) return { address: pairToken, symbol, decimals, kind: "ticker", ticker: symbol, label: `${symbol}*` };
      return { address: pairToken, symbol, decimals, kind: "erc20", ticker: symbol, label: symbol };
    },
  });
}
