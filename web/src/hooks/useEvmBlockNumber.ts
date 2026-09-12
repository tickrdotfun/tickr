"use client";

import { useBlockNumber, useReadContract } from "wagmi";
import { EVM_BLOCK_SOURCE, MULTICALL3_BLOCK_ABI } from "@/lib/evmBlock";

/**
 * `block.number` as the chain's contracts see it, for comparing with a block a contract recorded (see evmBlock.ts).
 * Polled every `everyMs` until `until` is reached, then left alone. Without Multicall3 (a devnet built with
 * NEXT_PUBLIC_MULTICALL3=none) it falls back to the RPC height, which on such a chain is the same number.
 */
export function useEvmBlockNumber({ enabled, until, everyMs }: { enabled: boolean; until?: bigint; everyMs: number }): bigint | undefined {
  const done = (b: bigint | undefined) => until !== undefined && b !== undefined && b >= until;
  const evm = useReadContract({
    abi: MULTICALL3_BLOCK_ABI,
    address: EVM_BLOCK_SOURCE,
    functionName: "getBlockNumber",
    query: { enabled: enabled && !!EVM_BLOCK_SOURCE, refetchInterval: (q) => (done(q.state.data) ? false : everyMs) },
  });
  const rpc = useBlockNumber({ query: { enabled: enabled && !EVM_BLOCK_SOURCE, refetchInterval: (q) => (done(q.state.data) ? false : everyMs) } });
  return EVM_BLOCK_SOURCE ? evm.data : rpc.data;
}
