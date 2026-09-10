"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { PublicClient } from "viem";
import type { V4Key } from "@/lib/route";
import { ADDRESSES, isZero } from "@/lib/addresses";

/** Uniswap's v4 quoter: it runs the swap across every range the pool has and reverts the result back out. */
const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/**
 * An executable quote for one pool, from the quoter, when one is wired: what a swap of `amountIn` would return
 * across every position in the pool, not only the one at the price. Disabled where no quoter is recorded, and the
 * caller falls back to its own estimate.
 */
/**
 * The same quote, once, on demand. A buy paid in the quote asset has no zap preview to refresh against, so this
 * is what it refreshes against instead: without it the floor for such a buy would be built from whatever number
 * was last on screen, however old, which is the case this exists to close.
 */
export async function quoterQuoteOnce(
  client: PublicClient,
  key: V4Key,
  zeroForOne: boolean,
  amountIn: bigint,
): Promise<bigint | null> {
  if (isZero(ADDRESSES.v4Quoter) || amountIn <= 0n) return null;
  const [amountOut] = (await client.readContract({
    abi: QUOTER_ABI,
    address: ADDRESSES.v4Quoter,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks }, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
  })) as [bigint, bigint];
  return amountOut;
}

export function useQuoterQuote(key: V4Key | undefined, zeroForOne: boolean | undefined, amountIn: bigint | undefined) {
  const client = usePublicClient();
  const enabled = !!client && !!key && zeroForOne !== undefined && !!amountIn && amountIn > 0n && amountIn < 2n ** 128n && !isZero(ADDRESSES.v4Quoter);
  return useQuery({
    queryKey: ["quoter", key ? `${key.currency0}-${key.currency1}-${key.fee}-${key.tickSpacing}-${key.hooks}` : "", zeroForOne, amountIn?.toString()],
    enabled,
    refetchInterval: 5_000,
    queryFn: async (): Promise<bigint | null> => {
      if (!client || !key || zeroForOne === undefined || !amountIn) return null;
      const [amountOut] = await client.readContract({
        abi: QUOTER_ABI,
        address: ADDRESSES.v4Quoter,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks }, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
      });
      return amountOut;
    },
  });
}
