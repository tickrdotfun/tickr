/**
 * The gas limit for a write whose cost depends on what has traded since the estimate.
 *
 * `collectFees` is the case this exists for. With only buys the fees are all on the quote side and nothing is
 * burned; a sell adds coin-denominated fees whose protocol and club share is burned, and that burn is work the
 * earlier estimate never saw. Measured on a fork of chain 4663: 270,165 gas without the burn leg, 386,733 with
 * it, so the larger shape is 143% of the smaller. A wallet estimating for itself is subject to exactly the same
 * race, because a trade can land between its estimate and inclusion.
 *
 * Doubling covers that with margin. The ceiling is a refusal rather than a clamp: clipping down would send less
 * gas than the estimate asked for, which is a transaction bought to fail.
 */
export const GAS_CEILING = 3_000_000n;

export type GasDecision = { ok: true; gas: bigint } | { ok: false; reason: string };

export function gasWithHeadroom(estimate: bigint, ceiling: bigint = GAS_CEILING): GasDecision {
  if (estimate <= 0n) return { ok: false, reason: "the estimate was zero" };
  const padded = estimate * 2n;
  if (padded > ceiling) return { ok: false, reason: `this needs more gas than is safe to send unattended (${padded})` };
  return { ok: true, gas: padded };
}
