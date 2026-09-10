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
  KEEPER_KEY?: string;
  RPC_ENDPOINT?: string;
  KEEPER_LOCKER?: string;
  KEEPER_TREASURY?: string;
  KEEPER_COIN?: string;
  KEEPER_NAME?: string;
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
  const step = async (label: string, fn: () => Promise<`0x${string}`>) => {
    try {
      const hash = await fn();
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      out.push(`${label}: ${rc.status} ${hash}`);
    } catch (e) {
      // a step that did not resolve is reported and left alone. It is never sent again from here: the keeper
      // runs every ten minutes and cannot tell a transaction that is slow from one that is lost, so a resend
      // risks paying twice for work the first one is about to do.
      out.push(`${label}: skipped (${(e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message?.slice(0, 80)})`);
    }
  };

  /**
   * The gas limit for a write, estimated at the last moment and given bounded headroom.
   *
   * An estimate is a measurement of the chain as it is now, and these calls are not the only thing happening on
   * it. `collectFees` is the case that bit us: with only quote-side fees it burns nothing, and a sell landing
   * between the estimate and inclusion adds the coin-side burn, which costs more than the estimate allowed. The
   * transaction then fails on gas having paid for the whole limit.
   *
   * The headroom is a multiplier, not a blank cheque: it is capped in absolute terms so a wrong estimate cannot
   * drain the keeper, and the cap is well under a block's capacity.
   */
  // Measured on a fork of this chain (contracts/test/CollectFeesGas.t.sol): a collection with only buys costs
  // 270,165 and the same collection after a sell costs 386,733, so the burn leg makes it 143% of the estimate.
  // Twice the estimate covers that with real margin rather than the seven points 1.5x would have left.
  const GAS_HEADROOM_NUM = 2n, GAS_HEADROOM_DEN = 1n;
  // and it is bounded: twice a real collection is about 780,000, so this cap is far above anything legitimate
  // and far below a block, which is what stops a wrong estimate from draining the keeper.
  const GAS_CEILING = 3_000_000n;
  const gasFor = async (params: Parameters<typeof pub.estimateContractGas>[0]) => {
    const estimate = await pub.estimateContractGas({ ...params, account } as Parameters<typeof pub.estimateContractGas>[0]);
    const padded = (estimate * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;
    return padded > GAS_CEILING ? GAS_CEILING : padded;
  };
  // 1. the pool's fees, only when there is something to collect
  const pending = await pub.readContract({ address: locker, abi: LOCKER_ABI, functionName: "pendingFees", args: [coin] }).catch(() => [0n, 0n] as const);
  if (pending[0] > 0n || pending[1] > 0n) {
    await step("collectFees", async () => {
      const call = { address: locker, abi: LOCKER_ABI, functionName: "collectFees", args: [coin] } as const;
      return wallet.writeContract({ ...call, gas: await gasFor(call) });
    });
  }
  else out.push("collectFees: nothing pending");
  // 2. the treasury's cut, converted
  await step("treasury.collect", async () => {
    const call = { address: treasury, abi: TREASURY_ABI, functionName: "collect", args: [[name]] } as const;
    return wallet.writeContract({ ...call, gas: await gasFor(call) });
  });
  // 3. a buy, when its interval has passed and dollars are set aside
  const [next, earmarked] = await Promise.all([
    pub.readContract({ address: treasury, abi: TREASURY_ABI, functionName: "nextBuyAt" }).catch(() => 0n),
    pub.readContract({ address: treasury, abi: TREASURY_ABI, functionName: "earmarkedUsdg" }).catch(() => 0n),
  ]);
  if (earmarked > 0n && BigInt(Math.floor(Date.now() / 1000)) >= next) await step("treasury.buy", async () => {
    const call = { address: treasury, abi: TREASURY_ABI, functionName: "buy" } as const;
    return wallet.writeContract({ ...call, gas: await gasFor(call) });
  });
  else out.push(`treasury.buy: waiting (earmarked ${earmarked}, next at ${next})`);
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
  },
  /** A manual run, for a deploy or a check: `curl -H "x-refresh-key: ..." https://<worker>/refresh`. Reading is what the site does. */
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
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
