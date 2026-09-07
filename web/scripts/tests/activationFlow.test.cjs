// Workflow cases for the activation engine, offline: a fake chain, a fake wallet, in-memory storage, a fake lock.
// Run: node --test scripts/tests/activationFlow.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const v = require("viem");
const fx = require("./fixture.cjs");
const a = fx.src("lib/activation.ts");
const { createActivationFlow } = fx.src("lib/activationFlow.ts");
const { ADDRESSES } = fx.src("lib/addresses.ts");
const { wallet, coin, ticker } = fx;
const pools = a.poolsFor(ticker, { currency0: coin, currency1: ticker, fee: 10000, tickSpacing: 10, hooks: v.zeroAddress });
const hashOf = fx.hashOf;
const MAX = (1n << 256n) - 1n;

/** A fake chain: transactions become visible and mined as the test decides. */
function chain() {
  const txs = new Map(), receipts = new Map();
  const c = {
    head: 100n, latestNonce: 55n, pendingNonce: 55n, code: "0x", balance: 10n ** 18n, quoteOut: 1240000n, restricted: false, failReads: false,
    reads: {
      chainId: async () => 4663,
      blockNumber: async () => c.head,
      block: async (n) => ({ hash: `0x${((n ?? c.head) + 1000n).toString(16).padStart(64, "0")}`, number: n ?? c.head, timestamp: 1_800_000_000n + (n ?? c.head) }),
      transaction: async (h) => (c.failReads ? Promise.reject(new Error("timeout")) : txs.get(h) ?? null),
      receipt: async (h) => (c.failReads ? Promise.reject(new Error("timeout")) : receipts.get(h) ?? null),
      code: async () => c.code,
      nonce: async (_, tag) => (tag === "latest" ? c.latestNonce : c.pendingNonce),
      balance: async () => c.balance,
      coinPoolKey: async () => pools.main,
      namePoolKey: async () => pools.bridge,
      restrictions: async () => (c.restricted ? { tax: 500n, buy: 0n, hold: 0n } : { tax: 0n, buy: MAX, hold: MAX }),
      quote: async (p) => (p.length === 2 ? c.quoteOut : 10n ** 18n),
      estimateGas: async () => 200_000n,
      gasPrice: async () => 10n,
      call: async () => "0x",
    },
    /** the wallet broadcast `req` under `hash`: visible now or later, mined now or later */
    broadcast(req, hash, { visible = true, mined = true, ok = true, block } = {}) {
      const tx = { hash, from: req.from, to: req.to, input: req.data, nonce: Number(BigInt(req.nonce)), value: BigInt(req.value), chainId: req.chainId, gas: BigInt(req.gas), maxFeePerGas: BigInt(req.maxFeePerGas) };
      c.latestNonce = BigInt(req.nonce) + 1n; c.pendingNonce = c.latestNonce;
      if (visible) txs.set(hash, tx);
      if (mined) c.mine(hash, tx, ok, block);
      return tx;
    },
    mine(hash, tx, ok = true, block) {
      const b = block ?? c.head;
      txs.set(hash, { ...tx, blockHash: `0x${(b + 1000n).toString(16).padStart(64, "0")}`, blockNumber: b });
      const phase = v.decodeFunctionData({ abi: a.EXECUTE_ABI, data: tx.input }) && a.decodeBuy(tx.input).swap.path.length === 2 ? "quote" : "coin";
      receipts.set(hash, { transactionHash: hash, blockHash: `0x${(b + 1000n).toString(16).padStart(64, "0")}`, blockNumber: b, status: ok ? "success" : "reverted", gasUsed: 100_000n, effectiveGasPrice: 10n, logs: ok ? logsFor(phase) : [] });
      c.head = b + 1n; // one more block on top
    },
  };
  return c;
}
function logsFor(phase) {
  const out = phase === "quote" ? ticker : coin, amount = phase === "quote" ? 1240000n : 10n ** 18n;
  const route = phase === "quote" ? [pools.funding, pools.bridge] : [pools.funding, pools.bridge, pools.main];
  const entries = []; let input = v.zeroAddress, amt = a.AMOUNTS[phase];
  for (const [i, key] of route.entries()) {
    const input0 = input.toLowerCase() === key.currency0.toLowerCase(), outAmt = i === route.length - 1 ? amount : 5_000_000n;
    entries.push({ address: ADDRESSES.poolManager, topics: v.encodeEventTopics({ abi: v.parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]), eventName: "Swap", args: { id: a.poolId(key), sender: ADDRESSES.universalRouter } }), data: v.encodeAbiParameters(v.parseAbiParameters("int128,int128,uint160,uint128,int24,uint24"), [input0 ? -amt : outAmt, input0 ? outAmt : -amt, 1n, 1n, 0, key.fee]) });
    input = input0 ? key.currency1 : key.currency0; amt = outAmt;
  }
  entries.push({ address: out, topics: v.encodeEventTopics({ abi: v.parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]), eventName: "Transfer", args: { from: ADDRESSES.poolManager, to: wallet } }), data: v.encodeAbiParameters(v.parseAbiParameters("uint256"), [amount]) });
  return entries;
}
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, val) => m.set(k, val), map: m }; };
const freeLock = { request: async (_, fn) => fn() };
const busyLock = { request: async () => { throw new Error("another tab is activating with this wallet"); } };
function wallet0(c, behaviour = {}) {
  return {
    accounts: async () => [wallet], chainId: async () => 4663,
    send: async (req) => {
      if (behaviour.reject) { const e = new Error("User rejected the request."); e.code = 4001; throw e; }
      if (behaviour.lost) { c.broadcast(req, hashOf(behaviour.n ?? 1), { visible: behaviour.visible ?? true, mined: behaviour.mined ?? false }); throw new Error("Failed to fetch"); }
      c.broadcast(req, hashOf(behaviour.n ?? 1), { visible: behaviour.visible ?? true, mined: behaviour.mined ?? true, ok: behaviour.ok ?? true });
      return hashOf(behaviour.n ?? 1);
    },
  };
}
const flowOf = (c, storage, provider, locks = freeLock, now) => createActivationFlow({ chainId: 4663, wallet, coin, ticker, pools, router: ADDRESSES.universalRouter, storage, reads: c.reads, provider, locks: locks === null ? undefined : locks, now: now ?? (() => 1_800_000_000_000) });

