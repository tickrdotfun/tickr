// Route fees, price impact, slippage and staleness: three different things, kept apart.
// Run: node --test scripts/tests/quote.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const fx = require("./fixture.cjs");
const q = fx.src("lib/quote.ts");

const ZERO = "0x0000000000000000000000000000000000000000";
const key = (fee) => ({ currency0: ZERO, currency1: ZERO, fee, tickSpacing: 1, hooks: ZERO });
// fees are stated in pips, the unit a pool key uses: 10000 pips is one percent
const v4 = (fee) => ({ kind: 0, key: key(fee), pool: ZERO });
const wrap = () => ({ kind: 2, key: key(0), pool: ZERO });
const now = 1_800_000_000_000;

test("every hop's fee is counted, in pips, and a wrapper's mint charges none", () => {
  const r = q.routeFees(q.hopFeesFromPath([v4(100), v4(3000), v4(10000)], "buy", () => 0));
  assert.deepEqual(r.legs.map((l) => l.pips), [100, 3000, 10000]);
  assert.equal(q.routeFees(q.hopFeesFromPath([wrap()], "buy", () => 0)).totalPips, 0);
});

test("the coin's own pool, the way to it, and the chain's own take are kept apart", () => {
  const r = q.routeFees(q.hopFeesFromPath([v4(100), v4(3000), v4(10000)], "buy", () => 500));
  assert.equal(r.coinPips, 10000, "the last hop on a buy is the coin's, and the chain's take is not folded into it");
  assert.equal(r.bridgePips, q.compoundPips([100, 3000]));
  assert.equal(r.chainPips, q.compoundPips([500, 500, 500]));
  assert.equal(r.complete, true);
  // on a sell the coin's pool is the first hop, not the last
  const sell = q.routeFees(q.hopFeesFromPath([v4(10000), v4(3000), v4(100)], "sell", () => 0));
  assert.equal(sell.coinPips, 10000);
});

test("a protocol fee that was never read makes the total a lower bound, not a zero", () => {
  const r = q.routeFees(q.hopFeesFromPath([v4(100), v4(10000)], "buy"));
  assert.equal(r.complete, false, "and the page has to say so");
  assert.equal(r.chainPips, 0);
  // the pool fees are still counted, so the number shown is a floor and not nothing
  assert.equal(r.totalPips, q.compoundPips([100, 10000]));
});

