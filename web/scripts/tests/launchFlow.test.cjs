// Lifecycle cases for the creation engine, offline, with the runner's step settlement driven against it: a lost wallet
// answer, an old or mistaken hash, a reload, a second tab, storage errors, an approval followed by a guard failure, a
// reverted launch, a repriced launch, a delayed settlement racing a newer launch, a record of unknown shape.
// Run: node --test scripts/tests/launchFlow.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const v = require("viem");
const fx = require("./fixture.cjs");
const { createLaunchFlow, launchUnresolved, validateIntent, legacyLaunchKey } = fx.src("lib/launchFlow.ts");
const { settleStep } = fx.src("lib/txSteps.ts");
const { wallet, coin, factory, hashOf } = fx;
const launcher = "0x00000000000000000000000000000000000000c1";
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, val) => m.set(k, val), removeItem: (k) => m.delete(k), map: m }; };
const freeLock = { request: async (_, fn) => fn() };
const busyLock = { request: async () => { throw new Error("another tab is signing with this wallet"); } };
const LAUNCHED = v.parseAbi(["event TokenLaunched(address indexed token, bytes32 indexed poolId, address indexed deployer, address pairToken, uint256 launchConfigId, uint24 poolFee, uint256 phantomQuote)"]);
const launchLog = (token, deployer = wallet, emitter = factory) => ({ address: emitter, topics: v.encodeEventTopics({ abi: LAUNCHED, eventName: "TokenLaunched", args: { token, poolId: `0x${"11".repeat(32)}`, deployer } }), data: v.encodeAbiParameters(v.parseAbiParameters("address,uint256,uint24,uint256"), [coin, 0n, 10000, 1n]) });
const blockHash = (n) => `0x${(n + 5000n).toString(16).padStart(64, "0")}`;
function chain() {
  const txs = new Map(), receipts = new Map();
  const c = {
    head: 10n, canonical: true,
    reads: {
      transaction: async (h) => txs.get(h) ?? null,
      receipt: async (h) => receipts.get(h) ?? null,
      block: async (n) => ({ hash: c.canonical ? blockHash(n) : `0x${"ee".repeat(32)}`, number: n }),
      blockNumber: async () => c.head,
    },
    put(hash, tx) { txs.set(hash, { hash, ...tx }); },
    mine(hash, ok = true, logs = [launchLog(coin)], block = 7n) { receipts.set(hash, { transactionHash: hash, blockHash: blockHash(block), blockNumber: block, status: ok ? "success" : "reverted", logs }); },
  };
  return c;
}
const intent = (over = {}) => ({ seed: `0x${"ab".repeat(32)}`, predicted: coin, label: "Create BANANA and launch", isTicker: true, tickerSymbol: "BANANA", to: launcher, data: "0xdeadbeef", value: "2000000000000000", nonce: 55, ...over });
const txOf = (i, over = {}) => ({ from: wallet, to: i.to, input: i.data, nonce: i.nonce, value: BigInt(i.value), chainId: 4663, ...over });
const flowOf = (c, s, locks = freeLock) => createLaunchFlow({ chainId: 4663, wallet, factory, storage: s, reads: c.reads, locks: locks === null ? undefined : locks, now: () => 1_800_000_000_000 });

