/**
 * The keeper's lease and pending record, exercised through the real Durable Object.
 *
 * Everything here goes through the deployed handler and its real storage: the transitions are already covered
 * as pure functions, and what this adds is that they are wired to persistence correctly, survive a restart, and
 * behave under the two orderings that matter — a lost response, and two runs at once.
 *
 * No signing credentials are configured and no chain is reached.
 */
import assert from "node:assert";
import { unstable_dev } from "wrangler";

// both runs of the worker share one on-disk store, or "restart" would just be a second empty object and the
// check below would pass without proving anything
// wrangler puts the store under <persist>/.wrangler, so that is what has to go for a clean start. A stale
// store made this suite pass once and fail on the next run, which is worse than failing every time.
const PERSIST = "test/.state";
import { rmSync } from "node:fs";
for (const d of [PERSIST, "test/.wrangler", ".wrangler/state"]) rmSync(d, { recursive: true, force: true });

let worker = await unstable_dev("test/do-entry.ts", {
  config: "test/wrangler.test.jsonc",
  experimental: { disableExperimentalWarning: true },
  local: true,
  persist: PERSIST,
});

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ok  " + name); };
const call = async (op, params = {}) => {
  const qs = new URLSearchParams({ op, ...params }).toString();
  const r = await worker.fetch(`https://x/?${qs}`, params.__body ? { method: "POST", body: params.__body } : undefined);
  return r.json();
};
const post = async (op, params, body) => {
  const qs = new URLSearchParams({ op, ...params }).toString();
  const r = await worker.fetch(`https://x/?${qs}`, { method: "POST", body: JSON.stringify(body) });
  return r.json();
};

const A = "run-a", B = "run-b";
const inst = (s) => ({ instance: s });

