// Warms the fork's cache with every cold read the demo pages make against live-chain contracts, right after
// seeding, while the public node still serves the fork block's state. Without this the recorder reaches those
// pages after the node has pruned the block and the whole read batch fails.
import { createPublicClient, http, erc20Abi, type Address } from "viem";
import { readFileSync } from "node:fs";
import { FEE_TIERS, V3_FEES, idOf, keyOf, liquiditySlot } from "@/lib/route";
import { slot0Slot } from "@/lib/pool";
import { poolManagerAbi, v3FactoryAbi, v3PoolAbi } from "@/lib/extraAbis";

const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const d = JSON.parse(readFileSync(new URL(`../../../contracts/${process.env.DEPLOY_RECORD ?? "deployments/4663.json"}`, import.meta.url), "utf8")) as Record<string, string>;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const BURN = "0x000000000000000000000000000000000000dEaD" as Address;
// the live token the demo coin is priced in (Seed.s.sol LIVE_CHAIN_TOKEN)
const LIVE = "0x020bfC650A365f8BB26819deAAbF3E21291018b4" as Address;
const WETH = d.weth as Address;
const USDG = d.usdg as Address;
const V3 = (d.v3Factory ?? "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA") as Address;
const PM = d.poolManager as Address;
const spenders = ["launchSeeder", "zapRouter", "launchAndBuyRouter", "marketQuoteLauncher", "coinQuoteLauncher", "stockQuoteLauncher", "tickerLauncher"].map((k) => d[k]).filter(Boolean) as Address[];

const client = createPublicClient({ transport: http(RPC) });
const MC = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
(async () => {
  const contracts: { abi: any; address: Address; functionName: string; args?: readonly unknown[] }[] = [];
  for (const who of [ZERO, BURN, ...spenders]) contracts.push({ abi: erc20Abi, address: LIVE, functionName: "balanceOf", args: [who] });
  for (const s of spenders) contracts.push({ abi: erc20Abi, address: LIVE, functionName: "allowance", args: [ZERO, s] });
  for (const f of ["name", "symbol", "decimals", "totalSupply"]) contracts.push({ abi: erc20Abi, address: LIVE, functionName: f });
  for (const t of FEE_TIERS) {
    const k = keyOf(ZERO, LIVE, t.fee, t.tickSpacing);
    contracts.push({ abi: poolManagerAbi, address: PM, functionName: "extsload", args: [liquiditySlot(idOf(k))] });
    contracts.push({ abi: poolManagerAbi, address: PM, functionName: "extsload", args: [slot0Slot(idOf(k))] });
  }
  for (const counter of [WETH, USDG]) for (const fee of V3_FEES) contracts.push({ abi: v3FactoryAbi, address: V3, functionName: "getPool", args: [counter, LIVE, fee] });
  const first = await client.multicall({ contracts: contracts as any, allowFailure: true, multicallAddress: MC });
  let ok = first.filter((r) => r.status === "success").length;
  // the v3 pools that exist: liquidity, slot0, and their counter balances
  const pools: Address[] = [];
  first.slice(-2 * V3_FEES.length).forEach((r) => { if (r.status === "success" && r.result !== ZERO) pools.push(r.result as Address); });
  const second = pools.flatMap((p) => [
    { abi: v3PoolAbi, address: p, functionName: "liquidity" },
    { abi: v3PoolAbi, address: p, functionName: "slot0" },
    { abi: erc20Abi, address: WETH, functionName: "balanceOf", args: [p] },
    { abi: erc20Abi, address: USDG, functionName: "balanceOf", args: [p] },
  ]);
  if (second.length) ok += (await client.multicall({ contracts: second as any, allowFailure: true, multicallAddress: MC })).filter((r) => r.status === "success").length;
  console.log(`warm: ${ok} reads cached across ${contracts.length + second.length} calls, ${pools.length} v3 pools`);
})();
