const assert = require("assert");
const { src } = require("../ts-load.cjs");
const { decodeErrorResult } = require("viem");
const { KNOWN_ERRORS } = src("lib/knownErrors.ts");
const { explainRevert, explainFromError } = src("lib/explain.ts");

/**
 * The exact bytes the LIVE pool manager returned when a fixed-inventory market was drained on a fork of
 * chain 4663, captured by test/LegacyExhaustion.t.sol. The market module ships without the exhaustion
 * pre-check, so these are the bytes the production router actually surfaces, and this asserts what a user
 * reads when it happens.
 */
const REAL_REVERT =
  "0x7c9c6e8f00000000000000000000000000000000000000000000000000000001000276a400000000000000000000000000000000000000000000000000000001000276a4";

let n = 0;
const t = (name, fn) => { fn(); n++; };

t("the captured selector is Uniswap's PriceLimitAlreadyExceeded", () => {
  assert.equal(REAL_REVERT.slice(0, 10), "0x7c9c6e8f");
});

t("the production error list can name it", () => {
  const decoded = decodeErrorResult({ abi: KNOWN_ERRORS, data: REAL_REVERT });
  assert.equal(decoded.errorName, "PriceLimitAlreadyExceeded");
});

t("and the user reads a sentence, not a selector", () => {
  const decoded = decodeErrorResult({ abi: KNOWN_ERRORS, data: REAL_REVERT });
  const shown = explainRevert(decoded.errorName, "buy");
  assert.equal(shown, "buy failed: This route currently has no available liquidity in the required direction.");
  assert.ok(!/0x7c9c6e8f/.test(shown), "the raw selector must never reach the user");
});

t("the same holds through a nested viem error on the pre-flight path", () => {
  const e = { shortMessage: "execution reverted", cause: { data: REAL_REVERT, message: "reverted with PriceLimitAlreadyExceeded" } };
  const shown = explainFromError(e, "buy");
  assert.ok(/no available liquidity/.test(shown), shown);
});

t("a market wrapped inside Uniswap's WrappedError is still named", () => {
  // v4 wraps a callee's revert when a hook is involved; the inner selector is still ours to find
  const wrapped = { message: `execution reverted: WrappedError(...) inner ${REAL_REVERT}` };
  const shown = explainFromError(wrapped, "sell");
  assert.ok(/no available liquidity/.test(shown), shown);
});

console.log(`legacyExhaustion: ${n} tests passed`);
