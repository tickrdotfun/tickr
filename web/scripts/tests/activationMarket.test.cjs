// Activation through a fixed-inventory name: the whole transaction flow, offline, against a fake chain and wallet.
// The legacy managed route is covered by activation.test.cjs and activationFlow.test.cjs and is unchanged.
// Run: node --test scripts/tests/activationMarket.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const v = require("viem");
const fx = require("./fixture.cjs");
const a = fx.src("lib/activation.ts");
const { createActivationFlow } = fx.src("lib/activationFlow.ts");
const { ADDRESSES } = fx.src("lib/addresses.ts");
const { wallet, coin, ticker, hashOf } = fx;

// the issuer's own parameters, as a read of MarketTickerDeployer would report them
const ISSUER = { kind: "market", fee: 3000, tickSpacing: 60 };
const main = { currency0: coin, currency1: ticker, fee: 10000, tickSpacing: 10, hooks: v.zeroAddress };
const pools = a.poolsFor(ticker, main, ISSUER);
const MAX = (1n << 256n) - 1n;

// ---------------------------------------------------------------- the pools themselves

test("a market name bridges through its own hookless pool, priced in dollars", () => {
  assert.equal(pools.bridge.hooks, v.zeroAddress);
  assert.equal(pools.bridge.fee, ISSUER.fee);
  assert.equal(pools.bridge.tickSpacing, ISSUER.tickSpacing);
  assert.ok([pools.bridge.currency0, pools.bridge.currency1].some((c) => c.toLowerCase() === ADDRESSES.usdg.toLowerCase()));
  assert.ok(BigInt(pools.bridge.currency0) < BigInt(pools.bridge.currency1));
  // and the managed route is still exactly what it was
  const legacy = a.poolsFor(ticker, main);
  assert.equal(legacy.bridge.hooks.toLowerCase(), ADDRESSES.managedTickerHook.toLowerCase());
  assert.equal(legacy.bridge.fee, a.MANAGED_FEE);
});

test("the two kinds may not be mistaken for one another", () => {
  const hooked = { ...pools, bridge: { ...pools.bridge, hooks: ADDRESSES.managedTickerHook } };
  assert.throws(() => a.routeFor(hooked, "quote"), /a market pool must have no hook/);
  const hookless = { ...a.poolsFor(ticker, main), bridge: { ...pools.bridge } };
  assert.throws(() => a.routeFor(hookless, "quote"), /wrong managed pool/);
  const wrongFee = { ...pools, bridge: { ...pools.bridge, fee: 500 } };
  assert.throws(() => a.routeFor(wrongFee, "quote"), /not the issuer's/);
  const wrongSpacing = { ...pools, bridge: { ...pools.bridge, tickSpacing: 1 } };
  assert.throws(() => a.routeFor(wrongSpacing, "quote"), /not the issuer's/);
  assert.doesNotThrow(() => a.routeFor(pools, "quote"), "and the market route itself is fine");
});

test("a market pool that does not price the name in dollars is refused", () => {
  const other = "0x00000000000000000000000000000000000000dd";
  const [c0, c1] = BigInt(ticker) < BigInt(other) ? [ticker, other] : [other, ticker];
  const bad = { ...pools, bridge: { currency0: c0, currency1: c1, fee: ISSUER.fee, tickSpacing: ISSUER.tickSpacing, hooks: v.zeroAddress } };
  assert.throws(() => a.routeFor(bad, "quote"), /price the name in dollars/);
});

test("nonsense issuer parameters are refused rather than encoded", () => {
  for (const [label, spec] of Object.entries({
    zeroFee: { kind: "market", fee: 0, tickSpacing: 60 },
    hugeFee: { kind: "market", fee: 1_000_000, tickSpacing: 60 },
    zeroSpacing: { kind: "market", fee: 3000, tickSpacing: 0 },
    hugeSpacing: { kind: "market", fee: 3000, tickSpacing: 40_000 },
  })) {
    const p = { ...pools, name: spec, bridge: { ...pools.bridge, fee: spec.fee, tickSpacing: spec.tickSpacing } };
    assert.throws(() => a.routeFor(p, "quote"), /out of range/, label);
  }
});

test("activation is wired for a market name without the managed hook", () => {
  assert.equal(a.isActivationWired(ISSUER), true);
  assert.equal(a.isActivationWired(), true);
});

// ---------------------------------------------------------------- the calldata

test("the encoded buy walks the market pool and settles only the disclosed amounts", () => {
  const quote = 1_240_000n, minimum = a.minimumOutput(quote), deadline = 1_800_000_000;
  const data = a.encodeBuy({ wallet, pools, phase: "quote", amountIn: a.AMOUNTS.quote, minimumOut: minimum, deadline });
  const d = a.decodeBuy(data);
  assert.equal(d.swap.path.length, 2);
  assert.equal(d.swap.path[1].hooks, v.zeroAddress);
  assert.equal(d.swap.path[1].fee, ISSUER.fee);
  assert.equal(d.swap.amountIn, a.AMOUNTS.quote);
  assert.equal(d.swap.amountOutMinimum, minimum);
  assert.equal(d.deadline, deadline);
  assert.equal(d.recipient.toLowerCase(), wallet);
  assert.equal(a.decodeBuy(a.encodeBuy({ wallet, pools, phase: "coin", amountIn: a.AMOUNTS.coin, minimumOut: 1n, deadline })).swap.path.length, 3);
});

// ---------------------------------------------------------------- the whole flow

function chain() {
  const txs = new Map(), receipts = new Map();
  const c = {
    head: 100n, latestNonce: 55n, pendingNonce: 55n, code: "0x", balance: 10n ** 18n, quoteOut: 1240000n, failReads: false,
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
      restrictions: async () => ({ tax: 0n, buy: MAX, hold: MAX }),
      quote: async (p) => (p.length === 2 ? c.quoteOut : 10n ** 18n),
      estimateGas: async () => 200_000n,
      gasPrice: async () => 10n,
      call: async () => "0x",
    },
    broadcast(req, hash, { visible = true, mined = true, ok = true, block, logs } = {}) {
      const tx = { hash, from: req.from, to: req.to, input: req.data, nonce: Number(BigInt(req.nonce)), value: BigInt(req.value), chainId: req.chainId, gas: BigInt(req.gas), maxFeePerGas: BigInt(req.maxFeePerGas) };
      c.latestNonce = BigInt(req.nonce) + 1n; c.pendingNonce = c.latestNonce;
      if (visible) txs.set(hash, tx);
      if (mined) c.mine(hash, tx, ok, block, logs);
      return tx;
    },
    mine(hash, tx, ok = true, block, logs) {
      const b = block ?? c.head;
      txs.set(hash, { ...tx, blockHash: `0x${(b + 1000n).toString(16).padStart(64, "0")}`, blockNumber: b });
      const phase = a.decodeBuy(tx.input).swap.path.length === 2 ? "quote" : "coin";
      receipts.set(hash, { transactionHash: hash, blockHash: `0x${(b + 1000n).toString(16).padStart(64, "0")}`, blockNumber: b, status: ok ? "success" : "reverted", gasUsed: 100_000n, effectiveGasPrice: 10n, logs: ok ? (logs ?? logsFor(phase)) : [] });
      c.head = b + 1n;
    },
  };
  return c;
}

const SWAP = v.parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]);
const TRANSFER = v.parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

