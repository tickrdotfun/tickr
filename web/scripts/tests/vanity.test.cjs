// The coin's salt grinder: the cosmetic suffix, and, for an invented name, sorting below it.
// Run: node --test scripts/tests/vanity.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const fx = require("./fixture.cjs");
const { grindSalt, VANITY_SUFFIX, predictTokenAddress } = fx.src("lib/vanity.ts");

const deployer = "0xD86C1Cc523256519Dbd608318395e0C97e0368d6";
const initiator = "0x1111111111111111111111111111111111111111";
const initCodeHash = "0x" + "ab".repeat(32);
const seed = "0x" + "cd".repeat(32);

const ends = (a) => a.toLowerCase().endsWith(VANITY_SUFFIX);
const below = (a, b) => BigInt(a) < BigInt(b);

test("without a name, only the suffix is required, unchanged from before", async () => {
  const r = await grindSalt({ deployer, initiator, initCodeHash, seed });
  assert.ok(ends(r.address), `${r.address} should end in ${VANITY_SUFFIX}`);
  // the address is exactly what the salt predicts, so the contract will see the same one
  assert.equal(predictTokenAddress(deployer, initiator, r.salt, initCodeHash).toLowerCase(), r.address.toLowerCase());
});

test("with a name, the address ends in the suffix AND sorts below it", async () => {
  // a name high in the space, as every real one is: they are ground to start 0xF
  const name = "0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14";
  const r = await grindSalt({ deployer, initiator, initCodeHash, seed, below: name });
  assert.ok(ends(r.address), `${r.address} should end in ${VANITY_SUFFIX}`);
  assert.ok(below(r.address, name), `${r.address} should sort below ${name}`);
});

test("a name low in the space still yields an address below it", async () => {
  const name = "0x151073687c3f5B569fdEC876bEb3DBcEF5F3Ac83";
  const r = await grindSalt({ deployer, initiator, initCodeHash, seed, below: name });
  assert.ok(ends(r.address), "suffix");
  assert.ok(below(r.address, name), `${r.address} should sort below ${name}`);
});

test("the same inputs give the same salt, and a lower name forces a different one", async () => {
  const name = "0xF9d30A05A63d795e3eF37b34143f33b2cBEf0f14";
  const a1 = await grindSalt({ deployer, initiator, initCodeHash, seed, below: name });
  const a2 = await grindSalt({ deployer, initiator, initCodeHash, seed, below: name });
  assert.equal(a1.salt, a2.salt, "deterministic for the same inputs");

  // a name at exactly the address the first grind produced: that address no longer qualifies, because the
  // requirement is strictly below, so the grinder must go on and return a different salt
  const r = await grindSalt({ deployer, initiator, initCodeHash, seed, below: a1.address });
  assert.notEqual(r.salt, a1.salt, "changing the name must not reuse the old salt");
  assert.ok(below(r.address, a1.address), `${r.address} should sort below ${a1.address}`);
  assert.ok(ends(r.address), "and still carry the suffix");
});

test("a name very low in the address space can exhaust the search, and says so", async () => {
  // not a practical case, since names are ground to start 0xF, but the failure must be explicit rather than a
  // silent wrong answer: below 0x01.. only about 0.4% of addresses qualify, and with the suffix that is roughly
  // one in sixteen million, past the cap
  await assert.rejects(
    () => grindSalt({ deployer, initiator, initCodeHash, seed, below: "0x0100000000000000000000000000000000000000" }),
    /no address ending in .* and sorting below/,
  );
});

test("native ETH is never passed as a name, and would be impossible if it were", async () => {
  // address zero sorts first, so nothing can sort below it. The form must not pass it, and this documents why.
  await assert.rejects(
    () => grindSalt({ deployer, initiator, initCodeHash, seed, below: "0x0000000000000000000000000000000000000000" }),
    /no address ending in .* and sorting below/,
  );
});
