/**
 * The "any token" list, built on a schedule.
 *
 * The site's create page offers every token on Robinhood Chain that a launch can be priced in: an ERC-20 with a
 * Uniswap v3 pool against WETH or USDG deep enough for `MarketQuoteLauncher` to accept it. Working that out takes
 * a Blockscout crawl and a few hundred chain reads, which is far too much for a visitor's request. So this Worker
 * does it every fifteen minutes and writes the answer to KV under `chain-tokens`; the site reads that one key.
 *
 * It holds no keys and signs nothing. Everything it reads is public.
 */
import { createPublicClient, encodeFunctionData, erc20Abi, getAddress, http, keccak256, parseAbi, type Address, type PublicClient } from "viem";

/** Addresses arrive from configuration, where the checksum casing may be anything. */
const addr = (a: string): Address => getAddress(a.toLowerCase());

import { verifyNewLaunches, explorerStatus, explorerSubmit, lastExplorerNote } from "./verify";
import { gasWithHeadroom, afterResolve, acquire, record, clear, release, noteRun, runOutcome, balanceWarning, type Pending, type LockState, type RunHistory, type WorkOutcome } from "./keeper-policy";

type Env = {
  TICKR_KV: KVNamespace;
  KEEPER_KEY?: string;
  RPC_ENDPOINT?: string;
  KEEPER_LOCKER?: string;
  KEEPER_TREASURY?: string;
  KEEPER_COIN?: string;
  KEEPER_NAME?: string;
  /** the v2 coin the keeper also serves: its pool's fees, its name converted by the v2 treasury, that treasury's buys */
  KEEPER_V2_COIN?: string;
  KEEPER_V2_NAME?: string;
  KEEPER_V2_TREASURY?: string;
  KEEPER_ESCROW?: string;
  /** the HOLY treasury: the v2 coin's own buy-and-burn, fed by its creator share and by future launches' protocol share */
  KEEPER_HOLY_TREASURY?: string;
  PIN_COUNTER: DurableObjectNamespace;
  BUDGET_KEY?: string;
  RPC_URL: string;
  EXPLORER: string;
  WETH: string;
  USDG: string;
  V3_FACTORY: string;
  POOL_MANAGER: string;
  MULTICALL3: string;
  MARKET_QUOTE_LAUNCHER: string;
  FACTORY?: string;
  MARKET_DEPLOYER?: string;
  TICKER_LAUNCHER?: string;
  BLOCKSCOUT_KEY?: string;
  REFRESH_KEY?: string;
};

export type ChainToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logo?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  holders?: number;
  counter: "WETH" | "USDG";
  depthEth: number;
  pool: Address;
  fee: number;
  venues: string[];
};

import { ethUsdgSlot0Slot } from "./slot";

const KEY = "chain-tokens";
const FEES = [100, 500, 3000, 10000] as const;
const PAGES = 3;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const marketAbi = parseAbi([
  "struct Market { address pool; address counter; uint24 fee; uint256 depth; uint256 inBand; }",
  "function bestMarket(address quote) view returns (Market)",
  "function minDepth(address counter) view returns (uint256)",
]);
const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const v3PoolAbi = parseAbi(["function liquidity() view returns (uint128)"]);
const poolManagerAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

const H = { "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/120", Accept: "application/json" };
const CANDIDATES_KEY = "candidates";
const CANDIDATES_TTL_MS = 6 * 60 * 60_000;
const POOLS_KEY = "pools";
const POOLS_TTL_MS = 24 * 60 * 60_000;
const RATE_KEY = "eth-usd";
const RATE_TTL_MS = 60 * 60_000;
/** Below this there is no chance of five WETH in a pool, so there is no reason to ask about the token. */
const MIN_MARKET_CAP_USD = 250_000;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : Number(v));
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

type ExplorerToken = { address_hash?: string; address?: string; name?: string; symbol?: string; decimals?: string; holders_count?: string | number; holders?: string | number; exchange_rate?: string | null; circulating_market_cap?: string | null; icon_url?: string | null };
type Pool = { pool: Address; counter: "WETH" | "USDG"; fee: number };
type Candidate = { address: Address; symbol: string; name: string; decimals: number; holders?: number; priceUsd?: number; marketCapUsd?: number; logo?: string };
type Market = { counter: "WETH" | "USDG"; pool: Address; fee: number; depth: bigint; depthEth: number };

let lastFetchNote = "";
async function j<T>(url: string, key?: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: key ? { ...H, "x-api-key": key } : H });
    if (!r.ok) {
      lastFetchNote = `${new URL(url).host} ${r.status}: ${(await r.text()).slice(0, 120)}`;
      return null;
    }
    return (await r.json()) as T;
  } catch (e) {
    lastFetchNote = `${new URL(url).host} threw: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}`;
    return null;
  }
}

/** Every ERC-20 the explorer knows, richest first, minus the assets that have their own launch path. */
async function candidates(env: Env, stocks: Set<string>): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let next: Record<string, unknown> | null = null;
  for (let page = 0; page < PAGES; page++) {
    const qs = new URLSearchParams({ type: "ERC-20" });
    if (next) for (const [k, v] of Object.entries(next)) qs.set(k, String(v));
    const d = await j<{ items?: ExplorerToken[]; next_page_params?: Record<string, unknown> | null }>(`${env.EXPLORER}/tokens?${qs}`, env.BLOCKSCOUT_KEY);
    if (!d?.items) break;
    for (const t of d.items) {
      const address = (t.address_hash ?? t.address ?? "") as Address;
      const decimals = num(t.decimals);
      if (!/^0x[0-9a-fA-F]{40}$/.test(address) || decimals === undefined || decimals > 18 || decimals < 6 || !t.symbol) continue;
      if (same(address, env.USDG) || same(address, env.WETH) || stocks.has(address.toLowerCase())) continue;
      if (/Robinhood Token$/i.test(t.name ?? "")) continue;
      out.push({ address, symbol: t.symbol, name: t.name ?? t.symbol, decimals, holders: num(t.holders_count ?? t.holders), priceUsd: num(t.exchange_rate), marketCapUsd: num(t.circulating_market_cap), logo: t.icon_url ?? undefined });
    }
    next = d.next_page_params ?? null;
    if (!next) break;
  }
  return out;
}

async function chunked<T, R>(items: T[], size: number, f: (slice: T[]) => Promise<readonly R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await f(items.slice(i, i + size))));
  return out;
}

