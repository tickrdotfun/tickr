// The record genesis writes must pass the live guard, and a rehearsal or an unactivated genesis must not.
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const A = (n) => `0x${n.toString(16).padStart(40, "0")}`;
/** a record shaped exactly as Deploy.s.sol and Genesis.s.sol write it, with synthetic addresses */
const genesisRecord = () => ({
  chainId: 4663, startBlock: 100, factory: A(1), managedTickerHook: A(2), managedTickerDeployer: A(3), universalRouter: A(4), feeEscrow: A(5), launchLocker: A(6), launchDeployer: A(7), launchSeeder: A(8), buybackVault: A(9), buybackTreasury: A(10), anchorRegistry: A(11), launchAndBuyRouter: A(12), tickerLauncher: A(13), coinQuoteLauncher: A(14), stockQuoteLauncher: A(15), marketQuoteLauncher: A(16), marketQuoteLauncherDeployed: A(17), v3Factory: A(18), zapRouter: A(19), poolManager: A(20), positionManager: A(21), permit2: A(22), usdg: A(23), weth: A(24), v4Quoter: A(25),
  genesisToken: A(26), genesisTicker: A(27), genesisPool: `0x${"ab".repeat(32)}`, genesisActivated: true,
});
let schema;
test("the schema module loads", async () => { schema = await import("../lib/recordSchema.mjs"); assert.ok(schema.liveProblems); });
test("a record as genesis writes it passes the live guard", () => {
  assert.deepEqual(schema.liveProblems(genesisRecord(), { chainId: 4663, origin: "copied", src: "x", env: {} }), []);
  assert.deepEqual(schema.missingRequired(genesisRecord(), {}), []);
});
test("an unactivated genesis, a rehearsal record, a foreign field, the wrong chain or a missing router is refused", () => {
  const p = (r, o = {}) => schema.liveProblems(r, { chainId: 4663, origin: "copied", src: "x", env: {}, ...o });
  assert.match(p({ ...genesisRecord(), genesisActivated: false }).join(";"), /genesisActivated is not true/);
  const noField = genesisRecord(); delete noField.genesisActivated; assert.match(p(noField).join(";"), /genesisActivated is not true/);
  assert.match(p({ ...genesisRecord(), sepolia: true }).join(";"), /rehearsal/);
  assert.match(p({ ...genesisRecord(), chartGuardHook: A(99) }).join(";"), /not a field/);
  assert.match(p(genesisRecord(), { chainId: 11155111 }).join(";"), /for chain 4663/);
  assert.match(p({ ...genesisRecord(), genesisActivated: "true" }).join(";"), /not a boolean/);
  assert.deepEqual(schema.missingRequired({ ...genesisRecord(), universalRouter: schema.ZERO }, {}), ["universalRouter"]);
  assert.deepEqual(schema.missingRequired({ ...genesisRecord(), universalRouter: schema.ZERO }, { NEXT_PUBLIC_UNIVERSAL_ROUTER: A(4) }), []);
  assert.match(p(genesisRecord(), { origin: "kept" }).join(";"), /not read from/);
});
