#!/usr/bin/env node
// Runs the v2 genesis stages of script/GenesisV2.s.sol in order, and the airdrop of script/AirdropV2.s.sol after
// it, deciding every step from confirmed receipts rather than from what forge simulated.
//
// A forge script works out all of its transactions in a simulation before it sends them, so nothing it reads during
// a run describes the chain after its own sends. This runner is the part that does: it sends one stage, finds each
// transaction the wallet's nonce says landed, checks it is the one forge meant (sender, nonce, target, and for the
// launch the exact calldata), waits for its receipt in a canonical block with a block on top, checks what the
// receipt's logs moved, and writes all of that to a journal before the next stage is simulated against the new
// state. Nothing is ever resent automatically. A run that stops, for any reason, is resumed by running it again:
// the journal and the wallet's nonce say what landed, and each stage re-checks the chain on its own.
//
// usage:  node script/genesis-v2.mjs              the genesis: launch, listing buys, split, verify
//         node script/genesis-v2.mjs buy          the first buy, by hand, when the launch landed and nothing else did
//         node script/genesis-v2.mjs resolve <s> [hash]
//                                                 "I checked the chain: that stage sent nothing" — the only way a
//                                                 stage held for review is cleared, and it looks again first. With a
//                                                 hash: "the transaction at that nonce is this one", which it then
//                                                 checks like any other
//         node script/genesis-v2.mjs airdrop    the airdrop, once the genesis is verified and protection is over
//         node script/genesis-v2.mjs status     the journal, read only
// env:    RPC_URL, GENESIS_JOURNAL (a file path; created on the first run), and everything GenesisV2.s.sol reads,
//         including V2_MAX_BUY_ETH: the most ETH every buy of this genesis may spend together, the two listing buys
//         included. Each stage is told what the buys before it spent, and reserves the ones still to come.
//         The airdrop also reads AIRDROP_FILE and AIRDROP_SHA256. FORGE overrides the forge binary.
// No dependencies beyond Node itself.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEAD = "0x000000000000000000000000000000000000dead";

/** What each stage sends, in order, and where each transaction must go. */
export const SPEC = {
  launch: { script: "GenesisV2", fn: "launch", slow: false, to: (r) => [r.marketTickerLauncher, r.universalRouter] },
  buy: { script: "GenesisV2", fn: "buy", slow: true, to: (r) => [r.universalRouter] },
  listName: { script: "GenesisV2", fn: "listName", slow: true, to: (r) => [r.universalRouter] },
  listCoin: { script: "GenesisV2", fn: "listCoin", slow: true, to: (r) => [r.universalRouter] },
  split: { script: "GenesisV2", fn: "split", slow: true, to: (r, p) => [p.coin, r.permit2, r.permit2] },
  airdrop: { script: "AirdropV2", fn: "run", slow: true, to: (r, p) => [p.coin, r.permit2, r.permit2] },
};

export class Stop extends Error {}

/**
 * What in forge's own output, if anything, attests that the run failed before it submitted anything.
 *
 * A stage that was started and left no transaction behind is ambiguous: an absent record is not proof that nothing
 * was signed, and a stage cleared on that assumption would send its transactions a second time. The one thing that
 * can settle it is the broadcaster saying where it stopped, and only one kind of statement does: forge simulates a
 * script whole before it sends any of it, so a script that failed *in that simulation* never reached a send.
 *
 * Nothing else counts, and the reasons are not hypothetical. "error sending request" does not say which request
 * failed. "invalid type:" comes out of a decoder, and an audit captured it from forge decoding the answer to an
 * `eth_sendRawTransaction` the node had **already accepted and mined**. Any message that could be written after a
 * transaction left the process is unknown, and unknown holds the stage for a person.
 *
 * So: one narrow list of simulation failures, and a wide list of anything that suggests the sending phase was
 * reached at all. A match on the second overrules a match on the first.
 *
 * Returns the line it matched, so the journal keeps the evidence and not just a verdict.
 */
const SIMULATION_FAILED = /script failed:|Simulated execution failed|Failed to simulate|Compiler run failed/i;
/** Anything forge writes at or after the point where it starts sending, however that attempt then ends. */
const REACHED_SENDING =
  /ONCHAIN EXECUTION|Sending transactions|Waiting for receipts|Transactions saved to|Sensitive values saved to|\bHash:|Failed to send transaction|Transaction dropped|nonce too low|already known|replacement transaction underpriced|deserialization error|invalid type:|Error: Failed to get/i;

