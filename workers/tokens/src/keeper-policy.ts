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

/**
 * A write this keeper has signed. Recorded BEFORE the broadcast, never after.
 *
 * A broadcast the node accepted whose answer was lost looks, from here, exactly like one that never left. The
 * only way to recognise it later is to know the hash beforehand, which is why the transaction is signed locally
 * first: the hash of a signed transaction is fixed before anyone sees it. The nonce is kept alongside so a run
 * can tell "it landed" from "that nonce is still free".
 */
export type Pending = { label: string; hash: string; nonce: number; at: number };

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


/* ------------------------------------------------------------------ the lease and the record, as transitions

   These run inside a Durable Object, one instance, one request at a time. Expressed as pure functions so the
   ordering they depend on can be tested directly rather than inferred from a live worker.
   ------------------------------------------------------------------ */

/**
 * The lease, its owner, and whatever write is outstanding.
 *
 * `owner` is a token minted by the run that took the lease. Every mutation must present it. Without one, a run
 * whose lease expired and was taken over by another could still come back and clear a record or release a lease
 * that is no longer its own, which is precisely the case an expiry creates.
 */
export type LockState = { leaseUntil?: number; owner?: string; pending?: Pending };

export type Rejected = { ok: false; reason: string };

/** Every mutation checks this first: the caller must still hold the lease it is acting under. */
function held(state: LockState, token: string): Rejected | undefined {
  if (!state.owner) return { ok: false, reason: "no lease is held; acquire one first" };
  if (state.owner !== token) return { ok: false, reason: "this run's lease was taken over; its changes are refused" };
  return undefined;
}



export type Acquired =
  | { ok: true; state: LockState; token: string; resolveFirst?: Pending }
  | Rejected;

/**
 * Take the lease, or refuse.
 *
 * Two runs firing together both reach this; the object serialises them, so the first sets `leaseUntil` and the
 * second sees it and is turned away. A lease that has expired is taken over: a run that died holding one must
 * not lock the keeper out forever. Whatever the last run left pending comes back with the lease, because it has
 * to be settled before this run writes anything.
 */
export function acquire(state: LockState, now: number, leaseMs: number, token: string): Acquired {
  if (state.leaseUntil !== undefined && state.leaseUntil > now) {
    return { ok: false, reason: `another run holds the lease for ${Math.ceil((state.leaseUntil - now) / 1000)}s` };
  }
  // taking over an expired lease mints a new owner, which is what invalidates the previous run's token
  return {
    ok: true,
    token,
    state: { ...state, leaseUntil: now + leaseMs, owner: token },
    ...(state.pending ? { resolveFirst: state.pending } : {}),
  };
}

/** Record a signed write. Refuses to overwrite one that is still unsettled, or to act without the lease. */
export function record(state: LockState, p: Pending, token: string): { ok: true; state: LockState } | Rejected {
  const no = held(state, token);
  if (no) return no;
  if (state.pending) {
    return { ok: false, reason: `a write is already pending (${state.pending.label} ${state.pending.hash})` };
  }
  return { ok: true, state: { ...state, pending: p } };
}

/**
 * Clear one specific record.
 *
 * The hash has to match. A run that resolved attempt A must not be able to clear attempt B, which is what a
 * bare clear would do if a takeover happened in between and the new run had already recorded its own write.
 */
export function clear(state: LockState, hash: string, token: string): { ok: true; state: LockState } | Rejected {
  const no = held(state, token);
  if (no) return no;
  if (!state.pending) return { ok: false, reason: "there is no pending write to clear" };
  if (state.pending.hash !== hash) {
    return { ok: false, reason: `the pending write is ${state.pending.hash}, not ${hash}; refusing to clear it` };
  }
  const { pending: _drop, ...rest } = state;
  return { ok: true, state: rest };
}

export function release(state: LockState, token: string): { ok: true; state: LockState } | Rejected {
  const no = held(state, token);
  if (no) return no;
  const { leaseUntil: _l, owner: _o, ...rest } = state;
  return { ok: true, state: rest };
}
