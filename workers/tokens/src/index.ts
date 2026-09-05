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
import { createPublicClient, erc20Abi, getAddress, http, parseAbi, type Address, type PublicClient } from "viem";

/** Addresses arrive from configuration, where the checksum casing may be anything. */
const addr = (a: string): Address => getAddress(a.toLowerCase());

type Env = {
  TICKR_KV: KVNamespace;
  RPC_URL: string;
  EXPLORER: string;
  WETH: string;
  USDG: string;
  V3_FACTORY: string;
  POOL_MANAGER: string;
  MULTICALL3: string;
  MARKET_QUOTE_LAUNCHER: string;
  BLOCKSCOUT_KEY?: string;
  REFRESH_KEY?: string;
  BUDGET_KEY?: string;
  PIN_BUDGET: DurableObjectNamespace;
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

/**
 * Before the launcher exists, the floors are checked against what DexScreener reports each pool holds. It gives
 * the pool address and its two sides, so no chain call is needed for the estimate; the launcher itself is the
 * authority once it is deployed, and the contract checks again at launch either way.
 */
function marketsFromPairs(env: Env, cands: Candidate[], dex: Map<string, DexPair[]>, ethUsd: number) {
  const weth = addr(env.WETH);
  const usdg = addr(env.USDG);
  const floors = { WETH: 5, USDG: 15_000 };
  const best = new Map<string, Market>();
  for (const c of cands) {
    for (const p of dex.get(c.address.toLowerCase()) ?? []) {
      if (p.dexId !== "uniswap" || !(p.labels ?? []).includes("v3")) continue;
      if (!/^0x[0-9a-fA-F]{40}$/.test(p.pairAddress ?? "")) continue;
      const baseIsOurs = same(p.baseToken.address, c.address);
      const other = baseIsOurs ? p.quoteToken.address : p.baseToken.address;
      const counter: "WETH" | "USDG" | undefined = same(other, weth) ? "WETH" : same(other, usdg) ? "USDG" : undefined;
      if (!counter) continue;
      // the counter side of the pool, in whole units, as DexScreener reports it
      const held = baseIsOurs ? p.liquidity?.quote : p.liquidity?.base;
      if (held === undefined || held < floors[counter]) continue;
      const depthEth = counter === "WETH" ? held : ethUsd > 0 ? held / ethUsd : 0;
      const key = c.address.toLowerCase();
      const cur = best.get(key);
      if (cur) {
        if (cur.counter === "WETH" && counter === "USDG") continue;
        if (cur.counter === counter && cur.depthEth >= depthEth) continue;
      }
      best.set(key, { counter, pool: addr(p.pairAddress), fee: 0, depth: 0n, depthEth });
    }
  }
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
async function refresh(env: Env) {
  const out = await build(env);
  if (out.tokens.length > 0) {
    await env.TICKR_KV.put(KEY, JSON.stringify({ ...out, at: Date.now() }));
    return { ...out, stored: true };
  }
  const kept = await env.TICKR_KV.get(KEY);
  return { ...out, stored: false, keeping: kept ? (JSON.parse(kept) as { tokens: unknown[] }).tokens.length : 0 };
}

/**
 * The pin budget: how many uploads an address may make per hour, counted in one place. A Durable Object is a
 * single-threaded counter, so twenty requests at once cannot each see "zero" the way a read-then-write in KV can.
 */
export class PinBudget {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") ?? "12");
    const windowMs = Number(url.searchParams.get("window") ?? String(60 * 60_000));
    const now = Date.now();
    const hits = ((await this.state.storage.get<number[]>("hits")) ?? []).filter((t) => now - t < windowMs);
    const allowed = hits.length < limit;
    if (allowed) {
      hits.push(now);
      await this.state.storage.put("hits", hits);
    }
    return Response.json({ allowed, count: hits.length, limit });
  }
}

export default {
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(refresh(env).then((o) => console.log(`tokens: ${o.tokens.length} of ${o.stats.candidates} candidates`)));
  },
  /** A manual run, for a deploy or a check: `curl https://<worker>/refresh`. Reading is what the site does. */
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/refresh") {
      // a manual run is ours to trigger: the schedule does it otherwise
      if (!env.REFRESH_KEY || url.searchParams.get("key") !== env.REFRESH_KEY) return new Response("not found", { status: 404 });
      const out = await refresh(env);
      return Response.json({ ok: true, ...out.stats, tokens: out.tokens.length, stored: out.stored, keeping: out.keeping });
    }
    // the pin budget for the site: one counter per address, atomic. `key` is the caller's address, `secret` proves the caller is ours.
    if (url.pathname === "/budget") {
      if (!env.BUDGET_KEY || url.searchParams.get("secret") !== env.BUDGET_KEY) return new Response("not found", { status: 404 });
      const who = url.searchParams.get("key") ?? "unknown";
      const stub = env.PIN_BUDGET.get(env.PIN_BUDGET.idFromName(who));
      return stub.fetch(new Request(`https://budget/?limit=12&window=${60 * 60_000}`));
    }
    const cached = await env.TICKR_KV.get(KEY);
    return new Response(cached ?? JSON.stringify({ tokens: [], at: 0 }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });
  },
};
