// Every transaction the site sends is bound to the wallet account and the chain it was reviewed with: the real useTx
// module, driven outside React with a scripted wallet that switches account while the first step confirms.
// Run: node --test scripts/tests/txBinding.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const fs = require("node:fs"), path = require("node:path");
const fx = require("./fixture.cjs");

const SRC = path.join(__dirname, "..", "..", "src");
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";

// a wallet whose active account and network the test controls, and a chain that confirms every hash at once
const wallet = { account: A, chainId: 4663, sent: [], afterFirstReceipt: () => {} };
const fake = (name, exports) => {
  const id = require.resolve(name, { paths: [path.join(__dirname, "..", "..")] });
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
fake("react", { useCallback: (f) => f, useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}] });
fake("wagmi", {
  useAccount: () => ({
    connector: {
      getAccounts: async () => [wallet.account],
      getChainId: async () => wallet.chainId,
      getProvider: async () => ({ request: async () => "0x6080" }), // the wallet sees the factory
    },
  }),
  usePublicClient: () => ({
    waitForTransactionReceipt: async ({ hash }) => {
      wallet.afterFirstReceipt();
      return { status: "success", transactionHash: hash, blockNumber: 1n };
    },
  }),
  useWriteContract: () => ({
    writeContractAsync: async (req) => {
      wallet.sent.push(req);
      return `0x${String(wallet.sent.length).padStart(64, "0")}`;
    },
  }),
});
const { useTx } = fx.src("hooks/useTx.ts");

/** an approval then a buy whose calldata pays `recipient`, as the trade panel builds them */
const steps = (recipient) => [
  { label: "approve", request: (w) => w({ functionName: "approve", args: [] }) },
  { label: "buy", request: (w) => w({ functionName: "zapBuy", args: [recipient] }) },
];
const reset = () => {
  wallet.account = A;
  wallet.chainId = 4663;
  wallet.sent = [];
  wallet.afterFirstReceipt = () => {};
};

test("bound to the reviewed account: a switch during the approval stops the buy before it is asked", async () => {
  reset();
  wallet.afterFirstReceipt = () => (wallet.account = B);
  const tx = useTx();
  const h = await tx.run(steps(A), { account: A, chainId: 4663 });
  assert.equal(h, undefined, "the run did not complete");
  assert.equal(wallet.sent.length, 1, "only the approval was sent");
  assert.match(String(tx.lastError.current?.message), /active account changed/);
  assert.equal(wallet.sent[0].account, A, "and the approval itself carried the reviewed account");
  assert.equal(wallet.sent[0].chainId, 4663, "and the reviewed chain");
});

test("bound to the reviewed chain: a network switch stops the next request", async () => {
  reset();
  wallet.afterFirstReceipt = () => (wallet.chainId = 1);
  const tx = useTx();
  await tx.run(steps(A), { account: A, chainId: 4663 });
  assert.equal(wallet.sent.length, 1);
  assert.match(String(tx.lastError.current?.message), /network changed/);
});

test("unbound, the same switch sends the buy from the new account with the old recipient: why every flow binds", async () => {
  reset();
  wallet.afterFirstReceipt = () => (wallet.account = B);
  const tx = useTx();
  await tx.run(steps(A));
  assert.equal(wallet.sent.length, 2, "the second request went out");
  assert.equal(wallet.sent[1].account, undefined, "from whatever account the wallet had active");
});

test("every transaction flow on the site passes the account and chain it was reviewed with", () => {
  // the flows that sign: each `run(` of a useTx result must carry its binding
  const files = ["components/token/TradePanel.tsx", "components/token/FeeLedger.tsx", "components/token/CreatorControls.tsx", "components/token/TickerClub.tsx", "components/token/Buyback.tsx", "components/create/CreateForm.tsx"];
  for (const f of files) {
    const s = fs.readFileSync(path.join(SRC, f), "utf8");
    const runs = [...s.matchAll(/\btx\s*\.run\(|\btx\s*\n\s*\.run\(/g)].length;
    const bound = [...s.matchAll(/chainId: CHAIN_ID \}\)|\], bind\)/g)].length;
    assert.ok(runs > 0, `${f} sends something`);
    assert.ok(bound >= runs, `${f}: ${runs} runs, ${bound} bound`);
  }
});