/** Each hop paid with exactly what the hop before it returned, which is what verifyTradeLogs insists on. */
function logsFor(phase, { bridgeOut = 5_000_000n, extra = [] } = {}) {
  const out = phase === "quote" ? ticker : coin, amount = phase === "quote" ? 1240000n : 10n ** 18n;
  const route = phase === "quote" ? [pools.funding, pools.bridge] : [pools.funding, pools.bridge, pools.main];
  const entries = []; let input = v.zeroAddress, amt = a.AMOUNTS[phase];
  for (const [i, key] of route.entries()) {
    const input0 = input.toLowerCase() === key.currency0.toLowerCase();
    const outAmt = i === route.length - 1 ? amount : bridgeOut;
    entries.push({ address: ADDRESSES.poolManager, topics: v.encodeEventTopics({ abi: SWAP, eventName: "Swap", args: { id: a.poolId(key), sender: ADDRESSES.universalRouter } }), data: v.encodeAbiParameters(v.parseAbiParameters("int128,int128,uint160,uint128,int24,uint24"), [input0 ? -amt : outAmt, input0 ? outAmt : -amt, 1n, 1n, 0, key.fee]) });
    input = input0 ? key.currency1 : key.currency0; amt = outAmt;
  }
  entries.push({ address: out, topics: v.encodeEventTopics({ abi: TRANSFER, eventName: "Transfer", args: { from: ADDRESSES.poolManager, to: wallet } }), data: v.encodeAbiParameters(v.parseAbiParameters("uint256"), [amount]) });
  return [...entries, ...extra];
}

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, val) => m.set(k, val), map: m }; };
const freeLock = { request: async (_, fn) => fn() };
function walletOf(c, behaviour = {}) {
  return {
    accounts: async () => [wallet], chainId: async () => 4663,
    send: async (req) => {
      if (behaviour.reject) { const e = new Error("User rejected the request."); e.code = 4001; throw e; }
      if (behaviour.lost) { c.broadcast(req, hashOf(behaviour.n ?? 1), { visible: behaviour.visible ?? true, mined: behaviour.mined ?? false }); throw new Error("Failed to fetch"); }
      c.broadcast(req, hashOf(behaviour.n ?? 1), { visible: behaviour.visible ?? true, mined: behaviour.mined ?? true, ok: behaviour.ok ?? true, logs: behaviour.logs });
      return hashOf(behaviour.n ?? 1);
    },
  };
}
const flowOf = (c, storage, provider, locks = freeLock) => createActivationFlow({ chainId: 4663, wallet, coin, ticker, pools, router: ADDRESSES.universalRouter, storage, reads: c.reads, provider, locks, now: () => 1_800_000_000_000 });