test("two purchases, two receipts, in order, then confirmed; the coin waits for the name", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, wallet0(c, { n: 1 }));
  await assert.rejects(f.prepare("coin"), /confirm the earlier purchase first/);
  const r1 = await f.prepare("quote");
  assert.equal(BigInt(r1.minimum), a.minimumOutput(1240000n));
  const l1 = await f.send(r1);
  assert.equal(l1.attempts[0].hash, hashOf(1));
  let s1 = await f.inspect(l1); assert.equal(s1.next, 1); assert.equal(s1.records[0].status, "confirmed");
  const f2 = flowOf(c, s, wallet0(c, { n: 2 }));
  const r2 = await f2.prepare("coin"); assert.equal(r2.predecessorHash, hashOf(1));
  const l2 = await f2.send(r2); const s2 = await f2.inspect(l2);
  assert.equal(s2.confirmed, true); assert.equal(s2.next, 2); assert.equal(s2.records[1].received, 10n ** 18n);
  await assert.rejects(f2.prepare("coin"), /confirm the earlier purchase|never repeated/);
});
test("a lost wallet answer leaves an unresolved attempt that blocks everything until its hash is matched, and an unchanged nonce changes nothing", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, wallet0(c, { lost: true, visible: false }));
  const r = await f.prepare("quote");
  await assert.rejects(f.send(r), /did not return a transaction hash/);
  const l = f.load(); assert.equal(l.attempts.length, 1); assert.equal(l.attempts[0].hash, undefined);
  const st = await f.inspect(l); assert.equal(st.unknown, true); assert.match(st.blocked, /paste the transaction hash/);
  await assert.rejects(f.prepare("quote"), /never repeated|confirm the earlier/);
  await assert.rejects(f.prepare("coin"), /confirm the earlier purchase/);
  // the chain says the nonce did not move; that is not evidence the wallet sent nothing, so nothing is dismissed
  c.latestNonce = 55n; c.pendingNonce = 55n;
  await assert.rejects(f.prepare("quote"));
  assert.equal(f.load().attempts.length, 1);
  await assert.rejects(f.recover(hashOf(1)), /no transaction is visible/);
  // the transaction becomes visible later: recovered by its hash, verified against the review, then confirmed
  const tx = c.broadcast(r.request, hashOf(1), { visible: true, mined: false });
  const rec = await f.recover(hashOf(1)); assert.equal(rec.attempts[0].hash, hashOf(1));
  let st2 = await f.inspect(rec); assert.equal(st2.pending, true); assert.equal(st2.records[0].status, "pending");
  c.mine(hashOf(1), tx);
  st2 = await f.inspect(rec); assert.equal(st2.next, 1);
});
test("a transaction the wallet returned but the chain has not shown yet is waited for, never resent", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, wallet0(c, { visible: false, mined: false }));
  const r = await f.prepare("quote"); const l = await f.send(r);
  assert.equal(l.attempts[0].hash, hashOf(1));
  const st = await f.inspect(l); assert.equal(st.pending, true); assert.equal(st.records[0].status, "waiting");
  await assert.rejects(f.prepare("quote"), /never repeated|confirm the earlier/);
  await assert.rejects(f.prepare("coin"), /waiting for the saved transaction|confirm the earlier purchase/);
});
test("a reload resumes from the same record: a new engine over the same storage sees the attempt and its receipt", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, wallet0(c, { n: 1 }));
  await f.send(await f.prepare("quote"));
  const again = flowOf(c, s, wallet0(c, { n: 9 }));
  const l = again.load(); assert.equal(l.attempts.length, 1); assert.equal(l.attempts[0].hash, hashOf(1));
  const st = await again.inspect(l); assert.equal(st.next, 1);
  await assert.rejects(again.prepare("quote"), /never repeated|confirm the earlier/);
  const r2 = await again.prepare("coin"); assert.equal(r2.predecessorHash, hashOf(1));
});
test("a second tab holding the wallet's lock stops every signing path; no lock manager means no signing", async () => {
  const c = chain(), s = memory();
  const busy = flowOf(c, s, wallet0(c), busyLock);
  await assert.rejects(busy.prepare("quote"), /another tab/);
  await assert.rejects(busy.refresh(), /another tab/);
  const none = flowOf(c, s, wallet0(c), null);
  await assert.rejects(none.prepare("quote"), /cannot hold a signing lock/);
  assert.equal(none.load().attempts.length, 0);
});
test("a decline in the wallet is the one definite decline: recorded, nothing sent, the next check can start again", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, wallet0(c, { reject: true }));
  const r = await f.prepare("quote");
  await assert.rejects(f.send(r), /declined in the wallet/);
  const l = f.load(); assert.equal(l.attempts.length, 0); assert.equal(l.declined.length, 1);
  const r2 = await f.prepare("quote"); assert.ok(r2);
});
test("a reverted purchase stops the sequence; a stale review, a moved nonce or a smart account are refused before the wallet", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, wallet0(c, { ok: false }));
  const r = await f.prepare("quote"); const l = await f.send(r);
  const st = await f.inspect(l); assert.equal(st.records[0].status, "stopped"); assert.match(st.blocked, /reverted/);
  await assert.rejects(f.prepare("coin"), /reverted/);
  const c2 = chain(), s2 = memory(); let t = 1_800_000_000_000; const f2 = flowOf(c2, s2, wallet0(c2), freeLock, () => t);
  const r2 = await f2.prepare("quote"); t += 400_000;
  await assert.rejects(f2.send(r2), /expired/);
  const r3 = await f2.prepare("quote"); c2.latestNonce = 56n; c2.pendingNonce = 56n;
  await assert.rejects(f2.send(r3), /nonce changed/);
  c2.latestNonce = 55n; c2.pendingNonce = 55n; c2.code = "0x6001";
  await assert.rejects(f2.prepare("quote"), /ordinary wallet/);
  c2.code = undefined; assert.ok(await f2.prepare("quote"), "an empty-code answer reported as undefined is an ordinary wallet");
});
test("a failed quote, a zero quote or a failing read produces no request", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, wallet0(c));
  c.quoteOut = 0n; await assert.rejects(f.prepare("quote"), /positive quote/);
  c.quoteOut = 1240000n; c.reads.quote = async () => { throw new Error("429 rate limited"); };
  await assert.rejects(f.prepare("quote"), /429/);
  assert.equal(f.load().attempts.length, 0);
  c.restricted = true; c.reads.quote = async () => 10n ** 18n;
  const s3 = memory(); s3.setItem(a.ledgerKey(4663, wallet, coin), JSON.stringify({ version: 1, chainId: 4663, wallet, coin, ticker, attempts: [], declined: [] }));
});
test("a durable-write failure stops before the wallet opens", async () => {
  const c = chain(), dead = { getItem: () => null, setItem: () => {} }, f = flowOf(c, dead, wallet0(c));
  const r = await f.prepare("quote");
  await assert.rejects(f.send(r), /durably/);
});
