// The v2 genesis runner against a fake chain: every stage judged from receipts, interruptions resumed from the
// wallet's nonce and forge's broadcast file, and every ambiguous state stopped rather than guessed.
// Run: node --test script/tests/
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attestedNoSend, createRunner, decodePlan, SPEC, Stop, transfers } from "../genesis-v2.mjs";

const A = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const word = (x) => BigInt(x).toString(16).padStart(64, "0");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEAD = "0x000000000000000000000000000000000000dEaD";

const PLAN = { me: A(0xaa), treasury: A(0xbb), name: A(0xf0), coin: A(0x6942), nameSalt: "0x" + "11".repeat(32), supply: 1000n, maxBuyEth: 5000n, nameListingEth: 5n, coinListingEth: 10n, target: 70n, toTreasury: 19n, kept: 51n };
const REC = { marketTickerLauncher: A(1), universalRouter: A(2), permit2: A(3) };
const LAUNCH = { to: REC.marketTickerLauncher, value: "5", data: "0xcafe" };
const planHex = "0x" + [PLAN.me, PLAN.treasury, PLAN.name, PLAN.coin].map((a) => a.slice(2).padStart(64, "0")).join("") + PLAN.nameSalt.slice(2) + [PLAN.supply, PLAN.maxBuyEth, PLAN.nameListingEth, PLAN.coinListingEth, PLAN.target, PLAN.toTreasury, PLAN.kept].map(word).join("");
const log = (token, from, to, amount) => ({ address: token, topics: [TRANSFER, "0x" + from.slice(2).padStart(64, "0"), "0x" + to.slice(2).padStart(64, "0")], data: "0x" + word(amount) });

