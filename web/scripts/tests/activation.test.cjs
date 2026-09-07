// Offline cases for the pure activation library: the calldata, the checks on it, the journal and what a receipt must show.
// Run: node --test scripts/tests/activation.test.cjs
"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), { test } = require("node:test");
const ts = require("typescript"), v = require("viem");
require.extensions[".ts"] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, f);
process.env.NEXT_PUBLIC_UNIVERSAL_ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
process.env.NEXT_PUBLIC_MANAGED_TICKER_HOOK = "0x3eC51B11c1AfaaF7B084B7A31B6945413CC5Aac0";
const a = require(path.join(__dirname, "..", "..", "src", "lib", "activation.ts"));
const { ADDRESSES } = require(path.join(__dirname, "..", "..", "src", "lib", "addresses.ts"));
const wallet = "0x00000000000000000000000000000000000000a1";
const coin = "0x1ebf16a641e5f5e1bf0ed4fa8c126ecf590523cd", ticker = "0xf1ff8ca3e0e7f843365b7c7c8e38a093dd0a82d0";
const pools = a.poolsFor(ticker, { currency0: coin, currency1: ticker, fee: 10000, tickSpacing: 10, hooks: v.zeroAddress });
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
function review(phase = "quote", quote = 1240000n) {
  const minimum = a.minimumOutput(quote), deadline = 1_800_000_000;
  const data = a.encodeBuy({ wallet, pools, phase, amountIn: a.AMOUNTS[phase], minimumOut: minimum, deadline });
  const request = { from: wallet, to: ADDRESSES.universalRouter, data, value: a.hex(a.AMOUNTS[phase]), nonce: phase === "quote" ? "0x37" : "0x38", chainId: 4663, gas: "0x30000", maxFeePerGas: "0x10", maxPriorityFeePerGas: "0x0" };
  return { phase, request, maximum: String(a.maximumCost(request)), preparedAt: Date.now(), ledgerFingerprint: "0x", quote: String(quote), minimum: String(minimum), deadline, predecessorHash: phase === "quote" ? "" : hash(1), pools, gasEstimate: "1" };
}
const ledger = (two = false) => ({ version: 1, chainId: 4663, wallet, coin, ticker, attempts: two ? [{ review: review(), createdAt: 1, hash: hash(1) }, { review: review("coin", 10n ** 18n), createdAt: 2 }] : [], declined: [] });

test("a reviewed request round-trips through the router encoding", () => {
  const r = review();
  const d = a.decodeBuy(r.request.data);
  assert.equal(d.recipient.toLowerCase(), wallet);
  assert.equal(d.swap.amountIn, a.AMOUNTS.quote);
  assert.equal(d.swap.amountOutMinimum, a.minimumOutput(1240000n));
  assert.equal(d.swap.path.length, 2);
  assert.equal(a.decodeBuy(review("coin").request.data).swap.path.length, 3);
});
test("both phases and an ordered ledger validate", () => { const l = ledger(true); a.validateReview(l, review()); a.validateReview(l, review("coin", 10n ** 18n)); a.validateLedger(l, 4663, wallet, coin); });
for (const phase of a.PHASES)
  for (const [label, mutate] of Object.entries({
    value: (r) => (r.request.value = "0x1"),
    sender: (r) => (r.request.from = v.zeroAddress),
    target: (r) => (r.request.to = wallet),
    minimum: (r) => (r.minimum = "1"),
    quote: (r) => (r.quote = "0"),
    calldata: (r) => (r.request.data = r.request.data.slice(0, 330) + (r.request.data[330] === "0" ? "1" : "0") + r.request.data.slice(331)),
    priority: (r) => (r.request.maxPriorityFeePerGas = "0x1"),
    ceiling: (r) => (r.maximum = "1"),
    chain: (r) => (r.request.chainId = 1),
  }))
    test(`${phase}: a changed ${label} is refused`, () => { const r = review(phase, phase === "quote" ? 1240000n : 10n ** 18n); mutate(r); assert.throws(() => a.validateReview(ledger(true), r)); });
