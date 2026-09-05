"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Hex } from "viem";
import { poolManagerAbi } from "@/lib/extraAbis";
import { ADDRESSES, DEPLOYED } from "@/lib/addresses";
import { POLL_MS } from "@/lib/constants";
import { poolIdOf, slot0Slot, sqrtPriceFromSlot0, tokenPriceInQuote } from "@/lib/pool";

const ETH = "0x0000000000000000000000000000000000000000";

/** Dollars per ETH, read from the canonical ETH/USDG pool (fee 0.01%). `undefined` while unknown or unreadable. */
export function useEthUsd() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["ethUsd"],
    enabled: !!client && DEPLOYED,
    refetchInterval: POLL_MS * 2,
    queryFn: async (): Promise<number | null> => {
      if (!client) return null;
      try {
        const id = poolIdOf(ETH, ADDRESSES.usdg, 100, 1, ETH);
        const slot = await client.readContract({ abi: poolManagerAbi, address: ADDRESSES.poolManager, functionName: "extsload", args: [slot0Slot(id)] });
        const sqrt = sqrtPriceFromSlot0(slot as Hex);
        return sqrt > 0n ? tokenPriceInQuote(sqrt, true, 18, 6) : null;
      } catch {
        return null;
      }
    },
  });
}