/** A chain that mines one transaction per block, and a forge whose sends each test scripts. */
function world({ sends = {}, env = {} } = {}) {
  const c = { nonce: 0, pending: 0, head: 100, txs: {}, receipts: {}, blocks: {}, balances: {}, record: { ...REC }, broadcast: {}, calls: [], env: [], journal: null };
  const bal = (t, w) => c.balances[`${t.toLowerCase()}:${w.toLowerCase()}`] ?? 0n;
  const move = (t, from, to, amount) => {
    c.balances[`${t.toLowerCase()}:${from.toLowerCase()}`] = bal(t, from) - amount;
    c.balances[`${t.toLowerCase()}:${to.toLowerCase()}`] = bal(t, to) + amount;
  };
  /** lands one transaction from the wallet; `effect` returns its logs, or null for a revert */
  c.land = (id, to, effect, { input = "0x", value = "0", lost = false, invisible = false } = {}) => {
    if (invisible) {
      // signed and broadcast, and this node knows nothing about it: no nonce consumed, no receipt, only forge's record
      const h = "0x" + createHash("sha256").update(`${id}:${c.nonce}:invisible`).digest("hex");
      (c.broadcast[id] ??= []).push({ hash: h, nonce: c.nonce });
      c.pending = c.nonce;
      c.settleLate = () => {
        const nonce = c.nonce++;
        const block = ++c.head;
        c.blocks[block] = "0x" + word(block * 7);
        c.txs[h] = { from: PLAN.me, nonce: "0x" + nonce.toString(16), to, input, value };
        c.receipts[h] = { status: "0x1", blockNumber: "0x" + block.toString(16), blockHash: c.blocks[block], transactionHash: h, logs: effect ? effect() : [] };
        c.head++;
        c.blocks[c.head] = "0x" + word(c.head * 7);
        c.pending = c.nonce;
      };
      return h;
    }
    const hash = "0x" + createHash("sha256").update(`${id}:${c.nonce}`).digest("hex");
    const nonce = c.nonce++;
    c.pending = c.nonce;
    const block = ++c.head;
    c.blocks[block] = "0x" + word(block * 7);
    c.txs[hash] = { from: PLAN.me, nonce: "0x" + nonce.toString(16), to, input, value };
    const logs = effect ? effect() : null;
    c.receipts[hash] = { status: logs ? "0x1" : "0x0", blockNumber: "0x" + block.toString(16), blockHash: c.blocks[block], transactionHash: hash, logs: logs ?? [] };
    c.head++; // a block on top
    c.blocks[c.head] = "0x" + word(c.head * 7);
    if (!lost) (c.broadcast[id] ??= []).push({ hash, nonce });
    return hash;
  };
  const buyTo = (token, amount) => () => {
    move(token, "0x" + "00".repeat(20), PLAN.me, amount);
    return [log(token, A(0x999), PLAN.me, amount)];
  };
  c.ok = {
    launch: () => {
      c.land("launch", REC.marketTickerLauncher, () => [], { input: LAUNCH.data, value: LAUNCH.value });
      c.land("launch", REC.universalRouter, buyTo(PLAN.coin, 73n));
    },
    buy: () => c.land("buy", REC.universalRouter, buyTo(PLAN.coin, 71n)),
    listName: () => c.land("listName", REC.universalRouter, buyTo(PLAN.name, 5n)),
    listCoin: () => c.land("listCoin", REC.universalRouter, buyTo(PLAN.coin, 1n)),
    split: () => {
      c.land("split", PLAN.coin, () => []);
      c.land("split", REC.permit2, () => []);
      c.land("split", REC.permit2, () => {
        const held = bal(PLAN.coin, PLAN.me);
        const burn = held - PLAN.target;
        move(PLAN.coin, PLAN.me, PLAN.treasury, PLAN.toTreasury);
        move(PLAN.coin, PLAN.me, DEAD, burn);
        return [log(PLAN.coin, PLAN.me, PLAN.treasury, PLAN.toTreasury), log(PLAN.coin, PLAN.me, DEAD, burn)];
      });
    },
    verify: () => Object.assign(c.record, { genesisV2Token: PLAN.coin, genesisV2Name: PLAN.name, genesisV2Pool: "0x" + "ab".repeat(32) }),
  };
  const rpc = async (method, params) => {
    switch (method) {
      case "eth_chainId": return "0x1237";
      case "eth_getTransactionCount": return "0x" + (params[1] === "pending" ? c.pending : c.nonce).toString(16);
      case "eth_getTransactionByHash": return c.txs[params[0]] ?? null;
      case "eth_getTransactionReceipt": return c.receipts[params[0]] ?? null;
      case "eth_getBlockByNumber": return { hash: c.blocks[Number(params[0])] };
      case "eth_blockNumber": return "0x" + c.head.toString(16);
      case "eth_call": return "0x" + word(bal(params[0].to, "0x" + params[0].data.slice(-40)));
      default: throw new Error(method);
    }
  };
  // forge, as the runner sees it: an exit code and everything it printed, which is what says where a run stopped
  const SENT = "Sending transactions...\nONCHAIN EXECUTION COMPLETE & SUCCESSFUL.\nTransactions saved to: broadcast/x.json";
  const REFUSED = "Error: script failed: a precondition of the stage";
  const forge = async (spec, opts = {}) => {
    c.calls.push(spec.fn);
    c.env.push(opts.env ?? {});
    const s = sends[spec.fn] ?? c.ok[spec.fn];
    const refused = s() === false;
    return { code: refused ? 1 : 0, output: c.forgeOutput ?? (refused ? REFUSED : SENT) };
  };
  const forgeJson = (script, sig) => (sig === "plan()" ? { returned: c.planHex ?? planHex } : { returns: { to: { value: LAUNCH.to }, value: { value: LAUNCH.value }, data: { value: LAUNCH.data } } });
  c.runner = () =>
    createRunner({
      rpc, forge, forgeJson, env: { EXPECTED_CHAIN: "4663", ...env },
      broadcast: (spec) => c.broadcast[spec.fn] ?? [],
      record: () => c.record,
      journal: { load: () => (c.journal ? structuredClone(c.journal) : null), save: (j) => (c.journal = structuredClone(j)) },
      log: () => {}, sleep: async () => {}, confirmTimeoutMs: 0,
    });
  c.bal = bal;
  c.buyTo = buyTo;
  return c;
}

const stops = (p, re) => assert.rejects(p, (e) => e instanceof Stop && re.test(e.message));

test("the plan decodes from plan()'s twelve words", () => {
  const p = decodePlan(planHex);
  assert.equal(p.coin, PLAN.coin);
  assert.equal(p.maxBuyEth, "5000");
  assert.equal(p.coinListingEth, "10");
  assert.equal(p.kept, "51");
  assert.equal(p.nameSalt, PLAN.nameSalt);
});

test("transfers are read from a receipt's logs for one token only", () => {
  const t = transfers([log(PLAN.coin, PLAN.me, A(5), 9n), log(PLAN.name, PLAN.me, A(5), 1n)], PLAN.coin);
  assert.deepEqual(t, [{ from: PLAN.me, to: A(5), amount: 9n }]);
});

