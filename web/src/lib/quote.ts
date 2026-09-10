
/**
 * What a quote is worth, and what it costs.
 *
 * Three things get confused with each other and are kept apart here.
 *
 *  - **Route fees** are known in advance. Every hop charges its pool's fee, and a route through three pools
 *    charges three of them. A page that shows only the coin's pool fee understates what a trade costs.
 *  - **Price impact** is what moving the price costs, on top of the fees. It comes from comparing what the route
 *    returned with what it would have returned at the price before the trade.
 *  - **Slippage** is neither. It is the room the sender allows between quoting and landing, and it is the only
 *    one of the three the sender chooses.
 *
 * The minimum is built from the quote and the slippage, never from the impact, and it is never widened to make a
 * trade go through. A trade that will not clear its minimum is a trade that should not be sent.
 */

/** The whole route in basis points, for display, rounded once. */
export const totalFeeBps = (r: RouteFees) => Math.round(r.totalPips / 100);

/** A quote's shelf life. Past this it is refused rather than used. */
export const QUOTE_TTL_MS = 30_000;
export const DEFAULT_SLIPPAGE_BPS = 300;
export const MAX_SLIPPAGE_BPS = 5_000;
export const MIN_SLIPPAGE_BPS = 5;

export class QuoteRefused extends Error {}
const refuse = (why: string): never => {
  throw new QuoteRefused(why);
};


/**
 * One charge on the way through, in **pips**: hundredths of a basis point, which is the unit Uniswap states pool
 * fees in. Nothing is rounded until it is displayed, because rounding each leg first loses a hop's worth of
 * precision on a three hop route.
 *
 * `where` separates the three kinds, which are not the same money and should not be added up as if they were:
 *  - `coin`: the coin's own pool, which its creator and this protocol share
 *  - `bridge`: everything upstream of it, the name's market and the funding pool, which this protocol does not
 *  - `chain`: Uniswap v4's own protocol fee on a pool, taken off the input before the pool fee applies
 *  - `external`: what an outside app adds for routing there. Never known from here, and never assumed to be zero
 */
export type FeeWhere = "coin" | "bridge" | "chain" | "external";
export type FeeLeg = { label: string; pips: number; where: FeeWhere };

export const pipsToBps = (pips: number) => pips / 100;
/** For display only, and only at the end. */
export const pipsToPct = (pips: number) => pips / 10_000;

/** v4 packs a pool's protocol fee as two twelve bit halves: one per direction, each in pips. */
export function protocolFeePips(packed: number | bigint, zeroForOne: boolean): number {
  const v = Number(packed);
  if (!Number.isInteger(v) || v < 0 || v > 0xffffff) refuse(`a pool reported an impossible protocol fee (${packed})`);
  const half = zeroForOne ? v & 0xfff : (v >> 12) & 0xfff;
  if (half > 1_000) refuse(`a pool reported a protocol fee above v4's own ceiling (${half} pips)`);
  return half;
}

export type HopFees = {
  /** The pool's own fee, in pips, from its key. */
  poolPips: number;
  /** v4's protocol fee for the direction this hop is traded in, in pips. Undefined when it has not been read. */
  protocolPips?: number;
  where: FeeWhere;
  label: string;
};

export type RouteFees = {
  legs: FeeLeg[];
  /** Everything, compounded, in pips. */
  totalPips: number;
  /** Just the coin's own pool. */
  coinPips: number;
  /** Everything upstream of it. */
  bridgePips: number;
  /** v4's own take, across the route. */
  chainPips: number;
  /**
   * False when any hop's protocol fee was not read. The total is then a lower bound, not the answer, and a page
   * showing it must say so rather than presenting it as the whole cost.
   */
  complete: boolean;
};

/**
 * Every charge the route makes, kept apart and kept precise.
 *
 * A hop with an unread protocol fee contributes its pool fee and marks the result incomplete. It does not
 * contribute a zero, because a zero is a claim and an unread value is not.
 */
