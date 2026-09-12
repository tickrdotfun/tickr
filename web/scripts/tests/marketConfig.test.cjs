const assert = require("assert");
const { src } = require("../ts-load.cjs");
const { findMarketConfigId, MARKET_BASE_FEE_BPS } = src("lib/marketLaunch.ts");

const reads = (rows) => ({
  launchConfigCount: async () => BigInt(rows.length),
  getLaunchConfig: async (i) => { const r = rows[Number(i)]; if (!r) throw new Error("no such config"); return r; },
});
let n = 0;
const run = async (name, fn) => { await fn(); n++; };

(async () => {
  await run("the frozen fee is 82 bps", async () => assert.equal(MARKET_BASE_FEE_BPS, 82));

  await run("finds the enabled 82 bps config, not id 0", async () => {
    const id = await findMarketConfigId(reads([
      { baseFeeBps: 100n, enabled: true },   // the older one
      { baseFeeBps: 82n,  enabled: false },  // right fee, disabled
      { baseFeeBps: 82n,  enabled: true },   // this one
    ]));
    assert.equal(id, 2, "must skip id 0 and the disabled one");
  });

  await run("a disabled 82 bps config is not used", async () => {
    assert.equal(await findMarketConfigId(reads([{ baseFeeBps: 100n, enabled: true }, { baseFeeBps: 82n, enabled: false }])), undefined);
  });

  await run("no 82 bps config at all blocks rather than falling back to 0", async () => {
    assert.equal(await findMarketConfigId(reads([{ baseFeeBps: 100n, enabled: true }])), undefined);
  });

  await run("a config that cannot be read is skipped, not treated as a match", async () => {
    const bad = { launchConfigCount: async () => 2n, getLaunchConfig: async (i) => { if (i === 0n) throw new Error("rpc"); return { baseFeeBps: 82n, enabled: true }; } };
    assert.equal(await findMarketConfigId(bad), 1);
  });

  console.log(`marketConfig: ${n} tests passed`);
})();
