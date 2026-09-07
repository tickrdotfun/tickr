// The deployment record's schema, and the checks a live build makes on it. One module, so the release guard and
// its tests read the same rules, and so a field genesis writes cannot be unknown to the guard.
export const ZERO = "0x0000000000000000000000000000000000000000";
export const ADDRESSES = new Set(["factory", "managedTickerHook", "managedTickerDeployer", "universalRouter", "feeEscrow", "launchLocker", "launchDeployer", "launchSeeder", "buybackVault", "buybackTreasury", "anchorRegistry", "launchAndBuyRouter", "tickerLauncher", "coinQuoteLauncher", "stockQuoteLauncher", "marketQuoteLauncher", "marketQuoteLauncherDeployed", "v3Factory", "zapRouter", "poolManager", "positionManager", "permit2", "usdg", "weth", "v4Quoter", "genesisToken", "genesisTicker", "stockAAPL", "stockF", "stockNVDA"]);
export const HASHES = new Set(["genesisPool"]);
export const NUMBERS = new Set(["chainId", "startBlock"]);
export const BOOLEANS = new Set(["sepolia", "genesisActivated"]);
/** what every live build must carry as a real address, from the record or its documented override */
export const REQUIRED = { factory: "NEXT_PUBLIC_FACTORY", launchSeeder: "NEXT_PUBLIC_LAUNCH_SEEDER", launchLocker: "NEXT_PUBLIC_LAUNCH_LOCKER", feeEscrow: "NEXT_PUBLIC_FEE_ESCROW", launchDeployer: "NEXT_PUBLIC_LAUNCH_DEPLOYER", launchAndBuyRouter: "NEXT_PUBLIC_LAUNCH_AND_BUY_ROUTER", tickerLauncher: "NEXT_PUBLIC_TICKER_LAUNCHER", zapRouter: "NEXT_PUBLIC_ZAP_ROUTER", anchorRegistry: "NEXT_PUBLIC_ANCHOR_REGISTRY", managedTickerHook: "NEXT_PUBLIC_MANAGED_TICKER_HOOK", managedTickerDeployer: "NEXT_PUBLIC_MANAGED_TICKER_DEPLOYER", universalRouter: "NEXT_PUBLIC_UNIVERSAL_ROUTER", v4Quoter: "NEXT_PUBLIC_V4_QUOTER" };
export const OVERRIDES = ["NEXT_PUBLIC_FACTORY", "NEXT_PUBLIC_LAUNCH_DEPLOYER", "NEXT_PUBLIC_LAUNCH_SEEDER", "NEXT_PUBLIC_FEE_ESCROW", "NEXT_PUBLIC_LAUNCH_LOCKER", "NEXT_PUBLIC_LAUNCH_AND_BUY_ROUTER", "NEXT_PUBLIC_ANCHOR_REGISTRY", "NEXT_PUBLIC_TICKER_LAUNCHER", "NEXT_PUBLIC_COIN_QUOTE_LAUNCHER", "NEXT_PUBLIC_STOCK_QUOTE_LAUNCHER", "NEXT_PUBLIC_MARKET_QUOTE_LAUNCHER", "NEXT_PUBLIC_ZAP_ROUTER", "NEXT_PUBLIC_MANAGED_TICKER_HOOK", "NEXT_PUBLIC_MANAGED_TICKER_DEPLOYER", "NEXT_PUBLIC_UNIVERSAL_ROUTER", "NEXT_PUBLIC_BUYBACK_TREASURY", "NEXT_PUBLIC_POOL_MANAGER", "NEXT_PUBLIC_POSITION_MANAGER", "NEXT_PUBLIC_USDG", "NEXT_PUBLIC_WETH", "NEXT_PUBLIC_V3_FACTORY", "NEXT_PUBLIC_V4_QUOTER", "NEXT_PUBLIC_GENESIS_TOKEN", "NEXT_PUBLIC_GENESIS_TICKER"];
export const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** The addresses a live build is missing: real in the record, or given by the documented override. */
export function missingRequired(record, env) {
  return Object.entries(REQUIRED).filter(([k, name]) => { const v = record[k] && record[k] !== ZERO ? record[k] : env[name]; return !v || v === ZERO; }).map(([k]) => k);
}

/**
 * Every problem a live build must refuse: the record read from the contracts folder for this chain, complete after
 * genesis, every field by name and well formed, no rehearsal record, and, on the public chain, genesis activated:
 * the official coin's two activation buys landed, as the genesis script recorded.
 */
export function liveProblems(record, { chainId, origin, src, env }) {
  const problems = [];
  if (origin !== "copied") problems.push(`the record was not read from ${src} (${origin})`);
  if (record.chainId === undefined) problems.push("the record has no chainId");
  else if (Number(record.chainId) !== Number(chainId)) problems.push(`the record is for chain ${record.chainId}, this build is for ${chainId}`);
  for (const k of ["buybackTreasury", "genesisToken", "genesisTicker"]) if (!record[k] || record[k] === ZERO) problems.push(`${k} is missing: run genesis and sync again`);
  for (const [k, v] of Object.entries(record)) {
    if (NUMBERS.has(k)) { if (!Number.isInteger(Number(v)) || Number(v) < 0) problems.push(`${k} is not a whole number: ${v}`); continue; }
    if (HASHES.has(k)) { if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) problems.push(`${k} is not a 32 byte hash: ${v}`); continue; }
    if (BOOLEANS.has(k)) { if (typeof v !== "boolean") problems.push(`${k} is not a boolean: ${v}`); continue; }
    if (ADDRESSES.has(k)) { if (!isAddr(v)) problems.push(`${k} is not an address: ${v}`); continue; }
    problems.push(`${k} is not a field of the deployment record`);
  }
  if (record.sepolia === true) problems.push("the record is a Sepolia rehearsal record");
  if (record.genesisActivated !== true) problems.push("genesisActivated is not true: the official coin's two activation buys did not land in genesis, or the record predates them; a live build needs an activated genesis");
  for (const name of OVERRIDES) { const v = env[name]; if (v !== undefined && !isAddr(v)) problems.push(`${name} is not an address: ${v}`); }
  if (env.NEXT_PUBLIC_GENESIS_POOL !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(env.NEXT_PUBLIC_GENESIS_POOL)) problems.push("NEXT_PUBLIC_GENESIS_POOL is not a 32 byte hash");
  if (env.NEXT_PUBLIC_START_BLOCK !== undefined && !/^\d+$/.test(env.NEXT_PUBLIC_START_BLOCK)) problems.push("NEXT_PUBLIC_START_BLOCK is not a whole number");
  return problems;
}
