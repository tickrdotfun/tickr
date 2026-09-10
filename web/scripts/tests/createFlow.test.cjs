// The create page's salt keying: which launches require the coin to sort below its name, and when a ground
// address must be thrown away. Pure logic, no browser.
// Run: node --test scripts/tests/createFlow.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const fx = require("./fixture.cjs");
const { vanityInputs } = fx.src("lib/vanity.ts");

const addresses = {
  launchDeployer: "0xD86C1Cc523256519Dbd608318395e0C97e0368d6",
  factory: "0x12EF55f994E6eb6bd55eF55Ce63800cD4425A03f",
};
const socials = { twitter: "", telegram: "", discord: "", website: "", farcaster: "" };
const base = {
  user: "0x1111111111111111111111111111111111111111",
  supply: 1_000_000_000n * 10n ** 18n,
  name: "banana stand",
  symbol: "STAND",
  logo: "",
  description: "",
  socials,
  seed: "0x" + "cd".repeat(32),
  addresses,
};
const EXISTING_NAME = "0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14"; // a name that already exists
const NEW_NAME = "0xF7dd24482e69c47c6f469F82F95CB2a8Cd9260EA"; // one created inside the launch
const ZERO = "0x0000000000000000000000000000000000000000";

test("a coin priced in an existing name must sort below it", () => {
  const r = vanityInputs({ ...base, below: EXISTING_NAME });
  assert.equal(r.below, EXISTING_NAME);
  assert.ok(r.key.endsWith(EXISTING_NAME.toLowerCase()));
});

test("a coin priced in a name created inside the launch is treated the same", () => {
  const r = vanityInputs({ ...base, below: NEW_NAME });
  assert.equal(r.below, NEW_NAME);
  assert.notEqual(r.key, vanityInputs({ ...base, below: EXISTING_NAME }).key);
});

test("ETH, USDG, stock and coin quotes are unchanged: no ordering requirement", () => {
  for (const below of [undefined, ZERO]) {
    const r = vanityInputs({ ...base, below });
    assert.equal(r.below, undefined, "no name means no ordering requirement");
    assert.ok(r.key.endsWith(":none"), "and the key records that");
  }
  // and the key matches what the old code produced, so these paths grind exactly as before
  const legacy = vanityInputs({ ...base });
  assert.equal(legacy.key, `${base.seed}:${legacy.initCodeHash}:${base.user.toLowerCase()}:none`);
});

test("changing the name a coin is priced in invalidates the ground address", () => {
  const a = vanityInputs({ ...base, below: EXISTING_NAME });
  const b = vanityInputs({ ...base, below: NEW_NAME });
  assert.notEqual(a.key, b.key, "a different name must not reuse a salt ground for another");
});

test("changing the wallet invalidates it, because the address depends on the initiator", () => {
  const a = vanityInputs({ ...base, below: EXISTING_NAME });
  const b = vanityInputs({ ...base, user: "0x2222222222222222222222222222222222222222", below: EXISTING_NAME });
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.initiator, b.initiator);
});

test("changing anything written into the token invalidates it", () => {
  const a = vanityInputs({ ...base, below: EXISTING_NAME });
  for (const change of [
    { symbol: "STAND2" },
    { name: "banana stand two" },
    { description: "now with a description" },
    { logo: "ipfs://something" },
    { socials: { ...socials, twitter: "https://x.com/tickr" } },
    { supply: 500_000_000n * 10n ** 18n },
    { seed: "0x" + "ef".repeat(32) },
  ]) {
    const b = vanityInputs({ ...base, ...change, below: EXISTING_NAME });
    assert.notEqual(a.key, b.key, `changing ${Object.keys(change)[0]} must invalidate the ground address`);
  }
});

test("an incomplete form grinds nothing", () => {
  assert.equal(vanityInputs({ ...base, user: undefined, below: EXISTING_NAME }), undefined);
  assert.equal(vanityInputs({ ...base, supply: undefined, below: EXISTING_NAME }), undefined);
  assert.equal(vanityInputs({ ...base, symbol: "  ", below: EXISTING_NAME }), undefined);
  assert.equal(vanityInputs({ ...base, name: "", below: EXISTING_NAME }), undefined);
});

// NOT COVERED HERE, and deliberately recorded rather than implied:
//
// These are pure tests of the keying. They do not exercise the browser: a wallet or name changing while a grind is
// in flight, the promise cache being read after that change, or the review step showing an address the launch then
// uses. Those need a real page and a real wallet, and the harness for that lives in the scratchpad Playwright
// scripts rather than here. Until that exists, "changing the wallet mid-grind is safe" is an inference from the
// cache key, not a demonstration.