/** The launcher's own rule when it is deployed: `bestMarket` reverts unless the token qualifies. */
async function marketsFromLauncher(client: PublicClient, env: Env, cands: Candidate[], ethUsd: number) {
  const best = new Map<string, Market>();
  const res = await chunked(cands, 40, (slice) =>
    client.multicall({
      contracts: slice.map((c) => ({ abi: marketAbi, address: addr(env.MARKET_QUOTE_LAUNCHER), functionName: "bestMarket", args: [c.address] }) as const),
      allowFailure: true,
      multicallAddress: addr(env.MULTICALL3),
    }),
  );
  cands.forEach((c, i) => {
    const r = res[i];
    if (!r || r.status !== "success") return;
    const m = r.result as { pool: Address; counter: Address; fee: number; depth: bigint; inBand: bigint };
    const counter: "WETH" | "USDG" = same(m.counter, env.WETH) ? "WETH" : "USDG";
    const depthEth = counter === "WETH" ? Number(m.inBand) / 1e18 : ethUsd > 0 ? Number(m.inBand) / 1e6 / ethUsd : 0;
    best.set(c.address.toLowerCase(), { counter, pool: m.pool, fee: Number(m.fee), depth: m.inBand, depthEth });
  });
  return best;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The pools each token has against WETH or USDG, from the canonical v3 factory. Pools do not appear or vanish
 * often, so the answer is cached for a day and a run only asks about tokens it has not seen. Everything is
 * chunked and paced: the chain's public node rate limits a burst from shared address space.
 */
async function poolsOf(client: PublicClient, env: Env, cands: Candidate[]): Promise<Map<string, Pool[]>> {
  const cached = JSON.parse((await env.TICKR_KV.get(POOLS_KEY)) ?? "{}") as Record<string, { at: number; pools: Pool[] }>;
  const now = Date.now();
  const unseen = cands.filter((c) => now - (cached[c.address.toLowerCase()]?.at ?? 0) > POOLS_TTL_MS);
  const counters = [
    { addr: addr(env.WETH), name: "WETH" as const },
    { addr: addr(env.USDG), name: "USDG" as const },
  ];
  const lookups = unseen.flatMap((c) => counters.flatMap((k) => FEES.map((fee) => ({ token: c.address, counter: k, fee }))));
  for (let i = 0; i < lookups.length; i += 50) {
    if (i > 0) await sleep(400);
    const slice = lookups.slice(i, i + 50);
    let res;
    try {
      res = await client.multicall({
        contracts: slice.map((l) => ({ abi: v3FactoryAbi, address: addr(env.V3_FACTORY), functionName: "getPool", args: [l.token, l.counter.addr, l.fee] }) as const),
        allowFailure: true,
        multicallAddress: addr(env.MULTICALL3),
      });
    } catch (e) {
      lastFetchNote = `pool scan: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`;
      break; // whatever was learned is kept; the next run picks up the rest
    }
    slice.forEach((l, k) => {
      const r = res![k];
      const key = l.token.toLowerCase();
      const entry = (cached[key] ??= { at: now, pools: [] });
      entry.at = now;
      if (r?.status !== "success") return;
      const pool = r.result as Address;
      if (pool === ZERO) return;
      if (!entry.pools.some((p) => same(p.pool, pool))) entry.pools.push({ pool, counter: l.counter.name, fee: l.fee });
    });
  }
  await env.TICKR_KV.put(POOLS_KEY, JSON.stringify(cached));
  const out = new Map<string, Pool[]>();
  for (const c of cands) {
    const e = cached[c.address.toLowerCase()];
    if (e?.pools.length) out.set(c.address.toLowerCase(), e.pools);
  }
  return out;
}

/** What each of those pools holds of its counter asset right now, and whether it has liquidity at all. */
async function marketsFromChain(client: PublicClient, env: Env, pools: Map<string, Pool[]>, ethUsd: number): Promise<Map<string, Market>> {
  const weth = addr(env.WETH);
  const usdg = addr(env.USDG);
  const floors = { WETH: 5n * 10n ** 18n, USDG: 15_000n * 10n ** 6n };
  const flat = [...pools.entries()].flatMap(([token, ps]) => ps.map((p) => ({ token, ...p })));
  const best = new Map<string, Market>();
  for (let i = 0; i < flat.length; i += 25) {
    if (i > 0) await sleep(400);
    const slice = flat.slice(i, i + 25);
    let res;
    try {
      res = await client.multicall({
        contracts: slice.flatMap((l) => [
          { abi: erc20Abi, address: l.counter === "WETH" ? weth : usdg, functionName: "balanceOf", args: [l.pool] } as const,
          { abi: v3PoolAbi, address: l.pool, functionName: "liquidity" } as const,
        ]),
        allowFailure: true,
        multicallAddress: addr(env.MULTICALL3),
      });
    } catch (e) {
      lastFetchNote = `pool reads: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`;
      break;
    }
    slice.forEach((l, k) => {
      const bal = res![k * 2]?.status === "success" ? (res![k * 2].result as bigint) : 0n;
      const liq = res![k * 2 + 1]?.status === "success" ? (res![k * 2 + 1].result as bigint) : 0n;
      if (liq === 0n || bal < floors[l.counter]) return;
      const cur = best.get(l.token);
      if (cur) {
        if (cur.counter === "WETH" && l.counter === "USDG") return;
        if (cur.counter === l.counter && cur.depth >= bal) return;
      }
      const depthEth = l.counter === "WETH" ? Number(bal) / 1e18 : ethUsd > 0 ? Number(bal) / 1e6 / ethUsd : 0;
      best.set(l.token, { counter: l.counter, pool: l.pool, fee: l.fee, depth: bal, depthEth });
    });
  }
  return best;
}

/** Dollars per ETH from the canonical ETH/USDG v4 pool, for the depth figures. */
async function ethUsdRate(client: PublicClient, env: Env, slot: `0x${string}`): Promise<number> {
  try {
    const word = await client.readContract({ abi: poolManagerAbi, address: addr(env.POOL_MANAGER), functionName: "extsload", args: [slot] });
    const sqrt = BigInt(word as string) & ((1n << 160n) - 1n);
    if (sqrt === 0n) return 0;
    // price of currency1 (USDG, 6 decimals) per currency0 (ETH, 18): (sqrt / 2^96)^2, scaled
    const n = Number(sqrt) / 2 ** 96;
    return n * n * 10 ** 12;
  } catch (e) {
    lastFetchNote = `rpc: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`;
    return 0;
  }
}

async function build(env: Env): Promise<{ tokens: ChainToken[]; stats: Record<string, unknown> }> {
  const t0 = Date.now();
  const client = createPublicClient({ transport: http(env.RPC_URL, { retryCount: 5, retryDelay: 400, timeout: 20_000 }) }) as PublicClient;
  const stocksJson = await j<{ assets?: { address: string }[] }>(`${env.EXPLORER}/tokens?type=ERC-20&q=Robinhood`, env.BLOCKSCOUT_KEY);
  const stocks = new Set((stocksJson?.assets ?? []).map((s) => s.address.toLowerCase()));
  // the explorer rate limits shared address space, so a good candidate list is kept for six hours and a
  // throttled crawl falls back to it rather than emptying the run
  let cands = await candidates(env, stocks);
  const cachedCands = await env.TICKR_KV.get(CANDIDATES_KEY);
  if (cands.length === 0 && cachedCands) {
    const c = JSON.parse(cachedCands) as { at: number; list: Candidate[] };
    if (Date.now() - c.at < CANDIDATES_TTL_MS) cands = c.list;
  } else if (cands.length > 0) {
    await env.TICKR_KV.put(CANDIDATES_KEY, JSON.stringify({ at: Date.now(), list: cands }));
  }
  const slot = ethUsdgSlot0Slot(addr(env.USDG));
  let rate = await ethUsdRate(client, env, slot);
  const cachedRate = await env.TICKR_KV.get(RATE_KEY);
  if (rate > 0) await env.TICKR_KV.put(RATE_KEY, JSON.stringify({ at: Date.now(), rate }));
  else if (cachedRate) {
    const r = JSON.parse(cachedRate) as { at: number; rate: number };
    if (Date.now() - r.at < RATE_TTL_MS) rate = r.rate;
  }
  const useLauncher = /^0x[0-9a-fA-F]{40}$/.test(env.MARKET_QUOTE_LAUNCHER) && env.MARKET_QUOTE_LAUNCHER.toLowerCase() !== ZERO;
  // one pass over DexScreener names every pool worth checking, and carries the figures the site shows
  const worth = cands.filter((c) => (c.marketCapUsd ?? 0) >= MIN_MARKET_CAP_USD);
  const pools = await poolsOf(client, env, worth);
  const best = useLauncher ? await marketsFromLauncher(client, env, worth, rate) : await marketsFromChain(client, env, pools, rate);
  const eligible = worth.filter((c) => best.has(c.address.toLowerCase()));
  const tokens: ChainToken[] = eligible.map((c) => {
    const m = best.get(c.address.toLowerCase())!;
    const venues = (pools.get(c.address.toLowerCase()) ?? []).map((p) => `V3 ${p.counter}`);
    return {
      address: c.address,
      symbol: c.symbol,
      name: c.name,
      decimals: c.decimals,
      logo: c.logo,
      priceUsd: c.priceUsd,
      marketCapUsd: c.marketCapUsd,
      holders: c.holders,
      counter: m.counter,
      depthEth: m.depthEth,
      pool: m.pool,
      fee: m.fee,
      venues: [...new Set(venues)].slice(0, 3),
    };
  });
  tokens.sort((a, b) => b.depthEth - a.depthEth);
  return { tokens, stats: { candidates: cands.length, asked: worth.length, eligible: tokens.length, ethUsd: rate, source: useLauncher ? "launcher" : "pools", ms: Date.now() - t0, note: lastFetchNote } };
}

/**
 * A run that comes back empty is a bad day upstream, not an empty chain: the stored list stays as it was, and
 * the site keeps showing what it showed. Only a run that found something replaces it.
 */
/**
 * Source verification for every launch, on the same cron as the token list. The chain is read through viem with
 * the four views it needs; Sourcify is reached with the worker's fetch; progress lives in KV. See verify.ts.
 */
async function verifyLaunches(env: Env): Promise<string> {
  if (!env.FACTORY || !env.MARKET_DEPLOYER || !env.TICKER_LAUNCHER) return "verify: not configured";
  // the keeper's node when there is one: the public node rate-limits requests from this network, and a pass that
  // cannot read the launch list has nothing to do. Either way a failure is a line in the log, never a thrown run
  const client = createPublicClient({ transport: http(env.RPC_ENDPOINT || env.RPC_URL, { retryCount: 3, retryDelay: 600, timeout: 20_000 }) });
  const factory = addr(env.FACTORY), market = addr(env.MARKET_DEPLOYER), launcher = addr(env.TICKER_LAUNCHER);
  const FACTORY_ABI = [
    { type: "function", name: "launchCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "launchAt", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
    { type: "function", name: "getLaunchedToken", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [
      { name: "token", type: "address" }, { name: "deployer", type: "address" }, { name: "creatorFeeRecipient", type: "address" }, { name: "pairToken", type: "address" },
      { name: "phantomQuote", type: "uint256" }, { name: "poolFee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" }, { name: "lpTokenId", type: "uint256" }, { name: "creatorTaxBps", type: "uint16" }, { name: "buybackEnabled", type: "bool" }, { name: "launchedAt", type: "uint64" }, { name: "exists", type: "bool" } ] }] },
  ] as const;
  // Market's first field is the token, and every field of the struct is static, so one word is enough to read it
  const MARKET_ABI = [{ type: "function", name: "market", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [{ name: "token", type: "address" }] }] }] as const;
  const LAUNCHER_ABI = [{ type: "function", name: "pairCount", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
  const chain = {
    launchCount: async () => Number(await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "launchCount" })),
    launchAt: async (i: number) => client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "launchAt", args: [BigInt(i)] }) as Promise<string>,
    pairOf: async (coin: string) => (await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [addr(coin)] })).pairToken as string,
    isMarketName: async (name: string) => {
      try {
        const m = await client.readContract({ address: market, abi: MARKET_ABI, functionName: "market", args: [addr(name)] });
        return m.token.toLowerCase() === name.toLowerCase();
      } catch { return false; }
    },
    isManagedName: async (name: string) => {
      try { return (await client.readContract({ address: launcher, abi: LAUNCHER_ABI, functionName: "pairCount", args: [addr(name)] })) > 0n; } catch { return false; }
    },
  };
  const kv = { get: (k: string) => env.TICKR_KV.get(k), put: (k: string, v: string) => env.TICKR_KV.put(k, v) };
  try {
    const r = await verifyNewLaunches({ chain, kv, fetch: fetch.bind(globalThis), log: (m) => console.log(m), explorerKey: env.BLOCKSCOUT_KEY });
    return `verify: checked ${r.checked}, verified ${r.verified.length}, retry ${r.retry.length}`;
  } catch (e) {
    return `verify: did not run (${(e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message?.slice(0, 160)})`;
  }
}