export function attestedNoSend(out) {
  if (!out || REACHED_SENDING.test(out)) return undefined;
  const line = out.split("\n").find((l) => SIMULATION_FAILED.test(l));
  return line ? line.trim().slice(0, 200) : undefined;
}

const lower = (a) => (a ?? "").toLowerCase();
const same = (a, b) => lower(a) === lower(b);
const topicAddress = (t) => "0x" + t.slice(26).toLowerCase();

/** Every Transfer of `token` in a receipt's logs, decoded. */
export function transfers(logs, token) {
  return logs
    .filter((l) => same(l.address, token) && l.topics[0] === TRANSFER && l.topics.length === 3)
    .map((l) => ({ from: topicAddress(l.topics[1]), to: topicAddress(l.topics[2]), amount: BigInt(l.data) }));
}

/** Decodes the `Plan` struct `plan()` returns: twelve static words. */
export function decodePlan(hex) {
  const w = hex.replace(/^0x/, "").match(/.{64}/g);
  if (!w || w.length !== 12) throw new Stop("plan(): unexpected return data");
  const addr = (x) => "0x" + x.slice(24);
  const num = (x) => BigInt("0x" + x).toString();
  return {
    me: addr(w[0]), treasury: addr(w[1]), name: addr(w[2]), coin: addr(w[3]), nameSalt: "0x" + w[4],
    supply: num(w[5]), maxBuyEth: num(w[6]), nameListingEth: num(w[7]), coinListingEth: num(w[8]),
    target: num(w[9]), toTreasury: num(w[10]), kept: num(w[11]),
  };
}

/**
 * The runner, with everything it touches passed in, so the tests can drive it against a fake chain.
 * rpc(method, params) -> result; forge(spec, {broadcast}) -> exit code; forgeJson(script, sig) -> forge's JSON line;
 * broadcast(spec) -> [{hash, nonce}] from forge's broadcast file; record() -> the deployment record; journal {load, save}.
 */