test("the straight run: every stage sent once, judged from its receipt, and recorded only by verify", async () => {
  const c = world();
  await c.runner().genesis();
  assert.deepEqual(c.calls, ["launch", "listName", "listCoin", "split", "verify"]);
  for (const s of ["launch", "listName", "listCoin", "split", "verify"]) assert.equal(c.journal.stages[s].status, "confirmed", s);
  assert.equal(c.bal(PLAN.coin, PLAN.me), PLAN.kept);
  assert.equal(c.journal.stages.split.burned, "4");
  assert.equal(c.record.genesisV2Token, PLAN.coin);
  await c.runner().genesis(); // a second run finds everything done and sends nothing
  assert.equal(c.calls.length, 5);
});

test("a run killed after the launch resumes from the nonce and the broadcast file, and never sends the launch twice", async () => {
  const c = world({
    sends: {
      launch: () => {
        c.ok.launch();
        throw new Error("killed");
      },
    },
  });
  await assert.rejects(c.runner().genesis(), /killed/);
  assert.equal(c.journal.stages.launch.status, "sending");
  await c.runner().genesis();
  assert.deepEqual(c.calls, ["launch", "listName", "listCoin", "split", "verify"]);
  assert.equal(c.journal.stages.launch.txs.length, 2);
});

test("a launch whose first buy reverted is followed by buy(), sized from the chain", async () => {
  const c = world({
    sends: {
      launch: () => {
        c.land("launch", REC.marketTickerLauncher, () => [], { input: LAUNCH.data, value: LAUNCH.value });
        c.land("launch", REC.universalRouter, null);
      },
    },
  });
  await c.runner().genesis();
  assert.equal(c.journal.stages.launch.needBuy, "reverted");
  assert.deepEqual(c.calls, ["launch", "buy", "listName", "listCoin", "split", "verify"]);
  assert.equal(c.bal(PLAN.coin, PLAN.me), PLAN.kept);
});

test("a reverted launch stops everything", async () => {
  const c = world({ sends: { launch: () => void c.land("launch", REC.marketTickerLauncher, null, { input: LAUNCH.data, value: LAUNCH.value }) } });
  await stops(c.runner().genesis(), /launch reverted/);
  await stops(c.runner().genesis(), /stopped earlier/);
  assert.deepEqual(c.calls, ["launch"]);
});

test("a launch that is not the planned one, byte for byte, stops for review", async () => {
  const c = world({ sends: { launch: () => void c.land("launch", REC.marketTickerLauncher, () => [], { input: "0xbeef", value: LAUNCH.value }) } });
  await stops(c.runner().genesis(), /not the planned launch/);
});

test("a transaction to the wrong target stops for review", async () => {
  const c = world({ sends: { launch: () => void c.land("launch", A(0x666), () => [], { input: LAUNCH.data, value: LAUNCH.value }) } });
  await stops(c.runner().genesis(), /not the transaction the stage meant/);
});

test("nothing starts while a transaction of the wallet is pending", async () => {
  const c = world();
  c.pending = 1;
  await stops(c.runner().genesis(), /still pending/);
  assert.deepEqual(c.calls, []);
});

test("a landed nonce missing from forge's broadcast file stops instead of guessing", async () => {
  const c = world({
    sends: {
      launch: () => {
        c.land("launch", REC.marketTickerLauncher, () => [], { input: LAUNCH.data, value: LAUNCH.value, lost: true });
      },
    },
  });
  await stops(c.runner().genesis(), /no transaction forge recorded carries it/);
  assert.equal(c.journal.stages.launch.status, "stopped");
});

test("forge's broadcast file may pair a hash with another entry's nonce; the chain's own nonce decides", async () => {
  // exactly what Sepolia did: two transactions sent at once, and forge filled the hashes in the order the answers came
  const c = world({
    sends: {
      launch: () => {
        c.ok.launch();
        const rows = c.broadcast.launch;
        [rows[0].nonce, rows[1].nonce] = [rows[1].nonce, rows[0].nonce];
      },
    },
  });
  await c.runner().genesis();
  assert.equal(c.journal.stages.launch.status, "confirmed");
  assert.deepEqual(c.journal.stages.launch.txs.map((t) => t.nonce), [0, 1], "each transaction under the nonce the chain gives it");
  assert.equal(c.journal.stages.launch.txs[0].to, REC.marketTickerLauncher.toLowerCase(), "the launch first");
  assert.equal(c.journal.stages.launch.txs[1].to, REC.universalRouter.toLowerCase(), "then the buy");
});