export function routeFees(hops: HopFees[]): RouteFees {
  const legs: FeeLeg[] = [];
  let complete = true;
  for (const h of hops) {
    if (!Number.isFinite(h.poolPips) || h.poolPips < 0 || h.poolPips >= 1_000_000) {
      refuse(`a hop reported an impossible pool fee (${h.poolPips} pips)`);
    }
    legs.push({ label: h.label, pips: h.poolPips, where: h.where });
    if (h.protocolPips === undefined) complete = false;
    else if (h.protocolPips > 0) legs.push({ label: `${h.label}, chain protocol fee`, pips: h.protocolPips, where: "chain" });
  }
  const sum = (where: FeeWhere) => compoundPips(legs.filter((l) => l.where === where).map((l) => l.pips));
  return {
    legs,
    totalPips: compoundPips(legs.map((l) => l.pips)),
    coinPips: sum("coin"),
    bridgePips: sum("bridge"),
    chainPips: sum("chain"),
    complete,
  };
}

/**
 * Charges compound rather than add: two one percent legs keep 0.99 x 0.99, which is 199 basis points and not
 * 200. Kept in floating point through the multiplication and rounded once, at the end.
 */
export function compoundPips(pips: number[]): number {
  let kept = 1;
  for (const p of pips) {
    if (!Number.isFinite(p) || p < 0 || p >= 1_000_000) refuse(`an impossible fee (${p} pips)`);
    kept *= 1 - p / 1_000_000;
  }
  return Math.round((1 - kept) * 1_000_000);
}

/**
 * How far the trade moved the price, beyond what the fees already took.
 *
 * `idealOut` is what the route would have paid at the price before the trade, fees included. Anything short of
 * that is the trade moving the price against itself. Negative results are reported as zero: a route that beat
 * its own spot estimate has no impact to warn about.
 */
export function priceImpactBps(idealOut: bigint, quotedOut: bigint): number {
  if (idealOut <= 0n) refuse("there is no reference price to measure impact against");
  if (quotedOut < 0n) refuse("a quote cannot be negative");
  if (quotedOut >= idealOut) return 0;
  return Number(((idealOut - quotedOut) * 10_000n) / idealOut);
}

export type Quote = { out: bigint; at: number };

export const quoteAgeMs = (q: Quote, now = Date.now()) => now - q.at;
/** A quote from the future is as unusable as one from too long ago. */
export const isStale = (q: Quote, now = Date.now(), ttl = QUOTE_TTL_MS) => {
  const age = quoteAgeMs(q, now);
  return age < 0 || age > ttl;
};

/**
 * The fewest tokens the sender will accept. Built from the quote and the slippage they chose, and from nothing
 * else: not from the impact, not from what would make the trade succeed.
 */
export function minimumOut(q: Quote, slippageBps: number, now = Date.now(), ttl = QUOTE_TTL_MS): bigint {
  if (isStale(q, now, ttl)) refuse("this quote is too old to send. take a fresh one.");
  if (q.out <= 0n) refuse("the route returns nothing at this size");
  if (!Number.isInteger(slippageBps) || slippageBps < MIN_SLIPPAGE_BPS || slippageBps > MAX_SLIPPAGE_BPS) {
    refuse(`slippage must be between ${MIN_SLIPPAGE_BPS} and ${MAX_SLIPPAGE_BPS} basis points`);
  }
  const min = (q.out * BigInt(10_000 - slippageBps)) / 10_000n;
  if (min <= 0n) refuse("the minimum rounds to nothing at this size. raise the size or lower the slippage.");
  return min;
}

/**
 * A quote taken again right before sending, and the minimum built from that one.
 *
 * The refresh is what makes the minimum meaningful: a minimum from a quote taken a minute ago protects against a
 * price that has already moved. If the fresh quote is worse, the minimum is worse with it. It is never taken
 * from the older, better quote to keep a trade alive.
 */
