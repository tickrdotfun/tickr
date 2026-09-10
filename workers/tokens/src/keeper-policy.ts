/**
 * The keeper's rules about gas and about a send that never answered.
 *
 * Kept apart from the worker itself so they can be exercised directly: both are about cases that are awkward to
 * reproduce against a live chain, and both are the kind of thing that is only wrong once.
 */

/** Twice the estimate. Measured: a collection's burn leg makes it 143% of an estimate taken without one. */
export const GAS_HEADROOM_NUM = 2n;
export const GAS_HEADROOM_DEN = 1n;

/**
 * The ceiling is a refusal, not a clamp.
 *
 * Clipping a padded estimate down to the ceiling would submit *less* gas than the estimate asked for, which is
 * a transaction bought to fail. If the padded figure does not fit, the work is too large for the keeper to send
 * safely and a person should look at it.
 */
export const GAS_CEILING = 3_000_000n;

export type GasDecision = { ok: true; gas: bigint } | { ok: false; reason: string };

export function gasWithHeadroom(estimate: bigint, ceiling: bigint = GAS_CEILING): GasDecision {
  if (estimate <= 0n) return { ok: false, reason: "the estimate was zero" };
  const padded = (estimate * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;
  if (padded > ceiling) {
    return { ok: false, reason: `needs ${padded} gas, over the ${ceiling} ceiling; not sent` };
  }
  return { ok: true, gas: padded };
}

/** A write this keeper sent and has not yet seen resolve. */
export type Pending = { label: string; hash: string; at: number };

export type StartDecision =
  | { run: true; resolveFirst?: Pending }
  | { run: false; reason: string };

/**
 * Whether a run may start, given whatever the last one left behind.
 *
 * Two things stop a run: another one holding the lease, and a send from an earlier run that never resolved.
 * The second is the important one. The keeper cannot tell a transaction that is slow from one that was dropped,
 * so it does not send anything else until that attempt has an answer; a second write on top of an unresolved
 * first is how a nonce gets reused or work gets paid for twice.
 */
export function decideStart(now: number, lockUntil: number | undefined, pending: Pending | undefined): StartDecision {
  if (lockUntil !== undefined && lockUntil > now) {
    return { run: false, reason: `another run holds the lease for ${Math.ceil((lockUntil - now) / 1000)}s` };
  }
  if (pending) return { run: true, resolveFirst: pending };
  return { run: true };
}

export type ResolveOutcome =
  | { settled: true; status: "success" | "reverted" }
  | { settled: false; reason: string };

/** What to do with a pending attempt once its receipt has been looked for. */
export function afterResolve(o: ResolveOutcome): { clear: boolean; mayWrite: boolean; note: string } {
  if (o.settled) return { clear: true, mayWrite: true, note: `resolved: ${o.status}` };
  // still unknown: keep the record and write nothing this run
  return { clear: false, mayWrite: false, note: `unresolved (${o.reason}); no writes until it settles` };
}