test("a broadcast this node cannot see is never forgotten, so a late one is not bought again", async () => {
  // forge signed and broadcast the coin's listing buy; the node shows no pending nonce and no receipt for it
  const c = world({ sends: { listCoin: () => void c.land("listCoin", REC.universalRouter, c.buyTo(PLAN.coin, 1n), { invisible: true }) } });
  await stops(c.runner().genesis(), /cannot say what became of it/);
  assert.equal(c.journal.stages.listCoin.status, "sending", "the stage is kept, not cleared");
  assert.equal(c.journal.stages.listCoin.known.length, 1, "with the hash it is waiting on written into the journal");

  // it is still unknown: the run stops again, and still sends nothing
  await stops(c.runner().genesis(), /cannot say what became of it/);
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1, "the listing buy was sent once");

  // then it settles, after all. the next run finds it and carries on: one purchase, not two
  c.settleLate();
  await c.runner().genesis();
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1, "and it was never sent again");
  assert.equal(c.journal.stages.listCoin.status, "confirmed");
  assert.equal(c.journal.stages.listCoin.txs.length, 1);
  assert.equal(c.journal.stages.verify.status, "confirmed");
});

test("a split whose batch was broadcast but not seen is not sent again either", async () => {
  const c = world({
    sends: {
      split: () => {
        c.land("split", PLAN.coin, () => []);
        c.land("split", REC.permit2, () => []);
        c.land("split", REC.permit2, () => [], { invisible: true });
      },
    },
  });
  await stops(c.runner().genesis(), /cannot say what became of it/);
  assert.equal(c.journal.stages.split.status, "sending");
  assert.equal(c.calls.filter((x) => x === "split").length, 1, "no second batch is prepared");
});

test("the recovery buy is told what the buys have already spent, so one ceiling covers them both", async () => {
  const c = world({
    sends: {
      launch: () => {
        c.land("launch", REC.marketTickerLauncher, () => [], { input: LAUNCH.data, value: LAUNCH.value });
        c.land("launch", REC.universalRouter, null, { value: "0x2a" }); // reverted: nothing spent
      },
      buy: () => c.land("buy", REC.universalRouter, c.buyTo(PLAN.coin, 71n), { value: "0x2a" }),
    },
  });
  await c.runner().genesis();
  const buyEnv = c.env[c.calls.indexOf("buy")];
  assert.equal(buyEnv.V2_BUY_SPENT_WEI, "0", "a reverted first buy spent nothing");
  assert.equal(c.env[c.calls.indexOf("listName")].V2_BUY_SPENT_WEI, "42", "and the listing buys are told what the buys before them spent");
  const ok = world();
  await ok.runner().genesis();
  assert.equal(ok.env[0].V2_BUY_SPENT_WEI, undefined, "and the launch stage is not told anything of the kind");
});

test("a stage forge says it refused before sending is cleared, so the next run sends it again", async () => {
  let refuse = true;
  const c = world({ sends: { listName: () => (refuse ? false : c.ok.listName()) } });
  await stops(c.runner().genesis(), /forge stopped before sending anything/);
  assert.equal(c.journal.stages.listName, undefined);
  refuse = false;
  await c.runner().genesis();
  assert.equal(c.journal.stages.verify.status, "confirmed");
});

test("the coin's listing buy must land in a later block than the name's", async () => {
  const c = world({
    sends: {
      listCoin: () => {
        const h = c.land("listCoin", REC.universalRouter, () => [log(PLAN.coin, A(9), PLAN.me, 1n)]);
        c.receipts[h].blockNumber = "0x" + c.journal.stages.listName.txs[0].block.toString(16);
        c.receipts[h].blockHash = c.blocks[c.journal.stages.listName.txs[0].block];
      },
    },
  });
  await stops(c.runner().genesis(), /later block/);
});

test("a reverted listing buy stops; nothing is retried", async () => {
  const c = world({ sends: { listName: () => void c.land("listName", REC.universalRouter, null) } });
  await stops(c.runner().genesis(), /reverted on chain and used its nonce/);
  await stops(c.runner().genesis(), /stopped earlier/);
  assert.equal(c.calls.filter((x) => x === "listName").length, 1);
});