test("the coin review needs the name's receipt and the name review must not carry one", () => {
  const l = ledger(true); l.attempts[1].review.predecessorHash = hash(9); assert.throws(() => a.validateLedger(l, 4663, wallet, coin));
  const r = review(); r.predecessorHash = hash(1); assert.throws(() => a.validateReview(ledger(), r));
});
test("a zero or absent quote never makes a minimum", () => { assert.throws(() => a.minimumOutput(0n)); assert.throws(() => a.minimumOutput(undefined)); assert.equal(a.minimumOutput(10_000n), 9_900n); assert.throws(() => a.minimumOutput(10n, 1000)); });
test("a wrong route is refused before any calldata exists", () => {
  const bad = { ...pools, bridge: { ...pools.bridge, fee: 3000 } };
  assert.throws(() => a.encodeBuy({ wallet, pools: bad, phase: "quote", amountIn: a.AMOUNTS.quote, minimumOut: 1n, deadline: 1 }));
  assert.throws(() => a.encodeBuy({ wallet: ADDRESSES.universalRouter, pools, phase: "quote", amountIn: a.AMOUNTS.quote, minimumOut: 1n, deadline: 1 }));
  assert.throws(() => a.encodeBuy({ wallet, pools, phase: "quote", amountIn: a.AMOUNTS.quote, minimumOut: 0n, deadline: 1 }));
});
test("a record of another wallet, chain or coin is never adopted, and a failed durable write stops", () => {
  assert.throws(() => a.validateLedger(ledger(), 1, wallet, coin));
  assert.throws(() => a.validateLedger(ledger(), 4663, v.zeroAddress, coin));
  assert.throws(() => a.loadLedger({ getItem: () => "{bad" }, 4663, wallet, coin, ticker));
  const dead = { getItem: () => null, setItem: () => {} };
  assert.throws(() => a.saveLedger(dead, ledger()), /durably/);
});
function logs(phase, opts = {}) {
  const out = phase === "quote" ? ticker : coin, amount = phase === "quote" ? 1240000n : 10n ** 18n;
  const route = phase === "quote" ? [pools.funding, pools.bridge] : [pools.funding, pools.bridge, pools.main];
  const entries = [];
  let input = v.zeroAddress, amt = a.AMOUNTS[phase];
  for (const [i, key] of route.entries()) {
    const input0 = input.toLowerCase() === key.currency0.toLowerCase();
    const outAmt = i === route.length - 1 ? amount : 5_000_000n;
    entries.push({ address: ADDRESSES.poolManager, topics: v.encodeEventTopics({ abi: v.parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]), eventName: "Swap", args: { id: a.poolId(key), sender: opts.sender || ADDRESSES.universalRouter } }), data: v.encodeAbiParameters(v.parseAbiParameters("int128,int128,uint160,uint128,int24,uint24"), [input0 ? -amt : outAmt, input0 ? outAmt : -amt, 1n, 1n, 0, key.fee]) });
    input = input0 ? key.currency1 : key.currency0; amt = outAmt;
  }
  const transferAbi = v.parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
  entries.push({ address: out, topics: v.encodeEventTopics({ abi: transferAbi, eventName: "Transfer", args: { from: ADDRESSES.poolManager, to: opts.to || wallet } }), data: v.encodeAbiParameters(v.parseAbiParameters("uint256"), [opts.short ? amount - 1n : amount]) });
  return entries;
}
for (const phase of a.PHASES) {
  test(`${phase}: a receipt proves the full route and the wallet delivery`, () => assert.equal(a.verifyTradeLogs(ledger(true), phase, logs(phase), 1n, pools), phase === "quote" ? 1240000n : 10n ** 18n));
  test(`${phase}: a swap by another router, a delivery elsewhere, a short delivery or a missing hop is refused`, () => {
    const l = ledger(true);
    assert.throws(() => a.verifyTradeLogs(l, phase, logs(phase, { sender: wallet }), 1n, pools));
    assert.throws(() => a.verifyTradeLogs(l, phase, logs(phase, { to: v.zeroAddress }), 1n, pools));
    assert.throws(() => a.verifyTradeLogs(l, phase, logs(phase, { short: true }), 1n, pools));
    assert.throws(() => a.verifyTradeLogs(l, phase, logs(phase).slice(1), 1n, pools));
    assert.throws(() => a.verifyTradeLogs(l, phase, logs(phase), 10n ** 30n, pools));
  });
}
test("the coin purchase must not spend the name bought into the wallet", () => {
  const x = logs("coin");
  x.push({ address: ticker, topics: v.encodeEventTopics({ abi: v.parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]), eventName: "Transfer", args: { from: wallet, to: ADDRESSES.poolManager } }), data: v.encodeAbiParameters(v.parseAbiParameters("uint256"), [1n]) });
  assert.throws(() => a.verifyTradeLogs(ledger(true), "coin", x, 1n, pools), /must not spend/);
});
test("a submitted transaction must match the reviewed identity", () => {
  const r = review().request;
  a.matchIdentity({ from: wallet, to: r.to, input: r.data, nonce: 0x37, value: a.AMOUNTS.quote, chainId: 4663 }, r);
  assert.throws(() => a.matchIdentity({ from: wallet, to: r.to, input: r.data, nonce: 0x38, value: a.AMOUNTS.quote, chainId: 4663 }, r));
  assert.throws(() => a.matchIdentity({ from: wallet, to: r.to, input: "0x00", nonce: 0x37, value: a.AMOUNTS.quote, chainId: 4663 }, r));
});
test("a review expires", () => { const r = review(); assert.equal(a.reviewExpired(r), false); r.preparedAt = Date.now() - 200_000; assert.equal(a.reviewExpired(r), true); });
