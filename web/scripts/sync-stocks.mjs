// Snapshot Robinhood's asset registry (the same source their docs table reads) into src/data/stocks.json, merged
// with the Chainlink feeds from contracts/config. Run it to refresh; the JSON is committed so builds need no network.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const OUT = fileURLToPath(new URL("../src/data/stocks.json", import.meta.url));
const CFG = fileURLToPath(new URL("../../contracts/config/stock-tokens-4663.json", import.meta.url));
const res = await fetch("https://api.robinhood.com/rhj/assets", { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/120", Accept: "application/json" } });
if (!res.ok) throw new Error(`assets api ${res.status}`);
const { assets } = await res.json();
const feeds = fs.existsSync(CFG) ? Object.fromEntries(JSON.parse(fs.readFileSync(CFG, "utf8")).assets.map((a) => [a.token.toLowerCase(), a.feed])) : {};
const rows = assets
  .filter((a) => a.status === "ASSET_STATUS_ACTIVE")
  .flatMap((a) => a.deployments.filter((d) => d.chainId === 4663).map((d) => ({
    symbol: a.tokenSymbol,
    name: a.tokenName.replace(/\s*•\s*Robinhood Token$/, ""),
    onChainName: a.tokenName,
    address: d.contractAddress,
    isin: a.isin || "",
    multiplier: a.currentMultiplier,
    feed: feeds[d.contractAddress.toLowerCase()] ?? "0x0000000000000000000000000000000000000000",
    tradable: a.tradingCapabilities?.market?.whole === "TRADING_STATUS_TRADABLE",
  })))
  .sort((x, y) => x.symbol.localeCompare(y.symbol));
fs.writeFileSync(OUT, JSON.stringify({ source: "https://api.robinhood.com/rhj/assets", syncedAt: new Date().toISOString().slice(0, 10), issuer: "Robinhood Assets", count: rows.length, assets: rows }, null, 1));
console.log(`stocks: ${rows.length} active Stock Tokens on Robinhood Chain, ${rows.filter((r) => !r.feed.startsWith("0x0000")).length} with a Chainlink feed`);