test("a split whose transfer left no record at all stops for review, and goes again only once a person says so", async () => {
  let first = true;
  const c = world({
    sends: {
      split: () => {
        if (first) {
          first = false;
          c.land("split", PLAN.coin, () => []);
          c.land("split", REC.permit2, () => []);
          return false;
        }
        c.ok.split();
      },
    },
  });
  await stops(c.runner().genesis(), /approvals landed and nothing is recorded for the transfer/);
  assert.equal(c.journal.stages.split.status, "stopped", "kept, and stopped for a person");
  assert.equal(c.bal(PLAN.coin, PLAN.treasury), 0n, "no coin moved");
  await stops(c.runner().genesis(), /stopped earlier/, "and it stays stopped on its own");
  assert.equal(c.calls.filter((x) => x === "split").length, 1);

  // the person looks, finds no transfer from the wallet, and deletes the stage from the journal
  delete c.journal.stages.split;
  await c.runner().genesis();
  assert.equal(c.bal(PLAN.coin, PLAN.me), PLAN.kept);
  assert.equal(c.journal.stages.split.status, "confirmed");
});

test("receipts that exist while the nonce says nothing landed are a contradiction, not an empty stage", async () => {
  const c = world({
    sends: {
      listCoin: () => {
        c.land("listCoin", REC.universalRouter, c.buyTo(PLAN.coin, 1n));
        c.nonce--; // the node answers the nonce from behind the receipt it already serves
        c.pending = c.nonce;
      },
    },
  });
  await stops(c.runner().genesis(), /have receipts but the wallet's nonce says none landed/);
  assert.equal(c.journal.stages.listCoin.status, "stopped", "nothing is cleared on two answers that disagree");
  await stops(c.runner().genesis(), /stopped earlier/);
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1, "and nothing is sent again");
});

test("the journal remembers a broadcast hash even when forge's file is gone", async () => {
  const c = world({ sends: { listCoin: () => void c.land("listCoin", REC.universalRouter, c.buyTo(PLAN.coin, 1n), { invisible: true }) } });
  await stops(c.runner().genesis(), /cannot say what became of it/);
  assert.equal(c.journal.stages.listCoin.known.length, 1);

  // the broadcast file is replaced or lost; the journal is what is left
  c.broadcast.listCoin = [];
  await stops(c.runner().genesis(), /cannot say what became of it/, "still known, so still nothing is sent");
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1);

  c.settleLate();
  await c.runner().genesis();
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1, "one purchase, across every restart");
  assert.equal(c.journal.stages.listCoin.txs.length, 1);
});

test("a launch whose first buy left no record holds, restart after restart, until a person ends it", async () => {
  const c = world({
    sends: {
      launch: () => {
        c.land("launch", REC.marketTickerLauncher, () => [], { input: LAUNCH.data, value: LAUNCH.value });
      },
    },
  });
  await stops(c.runner().genesis(), /nothing is recorded for the first buy behind it/);
  assert.equal(c.journal.stages.launch.status, "stopped", "held, not confirmed");
  assert.equal(c.journal.stages.launch.needBuy, "unknown");
  assert.equal(c.journal.stages.launch.txs.length, 1, "and the launch's own receipt is kept");

  // an ordinary restart must send nothing at all: this is a state a person has to end
  for (const _ of [1, 2]) await stops(c.runner().genesis(), /stopped earlier/);
  assert.deepEqual(c.calls, ["launch"], "no buy, no stage, nothing signed");

  // the person checks the explorer, finds no buy, and asks for it. it looks again itself before sending
  await c.runner().buy();
  assert.deepEqual(c.calls, ["launch", "buy"]);
  assert.equal(c.journal.stages.buy.status, "confirmed");
  await c.runner().genesis();
  assert.equal(c.journal.stages.verify.status, "confirmed");
  assert.equal(c.bal(PLAN.coin, PLAN.me), PLAN.kept);
});