export function refreshedMinimum(fresh: Quote | undefined, previous: Quote, slippageBps: number, now = Date.now()): bigint {
  const q = fresh ?? previous;
  if (!fresh && isStale(previous, now)) refuse("the quote expired and a fresh one could not be taken. nothing was sent.");
  return minimumOut(q, slippageBps, now);
}

/** Turn a zap path into hop fees. The coin's own pool is the last hop on a buy and the first on a sell. */
export function hopFeesFromPath(
  path: { kind: number; key: { fee: number } }[],
  side: "buy" | "sell",
  protocolPips?: (i: number) => number | undefined,
): HopFees[] {
  const coinAt = side === "buy" ? path.length - 1 : 0;
  return path.map((h, i) => ({
    // a wrap hop mints or redeems and charges nothing; every pool hop charges its key's fee, in pips already
    poolPips: h.kind === 2 ? 0 : h.key.fee,
    protocolPips: h.kind === 2 ? 0 : protocolPips?.(i),
    where: (i === coinAt ? "coin" : "bridge") as FeeWhere,
    label: i === coinAt ? "the coin's pool" : `hop ${i + 1}`,
  }));
}

/** How far a refreshed quote may fall short of the reviewed one before the review has to be made again. */
const RENEW_REVIEW_BPS = 100;

/**
 * The floor, from a quote taken as late as possible.
 *
 * Three things this does that taking the displayed number did not. It refuses a quote that has gone stale
 * instead of using it, and a quote with no known time is treated as stale rather than as new. It runs inside
 * the send step, so an approval that takes a minute does not leave the minimum a minute old. And when the fresh
 * quote is materially worse than the one that was reviewed, it stops and asks for the review again rather than
 * quietly sending against terms nobody agreed to.
 */
export async function floorFor(
  reviewed: Quote,
  take: () => Promise<bigint | null>,
  slipBps: number,
  onRenew: (why: string) => void,
): Promise<bigint> {
  const got = await take().catch(() => null);
  const fresh: Quote | undefined = got !== null && got > 0n ? { out: got, at: Date.now() } : undefined;
  if (!fresh && (reviewed.at === 0 || isStale(reviewed))) {
    throw new Error("the quote expired and a fresh one could not be taken. nothing was sent; check the amount and try again.");
  }
  const basis = fresh ?? reviewed;
  if (fresh && reviewed.out > 0n) {
    const worse = reviewed.out > fresh.out ? Number(((reviewed.out - fresh.out) * 10_000n) / reviewed.out) : 0;
    if (worse > RENEW_REVIEW_BPS) {
      onRenew(`the price moved ${(worse / 100).toFixed(2)}% against this trade while it was being prepared. nothing was sent. check the new amount and send again if it still suits you.`);
      throw new Error("the terms changed; review them again");
    }
  }
  return minimumOut(basis, slipBps);
}

/**
 * Which way each v4 hop is traded, walking the route from the asset going in. A pool's protocol fee differs by
 * direction, so reading the wrong half reports a fee the trade will not pay.
 */
export function hopDirections(
  path: { kind: number; key: { currency0: string; currency1: string }; pool: string }[],
  from: string,
): (boolean | undefined)[] {
  let cur = from.toLowerCase();
  return path.map((h) => {
    if (h.kind !== 0) {
      // a wrap hop swaps the name for its counter and back; the router settles which, and there is no pool fee
      cur = cur === h.pool.toLowerCase() ? "" : h.pool.toLowerCase();
      return undefined;
    }
    const c0 = h.key.currency0.toLowerCase();
    const c1 = h.key.currency1.toLowerCase();
    const zeroForOne = cur === c0;
    if (cur !== c0 && cur !== c1) return undefined; // the route does not connect here; nothing to claim
    cur = zeroForOne ? c1 : c0;
    return zeroForOne;
  });
}
