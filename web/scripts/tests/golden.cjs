// The golden activation calldata: what the site's encoder produces for one fixed set of inputs, kept in golden.json
// and mirrored as hex in contracts/test/UniversalRouterBuy.t.sol, which compares the script encoder against it.
//   node scripts/tests/golden.cjs           checks golden.json against the encoder and the Solidity test
//   node scripts/tests/golden.cjs --write   regenerates golden.json and rewrites the hex in the Solidity test
"use strict";
const fs = require("node:fs"), path = require("node:path");
const fx = require("./fixture.cjs");
const a = fx.src("lib/activation.ts");
const pools = a.poolsFor(fx.ticker, { currency0: fx.coin, currency1: fx.ticker, fee: 10000, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" });
const INPUTS = { wallet: fx.wallet, coin: fx.coin, ticker: fx.ticker, usdg: pools.funding.currency1, hook: pools.bridge.hooks, deadline: 1800000000, quote: { amountIn: "500000000000000", minimum: "1229777" }, coin_: { amountIn: "1000000000000000", minimum: "664767222266720916779239" } };
function generate() {
  return {
    inputs: INPUTS,
    quote: a.encodeBuy({ wallet: fx.wallet, pools, phase: "quote", amountIn: BigInt(INPUTS.quote.amountIn), minimumOut: BigInt(INPUTS.quote.minimum), deadline: INPUTS.deadline }),
    coin: a.encodeBuy({ wallet: fx.wallet, pools, phase: "coin", amountIn: BigInt(INPUTS.coin_.amountIn), minimumOut: BigInt(INPUTS.coin_.minimum), deadline: INPUTS.deadline }),
  };
}
const jsonPath = path.join(__dirname, "golden.json");
const solPath = path.join(__dirname, "..", "..", "..", "contracts", "test", "UniversalRouterBuy.t.sol");
function solidityHexes() {
  const s = fs.readFileSync(solPath, "utf8");
  const m = [...s.matchAll(/hex"([0-9a-f]+)"/g)].map((x) => "0x" + x[1]);
  return { quote: m[0], coin: m[1] };
}
module.exports = { generate, INPUTS, jsonPath, solPath, solidityHexes };
if (require.main === module) {
  const g = generate();
  if (process.argv.includes("--write")) {
    fs.writeFileSync(jsonPath, JSON.stringify(g, null, 2) + "\n");
    let s = fs.readFileSync(solPath, "utf8");
    const hexes = [...s.matchAll(/hex"([0-9a-f]+)"/g)];
    if (hexes.length !== 2) throw new Error("expected two hex literals in the Solidity test");
    s = s.replace(hexes[0][0], `hex"${g.quote.slice(2)}"`).replace(hexes[1][0], `hex"${g.coin.slice(2)}"`);
    fs.writeFileSync(solPath, s);
    console.log("golden.json and the Solidity test rewritten");
  } else {
    const j = JSON.parse(fs.readFileSync(jsonPath, "utf8")), sol = solidityHexes();
    const ok = j.quote === g.quote && j.coin === g.coin && sol.quote === g.quote && sol.coin === g.coin;
    console.log(ok ? "golden bytes match the encoder and the Solidity test" : "MISMATCH: run with --write after reviewing the change, then rerun forge test");
    process.exit(ok ? 0 : 1);
  }
}
