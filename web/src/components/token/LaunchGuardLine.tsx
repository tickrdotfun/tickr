"use client";

import { useBlockNumber, useReadContract } from "wagmi";
import type { TokenData } from "@/hooks/useTokenData";

/** One line while a coin's launch protection is on: the first two blocks after launch, five percent per wallet. */
export function LaunchGuardLine({ d }: { d: TokenData }) {
  const { launch } = d;
  // the end block is a constant of the coin; the current block is polled only until it is past
  const ends = useReadContract({ abi: TOKEN_GUARD_ABI, address: launch?.token, functionName: "protectionEndsAtBlock", query: { enabled: !!launch, staleTime: Infinity } });
  const endsAt = ends.data;
  const blockNo = useBlockNumber({
    query: { enabled: !!launch && endsAt !== undefined, refetchInterval: (q) => (endsAt !== undefined && q.state.data !== undefined && q.state.data >= endsAt ? false : 2_000) },
  });
  if (endsAt === undefined || blockNo.data === undefined || blockNo.data >= endsAt) return null;
  return <p className="detail-note detail-note-tight">launch protection is on: the first two blocks, 5% of supply per wallet, bought or received. sells of this coin are never limited.</p>;
}

const TOKEN_GUARD_ABI = [{ type: "function", name: "protectionEndsAtBlock", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