try {
  await t("two simultaneous runs: only one takes the lease", async () => {
    const i = inst("sim");
    const [a, b] = await Promise.all([call("acquire", { ...i, token: A }), call("acquire", { ...i, token: B })]);
    const wins = [a, b].filter((r) => r.ok);
    const loses = [a, b].filter((r) => !r.ok);
    assert.equal(wins.length, 1, "exactly one run may hold the lease");
    assert.equal(loses.length, 1);
    assert.ok(/another run holds the lease/.test(loses[0].reason), loses[0].reason);
  });

  await t("a run that lost the race cannot record anything", async () => {
    const i = inst("sim");
    const s = await call("peek", i);
    const loser = s.state.owner === A ? B : A;
    const r = await post("record", { ...i, token: loser }, { label: "collectFees", hash: "0xaaa", nonce: 1, at: 1 });
    assert.equal(r.ok, false);
    assert.ok(/taken over|no lease/.test(r.reason), r.reason);
  });

  await t("a broadcast whose response is lost stays recorded", async () => {
    const i = inst("lost");
    const a = await call("acquire", { ...i, token: A });
    assert.equal(a.ok, true);
    // signed and recorded BEFORE the broadcast; the send then appears to fail
    const rec = await post("record", { ...i, token: A }, { label: "collectFees", hash: "0xlost", nonce: 7, at: 1 });
    assert.equal(rec.ok, true);
    const s = await call("peek", i);
    assert.equal(s.state.pending.hash, "0xlost", "the hash survives a send that never answered");
    assert.equal(s.state.pending.nonce, 7);
  });

  await t("the next run inherits it and must resolve it first", async () => {
    const i = inst("lost");
    await call("release", { ...i, token: A });
    const next = await call("acquire", { ...i, token: B });
    assert.equal(next.ok, true);
    assert.equal(next.resolveFirst.hash, "0xlost", "handed back to be settled before any new write");
  });

  await t("clearing the wrong hash is refused", async () => {
    const i = inst("lost");
    const bad = await call("clear", { ...i, token: B, hash: "0xsomethingelse" });
    assert.equal(bad.ok, false);
    assert.ok(/refusing to clear/.test(bad.reason), bad.reason);
    const still = await call("peek", i);
    assert.equal(still.state.pending.hash, "0xlost", "the record is untouched");
  });

  await t("clearing the right hash works", async () => {
    const i = inst("lost");
    const good = await call("clear", { ...i, token: B, hash: "0xlost" });
    assert.equal(good.ok, true);
    const s = await call("peek", i);
    assert.equal(s.state.pending, undefined);
  });

  await t("an old run resuming after a takeover is refused every mutation", async () => {
    const i = inst("takeover");
    // run A takes a lease that then expires
    const a = await call("acquire", { ...i, token: A, lease: "1" });
    assert.equal(a.ok, true);
    await new Promise((r) => setTimeout(r, 30));
    // run B takes it over
    const b = await call("acquire", { ...i, token: B });
    assert.equal(b.ok, true, "an expired lease may be taken over");
    // B records its own write
    assert.equal((await post("record", { ...i, token: B }, { label: "treasury.collect", hash: "0xbbb", nonce: 9, at: 2 })).ok, true);

    // now A wakes up and tries to finish what it started
    const staleRecord = await post("record", { ...i, token: A }, { label: "collectFees", hash: "0xaaa", nonce: 8, at: 3 });
    assert.equal(staleRecord.ok, false, "a stale run must not record");
    const staleClear = await call("clear", { ...i, token: A, hash: "0xbbb" });
    assert.equal(staleClear.ok, false, "a stale run must not clear the new run's record");
    const staleRelease = await call("release", { ...i, token: A });
    assert.equal(staleRelease.ok, false, "a stale run must not release the new run's lease");

    const s = await call("peek", i);
    assert.equal(s.state.owner, B, "the lease is still B's");
    assert.equal(s.state.pending.hash, "0xbbb", "and B's record is intact");
  });

  await t("a second write cannot be recorded over an unsettled one", async () => {
    const i = inst("takeover");
    const r = await post("record", { ...i, token: B }, { label: "treasury.buy", hash: "0xccc", nonce: 10, at: 4 });
    assert.equal(r.ok, false);
    assert.ok(/already pending/.test(r.reason), r.reason);
  });

  await t("an unsettled record survives the worker restarting", async () => {
    const i = inst("takeover");
    const before = await call("peek", i);
    assert.equal(before.state.pending.hash, "0xbbb", "there is something to survive");

    await worker.stop();
    worker = await unstable_dev("test/do-entry.ts", {
      config: "test/wrangler.test.jsonc",
      experimental: { disableExperimentalWarning: true },
      local: true,
      persist: PERSIST,
    });

    const after = await call("peek", i);
    assert.equal(after.state.pending?.hash, "0xbbb", "a restart must not lose an unsettled write");
    assert.equal(after.state.pending?.nonce, 9);
    assert.equal(after.state.owner, "run-b", "nor the lease it belongs to");
  });

  await t("and the run after the restart still has to resolve it", async () => {
    const i = inst("takeover");
    // b's lease is still live, so a third run is refused; once it lapses the record is handed on
    const third = await call("acquire", { ...i, token: "run-c" });
    assert.equal(third.ok, false, "b still holds it");
    assert.ok(/another run holds the lease/.test(third.reason));
  });

  await t("a record whose body arrives late, after a takeover, is refused", async () => {
    const i = inst("slowbody");

    // run A takes a short lease
    const a = await call("acquire", { ...i, token: A, lease: "40" });
    assert.equal(a.ok, true);

    // A starts recording, but its body trickles in. This is the window that used to be exploitable: the state
    // was read first, so the ownership check saw A still holding the lease no matter what happened meanwhile.
    const payload = JSON.stringify({ label: "collectFees", hash: "0xslow", nonce: 21, at: 1 });
    let releaseBody;
    const bodyArrived = new Promise((r) => { releaseBody = r; });
    const slow = new ReadableStream({
      async pull(c) {
        await bodyArrived;
        c.enqueue(new TextEncoder().encode(payload));
        c.close();
      },
    });
    const qs = new URLSearchParams({ op: "record", ...i, token: A }).toString();
    const inFlight = worker.fetch(`https://x/?${qs}`, { method: "POST", body: slow, duplex: "half" });

    // while A's body is still in the air, its lease lapses and B takes over
    await new Promise((r) => setTimeout(r, 80));
    const b = await call("acquire", { ...i, token: B });
    assert.equal(b.ok, true, "B takes over the expired lease");

    // now A's body finally lands
    releaseBody();
    const late = await (await inFlight).json();

    assert.equal(late.ok, false, "the late write must be refused: A no longer holds the lease");
    assert.ok(/taken over/.test(late.reason), late.reason);

    const s2 = await call("peek", i);
    assert.equal(s2.state.owner, B, "the lease is B's");
    assert.equal(s2.state.pending, undefined, "and A's write was never recorded");
  });

  await t("the same run, body delayed but lease still held, still works", async () => {
    const i = inst("slowbody-ok");
    const a = await call("acquire", { ...i, token: A });
    assert.equal(a.ok, true);
    const payload = JSON.stringify({ label: "collectFees", hash: "0xfine", nonce: 22, at: 2 });
    let go;
    const gate = new Promise((r) => { go = r; });
    const slow = new ReadableStream({
      async pull(c) { await gate; c.enqueue(new TextEncoder().encode(payload)); c.close(); },
    });
    const qs = new URLSearchParams({ op: "record", ...i, token: A }).toString();
    const inFlight = worker.fetch(`https://x/?${qs}`, { method: "POST", body: slow, duplex: "half" });
    await new Promise((r) => setTimeout(r, 60));
    go();
    const r = await (await inFlight).json();
    assert.equal(r.ok, true, "a slow body is not itself a failure");
    assert.equal((await call("peek", i)).state.pending.hash, "0xfine");
  });

  await t("one failed run is quiet, two in a row raise an alarm", async () => {
    const one = await (await worker.fetch("https://x/?op=policy&outcomes=could not")).json();
    assert.equal(one.alarms[0], undefined, "a single failure is not yet a pattern");

    const two = await (await worker.fetch("https://x/?op=policy&outcomes=could not,could not")).json();
    assert.ok(/2 consecutive runs could not do any work/.test(two.alarms[1]), two.alarms[1]);
    assert.ok(/estimate would not resolve/.test(two.alarms[1]), "the alarm says what went wrong");

    const reset = await (await worker.fetch("https://x/?op=policy&outcomes=could not,worked,could not")).json();
    assert.equal(reset.alarms[2], undefined, "a run that worked clears the streak");
    assert.equal(reset.history.consecutiveNoWork, 1);

    const idle = await (await worker.fetch("https://x/?op=policy&outcomes=nothing to do,nothing to do,nothing to do")).json();
    assert.equal(idle.alarms.filter(Boolean).length, 0, "having nothing to do is not a failure");
  });

  await t("a balance below one cycle is reported before the cycle is tried", async () => {
    const short = await (await worker.fetch("https://x/?op=policy&balance=50362000000000&need=460000000000000")).json();
    assert.ok(/below the 460000000000000 wei one cycle needs/.test(short.low), short.low);

    const fine = await (await worker.fetch("https://x/?op=policy&balance=1500000000000000&need=460000000000000")).json();
    assert.equal(fine.low, null, "a funded keeper says nothing");
  });

  console.log(`\ndurable object: ${n} checks passed`);
} finally {
  try { await worker.stop(); } catch {}
}