async function refresh(env: Env) {
  const out = await build(env);
  if (out.tokens.length > 0) {
    await env.TICKR_KV.put(KEY, JSON.stringify({ ...out, at: Date.now() }));
    return { ...out, stored: true, keeping: out.tokens.length };
  }
  const kept = await env.TICKR_KV.get(KEY);
  return { ...out, stored: false, keeping: kept ? (JSON.parse(kept) as { tokens: unknown[] }).tokens.length : 0 };
}

/**
 * Upload accounting for the site's image pinning: shared counters per address, per signed-in wallet, for everyone
 * and per day (the hard spending budget), a memory of pinned files by hash so the same bytes are never pinned twice,
 * and a stats view. Everything behind BUDGET_KEY. Each counter is one Durable Object, single-threaded, so twenty
 * requests at once cannot each see "zero" the way a read-then-write in KV can; it keeps counts in buckets (a minute
 * for hour windows, an hour for the day window), which stays small however busy the site gets.
 */
export const PIN_LIMITS = {
  ip: { limit: 30, windowMs: 3_600_000 },
  wallet: { limit: 30, windowMs: 3_600_000 },
  everyone: { limit: 2_000, windowMs: 3_600_000 },
  day: { limit: 10_000, windowMs: 86_400_000 },
} as const;
type Rule = { limit: number; windowMs: number };
type Counted = { allowed: boolean; count: number; limit: number };
export class PinCounter {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // the keeper's lease and its pending write live here rather than in KV: KV is eventually consistent, so two
    // runs starting together can both read "no lease" and both proceed. A durable object answers one request at
    // a time, which is what makes the check and the set a single indivisible step.
    if (url.pathname.startsWith("/keeper")) return this.keeper(url, req);
    const limit = Number(url.searchParams.get("limit") ?? "30");
    const windowMs = Number(url.searchParams.get("window") ?? "3600000");
    const peek = url.searchParams.get("peek") === "1";
    const bucketMs = windowMs >= 86_400_000 ? 3_600_000 : 60_000;
    const now = Date.now();
    const kept: Record<string, number> = {};
    for (const [k, v] of Object.entries((await this.state.storage.get<Record<string, number>>("buckets")) ?? {})) if (now - Number(k) < windowMs) kept[k] = v;
    const count = Object.values(kept).reduce((a, b) => a + b, 0);
    const allowed = count < limit;
    if (allowed && !peek) {
      const b = String(now - (now % bucketMs));
      kept[b] = (kept[b] ?? 0) + 1;
      await this.state.storage.put("buckets", kept);
    }
    return Response.json({ allowed, count: allowed && !peek ? count + 1 : count, limit });
  }

  async keeper(url: URL, req: Request): Promise<Response> {
    const op = url.searchParams.get("op");
    const token = url.searchParams.get("token") ?? "";

    // The body is drained BEFORE the state is read, and nothing is awaited between the read and the write.
    //
    // Reading a request body is inbound I/O and can take arbitrarily long; awaiting it after loading the state
    // leaves a window in which another run can take the lease over. The ownership check would then run against
    // a snapshot in which this run still held it, and a stale run's write would be accepted. Storage calls are
    // gated by the object, so read → decide → put is indivisible; the body is the one await that is not.
    const body = op === "record" ? ((await req.json()) as Pending) : undefined;

    const state = ((await this.state.storage.get<LockState>("keeper")) ?? {}) as LockState;
    if (op === "acquire") {
      const a = acquire(state, Date.now(), Number(url.searchParams.get("lease") ?? 300_000), token);
      if (!a.ok) return Response.json({ ok: false, reason: a.reason });
      await this.state.storage.put("keeper", a.state);
      return Response.json({ ok: true, token: a.token, resolveFirst: a.resolveFirst ?? null });
    }
    if (op === "record") {
      if (!body) return Response.json({ ok: false, reason: "no write was supplied" });
      const r = record(state, body, token);
      if (!r.ok) return Response.json({ ok: false, reason: r.reason });
      await this.state.storage.put("keeper", r.state);
      return Response.json({ ok: true });
    }
    if (op === "clear") {
      const c = clear(state, url.searchParams.get("hash") ?? "", token);
      if (!c.ok) return Response.json({ ok: false, reason: c.reason });
      await this.state.storage.put("keeper", c.state);
      return Response.json({ ok: true });
    }
    if (op === "release") {
      const r = release(state, token);
      if (!r.ok) return Response.json({ ok: false, reason: r.reason });
      await this.state.storage.put("keeper", r.state);
      return Response.json({ ok: true });
    }
    if (op === "peek") return Response.json({ ok: true, state });
    return Response.json({ ok: false, reason: "unknown op" }, { status: 400 });
  }
}
async function counted(env: Env, name: string, rule: Rule, peek = false): Promise<Counted> {
  const stub = env.PIN_COUNTER.get(env.PIN_COUNTER.idFromName(name));
  return (await stub.fetch(new Request(`https://count/?limit=${rule.limit}&window=${rule.windowMs}${peek ? "&peek=1" : ""}`))).json() as Promise<Counted>;
}
async function pinRoutes(url: URL, req: Request, env: Env): Promise<Response> {
  // the secret travels in a header, never in the URL, so it cannot end up in a request log
  if (!env.BUDGET_KEY || req.headers.get("x-budget-key") !== env.BUDGET_KEY) return new Response("not found", { status: 404 });
  if (url.pathname === "/budget" && req.method === "POST") {
    const { ip, wallet } = (await req.json().catch(() => ({}))) as { ip?: string; wallet?: string };
    const order: [string, string, Rule][] = [["ip", `ip:${ip ?? "unknown"}`, PIN_LIMITS.ip]];
    if (wallet) order.push(["wallet", `wallet:${wallet.toLowerCase()}`, PIN_LIMITS.wallet]);
    order.push(["everyone", "everyone", PIN_LIMITS.everyone], ["day", "day", PIN_LIMITS.day]);
    const counts: Record<string, Counted> = {};
    for (const [key, name, rule] of order) {
      const c = await counted(env, name, rule);
      counts[key] = c;
      if (!c.allowed) {
        console.log(JSON.stringify({ pin: "refused", by: key, count: c.count, limit: c.limit }));
        return Response.json({ allowed: false, by: key, counts });
      }
    }
    return Response.json({ allowed: true, counts });
  }
  if (url.pathname === "/pin-seen") {
    const hash = url.searchParams.get("hash") ?? "";
    if (!/^[0-9a-f]{64}$/.test(hash)) return Response.json({});
    const image = await env.TICKR_KV.get(`pin:${hash}`);
    return Response.json(image ? { image } : {});
  }
  if (url.pathname === "/pin-record" && req.method === "POST") {
    const { hash, image } = (await req.json().catch(() => ({}))) as { hash?: string; image?: string };
    if (!hash || !/^[0-9a-f]{64}$/.test(hash) || !image || !image.startsWith("ipfs://") || image.length > 200) return Response.json({ ok: false });
    await env.TICKR_KV.put(`pin:${hash}`, image, { expirationTtl: 30 * 86_400 });
    return Response.json({ ok: true });
  }
  if (url.pathname === "/pin-stats") {
    return Response.json({ everyone: await counted(env, "everyone", PIN_LIMITS.everyone, true), day: await counted(env, "day", PIN_LIMITS.day, true), limits: PIN_LIMITS });
  }
  return new Response("not found", { status: 404 });
}


