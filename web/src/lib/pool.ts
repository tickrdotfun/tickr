import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export const Q96 = 2 ** 96;

/** Uniswap v4 PoolId = keccak256(abi.encode(PoolKey)). Currencies must already be sorted. */
export function poolIdOf(currency0: Address, currency1: Address, fee: number, tickSpacing: number, hooks: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, fee, tickSpacing, hooks],
    ),
  );
}

export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/** Storage slot of Pool.State.slot0 for a pool: keccak256(abi.encode(poolId, uint256(6))). `_pools` lives at slot 6. */
export function slot0Slot(poolId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
}

/** slot0 packs sqrtPriceX96 in its low 160 bits. */
export function sqrtPriceFromSlot0(slot0: Hex): bigint {
  return BigInt(slot0) & ((1n << 160n) - 1n);
}

/** Raw price of currency1 per currency0 (base units), as a float. */
export function rawPriceFromSqrt(sqrtPriceX96: bigint): number {
  const s = Number(sqrtPriceX96) / Q96;
  return s * s;
}

/**
 * Human-readable price of `token` in `quote`, from a pool's sqrtPriceX96.
 * tokenIs0: whether the launch token is currency0 of the pool.
 */
export function tokenPriceInQuote(
  sqrtPriceX96: bigint,
  tokenIs0: boolean,
  tokenDecimals: number,
  quoteDecimals: number,
): number {
  const p = rawPriceFromSqrt(sqrtPriceX96);
  if (p === 0) return 0;
  const quotePerTokenRaw = tokenIs0 ? p : 1 / p;
  return quotePerTokenRaw * 10 ** (tokenDecimals - quoteDecimals);
}

export const BPS = 10_000n;
const Q96N = 1n << 96n;

/** Scale an amount down by `slippageBps`, for a minimum-out bound. */
export function applySlippage(amount: bigint, slippageBps: number): bigint {
  const s = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (amount * (BPS - s)) / BPS;
}

/** sqrt(1.0001^tick), as a float. Precise enough for reserves shown on a page. */
export function sqrtAtTick(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/**
 * The quote asset sitting in the locked launch position, in raw units. The position is one-sided at launch
 * and the coin's side sits on the far side of the price, so every buy leaves quote inside the range:
 * with the coin as currency0 the quote is currency1 and amount1 = L (sqrtP - sqrtLower); with the coin as
 * currency1 the quote is currency0 and amount0 = L (sqrtUpper - sqrtP) / (sqrtP sqrtUpper).
 */
export function positionQuoteReserve(p: { liquidity: bigint; sqrtPriceX96: bigint; tickLower: number; tickUpper: number; tokenIs0: boolean }): number {
  const L = Number(p.liquidity);
  const sp = Number(p.sqrtPriceX96) / Q96;
  if (!(L > 0) || !(sp > 0)) return 0;
  if (p.tokenIs0) {
    const lo = sqrtAtTick(p.tickLower);
    return Math.max(0, L * (sp - lo));
  }
  const hi = sqrtAtTick(p.tickUpper);
  return Math.max(0, (L * (hi - sp)) / (sp * hi));
}

/**
 * Exact-input quote for one hop of a pool that holds one position around the price: constant product on the
 * live liquidity and sqrt price, the LP fee taken from the input. Exact until the swap crosses a tick, which
 * a launch pool only does when the position runs out; the on-chain minimum-out guards the rest.
 */
export function quoteExactIn(p: { amountIn: bigint; liquidity: bigint; sqrtPriceX96: bigint; feePips: number; zeroForOne: boolean }): bigint {
  const { amountIn, liquidity: L, sqrtPriceX96: sp } = p;
  if (amountIn <= 0n || L <= 0n || sp <= 0n) return 0n;
  const net = (amountIn * BigInt(1_000_000 - p.feePips)) / 1_000_000n;
  if (p.zeroForOne) {
    // paying currency0: sqrtNext = L Q96 sp / (L Q96 + net sp); out1 = L (sp - sqrtNext) / Q96
    const num = L * Q96N * sp;
    const den = L * Q96N + net * sp;
    const next = num / den;
    return (L * (sp - next)) / Q96N;
  }
  // paying currency1: sqrtNext = sp + net Q96 / L; out0 = L Q96 (sqrtNext - sp) / (sqrtNext sp)
  const next = sp + (net * Q96N) / L;
  return (L * Q96N * (next - sp)) / (next * sp);
}

/** A launch pool's key: currencies sorted, no hook. */
export function launchPoolKey(token: Address, pair: Address, fee: number, tickSpacing: number) {
  const [c0, c1] = sortCurrencies(pair, token);
  const hooks = "0x0000000000000000000000000000000000000000" as Address;
  return { currency0: c0, currency1: c1, fee, tickSpacing, hooks, id: poolIdOf(c0, c1, fee, tickSpacing, hooks), tokenIs0: c0.toLowerCase() === token.toLowerCase() };
}
