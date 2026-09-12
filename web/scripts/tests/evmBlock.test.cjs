// Launch protection is counted in EVM blocks, which on Robinhood Chain are Ethereum's, not the RPC's height: the site
// must compare a coin's end block with the former.
// Run: node --test scripts/tests/evmBlock.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const fs = require("node:fs"), path = require("node:path");
const fx = require("./fixture.cjs");
const { protectionOn, EVM_BLOCK_SOURCE, MULTICALL3_BLOCK_ABI } = fx.src("lib/evmBlock.ts");

// read from mainnet on the same second: the RPC's height and Multicall3's getBlockNumber()
const RPC_HEIGHT = 60_532_231n;
const EVM_BLOCK = 25_956_491n;

test("a coin launched a block ago is protected by the EVM's count, and would read as unprotected by the RPC's", () => {
  const endsAt = EVM_BLOCK - 1n + 3n; // launched in the previous EVM block; the window is that block and the next two
  assert.equal(protectionOn(EVM_BLOCK, endsAt), true, "the EVM block number says protection holds");
  assert.equal(protectionOn(RPC_HEIGHT, endsAt), false, "the RPC height, compared wrongly, says it ended long ago");
  assert.equal(protectionOn(endsAt, endsAt), false, "and it ends at its end block");
  assert.equal(protectionOn(undefined, endsAt), false, "unknown is not shown as protected");
  assert.equal(protectionOn(EVM_BLOCK, undefined), false);
});

test("the EVM block number is read from Multicall3's getBlockNumber at the canonical address", () => {
  assert.equal(EVM_BLOCK_SOURCE, "0xcA11bde05977b3631167028862bE2a173976CA11");
  assert.equal(MULTICALL3_BLOCK_ABI[0].name, "getBlockNumber");
});

test("nothing that shows launch protection reads the RPC's height", () => {
  for (const f of ["components/token/TradePanel.tsx", "components/token/LaunchGuardLine.tsx"]) {
    const s = fs.readFileSync(path.join(__dirname, "..", "..", "src", f), "utf8");
    assert.ok(s.includes("protectionEndsAtBlock"), `${f} reads the coin's end block`);
    assert.ok(!/\buseBlockNumber\b/.test(s), `${f} does not compare it with useBlockNumber`);
    assert.ok(/useEvmBlockNumber\(/.test(s), `${f} compares it with the EVM's block number`);
  }
});
