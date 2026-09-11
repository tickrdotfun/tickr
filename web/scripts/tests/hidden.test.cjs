// Addresses the public site does not list: by chain and address, never by name.
// Run: node --test scripts/tests/hidden.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const fx = require("./fixture.cjs");
const h = fx.src("lib/hidden.ts");

const CHAIN = 4663;
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";

test("the acceptance run's name and both coins are hidden by address", () => {
  const NAME = "0x6C92c9AD7cE9Cf22db3Ea0447836eFB38e811698";
  const COIN_A = "0x56B12107948F0cF01684454CAdb92d6BFA2299b5";
  const COIN_B = "0x400D1CDE38775AF5Ee5Db600d6852a30DddeEc6A";
  for (const a of [NAME, COIN_A, COIN_B]) {
    assert.equal(h.isHidden(CHAIN, a), true, `${a} is excluded`);
    assert.equal(h.isHidden(CHAIN, a.toLowerCase()), true, "whatever case it is written in");
  }
  assert.equal(h.isHidden(CHAIN, A), false, "and an unrelated address is not");
});

test("matching is by chain and address, and is case-insensitive", () => {
  // the check is exercised through the exported helpers rather than by mutating the frozen list
  const rows = [{ token: A }, { token: "0x56B12107948F0cF01684454CAdb92d6BFA2299b5" }, { token: B }];
  assert.deepEqual(h.withoutHidden(CHAIN, rows, (r) => r.token).map((r) => r.token), [A, B], "the hidden one is dropped");
  assert.equal(h.isHidden(CHAIN, A.toUpperCase()), h.isHidden(CHAIN, A), "case does not decide identity");
  assert.equal(h.isHidden(CHAIN, undefined), false);
  assert.equal(h.isHidden(CHAIN, null), false);
});

test("an entry is a chain and an address, and carries a note", () => {
  for (const e of h.HIDDEN) {
    assert.equal(typeof e.chainId, "number");
    assert.match(e.address, /^0x[0-9a-fA-F]{40}$/, "an address, not a name or a symbol");
    assert.ok(e.note && e.note.length > 0, "and a reason it is there");
  }
});

test("a different chain with the same address is not hidden", () => {
  // the same address exists on every chain; only ours is excluded
  assert.equal(h.isHidden(1, A), false);
});

test("a launch configuration can be hidden, which an address prediction cannot get wrong", () => {
  // the acceptance run's own configuration, entered before any coin launched on it
  assert.equal(h.isHiddenConfig(CHAIN, 1n), true, "config 1 on Robinhood Chain is excluded");
  assert.equal(h.isHiddenConfig(CHAIN, 1), true, "a number reads the same as a bigint");
  assert.equal(h.isHiddenConfig(CHAIN, 0n), false, "config 0, which every real coin uses, is not");
  assert.equal(h.isHiddenConfig(CHAIN, undefined), false);
  assert.equal(h.isHiddenConfig(CHAIN, null), false);
  for (const c of h.HIDDEN_CONFIGS) {
    assert.equal(typeof c.chainId, "number");
    assert.equal(typeof c.launchConfigId, "bigint");
    assert.ok(c.note && c.note.length > 0);
  }
});

test("a configuration id on another chain is not hidden", () => {
  assert.equal(h.isHiddenConfig(1, 1n), false);
});

test("IDK and its name MAN, and both probes with their name TESTNAME, are hidden by address", () => {
  const ours = {
    IDK: "0xEA3d0DD63981Cd90181A5a76A85B4E95d88F6942",
    MAN: "0xF7dd24482e69c47c6f469F82F95CB2a8Cd9260EA",
    PROBE: "0x82237bEFCEce5085e324a60858b1Dc64ecaE3850",
    PROBETWO: "0x151073687c3f5B569fdEC876bEb3DBcEF5F3Ac83",
    TESTNAME: "0x4Dd89f107d9b8395237719FA9d621a7A5BC00c52",
  };
  for (const [name, a] of Object.entries(ours)) {
    assert.equal(h.isHidden(CHAIN, a), true, `${name} is excluded`);
    assert.equal(h.isHidden(CHAIN, a.toLowerCase()), true, `${name}, whatever case it is written in`);
    assert.equal(h.isHidden(11155111, a), false, `${name} only on the chain it was listed for`);
  }
  assert.equal(h.isHidden(CHAIN, "0x51d553Efd2E8D772AEe6d602A9ea26C56c9a6942"), false, "and TICKR is not");
});

