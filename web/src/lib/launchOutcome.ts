/**
 * What a creation run's ending means for its journal, decided in one place so the create page cannot confuse a
 * failure before the wallet was asked with a lost wallet answer. The phases: a record is written before anything
 * is asked of the wallet; the wallet is then invoked; from that moment an outcome that is not a definite decline
 * is unknown and the record must be kept.
 */
export type RunOutcome = "settled" | "sent" | "not-sent" | "declined" | "squat" | "unknown";

/** the wallet itself said no before anything left it: the one definite decline */
export function isRejection(e: unknown): boolean {
  const code = (e as { code?: number; cause?: { code?: number } } | undefined)?.code ?? (e as { cause?: { code?: number } } | undefined)?.cause?.code;
  if (code === 4001) return true;
  const msg = (e instanceof Error ? e.message : String(e ?? "")) + String((e as { cause?: { message?: string } } | undefined)?.cause?.message ?? "");
  return /User rejected|user rejected|rejected the request|denied transaction/i.test(msg);
}

export function afterRun(a: {
  /** the runner's hash, when the transaction landed */
  hash?: string;
  /** whether the wallet's send was actually invoked; false when the run failed before asking */
  sendInvoked: boolean;
  /** the journal's status as stored now */
  storedStatus?: string;
  failure: unknown;
  /** the failure is a taken pool key, retried at most once with a fresh salt */
  squat: boolean;
  retriedSquat: boolean;
}): RunOutcome {
  if (a.hash) return "settled";
  if (a.storedStatus === "sent") return "sent";
  if (!a.sendInvoked) return "not-sent";
  if (isRejection(a.failure)) return "declined";
  if (a.squat && !a.retriedSquat) return "squat";
  return "unknown";
}
