import type { Address, Hex } from "viem";
import { toHex } from "viem";
import { ADDRESSES, ZERO } from "./addresses";
import { poolIdOf, slot0Slot } from "./pool";

/** A Uniswap v4 pool key, in the shape the ZapRouter expects. */
export type V4Key = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** The canonical ETH/USDG v4 pool on Robinhood Chain (fee 0.01%), the deepest of the four tiers. */
export function ethUsdgKey(): V4Key {
  return { currency0: ZERO, currency1: ADDRESSES.usdg, fee: 100, tickSpacing: 1, hooks: ZERO };
}

/** One hop of a zap route: kind 0 is a Uniswap v4 pool key, kind 1 a Uniswap v3 pool address, kind 2 an
 *  invented ticker (a one-for-one wrapper of USDG): the router mints on the way in and redeems on the way out. */
export type Hop = { kind: number; key: V4Key; pool: Address };

const EMPTY_KEY: V4Key = { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO };

export function v4Hop(key: V4Key): Hop {
  return { kind: 0, key, pool: ZERO };
}

export function v3Hop(pool: Address): Hop {
  return { kind: 1, key: EMPTY_KEY, pool };
}

export function wrapHop(ticker: Address): Hop {
  return { kind: 2, key: EMPTY_KEY, pool: ticker };
}

export function hopId(h: Hop): string {
  if (h.kind === 1) return `v3:${h.pool}`;
  if (h.kind === 2) return `wrap:${h.pool}`;
  return `v4:${h.key.currency0}:${h.key.currency1}:${h.key.fee}:${h.key.hooks}`;
}

/** A buy route walked backwards is the sell route. */
export function reverseRoute(path: Hop[]): Hop[] {
  return [...path].reverse();
}

export const V3_FEES = [100, 500, 3000, 10000] as const;

export const FEE_TIERS: ReadonlyArray<{ fee: number; tickSpacing: number }> = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];

export function keyOf(a: Address, b: Address, fee: number, tickSpacing: number, hooks: Address = ZERO): V4Key {
  const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0: c0, currency1: c1, fee, tickSpacing, hooks };
}

export function idOf(k: V4Key): Hex {
  return poolIdOf(k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks);
}

/** Pool.State.liquidity sits three slots after slot0. */
export function liquiditySlot(poolId: Hex): Hex {
  return toHex(BigInt(slot0Slot(poolId)) + 3n, { size: 32 });
}