test("and if that first buy turns up after all, `buy` reads it instead of sending another", async () => {
  let hash;
  const c = world({
    sends: {
      launch: () => {
        c.land("launch", REC.marketTickerLauncher, () => [], { input: LAUNCH.data, value: LAUNCH.value });
        hash = c.land("launch", REC.universalRouter, c.buyTo(PLAN.coin, 73n), { invisible: true });
      },
    },
  });
  await stops(c.runner().genesis(), /cannot say what became of it/);
  c.settleLate(); // it was in flight all along
  await c.runner().buy();
  assert.deepEqual(c.calls, ["launch"], "nothing else was ever sent");
  assert.equal(c.journal.stages.launch.status, "confirmed");
  assert.equal(c.journal.stages.launch.txs[1].hash, hash);
  await c.runner().genesis();
  assert.equal(c.bal(PLAN.coin, PLAN.me), PLAN.kept);
});

test("a request that failed is not forge saying it sent nothing: the stage is held", async () => {
  // the case an audit called out: "error sending request" does not say which request failed, and a send whose answer
  // was lost looks exactly like a read that timed out
  let hash;
  const c = world({
    sends: {
      listCoin: () => {
        hash = c.land("listCoin", REC.universalRouter, c.buyTo(PLAN.coin, 1n), { invisible: true });
        c.broadcast.listCoin = []; // and the artifact never reached disk either
      },
    },
  });
  c.forgeOutput = "Error: error sending request for url (https://rpc.example)\nCaused by: operation timed out";
  await stops(c.runner().genesis(), /left no transaction behind, and forge did not say it stopped before sending/);
  assert.equal(c.journal.stages.listCoin.status, "stopped");
  assert.equal(c.journal.stages.listCoin.noSendEvidence, undefined, "nothing attested, so nothing is claimed");
  for (const _ of [1, 2]) await stops(c.runner().genesis(), /stopped earlier/);
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1, "no second purchase while it is unresolved");

  // it was in flight all along, and settles. with no artifact anywhere, the runner will not guess what used that
  // nonce: it stops until a person names the transaction they found, and then checks it like any other
  c.forgeOutput = undefined;
  c.settleLate();
  await stops(c.runner().resolve("listCoin"), /no transaction forge recorded carries it/, "and it will not guess what used that nonce");
  await c.runner().resolve("listCoin", hash);
  assert.equal(c.journal.stages.listCoin.status, "confirmed", "read, not cleared");
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1, "still one purchase");
  await c.runner().genesis();
  assert.equal(c.bal(PLAN.coin, PLAN.me), PLAN.kept);
});

test("forge's own words after an accepted transaction are not an attestation: the captured case", async () => {
  // captured by an audit from forge 1.8.1 decoding the answer to an eth_sendRawTransaction the node had already
  // accepted and mined. "invalid type:" comes out of a decoder, and says nothing about what was sent
  const CAPTURED =
    "Error: Failed to send transaction after 4 attempts Err(deserialization error: invalid type: map, expected 32 bytes, represented as a hex string of length 64, an array of u8, or raw bytes ...)\nFailed to save deployment sequence";
  assert.equal(attestedNoSend(CAPTURED), undefined, "it attests nothing");
  assert.equal(attestedNoSend("Error: script failed: genesis v2: the first buy is not in: run buy()"), "Error: script failed: genesis v2: the first buy is not in: run buy()");
  assert.equal(attestedNoSend("Sending transactions [0 - 1]\nError: script failed: later"), undefined, "and nothing after sending began does either");

  let hash;
  const c = world({
    sends: {
      listCoin: () => {
        hash = c.land("listCoin", REC.universalRouter, c.buyTo(PLAN.coin, 1n), { invisible: true });
        c.broadcast.listCoin = []; // the checkpoint never reached disk, as in the captured run
      },
    },
  });
  c.forgeOutput = CAPTURED;
  await stops(c.runner().genesis(), /left no transaction behind, and forge did not say it stopped before sending/);
  assert.equal(c.journal.stages.listCoin.status, "stopped");
  for (const _ of [1, 2]) await stops(c.runner().genesis(), /stopped earlier/);
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1, "no second purchase");

  c.forgeOutput = undefined;
  c.settleLate();
  await c.runner().resolve("listCoin", hash);
  assert.equal(c.journal.stages.listCoin.status, "confirmed");
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1, "still one purchase");
});

