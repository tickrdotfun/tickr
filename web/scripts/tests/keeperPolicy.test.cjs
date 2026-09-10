const assert = require("assert");
const path = require("path");
const { src } = require("../ts-load.cjs");
src("lib/gasHeadroom.ts"); // registers the .ts require hook
const P = require(path.join(__dirname, "../../../workers/tokens/src/keeper-policy.ts"));
const { gasWithHeadroom, decideStart, afterResolve, GAS_CEILING } = P;
const web = src("lib/gasHeadroom.ts");

let n = 0; const t = (name, fn) => { fn(); n++; };

// ---- 2. the ceiling refuses, it does not clamp
t("a padded estimate that fits is doubled", () => {
  const d = gasWithHeadroom(400_000n);
  assert.equal(d.ok, true);
  assert.equal(d.gas, 800_000n);
});

t("over the ceiling it REFUSES rather than clipping down", () => {
  const d = gasWithHeadroom(2_000_000n); // padded 4,000,000 > 3,000,000
  assert.equal(d.ok, false, "must refuse");
  assert.ok(/over the .* ceiling|not sent/.test(d.reason), d.reason);
});

t("clipping would have sent LESS than the estimate, which is the bug", () => {
  const estimate = 2_000_000n;
  const clipped = GAS_CEILING; // what the old code did
  assert.ok(clipped < estimate * 2n, "the clamp is below the padded need");
  assert.equal(gasWithHeadroom(estimate).ok, false, "so it is refused instead");
});

t("exactly at the ceiling is allowed", () => {
  const d = gasWithHeadroom(GAS_CEILING / 2n);
  assert.equal(d.ok, true);
  assert.equal(d.gas, GAS_CEILING);
});

t("a zero estimate is refused", () => assert.equal(gasWithHeadroom(0n).ok, false));

t("the site uses the same rule as the keeper", () => {
  assert.equal(web.gasWithHeadroom(400_000n).gas, 800_000n);
  assert.equal(web.gasWithHeadroom(2_000_000n).ok, false);
});

// ---- 1. an unresolved send blocks everything after it
t("a live lease stops a second run", () => {
  const d = decideStart(1000, 5000, undefined);
  assert.equal(d.run, false);
  assert.ok(/another run/.test(d.reason));
});

t("an expired lease does not", () => {
  assert.equal(decideStart(9000, 5000, undefined).run, true);
});

t("a carried-over attempt is resolved before anything is written", () => {
  const d = decideStart(9000, undefined, { label: "collectFees", hash: "0xabc", at: 1 });
  assert.equal(d.run, true);
  assert.equal(d.resolveFirst.hash, "0xabc");
});

t("an attempt that settles clears and lets writes continue", () => {
  const r = afterResolve({ settled: true, status: "success" });
  assert.equal(r.clear, true);
  assert.equal(r.mayWrite, true);
});

t("a reverted attempt also settles: it has an answer", () => {
  const r = afterResolve({ settled: true, status: "reverted" });
  assert.equal(r.clear, true);
  assert.equal(r.mayWrite, true);
});

t("an attempt with NO answer keeps the record and blocks every later write", () => {
  const r = afterResolve({ settled: false, reason: "timeout" });
  assert.equal(r.clear, false, "the record must survive for the next run");
  assert.equal(r.mayWrite, false, "and nothing else may be sent");
  assert.ok(/no writes until it settles/.test(r.note));
});

console.log(`keeperPolicy: ${n} tests passed`);
