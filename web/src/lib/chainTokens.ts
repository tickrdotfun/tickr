import type { Address, Hex } from "viem";
import stocks from "@/data/stocks.json";
import { ADDRESSES as DEPLOYED_ADDRESSES, ZERO, isZero, sameAddr } from "@/lib/addresses";
import { IS_DEVNET } from "@/lib/chain";
import { serverClient as deployedClient } from "@/lib/serverClient";
import { createPublicClient, defineChain, http } from "viem";

/**
 * The preview deployment replays a recorded devnet, but its token list should still be the real chain's, so a
 * demo build on a devnet id reads Robinhood Chain directly with the canonical addresses.
 */
const DEMO = process.env.NEXT_PUBLIC_DEMO === "1";
const LIVE = {
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  usdg: "0x5fc5360D0400A0Fd4f2af552ADD042D716F1d168" as Address,
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address,
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
  marketQuoteLauncher: ZERO,
};
const liveChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const READ_LIVE = IS_DEVNET && DEMO;
const ADDRESSES = READ_LIVE ? LIVE : DEPLOYED_ADDRESSES;
const serverClient = READ_LIVE ? createPublicClient({ chain: liveChain, transport: http() }) : deployedClient;
import { poolManagerAbi, v3FactoryAbi, v3PoolAbi } from "@/lib/extraAbis";
import { MarketQuoteLauncherAbi } from "@/lib/abis";
import { poolIdOf, slot0Slot, sqrtPriceFromSlot0, tokenPriceInQuote } from "@/lib/pool";
import { erc20Abi } from "viem";
import deployments from "@/lib/deployments.json";

/**
 * Every token on the chain a coin can be priced in through the market quote launcher: an ERC-20 with a Uniswap v3
 * pool against WETH or USDG from the canonical factory, holding at least the launcher's floor of that counter.
 *
 * Candidates come from the explorer's token list, ordered by value. Eligibility and depth are read from the chain
 * with the same rule the contract applies, so what the list shows is what the launcher accepts. Figures and logos
 * come from DexScreener where it knows the token, the explorer otherwise. Five minute cache.
 */
export type ChainToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logo?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  holders?: number;
  /** the counter asset held by the pool the launcher will price from, and how much of it, in ETH */
  counter: "WETH" | "USDG";
  depthEth: number;
  pool: Address;
  fee: number;
  /** venues DexScreener lists for the token, deepest first, e.g. "V3 WETH" */
  venues: string[];
};

const EX = "https://robinhoodchain.blockscout.com/api/v2";
const H = { "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/120", Accept: "application/json" };
const FEES = [100, 500, 3000, 10000] as const;
const PAGES = 4; // fifty tokens a page

const DEFAULT_MIN_WETH = 5n * 10n ** 18n;
const DEFAULT_MIN_USDG = 15_000n * 10n ** 6n;

type ExplorerToken = { address_hash?: string; address?: string; name?: string; symbol?: string; decimals?: string; holders_count?: string | number; holders?: string | number; exchange_rate?: string | null; circulating_market_cap?: string | null; icon_url?: string | null };
type DexPair = { dexId: string; labels?: string[]; baseToken: { address: string; symbol: string }; quoteToken: { address: string; symbol: string }; priceUsd?: string; fdv?: number; marketCap?: number; liquidity?: { usd?: number; base?: number; quote?: number }; info?: { imageUrl?: string } };


async function j<T>(url: string, revalidate = 300): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: H, next: { revalidate } });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}
const num = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : Number(v));

