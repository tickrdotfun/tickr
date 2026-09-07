// Copies ../contracts/deployments/<chain id>.json (NEXT_PUBLIC_CHAIN_ID, default 4663) into src/lib/deployments.json when it exists,
// otherwise resets it to deployments.example.json (all-zero protocol addresses).
// Runs automatically before `pnpm dev` / `pnpm build`.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ZERO = "0x0000000000000000000000000000000000000000";
const here = dirname(fileURLToPath(import.meta.url));
const chainId = process.env.NEXT_PUBLIC_CHAIN_ID || "4663";
const src = process.env.DEPLOY_RECORD ? resolve(here, "..", "..", "contracts", process.env.DEPLOY_RECORD) : resolve(here, "..", "..", "contracts", "deployments", `${chainId}.json`);
const example = resolve(here, "..", "src", "lib", "deployments.example.json");
const dest = resolve(here, "..", "src", "lib", "deployments.json");

let origin = "example";
if (existsSync(src)) {
  copyFileSync(src, dest);
  origin = "copied";
  console.log(`deployments: copied ${src}`);
} else if (existsSync(dest) && JSON.parse(readFileSync(dest, "utf8")).factory !== ZERO) {
  origin = "kept";
  // No contracts folder to read from, but the addresses already in the tree are real: this is a deploy
  // rooted at web/, so keep them rather than blanking the app. Same rule as sync-docs.mjs.
  console.log("deployments: ../contracts not found, keeping the addresses already in src/lib/deployments.json");
} else {
  copyFileSync(example, dest);
  console.log("deployments: nothing to read and nothing in the tree, using example (zero addresses)");
}

