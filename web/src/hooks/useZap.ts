"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { BaseError, ContractFunctionRevertedError, encodeAbiParameters, keccak256, maxUint256, toHex, type Address, type Hex } from "viem";
import { ZapRouterAbi } from "@/lib/abis";
import { ADDRESSES, ZERO, isZero } from "@/lib/addresses";
import { hopId, type Hop } from "@/lib/route";

export type ZapPreview = { quoteOut: bigint; tokensOut: bigint };
export type ZapSellPreview = { quoteOut: bigint; amountOut: bigint };

/** Storage slot of `_allowances` in the launch Token (OpenZeppelin ERC20 layout, from `forge inspect`). */
const TOKEN_ALLOWANCE_SLOT = 1n;

/** Recipient used for quoting before a wallet is connected: the coin refuses transfers to the zero address. */
const PREVIEW_RECIPIENT: Address = "0x000000000000000000000000000000000000dEaD";
/** A quote is a simulation, never sent: a fixed far-off deadline keeps its calldata the same from one call to the
 *  next, so a recorded preview replays and two quotes of one route are one read. A real send gets a real deadline. */
const PREVIEW_DEADLINE = 4_102_444_800n; // 2100-01-01

/** A buy: `tokenIn` is what the caller pays (ETH by default), `path` ends in the coin's own pool. */
export function zapParams(token: Address, path: Hop[], recipient: Address, minTokensOut = 0n, tokenIn: Address = ZERO, amountIn = 0n, deadline?: bigint) {
  return {
    token,
    tokenIn,
    amountIn,
    path,
    minTokensOut,
    recipient,
    deadline: deadline ?? BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
  };
}

export type Client = NonNullable<ReturnType<typeof usePublicClient>>;

/** One quote of a buy paid in ETH: `previewZap` always reverts with `Preview(quoteOut, tokensOut)`. */
export async function previewZapOnce(client: Client, token: Address, path: Hop[], valueWei: bigint, from?: Address): Promise<ZapPreview | null> {
  try {
    await client.simulateContract({
      abi: ZapRouterAbi,
      address: ADDRESSES.zapRouter,
      functionName: "previewZap",
      args: [zapParams(token, path, from ?? PREVIEW_RECIPIENT, 0n, ZERO, 0n, PREVIEW_DEADLINE)],
      value: valueWei,
      account: from,
    });
    return null; // cannot happen: previewZap always reverts
  } catch (e) {
    if (e instanceof BaseError) {
      const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === "Preview") {
        const [quoteOut, tokensOut] = revert.data.args as readonly [bigint, bigint];
        return { quoteOut, tokensOut };
      }
    }
    throw e;
  }
}

/**
 * Quote a buy paid in ETH by simulating `previewZap`, which always reverts with `Preview(quoteOut, tokensOut)`.
 * Re-runs whenever the ETH amount or route changes.
 */
export function useZapPreview(token: Address | undefined, path: Hop[] | null | undefined, valueWei: bigint | undefined, from: Address | undefined) {
  const client = usePublicClient();
  const enabled = !!client && !!token && !!path && !!valueWei && valueWei > 0n && !isZero(ADDRESSES.zapRouter);
  return useQuery({
    // the account is part of the quote: the coin taxes and caps by recipient, and the preview simulates as `from`
    queryKey: ["zapPreview", token, valueWei?.toString(), path?.map(hopId).join("|"), from],
    enabled,
    refetchInterval: 5_000,
    queryFn: async (): Promise<ZapPreview | null> => {
      if (!client || !token || !path || !valueWei) return null;
      return previewZapOnce(client, token, path, valueWei, from);
    },
  });
}

/** One quote of a sell, simulated with an allowance the seller may not have granted yet. */
export async function previewZapSellOnce(client: Client, token: Address, path: Hop[], amountIn: bigint, from: Address, tokenOut: Address = ZERO): Promise<ZapSellPreview | null> {
  try {
    await client.simulateContract({
      abi: ZapRouterAbi,
      address: ADDRESSES.zapRouter,
      functionName: "previewZapSell",
      args: [zapSellParams(token, amountIn, path, from, 0n, tokenOut, PREVIEW_DEADLINE)],
      account: from,
      stateOverride: [{ address: token, stateDiff: [{ slot: allowanceSlot(from, ADDRESSES.zapRouter), value: toHex(maxUint256, { size: 32 }) }] }],
    });
    return null;
  } catch (e) {
    if (e instanceof BaseError) {
      const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === "Preview") {
        const [quoteOut, amountOut] = revert.data.args as readonly [bigint, bigint];
        return { quoteOut, amountOut };
      }
    }
    throw e;
  }
}

/** A sell: `path` starts with the coin's own pool and ends where `tokenOut` is (ETH by default). */
export function zapSellParams(token: Address, amountIn: bigint, path: Hop[], recipient: Address, minOut = 0n, tokenOut: Address = ZERO, deadline?: bigint) {
  return {
    token,
    amountIn,
    path,
    tokenOut,
    minOut,
    recipient,
    deadline: deadline ?? BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
  };
}

/** The slot holding `allowance(owner, spender)` in the launch Token. */
function allowanceSlot(owner: Address, spender: Address): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, TOKEN_ALLOWANCE_SLOT]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, inner]));
}

/**
 * Quote a sell by simulating `previewZapSell`, which always reverts with `Preview(quoteOut, amountOut)`.
 * The router pulls the coins with transferFrom, so the simulation overrides the seller's allowance to the router;
 * that way the quote is exact before the seller has approved anything.
 */
export function useZapSellPreview(
  token: Address | undefined,
  path: Hop[] | null | undefined,
  amountIn: bigint | undefined,
  from: Address | undefined,
  tokenOut: Address = ZERO,
) {
  const client = usePublicClient();
  const enabled = !!client && !!token && !!path && !!amountIn && amountIn > 0n && !!from && !isZero(ADDRESSES.zapRouter);
  return useQuery({
    queryKey: ["zapSellPreview", token, amountIn?.toString(), from, tokenOut, path?.map(hopId).join("|")],
    enabled,
    refetchInterval: 5_000,
    queryFn: async (): Promise<ZapSellPreview | null> => {
      if (!client || !token || !path || !amountIn || !from) return null;
      return previewZapSellOnce(client, token, path, amountIn, from, tokenOut);
    },
  });
}
