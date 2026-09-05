import type { Address } from "viem";
import deployments from "./deployments.json";

export const ZERO: Address = "0x0000000000000000000000000000000000000000";

type Deployments = {
  launchDeployer?: string;
  launchSeeder?: string;
  chainId?: number;
  factory?: string;
  feeEscrow?: string;
  launchLocker?: string;
  launchAndBuyRouter?: string;
  anchorRegistry?: string;
  tickerLauncher?: string;
  coinQuoteLauncher?: string;
  stockQuoteLauncher?: string;
  zapRouter?: string;
  v3Factory?: string;
  buybackTreasury?: string;
  marketQuoteLauncher?: string;
  poolManager?: string;
  positionManager?: string;
  usdg?: string;
  weth?: string;
  startBlock?: number | string;
  genesisToken?: string;
  genesisTicker?: string;
  genesisPool?: string;
  chartGuardHook?: string;
};

const d = deployments as Deployments;

function pick(json: string | undefined, env: string | undefined, fallback: Address = ZERO): Address {
  const v = json && json !== ZERO ? json : env && env !== "" ? env : fallback;
  return v as Address;
}

/** The official coin: TICKR, priced in FUN, the first launch. Zero until a deployment records it. */
export const OFFICIAL = {
  token: pick(d.genesisToken, process.env.NEXT_PUBLIC_GENESIS_TOKEN),
  ticker: pick(d.genesisTicker, process.env.NEXT_PUBLIC_GENESIS_TICKER),
  pool: (d.genesisPool ?? process.env.NEXT_PUBLIC_GENESIS_POOL ?? "0x") as `0x${string}`,
};

/** Where the protocol's share of the coin side of every fee goes. Nothing can move it out. */
export const BURN: Address = "0x000000000000000000000000000000000000dEaD";
export const isOfficialCoin = (a?: string) => !!a && OFFICIAL.token !== ZERO && a.toLowerCase() === OFFICIAL.token.toLowerCase();

export const ADDRESSES = {
  factory: pick(d.factory, process.env.NEXT_PUBLIC_FACTORY),
  launchDeployer: pick(d.launchDeployer, process.env.NEXT_PUBLIC_LAUNCH_DEPLOYER),
  launchSeeder: pick(d.launchSeeder, process.env.NEXT_PUBLIC_LAUNCH_SEEDER),
  feeEscrow: pick(d.feeEscrow, process.env.NEXT_PUBLIC_FEE_ESCROW),
  launchLocker: pick(d.launchLocker, process.env.NEXT_PUBLIC_LAUNCH_LOCKER),
  launchAndBuyRouter: pick(d.launchAndBuyRouter, process.env.NEXT_PUBLIC_LAUNCH_AND_BUY_ROUTER),
  anchorRegistry: pick(d.anchorRegistry, process.env.NEXT_PUBLIC_ANCHOR_REGISTRY),
  tickerLauncher: pick(d.tickerLauncher, process.env.NEXT_PUBLIC_TICKER_LAUNCHER),
  coinQuoteLauncher: pick(d.coinQuoteLauncher, process.env.NEXT_PUBLIC_COIN_QUOTE_LAUNCHER),
  stockQuoteLauncher: pick(d.stockQuoteLauncher, process.env.NEXT_PUBLIC_STOCK_QUOTE_LAUNCHER),
  marketQuoteLauncher: pick(d.marketQuoteLauncher, process.env.NEXT_PUBLIC_MARKET_QUOTE_LAUNCHER),
  zapRouter: pick(d.zapRouter, process.env.NEXT_PUBLIC_ZAP_ROUTER),
  chartGuardHook: pick(d.chartGuardHook, process.env.NEXT_PUBLIC_CHART_GUARD_HOOK),
  buybackTreasury: pick(d.buybackTreasury, process.env.NEXT_PUBLIC_BUYBACK_TREASURY),
  poolManager: pick(d.poolManager, process.env.NEXT_PUBLIC_POOL_MANAGER, "0x8366a39CC670B4001A1121B8F6A443A643e40951"),
  positionManager: pick(
    d.positionManager,
    process.env.NEXT_PUBLIC_POSITION_MANAGER,
    "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
  ),
  usdg: pick(d.usdg, process.env.NEXT_PUBLIC_USDG, "0x5fc5360D0400A0Fd4f2af552ADD042D716F1d168"),
  weth: pick(d.weth, process.env.NEXT_PUBLIC_WETH, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  v3Factory: pick(d.v3Factory, process.env.NEXT_PUBLIC_V3_FACTORY, "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA"),
} as const;

export const START_BLOCK: bigint = BigInt(
  (d.startBlock && Number(d.startBlock) > 0 ? d.startBlock : process.env.NEXT_PUBLIC_START_BLOCK) ?? 0,
);

export const DEPLOYED = ADDRESSES.factory !== ZERO;
export const isZero = (a?: string) => !a || a.toLowerCase() === ZERO;
export const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