// a live build must carry real addresses: a preview replays a fixture and the coming-soon landing has no chain
{
  // a live build is any build that is neither the preview nor the coming-soon page, on any host
  const live = (process.env.VERCEL === "1" || process.env.CF_LIVE === "1" || process.env.CI === "true") && process.env.NEXT_PUBLIC_DEMO !== "1" && process.env.NEXT_PUBLIC_SITE_MODE !== "soon";
  const record = JSON.parse(readFileSync(dest, "utf8"));
  const envFor = { factory: "NEXT_PUBLIC_FACTORY", launchSeeder: "NEXT_PUBLIC_LAUNCH_SEEDER", launchLocker: "NEXT_PUBLIC_LAUNCH_LOCKER", feeEscrow: "NEXT_PUBLIC_FEE_ESCROW", launchDeployer: "NEXT_PUBLIC_LAUNCH_DEPLOYER", launchAndBuyRouter: "NEXT_PUBLIC_LAUNCH_AND_BUY_ROUTER", tickerLauncher: "NEXT_PUBLIC_TICKER_LAUNCHER", zapRouter: "NEXT_PUBLIC_ZAP_ROUTER", anchorRegistry: "NEXT_PUBLIC_ANCHOR_REGISTRY", managedTickerHook: "NEXT_PUBLIC_MANAGED_TICKER_HOOK", managedTickerDeployer: "NEXT_PUBLIC_MANAGED_TICKER_DEPLOYER", universalRouter: "NEXT_PUBLIC_UNIVERSAL_ROUTER", v4Quoter: "NEXT_PUBLIC_V4_QUOTER" };
  const missing = Object.entries(envFor).filter(([k, env]) => { const v = record[k] && record[k] !== ZERO ? record[k] : process.env[env]; return !v || v === ZERO; }).map(([k]) => k);
  if (live && missing.length) {
    console.error(`deployments: refusing a live build with zero addresses for ${missing.join(", ")}. sync the real record first.`);
    process.exit(1);
  }
  if (live) {
    // the record must be the one written for this chain, read from the contracts folder now, well formed, and
    // complete: the treasury and the genesis coin are baked into the site, so a build from before genesis or from
    // another chain's record would ship a site that does not know its own official coin
    const problems = [];
    if (origin !== "copied") problems.push(`the record was not read from ${src} (${origin})`);
    if (record.chainId === undefined) problems.push("the record has no chainId");
    else if (Number(record.chainId) !== Number(chainId)) problems.push(`the record is for chain ${record.chainId}, this build is for ${chainId}`);
    for (const k of ["buybackTreasury", "genesisToken", "genesisTicker"]) if (!record[k] || record[k] === ZERO) problems.push(`${k} is missing: run genesis and sync again`);
    // every field by name: the record is a fixed schema, and a field it does not know is a mistake
    const ADDRESSES = new Set(["factory", "managedTickerHook", "managedTickerDeployer", "universalRouter", "feeEscrow", "launchLocker", "launchDeployer", "launchSeeder", "buybackVault", "buybackTreasury", "anchorRegistry", "launchAndBuyRouter", "tickerLauncher", "coinQuoteLauncher", "stockQuoteLauncher", "marketQuoteLauncher", "marketQuoteLauncherDeployed", "v3Factory", "zapRouter", "poolManager", "positionManager", "permit2", "usdg", "weth", "v4Quoter", "genesisToken", "genesisTicker", "stockAAPL", "stockF", "stockNVDA"]);
    const HASHES = new Set(["genesisPool"]);
    const NUMBERS = new Set(["chainId", "startBlock"]);
    const BOOLEANS = new Set(["sepolia"]);
    const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
    for (const [k, v] of Object.entries(record)) {
      if (NUMBERS.has(k)) { if (!Number.isInteger(Number(v)) || Number(v) < 0) problems.push(`${k} is not a whole number: ${v}`); continue; }
      if (HASHES.has(k)) { if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) problems.push(`${k} is not a 32 byte hash: ${v}`); continue; }
      if (BOOLEANS.has(k)) { if (typeof v !== "boolean") problems.push(`${k} is not a boolean: ${v}`); continue; }
      if (ADDRESSES.has(k)) { if (!isAddr(v)) problems.push(`${k} is not an address: ${v}`); continue; }
      problems.push(`${k} is not a field of the deployment record`);
    }
    if (record.sepolia === true) problems.push("the record is a Sepolia rehearsal record");
    // the effective configuration is what the site reads: every override addresses.ts knows must be well formed too
    const OVERRIDES = ["NEXT_PUBLIC_FACTORY", "NEXT_PUBLIC_LAUNCH_DEPLOYER", "NEXT_PUBLIC_LAUNCH_SEEDER", "NEXT_PUBLIC_FEE_ESCROW", "NEXT_PUBLIC_LAUNCH_LOCKER", "NEXT_PUBLIC_LAUNCH_AND_BUY_ROUTER", "NEXT_PUBLIC_ANCHOR_REGISTRY", "NEXT_PUBLIC_TICKER_LAUNCHER", "NEXT_PUBLIC_COIN_QUOTE_LAUNCHER", "NEXT_PUBLIC_STOCK_QUOTE_LAUNCHER", "NEXT_PUBLIC_MARKET_QUOTE_LAUNCHER", "NEXT_PUBLIC_ZAP_ROUTER", "NEXT_PUBLIC_MANAGED_TICKER_HOOK", "NEXT_PUBLIC_MANAGED_TICKER_DEPLOYER", "NEXT_PUBLIC_UNIVERSAL_ROUTER", "NEXT_PUBLIC_BUYBACK_TREASURY", "NEXT_PUBLIC_POOL_MANAGER", "NEXT_PUBLIC_POSITION_MANAGER", "NEXT_PUBLIC_USDG", "NEXT_PUBLIC_WETH", "NEXT_PUBLIC_V3_FACTORY", "NEXT_PUBLIC_V4_QUOTER", "NEXT_PUBLIC_GENESIS_TOKEN", "NEXT_PUBLIC_GENESIS_TICKER"];
    for (const env of OVERRIDES) { const v = process.env[env]; if (v !== undefined && !isAddr(v)) problems.push(`${env} is not an address: ${v}`); }
    if (process.env.NEXT_PUBLIC_GENESIS_POOL !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(process.env.NEXT_PUBLIC_GENESIS_POOL)) problems.push("NEXT_PUBLIC_GENESIS_POOL is not a 32 byte hash");
    if (process.env.NEXT_PUBLIC_START_BLOCK !== undefined && !/^\d+$/.test(process.env.NEXT_PUBLIC_START_BLOCK)) problems.push("NEXT_PUBLIC_START_BLOCK is not a whole number");
    if (problems.length) {
      console.error(`deployments: refusing a live build: ${problems.join("; ")}.`);
      process.exit(1);
    }
  }
}