export async function candidates(): Promise<{ address: Address; symbol: string; name: string; decimals: number; holders?: number; priceUsd?: number; marketCapUsd?: number; logo?: string }[]> {
  const out = [];
  let next: Record<string, unknown> | null = null;
  for (let page = 0; page < PAGES; page++) {
    const qs = new URLSearchParams({ type: "ERC-20" });
    if (next) for (const [k, v] of Object.entries(next)) qs.set(k, String(v));
    const d = await j<{ items?: ExplorerToken[]; next_page_params?: Record<string, unknown> | null }>(`${EX}/tokens?${qs}`);
    if (!d?.items) break;
    for (const t of d.items) {
      const address = (t.address_hash ?? t.address ?? "") as Address;
      const decimals = num(t.decimals);
      if (!/^0x[0-9a-fA-F]{40}$/.test(address) || decimals === undefined || decimals > 18 || !t.symbol) continue;
      out.push({ address, symbol: t.symbol, name: t.name ?? t.symbol, decimals, holders: num(t.holders_count ?? t.holders), priceUsd: num(t.exchange_rate), marketCapUsd: num(t.circulating_market_cap), logo: t.icon_url ?? undefined });
    }
    next = d.next_page_params ?? null;
    if (!next) break;
  }
  const official = new Set(stocks.assets.map((s) => s.address.toLowerCase()));
  return out.filter((t) => !sameAddr(t.address, ADDRESSES.usdg) && !sameAddr(t.address, ADDRESSES.weth) && !official.has(t.address.toLowerCase()) && !/Robinhood Token$/i.test(t.name));
}

export async function floors(): Promise<{ weth: bigint; usdg: bigint }> {
  if (isZero(ADDRESSES.marketQuoteLauncher)) return { weth: DEFAULT_MIN_WETH, usdg: DEFAULT_MIN_USDG };
  try {
    const [w, u] = await serverClient.multicall({
      contracts: [
        { abi: MarketQuoteLauncherAbi, address: ADDRESSES.marketQuoteLauncher, functionName: "minDepth", args: [ADDRESSES.weth] },
        { abi: MarketQuoteLauncherAbi, address: ADDRESSES.marketQuoteLauncher, functionName: "minDepth", args: [ADDRESSES.usdg] },
      ],
      allowFailure: false,
    });
    return { weth: w, usdg: u };
  } catch {
    return { weth: DEFAULT_MIN_WETH, usdg: DEFAULT_MIN_USDG };
  }
}

export async function ethUsd(): Promise<number> {
  try {
    const id = poolIdOf(ZERO, ADDRESSES.usdg, 100, 1, ZERO);
    const slot = await serverClient.readContract({ abi: poolManagerAbi, address: ADDRESSES.poolManager, functionName: "extsload", args: [slot0Slot(id)] });
    const sqrt = sqrtPriceFromSlot0(slot as Hex);
    return sqrt > 0n ? tokenPriceInQuote(sqrt, true, 18, 6) : 0;
  } catch (e) {
    lastStats.rpcError = e instanceof Error ? e.message.slice(0, 400) : String(e).slice(0, 400);
    return 0;
  }
}

/** Runs `f` over `items` in slices and concatenates the results, in order. */
async function chunked<T, R>(items: T[], size: number, f: (slice: T[]) => Promise<readonly R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await f(items.slice(i, i + size))));
  return out;
}

/**
 * When the launcher is deployed its own `bestMarket` view is the rule, in-range floor included, so the list is
 * exactly what the contract accepts. Before that, the balance rule below is the estimate.
 */
export async function marketsFromLauncher(cands: { address: Address }[], ethPrice: number) {
  const best = new Map<string, { counter: "WETH" | "USDG"; pool: Address; fee: number; depth: bigint; depthEth: number }>();
  const res = await chunked(cands, 60, (slice) =>
    serverClient.multicall({
      contracts: slice.map((c) => ({ abi: MarketQuoteLauncherAbi, address: ADDRESSES.marketQuoteLauncher, functionName: "bestMarket", args: [c.address] }) as const),
      allowFailure: true,
    }),
  );
  cands.forEach((c, i) => {
    const r = res[i];
    if (!r || r.status !== "success") return;
    const m = r.result as { pool: Address; counter: Address; fee: number; depth: bigint; inBand: bigint };
    const counter: "WETH" | "USDG" = sameAddr(m.counter, ADDRESSES.weth) ? "WETH" : "USDG";
    const depthEth = counter === "WETH" ? Number(m.inBand) / 1e18 : ethPrice > 0 ? Number(m.inBand) / 1e6 / ethPrice : 0;
    best.set(c.address.toLowerCase(), { counter, pool: m.pool, fee: Number(m.fee), depth: m.inBand, depthEth });
  });
  return best;
}