test("the intent is written before the wallet, the hash on return, the coin from the factory's own event for the predicted address in a canonical block", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s);
  const i = await f.begin(intent());
  assert.equal(f.load().status, "prepared"); assert.ok(launchUnresolved(f.load()));
  const sent = f.markSent(hashOf(1)); assert.equal(sent.hash, hashOf(1));
  c.put(hashOf(1), txOf(i));
  assert.equal((await f.settle()).state, "pending");
  c.mine(hashOf(1), true, [launchLog(coin)], 10n);
  assert.equal((await f.settle()).state, "confirming", "the receipt's block needs one more on top");
  c.head = 11n;
  const r = await f.settle(); assert.equal(r.state, "launched"); assert.equal(r.record.token.toLowerCase(), coin); assert.equal(r.record.blockHash, blockHash(10n));
  assert.equal(launchUnresolved(f.load()), false);
  await f.clear(); assert.equal(f.load(), undefined);
});
test("a receipt in a block that is no longer canonical stops the launch for review", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s);
  const i = await f.begin(intent()); f.markSent(hashOf(1)); c.put(hashOf(1), txOf(i)); c.mine(hashOf(1)); c.canonical = false;
  await assert.rejects(f.settle(), /no longer canonical/);
  assert.equal(f.load().status, "sent");
});
test("a lost wallet answer stays unresolved: no new launch, no dismissal, until the hash is matched", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s);
  const i = await f.begin(intent());
  await assert.rejects(f.begin(intent({ seed: `0x${"cd".repeat(32)}` })), /not settled yet/);
  await assert.rejects(f.recover(hashOf(1)), /no transaction is visible/);
  assert.equal(f.load().status, "prepared");
  c.put(hashOf(1), txOf(i));
  assert.equal((await f.recover(hashOf(1))).status, "sent");
  c.mine(hashOf(1));
  assert.equal((await f.settle()).state, "launched");
});
test("an old or mistaken transaction from the same wallet is refused: wrong target, calldata, value, nonce, or another coin", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s);
  const i = await f.begin(intent());
  c.put(hashOf(2), txOf(i, { to: fx.ticker })); await assert.rejects(f.recover(hashOf(2)), /sender, target or calldata/);
  c.put(hashOf(3), txOf(i, { input: "0xbeef" })); await assert.rejects(f.recover(hashOf(3)), /sender, target or calldata/);
  c.put(hashOf(4), txOf(i, { value: 1n })); await assert.rejects(f.recover(hashOf(4)), /value or nonce/);
  c.put(hashOf(5), txOf(i, { nonce: 54 })); await assert.rejects(f.recover(hashOf(5)), /value or nonce/);
  c.put(hashOf(6), txOf(i, { from: fx.ticker })); await assert.rejects(f.recover(hashOf(6)), /sender, target or calldata/);
  assert.equal(f.load().status, "prepared");
  c.put(hashOf(7), txOf(i)); await f.recover(hashOf(7));
  c.mine(hashOf(7), true, [launchLog(fx.ticker)]); await assert.rejects(f.settle(), /different coin/);
  c.mine(hashOf(7), true, [launchLog(coin, wallet, fx.ticker)]); await assert.rejects(f.settle(), /no launch by this wallet from the factory/);
  c.mine(hashOf(7), true, [launchLog(coin)]); assert.equal((await f.settle()).state, "launched");
});
test("a reload resumes the same record; a busy lock stops begin, recover, settle and clear; no lock manager means no launch", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s);
  const i = await f.begin(intent()); f.markSent(hashOf(1)); c.put(hashOf(1), txOf(i)); c.mine(hashOf(1));
  const again = flowOf(c, s);
  assert.equal(again.load().hash, hashOf(1));
  assert.equal((await again.settle()).state, "launched");
  const busy = flowOf(c, s, busyLock);
  await assert.rejects(busy.begin(intent()), /another tab/);
  await assert.rejects(busy.recover(hashOf(1)), /another tab/);
  await assert.rejects(busy.settle(), /another tab/);
  await assert.rejects(busy.clear(), /another tab/);
  const none = flowOf(c, memory(), null);
  await assert.rejects(none.begin(intent()), /cannot hold a signing lock/);
});
test("a delayed settlement of an older launch never overwrites a newer record", async () => {
  const c = chain(), s = memory();
  // tab A sends and settles slowly; while its reads are in flight the record is settled and replaced by a newer launch
  let release; const gate = new Promise((r) => (release = r));
  const slow = { reads: { ...c.reads, receipt: async (h) => { await gate; return c.reads.receipt(h); } } };
  const a = createLaunchFlow({ chainId: 4663, wallet, factory, storage: s, reads: slow.reads, locks: freeLock, now: () => 1 });
  const b = flowOf(c, s);
  const i = await a.begin(intent()); a.markSent(hashOf(1)); c.put(hashOf(1), txOf(i)); c.mine(hashOf(1), true, [launchLog(coin)], 7n);
  const delayed = a.settle(); // waiting on the gate
  // meanwhile the same record is settled by another tab, cleared, and a newer launch begins
  assert.equal((await b.settle()).state, "launched"); await b.clear();
  const newer = await b.begin(intent({ seed: `0x${"cd".repeat(32)}`, nonce: 56 }));
  release();
  await assert.rejects(delayed, /changed while this step was waiting/);
  assert.equal(b.load().seed, newer.seed, "the newer unresolved launch is untouched");
  assert.equal(b.load().status, "prepared");
});
test("a repricing is adopted only when it is the same request, through the runner's settlement; another request stops for review", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s);
  const i = await f.begin(intent());
  // the runner: the wallet returned hashOf(1), then repriced it to hashOf(2); the receipt arrives under hashOf(2)
  c.put(hashOf(1), txOf(i)); c.put(hashOf(2), txOf(i));
  const wait = async (hash, onReplaced) => { onReplaced({ reason: "repriced", hash: hashOf(2), ...txOf(i) }); c.mine(hashOf(2)); return c.reads.receipt(hashOf(2)); };
  const res = await settleStep(hashOf(1), { onHash: (h) => f.markSent(h), onReplaced: (r) => f.replaced(r) }, wait, "launch");
  assert.equal(res.hash, hashOf(2));
  const rec = f.load(); assert.equal(rec.hash, hashOf(2)); assert.equal(rec.originalHash, hashOf(1));
  const r = await f.settle(res.receipt); assert.equal(r.state, "launched");
  // a "repricing" into a different request is refused by the engine and the runner stops
  const c2 = chain(), s2 = memory(), f2 = flowOf(c2, s2);
  const i2 = await f2.begin(intent());
  const wait2 = async (hash, onReplaced) => { onReplaced({ reason: "repriced", hash: hashOf(9), ...txOf(i2, { input: "0xbeef" }) }); c2.mine(hashOf(9)); return c2.reads.receipt(hashOf(9)); };
  await assert.rejects(settleStep(hashOf(1), { onHash: (h) => f2.markSent(h), onReplaced: (r) => f2.replaced(r) }, wait2, "launch"), /not this request/);
  assert.equal(f2.load().hash, hashOf(1), "the first hash stays; nothing is adopted");
  // a cancellation is a failure of the step, and the record stays sent under its hash for a person to look at
  const wait3 = async (hash, onReplaced) => { onReplaced({ reason: "cancelled", hash: hashOf(8), ...txOf(i2) }); return c2.reads.receipt(hashOf(8)); };
  await assert.rejects(settleStep(hashOf(1), {}, wait3, "launch"), /cancelled in the wallet/);
  // a repriced launch's new hash can also be matched by hand
  c2.put(hashOf(3), txOf(i2));
  assert.equal((await f2.recover(hashOf(3))).hash, hashOf(3));
});
test("damaged, unreadable, foreign or oddly shaped storage is unresolved, never a fresh start; an older record blocks; a write that does not land stops", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s);
  s.setItem(`tickr.launch.v2.4663.${wallet}`, "{not json");
  assert.throws(() => f.load(), /damaged/);
  await assert.rejects(f.begin(intent()), /damaged/);
  const other = memory(); other.setItem(`tickr.launch.v2.4663.${wallet}`, JSON.stringify({ version: 2, chainId: 1, wallet, seed: `0x${"ab".repeat(32)}`, to: launcher, data: "0x", nonce: 1, status: "prepared" }));
  assert.throws(() => flowOf(c, other).load(), /not this wallet's/);
  for (const bad of [{ status: "done" }, { status: "sent" }, { status: "launched", hash: hashOf(1) }, { status: "prepared", hash: hashOf(1) }, { status: "prepared", nonce: -1 }]) {
    assert.throws(() => validateIntent({ ...intent(), version: 2, chainId: 4663, wallet, createdAt: 1, ...bad }, 4663, wallet), new RegExp(""), JSON.stringify(bad));
  }
  const legacy = memory(); legacy.setItem(legacyLaunchKey(4663, wallet), JSON.stringify({ hash: hashOf(1) }));
  assert.throws(() => flowOf(c, legacy).load(), /earlier version/);
  const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => {}, removeItem: () => {} };
  assert.throws(() => flowOf(c, throwing).load(), /cannot be read/);
  const dead = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  await assert.rejects(flowOf(c, dead).begin(intent()), /durably/);
});
test("an approval that landed is never taken for the launch: only the launch step's hash is recorded, and a guard failure after the approval leaves the launch prepared", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s);
  await f.begin(intent());
  c.put(hashOf(9), { from: wallet, to: fx.ticker, input: "0x095ea7b3", nonce: 54, value: 0n, chainId: 4663 }); c.mine(hashOf(9), true, []);
  await assert.rejects(f.recover(hashOf(9)), /sender, target or calldata/);
  assert.equal(f.load().status, "prepared");
  await assert.rejects(f.settle(), /no sent launch/);
  f.declined(); assert.equal(f.load(), undefined);
});
test("a reverted launch is read as reverted and then cleared; an unsettled one cannot be cleared", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s);
  const i = await f.begin(intent()); f.markSent(hashOf(1)); c.put(hashOf(1), txOf(i));
  await assert.rejects(f.clear(), /not settled/);
  c.mine(hashOf(1), false, []);
  assert.equal((await f.settle()).state, "reverted");
  await f.clear(); assert.equal(f.load(), undefined);
  assert.ok(await f.begin(intent({ seed: `0x${"ef".repeat(32)}` })));
});
