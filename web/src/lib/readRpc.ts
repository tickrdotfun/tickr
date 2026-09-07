/**
 * Bounded reads. A chain read that fails for a temporary reason (a rate limit, an outage, a dropped connection) is
 * retried a few times with backoff and never more; anything else is thrown as is. A delayed read is not proof that
 * a transaction failed, so callers treat a `ReadUnavailable` as "unknown, try reads again later", never as a reason
 * to send anything.
 */
export class ReadUnavailable extends Error {
  readonly code = "READ_UNAVAILABLE";
  constructor(readonly retryAt: number) {
    super("chain reads are temporarily unavailable. saved records are unchanged; only reads are retried, nothing is resent.");
    this.name = "ReadUnavailable";
  }
}

export const isReadUnavailable = (e: unknown): e is ReadUnavailable => e instanceof ReadUnavailable;

const TEMPORARY = /429|rate limit|timeout|timed out|ECONNRESET|fetch failed|network|503|502|504|Too Many Requests|HTTP request failed/i;

let cooldownUntil = 0;

/** Whether an error looks like the network rather than the contract: those are retried, nothing else is. */
export function isTemporary(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return TEMPORARY.test(msg);
}

/** Run `fn` with up to three attempts on temporary failures, waiting 1.5s, 3s, 6s. Throws `ReadUnavailable` after the last. */
export async function readBounded<T>(fn: () => Promise<T>, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  if (now() < cooldownUntil) throw new ReadUnavailable(cooldownUntil);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTemporary(e)) throw e;
      if (attempt === 2) {
        cooldownUntil = now() + 20_000;
        throw new ReadUnavailable(cooldownUntil);
      }
      await sleep(1_500 * 2 ** attempt);
    }
  }
  throw new ReadUnavailable(now());
}
