// The two activation purchases for one coin, as transactions to sign, built by the product's own module.
//
// This is the "script only" route: nothing here opens the site. But the calldata is not reimplemented either,
// it comes from lib/activation.ts, the same encodeBuy the site sends, so the bytes that reach the chain are the
// product's. What is not tested this way is the site's review, its journal and its recovery, and the run must
// say so rather than claim the creator journey was exercised.
//
// Usage: node scripts/activation-calldata.mjs <coin> <name> <coinPoolFee> <coinPoolSpacing> <wallet> <rpc>
// Prints one JSON object per phase. It signs nothing and sends nothing.
import { createPublicClient, http, formatEther } from "viem";

const [coin, name, feeArg, spacingArg, wallet, rpc] = process.argv.slice(2);
if (!coin || !name || !feeArg || !spacingArg || !wallet || !rpc) {
  console.error("usage: node scripts/activation-calldata.mjs <coin> <name> <coinPoolFee> <coinPoolSpacing> <wallet> <rpc>");
  process.exit(1);
}

// the product's own modules, against the real deployment record. Not the test fixture, which replaces every
// address with a test value and would encode a transaction pointing at nothing
const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const load = req("./ts-load.cjs");
const a = load.src("lib/activation.ts");
const { ADDRESSES } = load.src("lib/addresses.ts");
if (!ADDRESSES.universalRouter || ADDRESSES.universalRouter === "0x0000000000000000000000000000000000000000") {
  console.error("no universal router in the deployment record; refusing to encode anything");
  process.exit(3);
}

const client = createPublicClient({ transport: http(rpc) });

const ZERO = "0x0000000000000000000000000000000000000000";
const sorted = (x, y) => (BigInt(x) < BigInt(y) ? [x, y] : [y, x]);
const [c0, c1] = sorted(coin, name);
const main = { currency0: c0, currency1: c1, fee: Number(feeArg), tickSpacing: Number(spacingArg), hooks: ZERO };

// a fixed-inventory name: its market pool, from the issuer the site is configured with
const issuerFee = await client.readContract({
  abi: [{ type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] }],
  address: ADDRESSES.marketTickerDeployer,
  functionName: "fee",
});
const issuerSpacing = await client.readContract({
  abi: [{ type: "function", name: "spacing", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] }],
  address: ADDRESSES.marketTickerDeployer,
  functionName: "spacing",
});
const spec = { kind: "market", fee: Number(issuerFee), tickSpacing: Number(issuerSpacing) };
const pools = a.poolsFor(name, main, spec);

const block = await client.getBlock();
const deadline = Number(block.timestamp) + a.DEADLINE_SECONDS;

for (const phase of a.PHASES) {
  const path = a.routeFor(pools, phase);
  const amountIn = a.AMOUNTS[phase];
  const [quoted] = await client.simulateContract({
    abi: a.QUOTER_ABI,
    address: ADDRESSES.v4Quoter,
    functionName: "quoteExactInput",
    args: [{ exactCurrency: ZERO, path, exactAmount: amountIn }],
  }).then((r) => [r.result[0]]).catch(() => [null]);
  if (quoted === null || quoted === 0n) {
    console.error(`${phase}: no quote. Nothing to sign; do not send anything.`);
    process.exit(2);
  }
  const minimumOut = a.minimumOutput(quoted);
  const data = a.encodeBuy({ wallet, pools, phase, amountIn, minimumOut, deadline });
  console.log(
    JSON.stringify(
      {
        phase,
        to: ADDRESSES.universalRouter,
        value: `0x${amountIn.toString(16)}`,
        valueEth: formatEther(amountIn),
        data,
        quoted: quoted.toString(),
        minimumOut: minimumOut.toString(),
        deadline,
        note: phase === "coin" ? "send only after the quote phase's receipt is confirmed AND in a later block" : "send first",
      },
      null,
      2,
    ),
  );
}
