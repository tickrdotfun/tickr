// Lists every pool a wrapper (FUN by default) trades in on DexScreener and flags any that is not the guarded
// dollar pool or sits away from one dollar. Read-only. Usage: node scripts/fun-pools.mjs [wrapper address]
// The guarded pool is the one whose pair id equals the chart pool id in the deployment record, when present.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rec = JSON.parse(readFileSync(resolve(here, "..", "..", "contracts", "deployments", "4663.json"), "utf8"));
const wrapper = (process.argv[2] ?? rec.genesisTicker ?? "").toLowerCase();
if (!wrapper) { console.error("no wrapper address: pass one or set genesisTicker in the deployment record"); process.exit(1); }

const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${wrapper}`, { headers: { "user-agent": "tickr/1.0" } });
if (!r.ok) { console.error("dexscreener", r.status); process.exit(1); }
const pairs = ((await r.json()).pairs ?? []).filter((p) => p.chainId === "robinhood");
const isWrapperPair = (p) => [p.baseToken.address, p.quoteToken.address].map((a) => a.toLowerCase()).includes(wrapper);
const usdg = (rec.usdg ?? "").toLowerCase();

console.log(`wrapper ${wrapper}: ${pairs.length} pool(s) on DexScreener`);
let flagged = 0;
for (const p of pairs.filter(isWrapperPair)) {
  const other = [p.baseToken, p.quoteToken].find((t) => t.address.toLowerCase() !== wrapper);
  const againstUsdg = other && other.address.toLowerCase() === usdg;
  // price of the wrapper in dollars: priceUsd is the base token's; invert when the wrapper is the quote
  const wrapperIsBase = p.baseToken.address.toLowerCase() === wrapper;
  const priceUsd = p.priceUsd ? (wrapperIsBase ? Number(p.priceUsd) : 1 / Number(p.priceNative)) : null;
  const off = priceUsd != null ? Math.abs(priceUsd - 1) : null;
  const liq = p.liquidity?.usd ?? 0;
  const flag = againstUsdg && off != null && off > 0.01 ? "OFF ONE DOLLAR" : "";
  if (flag) flagged++;
  console.log(`  ${p.baseToken.symbol}/${p.quoteToken.symbol}  ${p.dexId} ${(p.labels ?? []).join(",")}  liq $${liq.toLocaleString()}  wrapper price ${priceUsd?.toFixed(4) ?? "?"}  ${p.pairAddress.slice(0, 12)}  ${flag}`);
}
if (flagged) {
  console.log(`\n${flagged} USDG pool(s) away from one dollar. the arbitrage: mint the wrapper at one dollar and sell into any pool above it,`);
  console.log("or buy from any pool below it and redeem. the guarded pool cannot move; the others hand the difference to whoever does this.");
} else {
  console.log("\nnothing off one dollar.");
}