test("both purchases go through, in order, and the coin waits for the name", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, walletOf(c, { n: 1 }));
  await assert.rejects(f.prepare("coin"), /confirm the earlier purchase first/);

  const r1 = await f.prepare("quote");
  assert.equal(BigInt(r1.minimum), a.minimumOutput(1240000n));
  assert.equal(r1.pools.bridge.hooks, v.zeroAddress, "the review carries the market pool, not a managed one");
  const l1 = await f.send(r1);
  const s1 = await f.inspect(l1);
  assert.equal(s1.records[0].status, "confirmed");
  assert.equal(s1.records[0].received, 1240000n, "the name that arrived is what the receipt shows");

  const f2 = flowOf(c, s, walletOf(c, { n: 2 }));
  const r2 = await f2.prepare("coin");
  assert.equal(r2.predecessorHash, hashOf(1));
  const l2 = await f2.send(r2);
  const s2 = await f2.inspect(l2);
  assert.equal(s2.confirmed, true);
  assert.equal(s2.records[1].received, 10n ** 18n);
});

test("a purchase is never made twice", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, walletOf(c, { n: 1 }));
  const r1 = await f.prepare("quote");
  await f.send(r1);
  // the same phase, again, from the same wallet and the same record
  await assert.rejects(f.prepare("quote"), /never repeated|confirm the earlier/);
  // and the very same reviewed request cannot be sent a second time
  await assert.rejects(f.send(r1), /never repeated|already|confirm/i);

  const f2 = flowOf(c, s, walletOf(c, { n: 2 }));
  const r2 = await f2.prepare("coin");
  await f2.send(r2);
  await assert.rejects(f2.prepare("coin"), /confirm the earlier purchase|never repeated/);
  await assert.rejects(f2.prepare("quote"), /never repeated|confirm the earlier/);
  assert.equal(f2.load().attempts.length, 2, "two attempts, and no more, however many times it is asked");
});

test("a wallet answer that never arrives blocks everything until the transaction is identified", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, walletOf(c, { lost: true, visible: false }));
  const r = await f.prepare("quote");
  await assert.rejects(f.send(r), /did not return a transaction hash/);
  const l = f.load();
  assert.equal(l.attempts.length, 1);
  assert.equal(l.attempts[0].hash, undefined);
  const st = await f.inspect(l);
  assert.equal(st.unknown, true);
  // nothing may be sent while an attempt is unaccounted for: that is what stops a duplicate purchase
  await assert.rejects(f.prepare("quote"), /never repeated|confirm the earlier/);
  await assert.rejects(f.prepare("coin"), /confirm the earlier purchase/);
  await assert.rejects(f.recover(hashOf(1)), /no transaction is visible/);
});

test("the coin purchase may not spend the name the first purchase bought", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, walletOf(c, { n: 1 }));
  await f.send(await f.prepare("quote"));

  const spendsTheName = [{
    address: ticker,
    topics: v.encodeEventTopics({ abi: TRANSFER, eventName: "Transfer", args: { from: wallet, to: ADDRESSES.poolManager } }),
    data: v.encodeAbiParameters(v.parseAbiParameters("uint256"), [1240000n]),
  }];
  const f2 = flowOf(c, s, walletOf(c, { n: 2, logs: logsFor("coin", { extra: spendsTheName }) }));
  const l2 = await f2.send(await f2.prepare("coin"));
  const st = await f2.inspect(l2);
  assert.equal(st.confirmed, false, "a receipt showing the name being spent is not a confirmation");
  assert.match(st.records[1].note || st.blocked, /name/i);
});

test("a receipt whose hops do not carry the previous hop's output is refused", async () => {
  const c = chain(), s = memory(), f = flowOf(c, s, walletOf(c, { n: 1 }));
  const r = await f.prepare("quote");
  const ledger = { version: 1, chainId: 4663, wallet, coin, ticker, attempts: [{ review: r, createdAt: 1 }], declined: [] };
  const good = logsFor("quote");
  assert.equal(a.verifyTradeLogs(ledger, "quote", good, BigInt(r.minimum), pools), 1240000n);

  // the second hop is paid something other than what the first returned
  const broken = logsFor("quote");
  const swap = v.decodeAbiParameters(v.parseAbiParameters("int128,int128,uint160,uint128,int24,uint24"), broken[1].data);
  broken[1].data = v.encodeAbiParameters(v.parseAbiParameters("int128,int128,uint160,uint128,int24,uint24"), [swap[0] < 0n ? swap[0] / 2n : swap[0], swap[1] < 0n ? swap[1] / 2n : swap[1], swap[2], swap[3], swap[4], swap[5]]);
  assert.throws(() => a.verifyTradeLogs(ledger, "quote", broken, BigInt(r.minimum), pools), /expected input/);
});