/** The pool the launcher would pick for each candidate: deepest WETH pool over the floor, else deepest USDG pool. */
export async function markets(cands: { address: Address }[], floor: { weth: bigint; usdg: bigint }, ethPrice: number) {
  const counters: { addr: Address; name: "WETH" | "USDG"; floor: bigint }[] = [
    { addr: ADDRESSES.weth, name: "WETH", floor: floor.weth },
    { addr: ADDRESSES.usdg, name: "USDG", floor: floor.usdg },
  ];
  const lookups = cands.flatMap((c) => counters.flatMap((k) => FEES.map((fee) => ({ token: c.address, counter: k, fee }))));
  // the node caps what one eth_call may do, so the lookups go in slices of a couple of hundred calls
  const pools = await chunked(lookups, 160, (slice) =>
    serverClient.multicall({
      contracts: slice.map((l) => ({ abi: v3FactoryAbi, address: ADDRESSES.v3Factory, functionName: "getPool", args: [l.token, l.counter.addr, l.fee] }) as const),
      allowFailure: true,
    }),
  );
  const live = lookups.map((l, i) => ({ ...l, pool: pools[i]?.status === "success" ? (pools[i].result as Address) : ZERO })).filter((l) => !isZero(l.pool));
  if (live.length === 0) return new Map<string, { counter: "WETH" | "USDG"; pool: Address; fee: number; depth: bigint; depthEth: number }>();
  const reads = await chunked(live, 80, (slice) =>
    serverClient.multicall({
      contracts: slice.flatMap((l) => [
        { abi: erc20Abi, address: l.counter.addr, functionName: "balanceOf", args: [l.pool] } as const,
        { abi: v3PoolAbi, address: l.pool, functionName: "liquidity" } as const,
      ]),
      allowFailure: true,
    }),
  );
  const best = new Map<string, { counter: "WETH" | "USDG"; pool: Address; fee: number; depth: bigint; depthEth: number }>();
  live.forEach((l, i) => {
    const bal = reads[i * 2]?.status === "success" ? (reads[i * 2].result as bigint) : 0n;
    const liq = reads[i * 2 + 1]?.status === "success" ? (reads[i * 2 + 1].result as bigint) : 0n;
    if (liq === 0n || bal < l.counter.floor) return;
    const key = l.token.toLowerCase();
    const cur = best.get(key);
    // a WETH market always beats a USDG one, like the contract; within a counter, the deeper pool wins
    if (cur) {
      if (cur.counter === "WETH" && l.counter.name === "USDG") return;
      if (cur.counter === l.counter.name && cur.depth >= bal) return;
    }
    const depthEth = l.counter.name === "WETH" ? Number(bal) / 1e18 : ethPrice > 0 ? Number(bal) / 1e6 / ethPrice : 0;
    best.set(key, { counter: l.counter.name, pool: l.pool, fee: l.fee, depth: bal, depthEth });
  });
  return best;
}

export async function dexscreener(addrs: Address[]): Promise<Map<string, DexPair[]>> {
  const out = new Map<string, DexPair[]>();
  for (let i = 0; i < addrs.length; i += 30) {
    const batch = addrs.slice(i, i + 30);
    const pairs = await j<DexPair[]>(`https://api.dexscreener.com/tokens/v1/robinhood/${batch.join(",")}`);
    for (const p of pairs ?? []) {
      for (const side of [p.baseToken.address, p.quoteToken.address]) {
        const k = side.toLowerCase();
        if (!batch.some((a) => a.toLowerCase() === k)) continue;
        out.set(k, [...(out.get(k) ?? []), p]);
      }
    }
  }
  return out;
}