test("v4's protocol fee is directional, and its ceiling is enforced", () => {
  const packed = 300 | (700 << 12); // 300 pips one way, 700 the other
  assert.equal(q.protocolFeePips(packed, true), 300);
  assert.equal(q.protocolFeePips(packed, false), 700);
  assert.equal(q.protocolFeePips(0, true), 0);
  assert.throws(() => q.protocolFeePips(1001, true), /above v4's own ceiling/);
  assert.throws(() => q.protocolFeePips(-1, true), /impossible protocol fee/);
});

test("charges compound rather than add, and nothing is rounded until the end", () => {
  // two one percent legs keep 0.99 x 0.99 = 0.9801, so 19,900 pips and not 20,000
  assert.equal(q.compoundPips([10_000, 10_000]), 19_900);
  assert.equal(q.compoundPips([]), 0);
  // three legs that would each round away to nothing in basis points still count together
  const tiny = q.compoundPips([40, 40, 40]);
  assert.equal(tiny, 120);
  assert.equal(q.pipsToBps(tiny), 1.2, "and the fraction survives to the display");
  assert.throws(() => q.compoundPips([1_000_000]), /impossible fee/);
});

test("price impact is measured against the price before the trade, and never goes negative", () => {
  assert.equal(q.priceImpactBps(1000n, 990n), 100);
  assert.equal(q.priceImpactBps(1000n, 1000n), 0);
  assert.equal(q.priceImpactBps(1000n, 1200n), 0, "a route that beat its estimate has no impact to warn about");
  assert.throws(() => q.priceImpactBps(0n, 1n), /no reference price/);
});

test("a quote goes stale, and one from the future is just as unusable", () => {
  const fresh = { out: 100n, at: now };
  assert.equal(q.isStale(fresh, now), false);
  assert.equal(q.isStale(fresh, now + q.QUOTE_TTL_MS + 1), true);
  assert.equal(q.isStale({ out: 100n, at: now + 5_000 }, now), true);
});

test("the minimum comes from the quote and the slippage, and nothing else", () => {
  const fresh = { out: 1_000_000n, at: now };
  assert.equal(q.minimumOut(fresh, 300, now), 970_000n);
  assert.equal(q.minimumOut(fresh, 5, now), 999_500n);
  assert.throws(() => q.minimumOut(fresh, 4, now), /slippage must be between/);
  assert.throws(() => q.minimumOut(fresh, 5_001, now), /slippage must be between/);
  assert.throws(() => q.minimumOut({ out: 0n, at: now }, 300, now), /returns nothing/);
  assert.throws(() => q.minimumOut({ out: 1n, at: now }, 5_000, now), /rounds to nothing/);
});

test("a stale quote cannot be sent, however good it looks", () => {
  const old = { out: 1_000_000n, at: now - q.QUOTE_TTL_MS - 1 };
  assert.throws(() => q.minimumOut(old, 300, now), /too old to send/);
});

test("the refresh is what makes the minimum mean anything, and a worse quote makes a worse minimum", () => {
  const old = { out: 1_000_000n, at: now };
  // the price moved against the trade between quoting and sending: the minimum follows it down
  assert.equal(q.refreshedMinimum({ out: 900_000n, at: now }, old, 300, now), 873_000n);
  // and never back up to the older, better quote
  assert.notEqual(q.refreshedMinimum({ out: 900_000n, at: now }, old, 300, now), 970_000n);
  // with no fresh quote and an expired old one, nothing is sent
  assert.throws(() => q.refreshedMinimum(undefined, { out: 1_000_000n, at: now - 60_000 }, 300, now), /expired.*nothing was sent/);
});

test("the floor is taken as late as possible, and a fresh quote that fails is not silently replaced by an old one", async () => {
  const notes = [];
  const on = (w) => notes.push(w);
  const reviewed = { out: 1_000_000n, at: Date.now() };

  // the ordinary case: a fresh quote is taken and the floor comes from it
  assert.equal(await q.floorFor(reviewed, async () => 990_000n, 300, on), 960_300n);

  // the fresh quote fails and the reviewed one is still good: it is used, and said to be
  assert.equal(await q.floorFor(reviewed, async () => null, 300, on), 970_000n);

  // the fresh quote fails and the reviewed one has gone stale: nothing is sent
  await assert.rejects(() => q.floorFor({ out: 1_000_000n, at: Date.now() - 60_000 }, async () => null, 300, on), /nothing was sent/);

  // a quote whose age is unknown counts as stale, not as new
  await assert.rejects(() => q.floorFor({ out: 1_000_000n, at: 0 }, async () => null, 300, on), /nothing was sent/);
  assert.equal(notes.length, 0);
});

test("terms that got materially worse stop for another look instead of being sent", async () => {
  const notes = [];
  const on = (w) => notes.push(w);
  const reviewed = { out: 1_000_000n, at: Date.now() };

  // one percent worse is inside the tolerance and goes through
  assert.equal(typeof (await q.floorFor(reviewed, async () => 990_000n, 300, on)), "bigint");
  assert.equal(notes.length, 0);

  // two percent worse is not
  await assert.rejects(() => q.floorFor(reviewed, async () => 980_000n, 300, on), /review them again/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /the price moved 2\.00% against this trade/);

  // and a fresh quote that is better is simply used
  assert.equal(await q.floorFor(reviewed, async () => 1_100_000n, 300, on), 1_067_000n);
});
