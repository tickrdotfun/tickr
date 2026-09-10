// What a name is, resolved from the issuers. There is no default: an unclaimed name or a failed read blocks.
// Run: node --test scripts/tests/nameKind.test.cjs
"use strict";
process.env.NEXT_PUBLIC_TICKER_LAUNCHER = "0x00000000000000000000000000000000000000e1";
process.env.NEXT_PUBLIC_MARKET_TICKER_DEPLOYER = "0x00000000000000000000000000000000000000e2";
const assert = require("node:assert/strict"), { test } = require("node:test");
const fx = require("./fixture.cjs");
const { resolveNameSpec, NameUnresolved } = fx.src("lib/nameKind.ts");
const { ticker } = fx;
const other = "0x00000000000000000000000000000000000000c9";

const reads = (o = {}) => ({
  isTicker: o.isTicker ?? (async () => false),
  marketToken: o.marketToken ?? (async () => "0x0000000000000000000000000000000000000000"),
  marketParams: o.marketParams ?? (async () => ({ fee: 3000, tickSpacing: 60 })),
});

test("a name the ticker launcher issued is a wrapper", async () => {
  assert.deepEqual(await resolveNameSpec(reads({ isTicker: async () => true }), ticker), { kind: "legacy" });
});

test("a name the market issuer made is a market, with the issuer's own fee and spacing", async () => {
  const spec = await resolveNameSpec(reads({ marketToken: async () => ticker, marketParams: async () => ({ fee: 10000, tickSpacing: 200 }) }), ticker);
  assert.deepEqual(spec, { kind: "market", fee: 10000, tickSpacing: 200 });
});

test("the launcher is asked first, and a name it claims is never asked of the market issuer", async () => {
  let asked = false;
  await resolveNameSpec(reads({ isTicker: async () => true, marketToken: async () => { asked = true; return ticker; } }), ticker);
  assert.equal(asked, false);
});

test("a name neither issuer claims blocks, and is not quietly called a wrapper", async () => {
  await assert.rejects(() => resolveNameSpec(reads(), ticker), (e) => e instanceof NameUnresolved && /neither issuer made it/.test(e.message));
  // the market issuer answering about a different token is not an answer about this one
  await assert.rejects(() => resolveNameSpec(reads({ marketToken: async () => other }), ticker), /neither issuer made it/);
});

test("a read that fails blocks, and is never read as a no", async () => {
  await assert.rejects(() => resolveNameSpec(reads({ isTicker: async () => { throw new Error("timeout"); } }), ticker), /ticker launcher could not be read.*timeout/s);
  await assert.rejects(() => resolveNameSpec(reads({ marketToken: async () => { throw new Error("429"); } }), ticker), /market issuer could not be read.*429/s);
  await assert.rejects(() => resolveNameSpec(reads({ marketToken: async () => ticker, marketParams: async () => { throw new Error("nope"); } }), ticker), /pool settings could not be read/);
});

test("an impossible fee or spacing from the issuer blocks rather than being encoded into a pool key", async () => {
  for (const params of [{ fee: 0, tickSpacing: 60 }, { fee: 1_000_000, tickSpacing: 60 }, { fee: 3000, tickSpacing: 0 }, { fee: 3000, tickSpacing: 40_000 }])
    await assert.rejects(() => resolveNameSpec(reads({ marketToken: async () => ticker, marketParams: async () => params }), ticker), /impossible/);
});

test("no name, and no market issuer wired, both block", async () => {
  await assert.rejects(() => resolveNameSpec(reads(), "0x0000000000000000000000000000000000000000"), /no name was given/);
});

test("the resolver follows whichever issuer is configured, so a newly deployed one is recognised", () => {
  // the acceptance run deploys a fresh issuer, and the site must be pointed at it and rebuilt. This is what
  // makes that a configuration step rather than a code change: nothing here names an issuer address
  const { MARKET_DEPLOYER_ABI, nameReadsFrom } = fx.src("lib/nameKind.ts");
  const { ADDRESSES } = fx.src("lib/addresses.ts");
  const seen = [];
  const client = {
    readContract: async (a) => {
      seen.push(a.address);
      if (a.functionName === "isTicker") return false;
      if (a.functionName === "market") return { token: ticker };
      if (a.functionName === "fee") return 3000;
      if (a.functionName === "spacing") return 60;
      throw new Error("unexpected read");
    },
  };
  const reads = nameReadsFrom(client);
  assert.ok(MARKET_DEPLOYER_ABI.length > 0);
  return Promise.all([reads.marketToken(ticker), reads.marketParams()]).then(() => {
    const issuerReads = seen.filter((a) => a.toLowerCase() === ADDRESSES.marketTickerDeployer.toLowerCase());
    assert.equal(issuerReads.length, 3, "every issuer read went to the configured address and nowhere else");
  });
});