test("a hash from another stage is refused, and clears nothing", async () => {
  const c = world({ sends: { listCoin: () => {} } });
  c.forgeOutput = "";
  await stops(c.runner().genesis(), /left no transaction behind/);
  const nameHash = c.journal.stages.listName.txs[0].hash; // the stage before it, a real transaction of ours
  await stops(c.runner().resolve("listCoin", nameHash), /that is a transaction of another stage; nothing was changed/);
  assert.equal(c.journal.stages.listCoin.status, "stopped", "the stage is still there");
  assert.equal(c.journal.resolved, undefined, "and nothing was archived away");

  // a hash that is not this wallet's, and one the node has never heard of, are refused too
  c.txs["0x" + "cd".repeat(32)] = { from: A(0x999), nonce: "0x0", to: REC.universalRouter };
  await stops(c.runner().resolve("listCoin", "0x" + "cd".repeat(32)), /was not sent by this wallet/);
  await stops(c.runner().resolve("listCoin", "0x" + "ef".repeat(32)), /is not a transaction this node knows/);
  assert.ok(c.journal.stages.listCoin);
});

test("a hash that turns up while a stage is held blocks `resolve`, whatever the stage was flagged with", async () => {
  const c = world({ sends: { listCoin: () => {} } });
  c.forgeOutput = ""; // ran, said nothing, left nothing
  await stops(c.runner().genesis(), /left no transaction behind/);
  assert.equal(c.journal.stages.listCoin.reviewRequired, true);

  // the artifact turns up late, naming a transaction of ours that has no receipt yet
  c.forgeOutput = undefined;
  const hash = c.land("listCoin", REC.universalRouter, c.buyTo(PLAN.coin, 1n), { invisible: true });
  await stops(c.runner().resolve("listCoin"), /cannot say what became of it/);
  assert.ok(c.journal.stages.listCoin, "the stage is still there");
  assert.equal(c.journal.stages.listCoin.known[0].hash, hash, "and the hash is kept");
  assert.equal(c.journal.resolved, undefined, "nothing was archived away");
  await stops(c.runner().genesis(), /cannot say what became of it/);
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1, "and nothing else is sent");

  c.settleLate();
  await c.runner().genesis();
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1, "one purchase, in the end");
  assert.equal(c.journal.stages.listCoin.txs[0].hash, hash);
});

test("a hash that turns up while the launch waits for its first buy blocks `buy` too", async () => {
  const c = world({
    sends: {
      launch: () => {
        c.land("launch", REC.marketTickerLauncher, () => [], { input: LAUNCH.data, value: LAUNCH.value });
      },
    },
  });
  await stops(c.runner().genesis(), /nothing is recorded for the first buy behind it/);
  const hash = c.land("launch", REC.universalRouter, c.buyTo(PLAN.coin, 73n), { invisible: true });
  await stops(c.runner().buy(), /cannot say what became of it/);
  assert.deepEqual(c.calls, ["launch"], "no buy is sent over a hash with no receipt");
  c.settleLate();
  await c.runner().genesis();
  assert.deepEqual(c.calls, ["launch", "listName", "listCoin", "split", "verify"], "and the buy that existed is the one that counts");
  assert.equal(c.journal.stages.launch.txs[1].hash, hash);
});

test("a stage that ran and left nothing behind, with no word from forge, is held rather than sent again", async () => {
  let ran = 0;
  const c = world({ sends: { listCoin: () => (ran++ === 0 ? undefined : c.ok.listCoin()) } }); // the first attempt says nothing about why it sent nothing
  c.forgeOutput = "";
  await stops(c.runner().genesis(), /left no transaction behind, and forge did not say it stopped before sending/);
  assert.equal(c.journal.stages.listCoin.status, "stopped");
  assert.equal(c.journal.stages.listCoin.reviewRequired, true);
  for (const _ of [1, 2]) await stops(c.runner().genesis(), /stopped earlier/);
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1, "no second attempt while it is held");

  // the person checks and says it sent nothing; resolve looks again itself, then clears it
  c.forgeOutput = undefined;
  await c.runner().resolve("listCoin");
  assert.equal(c.journal.stages.listCoin, undefined);
  assert.equal(c.journal.resolved[0].stage, "listCoin", "and what it knew is kept");
  await c.runner().genesis();
  assert.equal(c.journal.stages.listCoin.status, "confirmed");
  assert.equal(c.bal(PLAN.coin, PLAN.me), PLAN.kept);
});

test("resolve reads a transaction that is on the chain after all, and clears nothing", async () => {
  const c = world({ sends: { listCoin: () => void c.land("listCoin", REC.universalRouter, c.buyTo(PLAN.coin, 1n), { invisible: true }) } });
  await stops(c.runner().genesis(), /cannot say what became of it/);
  c.settleLate();
  await c.runner().resolve("listCoin");
  assert.equal(c.journal.stages.listCoin.status, "confirmed", "read, not cleared");
  assert.equal(c.journal.resolved, undefined);
  assert.equal(c.calls.filter((x) => x === "listCoin").length, 1);
});

