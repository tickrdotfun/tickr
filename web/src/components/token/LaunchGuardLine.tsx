"use client";

import { useReadContract } from "wagmi";
import { useEvmBlockNumber } from "@/hooks/useEvmBlockNumber";
import { protectionOn } from "@/lib/evmBlock";
import type { TokenData } from "@/hooks/useTokenData";

/** One line while a coin's launch protection is on: the first two blocks after launch, five percent per wallet. Said as the best-effort deterrent it is. */
export function LaunchGuardLine({ d }: { d: TokenData }) {
  const { launch } = d;
  // the end block is a constant of the coin; the current block is polled only until it is past. both are EVM block
  // numbers, which on this chain are Ethereum's, not the RPC's height (lib/evmBlock.ts)
  const ends = useReadContract({ abi: TOKEN_GUARD_ABI, address: launch?.token, functionName: "protectionEndsAtBlock", query: { enabled: !!launch, staleTime: Infinity } });
  const endsAt = ends.data;
  const blockNow = useEvmBlockNumber({ enabled: !!launch && endsAt !== undefined, until: endsAt, everyMs: 2_000 });
  if (!protectionOn(blockNow, endsAt)) return null;
  return <p className="detail-note detail-note-tight">launch protection is on: the first two blocks, 5% of supply per wallet, bought or received. it holds for ordinary routers; a bot that keeps its coins as claims inside uniswap can sidestep it. sells of this coin are never limited.</p>;
}

const TOKEN_GUARD_ABI = [{ type: "function", name: "protectionEndsAtBlock", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
