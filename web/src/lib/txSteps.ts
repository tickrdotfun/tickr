import type { Hash } from "viem";

/**
 * One transaction step's life after the wallet returned a hash, as the runner drives it: wait for the receipt,
 * and when the wallet repriced the transaction under a new hash, hand the replacement's identity to the caller so
 * the caller can decide whether it is the same request. Pure, so a journal engine can be tested against it.
 */
export type Replacement = { reason: "repriced" | "cancelled" | "replaced"; hash: Hash; from: `0x${string}`; to: `0x${string}` | null; input: `0x${string}`; nonce: number; value: bigint; chainId?: number };
export type StepHooks = {
  /** the hash the wallet first returned */
  onHash?: (hash: Hash) => void;
  /** a repricing of that transaction: same request, new hash; the caller verifies and adopts it or refuses */
  onReplaced?: (replacement: Replacement) => void;
};
export type StepResult<R> = { hash: Hash; receipt: R };

/**
 * Wait for `hash`. `wait` resolves with the receipt of the transaction that finally mined, reporting a replacement
 * through its callback first. A cancellation or a replacement by another request is a failure of this step; a
 * repricing continues under the new hash, which the caller has been told about before the receipt is returned.
 */
export async function settleStep<R extends { transactionHash: Hash }>(hash: Hash, hooks: StepHooks, wait: (hash: Hash, onReplaced: (r: Replacement) => void) => Promise<R>, label: string): Promise<StepResult<R>> {
  try {
    hooks.onHash?.(hash);
  } catch {
    // a caller's own bookkeeping must not stop the wait
  }
  let replacement: Replacement | undefined;
  let refused: Error | undefined;
  const receipt = await wait(hash, (r) => {
    replacement = r;
    if (r.reason !== "repriced") return;
    try {
      hooks.onReplaced?.(r);
    } catch (e) {
      refused = e instanceof Error ? e : new Error(String(e));
    }
  });
  if (replacement && replacement.reason !== "repriced") throw new Error(`${label}: ${replacement.reason === "cancelled" ? "cancelled in the wallet" : "replaced in the wallet by another transaction"}. nothing was sent.`);
  if (refused) throw new Error(`${label}: the wallet repriced the transaction into one that is not this request (${refused.message}). stop for review.`);
  return { hash: replacement ? replacement.hash : hash, receipt };
}