test("a split that pays the treasury the wrong amount, or leaves the wallet off the airdrop, stops", async () => {
  const wrong = world({
    sends: {
      split: () => {
        wrong.land("split", PLAN.coin, () => []);
        wrong.land("split", REC.permit2, () => []);
        wrong.land("split", REC.permit2, () => [log(PLAN.coin, PLAN.me, PLAN.treasury, 18n)]);
      },
    },
  });
  await stops(wrong.runner().genesis(), /treasury exactly its share/);

  const gift = world();
  gift.ok.listCoin = () => {
    gift.land("listCoin", REC.universalRouter, () => [log(PLAN.coin, A(9), PLAN.me, 1n)]);
  };
  const split = gift.ok.split;
  gift.ok.split = () => {
    split();
    gift.balances[`${PLAN.coin.toLowerCase()}:${PLAN.me.toLowerCase()}`] += 3n; // coins arriving after the simulation
  };
  await stops(gift.runner().genesis(), /not the airdrop's 51/);
});

test("a receipt whose block is no longer canonical stops", async () => {
  const c = world({
    sends: {
      listName: () => {
        const h = c.land("listName", REC.universalRouter, () => [log(PLAN.name, A(9), PLAN.me, 5n)]);
        c.blocks[Number(c.receipts[h].blockNumber)] = "0x" + "ee".repeat(32);
      },
    },
  });
  await stops(c.runner().genesis(), /no longer canonical/);
});

test("the environment must keep giving the journal's plan", async () => {
  const c = world();
  await c.runner().genesis();
  c.planHex = planHex.replace(PLAN.coin.slice(2), A(0x7777).slice(2));
  await stops(c.runner().genesis(), /coin differs/);
});

test("verify that does not confirm leaves the record alone and stops", async () => {
  const c = world({ sends: { verify: () => false } });
  await stops(c.runner().genesis(), /verify did not confirm/);
  assert.equal(c.record.genesisV2Token, undefined);
});

test("the airdrop: bound to the published list, judged payment by payment, and only after verify", async () => {
  const dir = mkdtempSync(join(tmpdir(), "airdrop-"));
  const file = join(dir, "list.json");
  const list = { addresses: [A(0x101), A(0x102)], amounts: ["50", "1"], total: "51" };
  writeFileSync(file, JSON.stringify(list));
  const sha = createHash("sha256").update(JSON.stringify(list)).digest("hex");
  const pay = (c, entries) => () => {
    c.land("run", PLAN.coin, () => []);
    c.land("run", REC.permit2, () => []);
    c.land("run", REC.permit2, () =>
      entries.map(([to, amount]) => {
        c.balances[`${PLAN.coin.toLowerCase()}:${PLAN.me.toLowerCase()}`] -= amount;
        return log(PLAN.coin, PLAN.me, to, amount);
      }),
    );
  };

  const early = world({ env: { AIRDROP_FILE: file, AIRDROP_SHA256: sha } });
  await stops(early.runner().airdrop(), /not verified yet/);

  const other = world({ env: { AIRDROP_FILE: file, AIRDROP_SHA256: "00".repeat(32) } });
  await other.runner().genesis();
  await stops(other.runner().airdrop(), /not the published one/);

  const off = world({ env: { AIRDROP_FILE: file, AIRDROP_SHA256: sha } });
  off.ok.run = pay(off, [[A(0x101), 49n], [A(0x102), 2n]]);
  await off.runner().genesis();
  await stops(off.runner().airdrop(), /not its entry in the list/);

  const good = world({ env: { AIRDROP_FILE: file, AIRDROP_SHA256: "0x" + sha } });
  good.ok.run = pay(good, [[A(0x101), 50n], [A(0x102), 1n]]);
  await good.runner().genesis();
  await good.runner().airdrop();
  assert.equal(good.journal.stages.airdrop.status, "confirmed");
  assert.equal(good.bal(PLAN.coin, PLAN.me), 0n);
});

test("every stage names where its transactions go", () => {
  for (const [id, s] of Object.entries(SPEC)) assert.ok(s.to(REC, PLAN).every(Boolean), id);
});
