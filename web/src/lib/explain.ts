/**
 * Turning a revert into something a person can act on.
 *
 * A named error is better than "transaction reverted", but a name is still jargon: "MarketExhausted" tells a
 * buyer nothing about what to do next. Every entry here answers two questions, what happened and what now.
 *
 * Errors that only a wrong integration can raise (BadPath, UnknownToken) are deliberately absent: they are bugs
 * on our side, and dressing them up as advice would send someone chasing their own settings instead.
 *
 * None of these promises an outcome. A market's state at the next block is not knowable from a revert at this
 * one, so nothing here says a smaller size, the other direction, or a retry will succeed; where a retry is worth
 * making, the line says to re-quote first rather than implying the result.
 */
const EXPLANATIONS: Record<string, string> = {
  // the fixed-inventory name markets
  MarketExhausted: "This route currently has no available liquidity in the required direction.",
  PriceLimitAlreadyExceeded: "This route currently has no available liquidity in the required direction.",
  InsufficientLiquidity:
    "this route could not fill an order this size in one transaction. take a fresh quote before trying again.",

  // the ordinary trading ones
  Slippage: "the price moved past the limit you approved. the quote refreshes every few seconds, so try again.",
  V4TooLittleReceived: "the price moved past the limit you approved. try again with a fresh quote.",
  ReceivedTooLow: "the price moved past the limit you approved. try again with a fresh quote.",
  TransactionDeadlinePassed: "the quote expired before the transaction was included. try again.",
  Expired: "the quote expired before the transaction was included. try again.",

  // launch protection
  WalletCapExceeded:
    "launch protection limits how much one wallet can buy in the first blocks after a launch. it lifts on its own shortly after.",

  // funding
  BadValue: "the amount is zero, or the ether sent does not match the amount asked for.",
};

/** The sentence for a named error, or undefined when we have nothing useful to add. */
export function explainError(name?: string): string | undefined {
  if (!name) return undefined;
  return EXPLANATIONS[name];
}

/**
 * A one-line message for a revert: the explanation when we have one, otherwise the name so the reason is at
 * least identifiable. `label` names the action that failed ("buy", "sell").
 */
export function explainRevert(name: string | undefined, label?: string): string {
  const lead = label ? `${label} failed` : "the transaction failed";
  const why = explainError(name);
  if (why) return `${lead}: ${why}`;
  if (name) return `${lead}: reverted with ${name}`;
  return `${lead}.`;
}

/**
 * The same explanation, found in an error we did not decode ourselves.
 *
 * A simulation failure arrives as a viem error whose text already carries the custom error's name when the ABI
 * was to hand. Scanning that text costs nothing and covers the pre-flight path, where the explanation matters
 * most: the buyer reads it before signing rather than after paying for a failed transaction.
 */
export function explainFromError(e: unknown, label?: string): string {
  const o = (e ?? {}) as { message?: string; shortMessage?: string; cause?: unknown; details?: string };
  const parts: string[] = [];
  let cur: unknown = o;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const c = cur as { message?: string; shortMessage?: string; details?: string; cause?: unknown };
    for (const v of [c.shortMessage, c.message, c.details]) if (typeof v === "string") parts.push(v);
    cur = c.cause;
  }
  const text = parts.join(" | ");
  for (const name of Object.keys(EXPLANATIONS)) {
    // word boundary: "Slippage" must not match inside "SlippageCheckFailed" from another protocol
    if (new RegExp(`\\b${name}\\b`).test(text)) return explainRevert(name, label);
  }
  return parts[0] ?? explainRevert(undefined, label);
}
