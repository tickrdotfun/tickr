const assert = require("assert");
const { src } = require("../ts-load.cjs");
const { explainError, explainRevert, explainFromError } = src("lib/explain.ts");

let n = 0;
const t = (name, fn) => { fn(); n++; };

t("an exhausted market explains itself, not its selector", () => {
  const s = explainError("MarketExhausted");
  assert.equal(s, "This route currently has no available liquidity in the required direction.");
  assert.ok(!/MarketExhausted/.test(s), "the name is jargon and must not be the answer");
});

t("no explanation promises an outcome", () => {
  for (const [name, text] of Object.entries({
    MarketExhausted: explainError("MarketExhausted"),
    PriceLimitAlreadyExceeded: explainError("PriceLimitAlreadyExceeded"),
    InsufficientLiquidity: explainError("InsufficientLiquidity"),
  })) {
    assert.ok(!/still works|should go through|will work|will succeed/.test(text),
      `${name} promises an outcome it cannot know: ${text}`);
  }
});

t("uniswap's own raw error gets the same explanation", () => {
  assert.equal(explainError("PriceLimitAlreadyExceeded"), explainError("MarketExhausted"));
});

t("exhausted is distinct from a partial fill", () => {
  assert.notEqual(explainError("MarketExhausted"), explainError("InsufficientLiquidity"));
  assert.ok(/fresh quote/.test(explainError("InsufficientLiquidity")));
});

t("an unknown error still names itself rather than going silent", () => {
  assert.equal(explainRevert("SomethingElse", "buy"), "buy failed: reverted with SomethingElse");
});

t("no name at all still says something", () => {
  assert.ok(explainRevert(undefined, "sell").startsWith("sell failed"));
});

t("a nested viem error is read through its causes", () => {
  const e = { shortMessage: "execution reverted", cause: { cause: { message: "reverted with MarketExhausted()" } } };
  assert.ok(/no available liquidity/.test(explainFromError(e, "buy")));
});

t("a name that only appears as a substring is not matched", () => {
  const e = { message: "SlippageCheckFailedElsewhere" };
  const s = explainFromError(e, "buy");
  assert.ok(!/price moved past/.test(s), "substring must not trigger the slippage explanation");
});

t("internal-only errors are deliberately absent", () => {
  assert.equal(explainError("BadPath"), undefined);
  assert.equal(explainError("UnknownToken"), undefined);
});

console.log(`explain: ${n} tests passed`);