export type ChainTokenStats = { candidates: number; markets: number; eligible: number; ethUsd: number; readLive: boolean; ms: number; error?: string; rpcError?: string; rpc?: string };
export const lastStats: ChainTokenStats = { candidates: 0, markets: 0, eligible: 0, ethUsd: 0, readLive: READ_LIVE, ms: 0 };

/** On a devnet there is no explorer: the candidates are the demo tokens the devnet script deployed. */
async function devnetCandidates(): Promise<Awaited<ReturnType<typeof candidates>>> {
  const demo = (deployments as { demoMoon?: string }).demoMoon;
  if (!demo || !/^0x[0-9a-fA-F]{40}$/.test(demo) || isZero(demo as Address)) return [];
  try {
    const [name, symbol, decimals] = await serverClient.multicall({
      contracts: [
        { abi: erc20Abi, address: demo as Address, functionName: "name" },
        { abi: erc20Abi, address: demo as Address, functionName: "symbol" },
        { abi: erc20Abi, address: demo as Address, functionName: "decimals" },
      ],
      allowFailure: false,
    });
    return [{ address: demo as Address, symbol, name, decimals }];
  } catch {
    return [];
  }
}

export async function buildChainTokens(): Promise<ChainToken[]> {
  const t0 = Date.now();
  // the mode is off when the launcher is not in the record; the list is then empty, and the site hides the tab
  if (isZero(DEPLOYED_ADDRESSES.marketQuoteLauncher) && !READ_LIVE) return [];
  const devnet = IS_DEVNET && !DEMO;
  const [cands, floor, ethPrice] = await Promise.all([devnet ? devnetCandidates() : candidates(), floors(), ethUsd()]);
  lastStats.candidates = cands.length;
  lastStats.rpc = serverClient.chain?.rpcUrls.default.http[0] ?? "none";
  lastStats.ethUsd = ethPrice;
  if (cands.length === 0 || isZero(ADDRESSES.v3Factory)) return [];
  const best = isZero(ADDRESSES.marketQuoteLauncher) ? await markets(cands, floor, ethPrice) : await marketsFromLauncher(cands, ethPrice);
  lastStats.markets = best.size;
  const eligible = cands.filter((c) => best.has(c.address.toLowerCase()));
  lastStats.eligible = eligible.length;
  lastStats.ms = Date.now() - t0;
  const dex = devnet ? new Map<string, DexPair[]>() : await dexscreener(eligible.map((c) => c.address));
  const rows: ChainToken[] = eligible.map((c) => {
    const m = best.get(c.address.toLowerCase())!;
    const pairs = (dex.get(c.address.toLowerCase()) ?? []).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const top = pairs[0];
    const mine = (p: DexPair) => (sameAddr(p.baseToken.address as Address, c.address) ? p.quoteToken.symbol : p.baseToken.symbol);
    const venues = pairs.filter((p) => p.dexId === "uniswap").map((p) => `${(p.labels?.[0] ?? "").toUpperCase()} ${mine(p)}`.trim());
    return {
      address: c.address,
      symbol: c.symbol,
      name: c.name,
      decimals: c.decimals,
      logo: top?.info?.imageUrl ?? c.logo,
      priceUsd: top?.priceUsd !== undefined ? Number(top.priceUsd) : c.priceUsd,
      marketCapUsd: top?.marketCap ?? top?.fdv ?? c.marketCapUsd,
      holders: c.holders,
      counter: m.counter,
      depthEth: m.depthEth,
      pool: m.pool,
      fee: m.fee,
      venues: [...new Set(venues)].slice(0, 3),
    };
  });
  return rows.sort((a, b) => b.depthEth - a.depthEth);
}