export function createRunner({ rpc, forge, forgeJson, broadcast, record, journal, log = console.log, sleep, env, confirmTimeoutMs = 180_000 }) {
  let j;
  let plan;
  let rec;
  /**
   * What the last `reconcile()` in this process found, as a word: "confirmed", "pending" (a hash of ours with no
   * receipt), "noRecord" (the stage left nothing behind and forge did not attest why), "launchNoBuy" (the launch
   * landed, nothing recorded behind it), "attestedNoSend", or "blocked" (anything that needs a person for another
   * reason). `buy` and `resolve` act on this and never on a flag in the journal, which describes an older look.
   */
  let outcome;

  const save = () => journal.save(j);
  const stop = (msg) => {
    throw new Stop(msg);
  };

  async function nonces(wallet) {
    const [latest, pending] = await Promise.all([rpc("eth_getTransactionCount", [wallet, "latest"]), rpc("eth_getTransactionCount", [wallet, "pending"])]);
    return { latest: Number(latest), pending: Number(pending) };
  }

  /** Nothing of the wallet's may be in flight when a stage starts or is judged. */
  async function quiet() {
    const n = await nonces(plan.me);
    if (n.pending > n.latest) stop(`a transaction from the wallet is still pending (nonce ${n.latest}). wait for it to land, then run again.`);
    return n.latest;
  }

  async function balanceOf(token, who) {
    const data = "0x70a08231" + who.replace(/^0x/, "").toLowerCase().padStart(64, "0");
    return BigInt(await rpc("eth_call", [{ to: token, data }, "latest"]));
  }

  /** The receipt, in a block that is still canonical and has at least one block on top. */
  async function confirmed(hash) {
    const until = Date.now() + confirmTimeoutMs;
    for (;;) {
      const rc = await rpc("eth_getTransactionReceipt", [hash]);
      if (rc) {
        const block = await rpc("eth_getBlockByNumber", [rc.blockNumber, false]);
        if (!block || !same(block.hash, rc.blockHash)) stop(`the block of ${hash} is no longer canonical. stop for review.`);
        const head = BigInt(await rpc("eth_blockNumber", []));
        if (head > BigInt(rc.blockNumber)) return rc;
      }
      if (Date.now() > until) stop(`no confirmed receipt for ${hash} yet. nothing is resent; run again to keep waiting.`);
      await sleep(1000);
    }
  }

  /** What the buys of this genesis have spent so far, in wei: every buy that succeeded, the listing buys included. */
  function spentOnBuys() {
    let total = 0n;
    const buys = [...(j.stages.launch?.txs ?? []).slice(1), ...(j.stages.buy?.txs ?? []), ...(j.stages.listName?.txs ?? []), ...(j.stages.listCoin?.txs ?? [])];
    for (const t of buys) if (t.success) total += BigInt(t.value ?? "0x0");
    return total;
  }

  /** Run a stage's forge script with --broadcast, bracketed by the journal. */
  async function send(id) {
    const n0 = await quiet();
    j.stages[id] = { status: "sending", nonceBefore: n0, at: new Date().toISOString() };
    save();
    log(`\n== ${id}: sending (wallet nonce ${n0})`);
    // every buy is held to one approved maximum, so each is told what the buys before it spent
    const extra = ["buy", "listName", "listCoin"].includes(id) ? { V2_BUY_SPENT_WEI: spentOnBuys().toString() } : {};
    const r = await forge(SPEC[id], { broadcast: true, env: extra });
    j.stages[id].forgeExit = r.code;
    // kept in the journal with the line it was read from, because a later run has no other way to know where this
    // one stopped, and a verdict with no evidence behind it cannot be checked
    j.stages[id].noSendEvidence = attestedNoSend(r.output);
    save();
  }

  /**
   * What the chain says about every hash forge recorded for this stage, by the hash alone.
   *
   * Forge's broadcast file lists each transaction it prepared and fills in hashes as the node answers, so the hash on
   * an entry is not always the hash of that entry's nonce: sending two transactions at once is enough to cross them.
   * The transaction itself is the authority on its own nonce, so each hash is looked up and believed. A hash the node
   * has never heard of keeps the nonce the file claims, which is only used to decide whether it belongs to this run.
   */
  async function recorded(spec, s) {
    // the journal is the record of what this stage ever signed: forge's file can be replaced or lost, and a hash it
    // once showed is knowledge we keep. Both sources together, never one instead of the other
    const isHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
    // forge writes its broadcast file before it has the answers, so an entry can carry no hash at all: a transaction
    // it prepared and never got a hash back for. There is nothing to ask the chain about, so these are kept as the
    // evidence they are — the stage still ends up held for review, because nothing identifiable landed
    const unnamed = broadcast(spec).filter((t) => !isHash(t.hash) && t.nonce >= s.nonceBefore);
    if (unnamed.length > 0) s.unnamed = unnamed.map((t) => ({ nonce: t.nonce }));
    else delete s.unnamed;
    const seen = new Map((s.known ?? []).filter((t) => isHash(t.hash)).map((t) => [lower(t.hash), t]));
    for (const t of broadcast(spec)) if (isHash(t.hash) && !seen.has(lower(t.hash))) seen.set(lower(t.hash), { hash: t.hash, nonce: t.nonce });
    const out = [];
    for (const t of seen.values()) {
      const tx = await rpc("eth_getTransactionByHash", [t.hash]);
      const nonce = tx ? Number(tx.nonce) : t.nonce;
      if (nonce < s.nonceBefore) continue; // an earlier run of the same stage
      const rc = tx ? await rpc("eth_getTransactionReceipt", [t.hash]) : null;
      out.push({ hash: t.hash, nonce, tx, settled: !!rc });
    }
    s.known = out.map(({ hash, nonce }) => ({ hash, nonce }));
    save();
    return out;
  }

  /** What the chain says about a stage that was sent: every landed transaction identified, confirmed, and checked. */
  async function reconcile(id) {
    const s = j.stages[id];
    const spec = SPEC[id];
    const expected = spec.to(rec, plan);
    outcome = undefined;

    // what this stage signed comes first, and the nonce is read after it: a transaction that settles while the scan
    // runs must not read as "nothing was sent", which is how a purchase would be made a second time
    const sent = await recorded(spec, s);
    const n1 = await quiet();
    const count = n1 - s.nonceBefore;

    // anything signed and broadcast whose outcome is unknown holds the stage where it is, whatever else landed. A
    // transaction that was broadcast can still settle later, and a stage cleared while one is out would send it again
    const open = sent.filter((t) => !t.settled);
    if (open.length > 0) {
      outcome = "pending";
      stop(
        `${id}: ${open.map((t) => `${t.hash} (nonce ${t.nonce})`).join(", ")} was broadcast and this node cannot say what became of ${open.length > 1 ? "them" : "it"}. ` +
          `nothing is sent again: a broadcast transaction can still settle. run again to keep looking, and review on the explorer if it stays this way.`,
      );
    }

    if (count === 0) {
      if (sent.length > 0) {
        // every hash this stage signed has a receipt, and yet the nonce says nothing landed: two reads that cannot
        // both be right. Nothing is sent and nothing is forgotten until a person has looked
        return halt(id, `${sent.length} transaction(s) of this stage have receipts but the wallet's nonce says none landed. the node is answering inconsistently; review before going on.`);
      }
      if (!s.noSendEvidence) {
        // the stage ran and left nothing behind. That it never signed anything cannot be read from an absent record,
        // so it is held: a person checks the chain, and `resolve` is how they say what they found
        outcome = "noRecord";
        return halt(
          id,
          `it ran and left no identifiable transaction behind${s.unnamed ? ` (forge recorded nonce ${s.unnamed.map((u) => u.nonce).join(", ")} without a hash)` : ""}, and forge did not say it stopped before sending. ` +
            `nothing is sent again on the assumption that nothing was. ` +
            `check the explorer for a transaction from this wallet at nonce ${s.nonceBefore}: if there is one, run again so it can be read; ` +
            `if there is none, say so with "node script/genesis-v2.mjs resolve ${id}".`,
          { reviewRequired: true },
        );
      }
      // forge said it failed in simulation, before it could submit anything, so there is nothing to be ambiguous about
      outcome = "attestedNoSend";
      delete j.stages[id];
      save();
      stop(`${id}: nothing landed. forge stopped before sending anything ("${s.noSendEvidence}"). fix the cause and run again.`);
    }
    if (count > expected.length) return halt(id, `${count} transactions landed where the stage sends ${expected.length}. review on the explorer.`);
    const txs = [];
    for (let k = 0; k < count; k++) {
      const nonce = s.nonceBefore + k;
      const entry = sent.find((t) => t.nonce === nonce);
      if (!entry) return halt(id, `nonce ${nonce} landed but no transaction forge recorded carries it. find that transaction on the explorer before going on.`);
      const tx = entry.tx;
      if (!same(tx.from, plan.me) || !same(tx.to, expected[k])) {
        return halt(id, `${entry.hash} is not the transaction the stage meant (sender or target differ). review before going on.`);
      }
      if (id === "launch" && k === 0) {
        const lc = launchCall();
        if (lower(tx.input) !== lower(lc.data) || BigInt(tx.value) !== BigInt(lc.value)) return halt(id, "the launch that landed is not the planned launch, byte for byte. review before going on.");
      }
      const rc = await confirmed(entry.hash);
      // on an Arbitrum chain the receipt also names the parent chain's block, which is what `block.number` reads inside
      // the EVM and so what a coin's launch protection counts in
      const l1Block = rc.l1BlockNumber ? Number(rc.l1BlockNumber) : undefined;
      txs.push({ hash: entry.hash, nonce, to: lower(tx.to), value: tx.value ?? "0x0", block: Number(rc.blockNumber), ...(l1Block ? { l1Block } : {}), success: rc.status === "0x1", logs: rc.logs });
    }
    s.txs = txs.map(({ logs, ...t }) => t);
    return judge(id, txs);
  }

  function halt(id, note, extra = {}) {
    outcome ??= "blocked";
    Object.assign(j.stages[id], { status: "stopped", note }, extra);
    save();
    stop(`${id}: ${note}`);
  }

  function confirm(id, extra = {}) {
    outcome = "confirmed";
    Object.assign(j.stages[id], { status: "confirmed" }, extra);
    save();
    log(`== ${id}: confirmed ${j.stages[id].txs.map((t) => `${t.hash} (block ${t.block})`).join(", ")}`);
  }

  const received = (tx, token) => transfers(tx.logs, token).filter((t) => t.to === lower(plan.me)).reduce((a, t) => a + t.amount, 0n);

  async function judge(id, txs) {
    const s = j.stages[id];
    const target = BigInt(plan.target);
    switch (id) {
      case "launch": {
        if (!txs[0].success) return halt(id, "the launch reverted on chain. review before anything else.");
        if (txs[1] && !txs[1].success) {
          // reverted on chain: a known outcome, and the one case the runner may re-size and send by itself
          confirm(id, { needBuy: "reverted" });
          log("== the first buy reverted on chain. buy() sizes what is missing against the chain as it is now.");
          return;
        }
        if (!txs[1]) {
          // the launch landed and nothing is recorded for the buy behind it. Whether it was ever signed cannot be read
          // from here, so this is written down as it is and survives every restart until a person ends it
          s.txs = txs.map(({ logs, ...t }) => t);
          outcome = "launchNoBuy";
          return halt(
            id,
            `the launch landed (${txs[0].hash}) and nothing is recorded for the first buy behind it. ` +
              `check the explorer for a transaction from this wallet at nonce ${s.nonceBefore + 1}: if there is one, run again so it can be read; ` +
              `if there is none, send the buy with "node script/genesis-v2.mjs buy", which looks again before it sends.`,
            { reviewRequired: true, needBuy: "unknown" },
          );
        }
        const got = received(txs[1], plan.coin);
        if (got < target) return halt(id, "the first buy's receipt shows less than the disclosed share reaching the wallet.");
        return confirm(id, { received: got.toString() });
      }
      case "buy":
      case "listName":
      case "listCoin": {
        const [tx] = txs;
        if (!tx.success) return halt(id, `${tx.hash} reverted on chain and used its nonce. review; nothing is retried automatically.`);
        if (id === "listName" && received(tx, plan.name) === 0n) return halt(id, "the name's listing buy moved no name into the wallet.");
        if (id !== "listName" && received(tx, plan.coin) === 0n) return halt(id, "the buy moved no coin into the wallet.");
        if (id === "listCoin" && !(tx.block > j.stages.listName.txs[0].block)) return halt(id, "the coin's listing buy did not land in a later block than the name's.");
        return confirm(id, { received: received(tx, id === "listName" ? plan.name : plan.coin).toString() });
      }
      case "split":
      case "airdrop": {
        const batch = txs[2];
        if (!batch) {
          if (txs.some((t) => !t.success)) return halt(id, "an approval reverted. review before going on.");
          // the approvals landed and nothing is recorded for the transfer. No coin moved, but a transfer that was
          // signed and never seen could still settle, and that cannot be ruled out from here
          return halt(
            id,
            `the approvals landed and nothing is recorded for the transfer, so no coin has moved. check the explorer for a transaction from this wallet at nonce ${s.nonceBefore + 2}: ` +
              `if there is one, clear this stage's "stopped" status and run again so it can be read; if there is none, delete this stage from the journal and run again to send it once more.`,
          );
        }
        if (!batch.success) return halt(id, `the transfer ${batch.hash} reverted, so no coin moved. review before going on.`);
        const out = transfers(batch.logs, plan.coin).filter((t) => t.from === lower(plan.me));
        const held = await balanceOf(plan.coin, plan.me);
        if (id === "split") {
          const toTreasury = out.filter((t) => t.to === lower(plan.treasury));
          const burned = out.filter((t) => t.to === DEAD);
          if (toTreasury.length !== 1 || toTreasury[0].amount !== BigInt(plan.toTreasury)) return halt(id, "the split's receipt does not pay the treasury exactly its share.");
          if (burned.length > 1 || out.length !== 1 + burned.length) return halt(id, "the split's receipt moved coins somewhere other than the treasury and the dead address.");
          if (held !== BigInt(plan.kept)) return halt(id, `after the split the wallet holds ${held}, not the airdrop's ${plan.kept}. something else moved coins into it; review.`);
          return confirm(id, { burned: (burned[0]?.amount ?? 0n).toString() });
        }
        const list = airdropList();
        const want = new Map(list.addresses.map((a, i) => [lower(a), BigInt(list.amounts[i])]));
        if (out.length !== want.size) return halt(id, `the airdrop's receipt has ${out.length} payments; the list has ${want.size}.`);
        for (const t of out) {
          if (want.get(t.to) !== t.amount) return halt(id, `the airdrop paid ${t.to} ${t.amount}, which is not its entry in the list.`);
          want.delete(t.to);
        }
        if (want.size !== 0 || held !== 0n) return halt(id, "the airdrop's receipt does not match the list, or the wallet is not empty after it.");
        return confirm(id);
      }
    }
    return s;
  }

  function launchCall() {
    const out = forgeJson("GenesisV2", "launchCall()");
    return { to: out.returns.to.value, value: out.returns.value.value, data: out.returns.data.value };
  }

  function airdropList() {
    const raw = readFileSync(env.AIRDROP_FILE, "utf8");
    const sha = createHash("sha256").update(raw).digest("hex");
    if (lower(env.AIRDROP_SHA256).replace(/^0x/, "") !== sha) stop("the list file is not the published one (its SHA-256 differs).");
    const list = JSON.parse(raw);
    if (list.addresses.length !== list.amounts.length) stop("the list's columns differ in length.");
    return list;
  }

  async function setup() {
    rec = record();
    const chainId = Number(await rpc("eth_chainId", []));
    if (String(chainId) !== String(env.EXPECTED_CHAIN)) stop(`the RPC is on chain ${chainId}, not EXPECTED_CHAIN ${env.EXPECTED_CHAIN}.`);
    plan = decodePlan(forgeJson("GenesisV2", "plan()").returned);
    j = journal.load() ?? { chainId, plan, stages: {} };
    if (j.chainId !== chainId) stop("the journal belongs to another chain.");
    for (const k of Object.keys(plan)) {
      if (String(j.plan[k]) !== String(plan[k])) stop(`the environment no longer gives the journal's plan (${k} differs). the env must stay the launch's.`);
    }
    save();
  }

  /** One stage: resume it if it was sent, send it otherwise, then judge it from the chain. */
  async function stage(id) {
    const s = j.stages[id];
    if (s?.status === "confirmed") return;
    if (s?.status === "stopped") stop(`${id} stopped earlier: ${s.note}${s.reviewRequired ? "" : ' review it, and say what you found with "node script/genesis-v2.mjs resolve ' + id + '".'}`);
    if (s?.status === "sending") {
      log(`== ${id}: was sent before; reading what landed`);
      await reconcile(id);
      if (j.stages[id]?.status === "confirmed") return;
    }
    await send(id);
    await reconcile(id);
  }

  return {
    async genesis() {
      await setup();
      await stage("launch");
      // only a first buy that landed and reverted is sent again without being asked. "unknown" stops in stage()
      // above and stays stopped, however many times this is run
      if (j.stages.launch.needBuy === "reverted" && j.stages.buy?.status !== "confirmed") await stage("buy");
      await stage("listName");
      await stage("listCoin");
      await stage("split");
      if (j.stages.verify?.status !== "confirmed") {
        log("\n== verify: reading the finished genesis from the chain");
        await quiet();
        const { code } = await forge({ script: "GenesisV2", fn: "verify" }, { broadcast: false });
        const r = record();
        if (code !== 0 || !same(r.genesisV2Token, plan.coin) || !same(r.genesisV2Name, plan.name) || !r.genesisV2Pool) {
          stop("verify did not confirm the genesis, so the record is unchanged. its output above says what differs.");
        }
        j.stages.verify = { status: "confirmed", at: new Date().toISOString() };
        save();
      }
      log(`\n== genesis verified and recorded: coin ${plan.coin}, name ${plan.name}`);
    },
    /**
     * The first buy, asked for by hand, when the launch landed and nothing was recorded behind it. It looks again
     * first: a buy that has since turned up is read, and then there is nothing to send.
     */
    async buy() {
      await setup();
      if (!j.stages.launch) stop("the launch has not run yet.");
      if (j.stages.buy?.status === "confirmed") stop("the first buy is already confirmed.");
      if (j.stages.launch.status !== "confirmed") {
        log("== launch: looking again for the first buy before anything is sent");
        if (j.stages.launch.status === "stopped") {
          j.stages.launch.status = "sending"; // read exactly as it was left; nothing recorded is lost
          save();
        }
        try {
          await reconcile("launch");
        } catch (e) {
          if (!(e instanceof Stop)) throw e;
          // only this one outcome, found by the look that just ran, is what this command may act on. A hash of ours
          // with no receipt, a contradiction, anything else: the stop stands and nothing is sent
          if (outcome !== "launchNoBuy") throw e;
          log("== still nothing recorded for the first buy: sending it, on your word that there is none");
          Object.assign(j.stages.launch, { status: "confirmed", needBuy: "operator", reviewRequired: false });
          save();
        }
      }
      const l = j.stages.launch;
      if (l.status !== "confirmed") stop("the launch is not confirmed; nothing was sent.");
      if (!l.needBuy) {
        log("== the first buy is in after all; nothing was sent. run the genesis to go on.");
        return;
      }
      await stage("buy");
      log("\n== the first buy is in. run the genesis again to go on from here.");
    },

    /**
     * "I have checked the chain, and this stage sent nothing." The one way a stage held for review is cleared, and
     * it looks again before it believes you: anything that has since turned up is read instead.
     */
    async resolve(id, hash) {
      await setup();
      const s = j.stages[id];
      if (!s) stop(`${id}: nothing to resolve.`);
      if (s.status === "confirmed") stop(`${id}: this stage is confirmed; there is nothing to resolve.`);
      if (hash) {
        // "the transaction at that nonce is this one": the identity a person read off the explorer. It is not taken
        // on trust — it must be this wallet's, and at a nonce this stage sent, before the reconcile below checks its
        // target, its receipt and what it moved like any other
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) stop(`${hash} is not a transaction hash.`);
        const tx = await rpc("eth_getTransactionByHash", [hash]);
        if (!tx) stop(`${hash} is not a transaction this node knows. check it, and give a hash that is.`);
        if (!same(tx.from, plan.me)) stop(`${hash} was not sent by this wallet, so it is not this genesis's.`);
        const n = Number(tx.nonce);
        const span = SPEC[id].to(rec, plan).length;
        if (n < s.nonceBefore || n >= s.nonceBefore + span) {
          stop(`${hash} is at nonce ${n}, and ${id} sends nonces ${s.nonceBefore} to ${s.nonceBefore + span - 1}. that is a transaction of another stage; nothing was changed.`);
        }
        s.known = [...(s.known ?? []), { hash, nonce: n }];
        save();
        log(`== ${id}: reading ${hash}, which you say is the transaction at nonce ${n}`);
      }
      // a stage still waiting on a hash of its own cannot be cleared by anyone: the reconcile below says so and stops
      log(`== ${id}: looking again before anything is cleared`);
      const was = { ...s };
      s.status = "sending";
      save();
      try {
        await reconcile(id);
        log(`== ${id}: something was there after all; it has been read. run the genesis to go on.`);
        return;
      } catch (e) {
        if (!(e instanceof Stop)) throw e;
        // what the look that just ran found decides this, not what an earlier one wrote down. "noRecord" is the only
        // outcome this command clears; a hash of ours with no receipt, or anything else, stops as it stopped
        if (outcome !== "noRecord") throw e;
        if (hash) {
          // the operator said "here is the transaction", not "there was none". If the chain cannot place it in this
          // stage, that is something to look at again, never a licence to clear the stage
          stop(`${id}: ${hash} did not turn out to be a transaction of this stage, and nothing was cleared. check the hash, or run "resolve ${id}" with none if the stage truly sent nothing.`);
        }
        j.resolved = [...(j.resolved ?? []), { stage: id, at: new Date().toISOString(), was }];
        delete j.stages[id];
        save();
        log(`== ${id}: cleared on your word that it sent nothing; what it knew is kept under "resolved". run the genesis to send it again.`);
      }
    },

    /**
     * "This stage is not going to happen, and the run may go on without it." Only for a stage that sends nothing
     * anyone depends on — the listing buys are a mark for the chart sites, not part of the split — and only after the
     * chain has been looked at again, so a transaction that did land cannot be skipped over.
     */
    async skip(id) {
      await setup();
      if (!["listName", "listCoin"].includes(id)) stop(`${id} cannot be skipped: only the listing buys can.`);
      const s = j.stages[id];
      if (s?.status === "confirmed") stop(`${id} is confirmed; there is nothing to skip.`);
      if (s) {
        log(`== ${id}: looking again before it is skipped`);
        s.status = "sending";
        save();
        try {
          await reconcile(id);
          log(`== ${id}: it had landed after all; nothing was skipped.`);
          return;
        } catch (e) {
          if (!(e instanceof Stop)) throw e;
          if (outcome !== "noRecord") throw e;
        }
      }
      j.stages[id] = { status: "confirmed", skipped: true, at: new Date().toISOString(), txs: [], note: "skipped by the operator: nothing landed, and nothing downstream needs it" };
      save();
      log(`== ${id}: skipped on your word. run the genesis to go on.`);
    },

    async airdrop() {
      await setup();
      if (j.stages.verify?.status !== "confirmed") stop("the genesis is not verified yet: run the genesis first.");
      airdropList();
      await stage("airdrop");
      log("\n== airdrop confirmed: every entry of the list paid, in one transaction");
    },
    async status() {
      rec = record();
      j = journal.load();
      log(JSON.stringify(j, null, 2));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// the command line: real forge, real RPC, a journal on disk
// ---------------------------------------------------------------------------------------------------------------------

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const env = process.env;
  const need = (k) => env[k] || (console.error(`set ${k}`), process.exit(2));
  const rpcUrl = need("RPC_URL");
  const journalPath = need("GENESIS_JOURNAL");
  const bin = env.FORGE || (existsSync(join(homedir(), ".foundry/bin/forge")) ? join(homedir(), ".foundry/bin/forge") : "forge");
  const recordPath = join(root, env.DEPLOY_RECORD || `deployments/${need("EXPECTED_CHAIN")}.json`);
  let id = 0;

  const rpc = async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
        const body = await res.json();
        if (body.error) throw new Error(`${method}: ${body.error.message}`);
        return body.result;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  };
  const args = (spec) => [`script/${spec.script}.s.sol`, "--sig", `${spec.fn}()`, "--rpc-url", rpcUrl];
  const forge = (spec, { broadcast, env: extra = {} }) =>
    new Promise((resolve) => {
      const flags = broadcast ? ["--broadcast", ...(spec.slow ? ["--slow"] : [])] : [];
      const p = spawn(bin, ["script", ...args(spec), ...flags], { cwd: root, env: { ...env, ...extra } });
      let output = "";
      for (const stream of ["stdout", "stderr"]) {
        p[stream].on("data", (d) => {
          output += d.toString();
          process[stream === "stdout" ? "stdout" : "stderr"].write(d); // live, as before, and kept
        });
      }
      p.on("close", (code) => resolve({ code: code ?? 1, output }));
      p.on("error", (e) => resolve({ code: 1, output: `${output}\n${e.message}` }));
    });
  const forgeJson = (script, sig) => {
    const r = spawnSync(bin, ["script", `script/${script}.s.sol`, "--sig", sig, "--rpc-url", rpcUrl, "--json"], { cwd: root, env, encoding: "utf8", maxBuffer: 1 << 28 });
    const line = (r.stdout || "").split("\n").reverse().find((l) => l.startsWith("{"));
    if (r.status !== 0 || !line) throw new Stop(`forge ${sig} failed:\n${(r.stderr || r.stdout || "").slice(-2000)}`);
    return JSON.parse(line);
  };
  const broadcast = (spec) => {
    const file = join(root, "broadcast", `${spec.script}.s.sol`, String(env.EXPECTED_CHAIN), `${spec.fn}-latest.json`);
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf8")).transactions.map((t) => ({ hash: t.hash, nonce: Number(t.transaction.nonce) }));
  };
  const journal = {
    load: () => (existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : null),
    save: (j) => {
      writeFileSync(journalPath + ".tmp", JSON.stringify(j, null, 2) + "\n");
      renameSync(journalPath + ".tmp", journalPath);
    },
  };
  const runner = createRunner({
    rpc, forge, forgeJson, broadcast, journal, env,
    record: () => JSON.parse(readFileSync(recordPath, "utf8")),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const cmd = process.argv[2] ?? "genesis";
  if (!["genesis", "airdrop", "buy", "resolve", "skip", "status"].includes(cmd)) {
    console.error("usage: node script/genesis-v2.mjs [genesis|buy|resolve <stage>|skip <stage>|airdrop|status]");
    process.exit(2);
  }
  if ((cmd === "resolve" || cmd === "skip") && !process.argv[3]) {
    console.error(`usage: node script/genesis-v2.mjs ${cmd} <stage>`);
    process.exit(2);
  }
  try {
    await runner[cmd](process.argv[3], process.argv[4]);
  } catch (e) {
    console.error(`\nSTOPPED: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
