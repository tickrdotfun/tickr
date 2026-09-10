const assert = require("assert");
const path = require("path");
const { src } = require("../ts-load.cjs");
src("lib/gasHeadroom.ts"); // registers the .ts require hook
const P = require(path.join(__dirname, "../../../workers/tokens/src/keeper-policy.ts"));
const { gasWithHeadroom, afterResolve, acquire, record, clear, release, GAS_CEILING } = P;
const web = src("lib/gasHeadroom.ts");

let n = 0; const t = (name, fn) => { fn(); n++; };

// ---- 2. the ceiling refuses, it does not clamp
t("a padded estimate that fits is doubled", () => {
  const d = gasWithHeadroom(400_000n);
  assert.equal(d.ok, true);
  assert.equal(d.gas, 800_000n);
});

t("over the ceiling it REFUSES rather than clipping down", () => {
  const d = gasWithHeadroom(2_000_000n); // padded 4,000,000 > 3,000,000
  assert.equal(d.ok, false, "must refuse");
  assert.ok(/over the .* ceiling|not sent/.test(d.reason), d.reason);
});

t("clipping would have sent LESS than the estimate, which is the bug", () => {
  const estimate = 2_000_000n;
  const clipped = GAS_CEILING; // what the old code did
  assert.ok(clipped < estimate * 2n, "the clamp is below the padded need");
  assert.equal(gasWithHeadroom(estimate).ok, false, "so it is refused instead");
});

t("exactly at the ceiling is allowed", () => {
  const d = gasWithHeadroom(GAS_CEILING / 2n);
  assert.equal(d.ok, true);
  assert.equal(d.gas, GAS_CEILING);
});

t("a zero estimate is refused", () => assert.equal(gasWithHeadroom(0n).ok, false));

t("the site uses the same rule as the keeper", () => {
  assert.equal(web.gasWithHeadroom(400_000n).gas, 800_000n);
  assert.equal(web.gasWithHeadroom(2_000_000n).ok, false);
});

// ---- 1 & 3. the lease, and a broadcast whose answer was lost

t("two runs starting together: the second is refused", () => {
  // the durable object serialises them, so this is exactly the order they see
  let state = {};
  const first = acquire(state, 1_000, 300_000, "A");
  assert.equal(first.ok, true, "the first run takes the lease");
  state = first.state;

  const second = acquire(state, 1_000, 300_000, "B"); // same instant
  assert.equal(second.ok, false, "the second must be turned away");
  assert.ok(/another run holds the lease/.test(second.reason), second.reason);
});

t("a lease that has expired is taken over, so a dead run cannot lock the keeper out", () => {
  const state = { leaseUntil: 5_000 };
  assert.equal(acquire(state, 4_999, 300_000, "B").ok, false, "still live at 4,999");
  assert.equal(acquire(state, 5_001, 300_000, "B").ok, true, "expired at 5,001");
});

t("the lease comes back with whatever the last run left unsettled", () => {
  const pending = { label: "collectFees", hash: "0xabc", nonce: 7, at: 1 };
  const a = acquire({ pending }, 9_000, 300_000, "A");
  assert.equal(a.ok, true);
  assert.deepEqual(a.resolveFirst, pending, "it must be handed back to be resolved first");
});

t("a broadcast accepted by the node whose response is lost is still recorded", () => {
  // the hash is computed from the signed transaction, so it exists before anyone broadcasts it
  const signedHash = "0xdeadbeef", nonce = 12;
  let state = acquire({}, 0, 300_000, "A").state;
  const r = record(state, { label: "collectFees", hash: signedHash, nonce, at: 1 }, "A");
  assert.equal(r.ok, true);
  state = r.state;
  // ...the send now throws, because the answer never came back. the record survives.
  assert.equal(state.pending.hash, signedHash, "the hash is known even though the send appeared to fail");
  assert.equal(state.pending.nonce, nonce, "and so is the nonce it used");

  // the next run picks it up rather than starting fresh
  const next = acquire(state, 600_000, 300_000, "B");
  assert.equal(next.ok, true);
  assert.equal(next.resolveFirst.hash, signedHash, "the next run resolves it before writing");
});

t("that lost broadcast, once mined, settles and unblocks", () => {
  const d = afterResolve({ settled: true, status: "success" });
  assert.equal(d.clear, true);
  assert.equal(d.mayWrite, true);
});

t("and while it stays unknown, nothing else is written", () => {
  const d = afterResolve({ settled: false, reason: "no receipt and the nonce is still open" });
  assert.equal(d.clear, false, "the record survives for the run after");
  assert.equal(d.mayWrite, false, "and no further write goes out");
});

t("a second write cannot be recorded on top of an unsettled one", () => {
  const state = { owner: "A", leaseUntil: 9e9, pending: { label: "collectFees", hash: "0xabc", nonce: 7, at: 1 } };
  const r = record(state, { label: "treasury.collect", hash: "0xdef", nonce: 8, at: 2 }, "A");
  assert.equal(r.ok, false, "the second must be refused");
  assert.ok(/already pending/.test(r.reason), r.reason);
});

t("clearing removes only the record; releasing removes only the lease", () => {
  const state = { leaseUntil: 9_000, owner: "A", pending: { label: "x", hash: "0x1", nonce: 1, at: 1 } };
  const c = clear(state, "0x1", "A");
  assert.equal(c.ok, true);
  assert.equal(c.state.pending, undefined);
  assert.equal(c.state.leaseUntil, 9_000, "clearing a record must not drop the lease");
  const r = release(state, "A");
  assert.equal(r.ok, true);
  assert.equal(r.state.leaseUntil, undefined);
  assert.ok(r.state.pending, "releasing the lease must not drop an unsettled record");
});

t("every mutation needs the lease it is acting under", () => {
  const state = { leaseUntil: 9e9, owner: "A", pending: { label: "x", hash: "0x1", nonce: 1, at: 1 } };
  assert.equal(record(state, { label: "y", hash: "0x2", nonce: 2, at: 2 }, "B").ok, false);
  assert.equal(clear(state, "0x1", "B").ok, false, "a stale run must not clear");
  assert.equal(release(state, "B").ok, false, "a stale run must not release");
});

t("clearing must name the hash it settles", () => {
  const state = { leaseUntil: 9e9, owner: "A", pending: { label: "x", hash: "0x1", nonce: 1, at: 1 } };
  assert.equal(clear(state, "0xother", "A").ok, false, "a mismatched hash is refused");
  assert.equal(clear(state, "0x1", "A").ok, true);
});

console.log(`keeperPolicy: ${n} tests passed`);
