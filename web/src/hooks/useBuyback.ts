"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Address, type Hex } from "viem";
import { BuybackTreasuryAbi, TokenAbi } from "@/lib/abis";
import { ADDRESSES, OFFICIAL, START_BLOCK, isZero } from "@/lib/addresses";

export type BuybackBurn = { usdgIn: bigint; tickrOut: bigint; caller: Address; blockNumber: bigint; txHash: Hex };

export type BuybackState = {
  earmarked: bigint;
  spent: bigint;
  burned: bigint;
  burnedPct?: number; // of TICKR supply, 0..1
  lastBuyAt: number;
  nextBuyAt: number;
  readyIn: number; // seconds until the next buy, 0 when ready
  previewIn: bigint;
  previewMin: bigint;
  history: BuybackBurn[];
};

const BOUGHT = parseAbiItem("event BoughtAndBurned(uint256 usdgIn, uint256 tickrOut, address indexed caller)");

/**
 * The buyback treasury for TICKR: what is set aside, what it has spent and burned, when the next buy may fire, and
 * the last twenty buys. Everything is read on chain; nothing here is set by the site.
 */
export function useBuyback() {
  const client = usePublicClient();
  const treasury = ADDRESSES.buybackTreasury;
  const tickr = OFFICIAL.token;
  const enabled = !!client && !isZero(treasury) && !isZero(tickr);

  return useQuery({
    queryKey: ["buyback", treasury, tickr],
    enabled,
    refetchInterval: 20_000,
    queryFn: async (): Promise<BuybackState | null> => {
      if (!client || isZero(treasury) || isZero(tickr)) return null;
      const t = { abi: BuybackTreasuryAbi, address: treasury } as const;
      const [earmarked, spent, burned, lastBuyAt, nextBuyAt, preview, supply] = await Promise.all([
        client.readContract({ ...t, functionName: "earmarkedUsdg" }) as Promise<bigint>,
        client.readContract({ ...t, functionName: "totalUsdgSpent" }) as Promise<bigint>,
        client.readContract({ ...t, functionName: "totalTickrBurned" }) as Promise<bigint>,
        client.readContract({ ...t, functionName: "lastBuyAt" }) as Promise<bigint>,
        client.readContract({ ...t, functionName: "nextBuyAt" }) as Promise<bigint>,
        client.readContract({ ...t, functionName: "previewBuy" }).catch(() => [0n, 0n] as const) as Promise<readonly [bigint, bigint]>,
        client.readContract({ abi: TokenAbi, address: tickr, functionName: "totalSupply" }).catch(() => 0n) as Promise<bigint>,
      ]);
      const now = Math.floor(Date.now() / 1000);
      const next = Number(nextBuyAt);
      let history: BuybackBurn[] = [];
      try {
        const logs = await client.getLogs({ address: treasury, event: BOUGHT, fromBlock: START_BLOCK, toBlock: "latest" });
        history = logs
          .map((l) => ({ usdgIn: l.args.usdgIn!, tickrOut: l.args.tickrOut!, caller: l.args.caller!, blockNumber: l.blockNumber!, txHash: l.transactionHash! }))
          .reverse()
          .slice(0, 20);
      } catch {
        // an RPC that will not scan logs still shows the totals
      }
      return {
        earmarked,
        spent,
        burned,
        burnedPct: supply > 0n ? Number((burned * 1_000_000n) / supply) / 1_000_000 : undefined,
        lastBuyAt: Number(lastBuyAt),
        nextBuyAt: next,
        readyIn: next === 0 || now >= next ? 0 : next - now,
        previewIn: preview[0],
        previewMin: preview[1],
        history,
      };
    },
  });
}
