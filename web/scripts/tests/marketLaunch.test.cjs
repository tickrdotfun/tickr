// Planning a launch under a fixed-inventory name: the ordering it must satisfy and the costs it discloses.
// Run: node --test scripts/tests/marketLaunch.test.cjs
"use strict";
process.env.NEXT_PUBLIC_MARKET_TICKER_DEPLOYER = "0x00000000000000000000000000000000000000e2";
process.env.NEXT_PUBLIC_MARKET_TICKER_LAUNCHER = "0x00000000000000000000000000000000000000e3";
const assert = require("node:assert/strict"), { test } = require("node:test");
const fx = require("./fixture.cjs");
const m = fx.src("lib/marketLaunch.ts");

const NAME = "0xf1ff8ca3e0e7f843365b7c7c8e38a093dd0a82d0";
const FEE = 500_000_000_000_000n;
const reads = (o = {}) => ({
  predictName: o.predictName ?? (async () => NAME),
  previewEconomics: o.previewEconomics ?? (async () => "0xfeed"),
  launchFee: o.launchFee ?? (async () => FEE),
  requiredDecimals: o.requiredDecimals ?? (async () => 6),
});
const salt = `0x${"11".repeat(32)}`;

test("a launch under an existing name takes that name and grinds under it", async () => {
  const p = await m.planMarketLaunch(reads(), { kind: "existing", address: NAME }, 0);
  assert.equal(p.name, NAME);
  assert.equal(p.createsName, false);
  assert.equal(p.mustSortBelow, NAME);
  assert.equal(p.expectedEconomics, "0xfeed");
});

test("a launch that makes its name asks the launcher where it will land first", async () => {
  let asked = null;
  const p = await m.planMarketLaunch(
    reads({ predictName: async (s, sym, d) => { asked = [s, sym, d]; return NAME; } }),
    { kind: "new", salt, symbol: "JOURNEY" },
    0,
  );
  assert.deepEqual(asked, [salt, "JOURNEY", 6], "the decimals came from the launcher, not the caller");
  assert.equal(p.createsName, true);
  assert.equal(p.mustSortBelow, NAME, "the coin must still sort under it, predicted or not");
});

test("every amount that leaves the wallet is named, and they add up", async () => {
  const none = await m.planMarketLaunch(reads(), { kind: "existing", address: NAME }, 0);
  assert.deepEqual(none.costs, [{ label: "launch fee", amount: FEE, asset: "ETH" }]);
  assert.equal(m.totalDisclosed(none), FEE);

  const withBuy = await m.planMarketLaunch(reads(), { kind: "existing", address: NAME }, 0, 10n ** 16n);
  assert.equal(withBuy.costs.length, 2);
  assert.equal(withBuy.costs[1].label, "your first buy");
  assert.equal(m.totalDisclosed(withBuy), FEE + 10n ** 16n);
});

test("ordering is checked the way the launcher checks it", async () => {
  const p = await m.planMarketLaunch(reads(), { kind: "existing", address: NAME }, 0);
  assert.equal(m.ordersCorrectly(p, "0x0000000000000000000000000000000000000001"), true);
  assert.equal(m.ordersCorrectly(p, "0xffffffffffffffffffffffffffffffffffffffff"), false);
  assert.equal(m.ordersCorrectly(p, NAME), false, "equal is not below");
  assert.equal(m.ordersCorrectly(p, ""), false);
});

test("nonsense is refused before a wallet is opened, not after a fee is paid", async () => {
  await assert.rejects(() => m.planMarketLaunch(reads(), { kind: "existing", address: "0x0000000000000000000000000000000000000000" }, 0), /pick a name/);
  await assert.rejects(() => m.planMarketLaunch(reads(), { kind: "new", salt, symbol: "" }, 0), /short plain symbol/);
  await assert.rejects(() => m.planMarketLaunch(reads(), { kind: "new", salt, symbol: "a name with spaces" }, 0), /short plain symbol/);
  await assert.rejects(() => m.planMarketLaunch(reads({ predictName: async () => "0x0000000000000000000000000000000000000000" }), { kind: "new", salt, symbol: "OK" }, 0), /could not say where/);
});

test("a read that fails blocks the plan rather than producing half of one", async () => {
  await assert.rejects(() => m.planMarketLaunch(reads({ launchFee: async () => { throw new Error("timeout"); } }), { kind: "existing", address: NAME }, 0), /timeout/);
  await assert.rejects(() => m.planMarketLaunch(reads({ previewEconomics: async () => { throw new Error("reverted"); } }), { kind: "existing", address: NAME }, 0), /reverted/);
});

test("the decimals are the counter's, read from the launcher and never offered as a choice", async () => {
  const p = await m.planMarketLaunch(reads({ requiredDecimals: async () => 6 }), { kind: "existing", address: NAME }, 0);
  assert.equal(p.decimals, 6);

  // an issuer counting in something else is followed, not overridden
  let asked = null;
  const q = await m.planMarketLaunch(
    reads({ requiredDecimals: async () => 18, predictName: async (s, sym, d) => { asked = d; return NAME; } }),
    { kind: "new", salt, symbol: "OK" },
    0,
  );
  assert.equal(q.decimals, 18);
  assert.equal(asked, 18);

  // and a launcher that answers with nonsense blocks the plan
  await assert.rejects(() => m.planMarketLaunch(reads({ requiredDecimals: async () => 99 }), { kind: "existing", address: NAME }, 0), /impossible decimals/);
  await assert.rejects(() => m.planMarketLaunch(reads({ requiredDecimals: async () => { throw new Error("no answer"); } }), { kind: "existing", address: NAME }, 0), /no answer/);
});