/**
 * The keeper: the permissionless housekeeping of the official coin, every ten minutes. Collect the pool's fees
 * (the protocol's and the club's coin-side shares burn in that call), let the treasury collect and convert its
 * cut, then let it buy and burn with the dollars it set aside. Anyone may call these; a small funded key does it
 * on a schedule so nobody has to. Every step is its own transaction and a failing one never blocks the next.
 */
const LOCKER_ABI = [{ type: "function", name: "collectFees", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "pendingFees", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }] }] as const;
const TREASURY_ABI = [{ type: "function", name: "collect", stateMutability: "nonpayable", inputs: [{ name: "tokens", type: "address[]" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "buy", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "nextBuyAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "earmarkedUsdg", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
/** the v2 treasury: a market name converts under terms the caller offers, which the policy floor bounds from below */
const TERMS = { type: "tuple", components: [{ name: "minOutPerInX96", type: "uint256" }, { name: "deadline", type: "uint256" }] } as const;
const TREASURY_V2_ABI = [
  { type: "function", name: "collect", stateMutability: "nonpayable", inputs: [{ name: "tokens", type: "address[]" }, { ...TERMS, name: "terms", type: "tuple[]" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "buy", stateMutability: "nonpayable", inputs: [{ ...TERMS, name: "offered" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "nextBuyAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "earmarkedUsdg", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "defaultMinRateToCounterX96", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "minRateToCounterX96", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "defaultMinRateFromCounterX96", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "minRateFromCounterX96", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const TREASURY_HOLY_ABI = [
  ...TREASURY_V2_ABI,
  { type: "function", name: "burnCoin", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pendingCoin", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pendingShareBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "shareEffectiveAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "applyBuybackShare", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;
const ESCROW_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOfToken", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const ERC20_BALANCE_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
/**
 * The transaction from `who` that used `nonce`, and what it did.
 *
 * There is no way to ask a node "which transaction had this nonce", so it has to be found. A linear walk back
 * from the head is the obvious way and the wrong one here: reconciliation happens on the *next* scheduled run,
 * ten minutes later, and at roughly a tenth of a second per block that is about six thousand blocks ago. A
 * window of a couple of hundred blocks covers twenty seconds and would therefore never find anything, leaving
 * the keeper permanently blocked for a reason that sounded like caution but was arithmetic.
 *
 * Instead: `getTransactionCount` at a past block says how many transactions the account had sent by then, which
 * is monotonic, so the block that consumed a given nonce can be found by bisection in about fifteen calls
 * however far back it is. Only that one block is then fetched in full.
 */
async function findByNonce(
  pub: {
    getTransactionCount: (a: { address: `0x${string}`; blockNumber: bigint }) => Promise<number>;
    getBlock: (a: { blockNumber: bigint; includeTransactions: true }) => Promise<{ transactions: { from: string; nonce: number; hash: `0x${string}` }[] }>;
    getTransactionReceipt: (a: { hash: `0x${string}` }) => Promise<{ status: "success" | "reverted" }>;
  },
  who: `0x${string}`,
  nonce: number,
  head: bigint,
  lookback = 60_000n,
): Promise<{ hash: `0x${string}`; status: "success" | "reverted" } | undefined> {
  let lo = head > lookback ? head - lookback : 0n;
  let hi = head;
  // the account must already have been past this nonce by `hi`, and not yet past it at `lo`
  const atLo = await pub.getTransactionCount({ address: who, blockNumber: lo }).catch(() => undefined);
  if (atLo === undefined || atLo > nonce) return undefined; // consumed before the window: not ours to guess at
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    const count = await pub.getTransactionCount({ address: who, blockNumber: mid }).catch(() => undefined);
    if (count === undefined) return undefined;
    if (count > nonce) hi = mid;
    else lo = mid + 1n;
  }
  const block = await pub.getBlock({ blockNumber: lo, includeTransactions: true }).catch(() => undefined);
  if (!block) return undefined;
  const hit = block.transactions.find((t) => t.from?.toLowerCase() === who.toLowerCase() && t.nonce === nonce);
  if (!hit) return undefined;
  const rc = await pub.getTransactionReceipt({ hash: hit.hash }).catch(() => undefined);
  return rc ? { hash: hit.hash, status: rc.status } : undefined;
}

async function keep(env: Env): Promise<string[]> {
  const out: string[] = [];
  if (!env.KEEPER_KEY || !env.KEEPER_LOCKER || !env.KEEPER_TREASURY || !env.KEEPER_COIN || !env.KEEPER_NAME) return ["keeper: not configured"];
  const { createWalletClient, createPublicClient, custom, defineChain } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL] } } });
  const account = privateKeyToAccount(env.KEEPER_KEY as `0x${string}`);
  // the public node rate-limits a burst from the shared addresses workers send from: one request at a time, a gap
  // between them, a pause and a retry on a refusal
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;
  const rpc = async (method: string, params: unknown, attempt = 0): Promise<unknown> => {
    // the fast endpoint where one is configured, the chain's public node otherwise
    const url = env.RPC_ENDPOINT || env.RPC_URL;
    // A broadcast is never retried. Re-sending the identical signed payload cannot execute twice, but a send
    // whose answer never arrived may still be in flight, and the keeper cannot tell that from one that was
    // refused. Reads are safe to repeat; this one is left for the next run to observe.
    const isBroadcast = method === "eth_sendRawTransaction";
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    if (r.status === 429 || r.status >= 500) {
      if (!isBroadcast && attempt < 5) {
        await sleep(800 * (attempt + 1));
        return rpc(method, params, attempt + 1);
      }
      throw new Error(`rpc ${r.status}`);
    }
    const j = (await r.json()) as { result?: unknown; error?: { message?: string; code?: number } };
    if (j.error) {
      // the node also answers a rate limit as a JSON error inside an HTTP 200 ("Rate Limit Hit, limit will reset
      // in 60 seconds"); that is worth waiting out, a few times, before giving the step up
      if (!isBroadcast && (j.error.code === 429 || /rate limit/i.test(j.error.message ?? "")) && attempt < 4) {
        await sleep(15_000 * (attempt + 1));
        return rpc(method, params, attempt + 1);
      }
      throw Object.assign(new Error(j.error.message ?? "rpc error"), { code: j.error.code });
    }
    return j.result;
  };
  const paced = custom({
    request: ({ method, params }: { method: string; params?: unknown }) => {
      const next = queue.then(async () => {
        const wait = last + 120 - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        return rpc(method, params ?? []);
      });
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
  });
  const wallet = createWalletClient({ account, chain, transport: paced });
  const pub = createPublicClient({ chain, transport: paced });
  const locker = env.KEEPER_LOCKER as `0x${string}`, treasury = env.KEEPER_TREASURY as `0x${string}`, coin = env.KEEPER_COIN as `0x${string}`, name = env.KEEPER_NAME as `0x${string}`;
  const lockStub = env.PIN_COUNTER.get(env.PIN_COUNTER.idFromName("keeper-lease"));
  // this run's proof that the lease is still its own. a run whose lease expired and was taken over presents a
  // token the object no longer recognises, and every change it tries to make is refused.
  const myToken = crypto.randomUUID();
  const lease = async (op: string, extra = "", body?: unknown) =>
    (await lockStub.fetch(
      new Request(`https://keeper/keeper?op=${op}&token=${myToken}${extra}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined),
    )).json() as Promise<{ ok: boolean; reason?: string; resolveFirst?: Pending | null }>;

  /**
   * Something a person has to look at.
   *
   * A blocked keeper stops collecting fees and stops the buyback, and it will stay stopped until someone
   * resolves the transaction it is waiting on: by design, since the alternative is guessing. So it is logged as
   * its own structured record rather than as one line among the run's notes, with the hash and nonce needed to
   * look it up and the reason it could not be settled.
   */
  const alerts: Record<string, unknown>[] = [];
  const alert = (what: string, fields: Record<string, unknown>, kind: "keeper blocked" | "keeper needs attention" = "keeper blocked") => {
    const a = { alert: kind, what, account: account.address, ...fields, at: new Date().toISOString() };
    if (kind === "keeper blocked") alerts.push(a);
    console.error(JSON.stringify(a));
  };

  // what this run managed, and what the ones before it managed
  const HISTORY_KEY = "keeper:history";
  const history = JSON.parse((await env.TICKR_KV.get(HISTORY_KEY)) ?? "null") as RunHistory | null;
  // worked: sends that succeeded; failed: sends mined and reverted; couldNot: sends that never went out
  let worked = 0, failed = 0, couldNot = 0, firstProblem: string | undefined;

  const got = await lease("acquire");
  if (!got.ok) {
    out.push(`keeper: ${got.reason}`);
    return out;
  }

  let mayWrite = true;
  // anything an earlier run signed is settled before this one signs anything
  if (got.resolveFirst) {
    const p = got.resolveFirst;
    let outcome;
    try {
      const rc = await pub.waitForTransactionReceipt({ hash: p.hash as `0x${string}`, timeout: 60_000 });
      outcome = { settled: true as const, status: rc.status };
    } catch {
      // No receipt under our hash. A nonce that has moved on is NOT an answer: it says some transaction used
      // that number, not which, and not what it did. Our own transaction may have been repriced by the node
      // into a different hash, or something else may be signing with this key. Find the transaction that
      // actually consumed the nonce and read its receipt; anything less is a guess, and a guess here unblocks
      // the keeper on a conclusion nobody checked.
      const seen = await pub.getTransactionCount({ address: account.address }).catch(() => undefined);
      if (seen === undefined || seen <= p.nonce) {
        outcome = { settled: false as const, reason: "no receipt, and that nonce is still unused" };
      } else {
        const found = await findByNonce(pub as never, account.address, p.nonce, await pub.getBlockNumber().catch(() => 0n));
        if (!found) {
          outcome = {
            settled: false as const,
            reason: `nonce ${p.nonce} was used by a transaction this run could not find; blocked for review`,
          };
        } else {
          out.push(`${p.label}: nonce ${p.nonce} was consumed by ${found.hash} (${found.status})`);
          outcome = { settled: true as const, status: found.status };
        }
      }
    }
    const d = afterResolve(outcome);
    out.push(`${p.label} (from an earlier run): ${d.note} ${p.hash}`);
    if (d.clear) await lease("clear", `&hash=${p.hash}`);
    else alert(`${p.label} is unresolved`, { hash: p.hash, nonce: p.nonce, sentAt: new Date(p.at).toISOString(), detail: d.note });
    if (d.worked) worked++;
    if (d.failed) {
      failed++;
      firstProblem ??= `${p.label}: mined and reverted ${p.hash}`;
      alert(`${p.label} (from an earlier run) was mined and reverted`, { hash: p.hash, nonce: p.nonce }, "keeper needs attention");
    }
    mayWrite = d.mayWrite;
  }

  /**
   * One write: signed here, recorded, then broadcast.
   *
   * The order is the point. A broadcast the node accepted whose answer never came back is indistinguishable
   * from one that never left, so the hash is computed and stored before anyone has seen the transaction. Any
   * outcome that is not a clean receipt stops this run and every write after it.
   */
  const step = async (label: string, call: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => {
    if (!mayWrite) {
      out.push(`${label}: not attempted, an earlier send is unresolved`);
      return;
    }
    let signed: `0x${string}`, hash: `0x${string}`, nonce: number, data: `0x${string}`;
    try {
      const estimate = await pub.estimateContractGas({ ...call, account } as Parameters<typeof pub.estimateContractGas>[0]);
      const g = gasWithHeadroom(estimate);
      if (!g.ok) {
        out.push(`${label}: not sent (${g.reason})`);
        couldNot++; firstProblem ??= `${label}: ${g.reason}`;
        return;
      }
      nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
      data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as Parameters<typeof encodeFunctionData>[0]);
      const request = await wallet.prepareTransactionRequest({ to: call.address, data, gas: g.gas, nonce, account, chain });
      signed = await wallet.signTransaction(request as Parameters<typeof wallet.signTransaction>[0]);
      hash = keccak256(signed);
    } catch (e) {
      // nothing was broadcast: preparing or signing failed, so no transaction exists to be ambiguous about
      const why = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message?.slice(0, 80);
      out.push(`${label}: not sent (${why})`);
      couldNot++; firstProblem ??= `${label}: ${why}`;
      return;
    }

    const rec = await lease("record", "", { label, hash, nonce, at: Date.now() } satisfies Pending);
    if (!rec.ok) {
      out.push(`${label}: not sent (${rec.reason})`);
      mayWrite = false;
      return;
    }

    try {
      await pub.sendRawTransaction({ serializedTransaction: signed });
    } catch (e) {
      // the node refused, or the answer was lost. Either way this transaction may be in flight under a hash we
      // already hold, so it is left recorded and nothing else is written.
      mayWrite = false;
      out.push(`${label}: send ambiguous ${hash} (${(e as Error).message?.slice(0, 60)}); later steps skipped`);
      alert(`${label} may or may not have been broadcast`, { hash, nonce, detail: (e as Error).message?.slice(0, 120) });
      return;
    }

    try {
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      const d = afterResolve({ settled: true, status: rc.status });
      await lease("clear", `&hash=${hash}`);
      out.push(`${label}: ${rc.status} ${hash}`);
      if (d.worked) worked++;
      else {
        // resolved, not done: the record is cleared, and the failure is counted and said, with its reason when the
        // same call replayed at that block gives one
        failed++;
        const reason = await pub
          .call({ account: account.address, to: call.address, data, blockNumber: rc.blockNumber })
          .then(() => undefined, (e) => (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message?.slice(0, 120));
        firstProblem ??= `${label}: mined and reverted ${hash}${reason ? ` (${reason})` : ""}`;
        alert(`${label} was mined and reverted`, { hash, nonce, reason }, "keeper needs attention");
      }
    } catch (e) {
      mayWrite = false;
      out.push(`${label}: unresolved ${hash} (${(e as Error).message?.slice(0, 60)}); later steps skipped`);
      alert(`${label} was sent but never confirmed`, { hash, nonce, detail: (e as Error).message?.slice(0, 120) });
    }
  };

  // 1. the pool's fees, only when there is something to collect
  const pending = await pub.readContract({ address: locker, abi: LOCKER_ABI, functionName: "pendingFees", args: [coin] }).catch(() => [0n, 0n] as const);
  if (pending[0] > 0n || pending[1] > 0n) await step("collectFees", { address: locker, abi: LOCKER_ABI, functionName: "collectFees", args: [coin] });
  else out.push("collectFees: nothing pending");
  // 2. the treasury's cut, converted
  await step("treasury.collect", { address: treasury, abi: TREASURY_ABI, functionName: "collect", args: [[name]] });
  // 3. a buy, when its interval has passed and dollars are set aside
  const [next, earmarked] = await Promise.all([
    pub.readContract({ address: treasury, abi: TREASURY_ABI, functionName: "nextBuyAt" }).catch(() => 0n),
    pub.readContract({ address: treasury, abi: TREASURY_ABI, functionName: "earmarkedUsdg" }).catch(() => 0n),
  ]);
  if (earmarked > 0n && BigInt(Math.floor(Date.now() / 1000)) >= next) await step("treasury.buy", { address: treasury, abi: TREASURY_ABI, functionName: "buy" });
  else out.push(`treasury.buy: waiting (earmarked ${earmarked}, next at ${next})`);

  // 4. the v2 coin, the same three steps. Its name is a market, not a wrapped dollar, so the v2 treasury converts it
  // under terms: the offered rate floor is the treasury's own policy floor (so the policy decides, not this code,
  // and a name trading under it simply waits), the deadline sits inside the window the treasury allows.
  if (env.KEEPER_V2_COIN && env.KEEPER_V2_NAME && env.KEEPER_V2_TREASURY && env.KEEPER_ESCROW) {
    const coin2 = env.KEEPER_V2_COIN as `0x${string}`, name2 = env.KEEPER_V2_NAME as `0x${string}`;
    const treasury2 = env.KEEPER_V2_TREASURY as `0x${string}`, escrow = env.KEEPER_ESCROW as `0x${string}`;
    const pending2 = await pub.readContract({ address: locker, abi: LOCKER_ABI, functionName: "pendingFees", args: [coin2] }).catch(() => [0n, 0n] as const);
    if (pending2[0] > 0n || pending2[1] > 0n) await step("collectFees(v2)", { address: locker, abi: LOCKER_ABI, functionName: "collectFees", args: [coin2] });
    else out.push("collectFees(v2): nothing pending");
    const terms = async () => {
      const set = await pub.readContract({ address: treasury2, abi: TREASURY_V2_ABI, functionName: "minRateToCounterX96", args: [name2] }).catch(() => 0n);
      const floor = set > 0n ? set : await pub.readContract({ address: treasury2, abi: TREASURY_V2_ABI, functionName: "defaultMinRateToCounterX96" }).catch(() => 0n);
      return { minOutPerInX96: floor, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
    };
    // collect only when the escrow or the treasury holds something: a run that converts nothing has no reason to pay for the call
    const [escEth, escName, heldName] = await Promise.all([
      pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "balanceOf", args: [treasury2] }).catch(() => 0n),
      pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "balanceOfToken", args: [treasury2, name2] }).catch(() => 0n),
      pub.readContract({ address: name2, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [treasury2] }).catch(() => 0n),
    ]);
    if (escEth > 0n || escName > 0n || heldName > 0n) {
      const t = await terms();
      if (t.minOutPerInX96 === 0n) out.push("treasury2.collect: not attempted, no rate floor could be read");
      else await step("treasury2.collect", { address: treasury2, abi: TREASURY_V2_ABI, functionName: "collect", args: [[name2], [t]] });
    } else out.push("treasury2.collect: nothing to collect");
    const [next2, earmarked2] = await Promise.all([
      pub.readContract({ address: treasury2, abi: TREASURY_V2_ABI, functionName: "nextBuyAt" }).catch(() => 0n),
      pub.readContract({ address: treasury2, abi: TREASURY_V2_ABI, functionName: "earmarkedUsdg" }).catch(() => 0n),
    ]);
    if (earmarked2 > 0n && BigInt(Math.floor(Date.now() / 1000)) >= next2) {
      const t = await terms();
      if (t.minOutPerInX96 === 0n) out.push("treasury2.buy: not attempted, no rate floor could be read");
      else await step("treasury2.buy", { address: treasury2, abi: TREASURY_V2_ABI, functionName: "buy", args: [t] });
    } else out.push(`treasury2.buy: waiting (earmarked ${earmarked2}, next at ${next2})`);

    // 5. the HOLY treasury: the coin's creator share arrives here as HOLY (burned as is) and as COW (converted and
    // spent on HOLY, which is burned). Same terms, same gating, plus the burn of what is already the coin.
    if (env.KEEPER_HOLY_TREASURY) {
      const holyT = env.KEEPER_HOLY_TREASURY as `0x${string}`;
      // a proposed raise of the burn share is anyone's to apply once its delay has passed; the keeper is the anyone
      const [pendingShare, shareAt] = await Promise.all([
        pub.readContract({ address: holyT, abi: TREASURY_HOLY_ABI, functionName: "pendingShareBps" }).catch(() => 0),
        pub.readContract({ address: holyT, abi: TREASURY_HOLY_ABI, functionName: "shareEffectiveAt" }).catch(() => 0n),
      ]);
      if (pendingShare > 0 && BigInt(Math.floor(Date.now() / 1000)) >= shareAt) await step("holy.applyShare", { address: holyT, abi: TREASURY_HOLY_ABI, functionName: "applyBuybackShare" });
      else if (pendingShare > 0) out.push(`holy.applyShare: waiting (${pendingShare} bps from ${shareAt})`);
      const pendingCoin = await pub.readContract({ address: holyT, abi: TREASURY_HOLY_ABI, functionName: "pendingCoin" }).catch(() => 0n);
      if (pendingCoin > 0n) await step("holy.burnCoin", { address: holyT, abi: TREASURY_HOLY_ABI, functionName: "burnCoin" });
      else out.push("holy.burnCoin: nothing to burn");
      const termsH = async () => {
        const set = await pub.readContract({ address: holyT, abi: TREASURY_HOLY_ABI, functionName: "minRateToCounterX96", args: [name2] }).catch(() => 0n);
        const floor = set > 0n ? set : await pub.readContract({ address: holyT, abi: TREASURY_HOLY_ABI, functionName: "defaultMinRateToCounterX96" }).catch(() => 0n);
        return { minOutPerInX96: floor, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
      };
      const [hEth, hName, hHeld] = await Promise.all([
        pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "balanceOf", args: [holyT] }).catch(() => 0n),
        pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "balanceOfToken", args: [holyT, name2] }).catch(() => 0n),
        pub.readContract({ address: name2, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [holyT] }).catch(() => 0n),
      ]);
      if (hEth > 0n || hName > 0n || hHeld > 0n) {
        const t = await termsH();
        if (t.minOutPerInX96 === 0n) out.push("holy.collect: not attempted, no rate floor could be read");
        else await step("holy.collect", { address: holyT, abi: TREASURY_HOLY_ABI, functionName: "collect", args: [[name2], [t]] });
      } else out.push("holy.collect: nothing to collect");
      const [nextH, earmarkedH] = await Promise.all([
        pub.readContract({ address: holyT, abi: TREASURY_HOLY_ABI, functionName: "nextBuyAt" }).catch(() => 0n),
        pub.readContract({ address: holyT, abi: TREASURY_HOLY_ABI, functionName: "earmarkedUsdg" }).catch(() => 0n),
      ]);
      if (earmarkedH > 0n && BigInt(Math.floor(Date.now() / 1000)) >= nextH) {
        // buying the name with dollars is the other direction, so it is the other floor
        const set = await pub.readContract({ address: holyT, abi: TREASURY_HOLY_ABI, functionName: "minRateFromCounterX96", args: [name2] }).catch(() => 0n);
        const floor = set > 0n ? set : await pub.readContract({ address: holyT, abi: TREASURY_HOLY_ABI, functionName: "defaultMinRateFromCounterX96" }).catch(() => 0n);
        if (floor === 0n) out.push("holy.buy: not attempted, no rate floor could be read");
        else await step("holy.buy", { address: holyT, abi: TREASURY_HOLY_ABI, functionName: "buy", args: [{ minOutPerInX96: floor, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }] });
      } else out.push(`holy.buy: waiting (earmarked ${earmarkedH}, next at ${nextH})`);
    }
  }
  // a balance that cannot cover a cycle is worth saying before it is worth failing over
  const bal = await pub.getBalance({ address: account.address }).catch(() => 0n);
  const NEED_WEI = 920_000_000_000_000n; // one cycle's limits at twice the base fee, measured on a fork, doubled for the v2 steps
  const low = balanceWarning(bal, NEED_WEI);
  if (low) {
    out.push(low);
    alert("the keeper cannot afford a full cycle", { balanceWei: bal.toString(), needWei: NEED_WEI.toString(), fundAt: account.address }, "keeper needs attention");
  }

  const outcome: WorkOutcome = runOutcome({ worked, failed, couldNot });
  const noted = noteRun(history ?? { consecutiveNoWork: 0 }, outcome, firstProblem);
  await env.TICKR_KV.put(HISTORY_KEY, JSON.stringify(noted.history));
  if (noted.alarm) alert("the keeper has stopped doing work", { detail: noted.alarm, runs: noted.history.consecutiveNoWork }, "keeper needs attention");
  out.push(`run outcome: ${outcome}${noted.alarm ? `, ${noted.alarm}` : ""}`);

  await lease("release");
  if (alerts.length > 0) out.unshift(`BLOCKED: ${alerts.length} unresolved; the keeper will not write again until settled`);
  return out;
}

export default {
  async scheduled(c: ScheduledController, env: Env, ctx: ExecutionContext) {
    // two schedules share this worker: the token list every fifteen minutes, the keeper every ten
    if (c.cron === "*/10 * * * *") {
      ctx.waitUntil(keep(env).then((lines) => console.log(JSON.stringify({ keeper: lines }))));
      return;
    }
    ctx.waitUntil(refresh(env).then((o) => console.log(`tokens: ${o.tokens.length} of ${o.stats.candidates} candidates`)));
    ctx.waitUntil(verifyLaunches(env).then((line) => console.log(line)));
  },
  /** A manual run, for a deploy or a check: `curl -H "x-refresh-key: ..." https://<worker>/refresh`. Reading is what the site does. */
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/verify") {
      if (!env.REFRESH_KEY || req.headers.get("x-refresh-key") !== env.REFRESH_KEY) return new Response("not found", { status: 404 });
      // `?explorer=<address>&kind=coin` asks the explorer about one address and submits it if needed: a check that
      // this network can reach the explorer at all, and a way to push one launch through by hand
      const one = url.searchParams.get("explorer");
      if (one) {
        const kind = (url.searchParams.get("kind") ?? "coin") as "coin" | "market-name" | "managed-name";
        const before = await explorerStatus(fetch.bind(globalThis), one, env.BLOCKSCOUT_KEY);
        const line = before ? "already verified" : await explorerSubmit(fetch.bind(globalThis), one, kind, (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), env.BLOCKSCOUT_KEY);
        return new Response(`explorer: ${kind} ${one} -> status ${before} (${lastExplorerNote}) -> ${line}`, { headers: { "content-type": "text/plain" } });
      }
      return new Response(await verifyLaunches(env), { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/keep") {
      if (!env.REFRESH_KEY || req.headers.get("x-refresh-key") !== env.REFRESH_KEY) return new Response("not found", { status: 404 });
      return Response.json({ keeper: await keep(env) });
    }
    if (url.pathname === "/refresh") {
      // a manual run is ours to trigger: the schedule does it otherwise
      // the key travels in a header: a query string lands in logs, caches and browser history
      if (!env.REFRESH_KEY || req.headers.get("x-refresh-key") !== env.REFRESH_KEY || url.searchParams.has("key")) return new Response("not found", { status: 404 });
      const out = await refresh(env);
      return Response.json({ ok: true, ...out.stats, tokens: out.tokens.length, stored: out.stored, keeping: out.keeping });
    }
    if (url.pathname === "/budget" || url.pathname.startsWith("/pin-")) return pinRoutes(url, req, env);
    const cached = await env.TICKR_KV.get(KEY);
    return new Response(cached ?? JSON.stringify({ tokens: [], at: 0 }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });
  },
};
