import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { AnchorRegistryAbi, StockQuoteLauncherAbi, TickerLauncherAbi, TokenAbi } from "@/lib/abis";
import { poolManagerAbi } from "@/lib/extraAbis";
import { ADDRESSES, BURN, OFFICIAL, START_BLOCK, isZero, sameAddr } from "@/lib/addresses";
import { poolIdOf, slot0Slot, sqrtPriceFromSlot0, tokenPriceInQuote } from "@/lib/pool";
import type { Launch } from "./launches";

/** Uniswap v4 PoolManager: one per swap, amounts from the swapper's side (negative = paid in). */
const FEES_COLLECTED = parseAbiItem(
  "event FeesCollected(address indexed token, uint256 quoteCollected, uint256 coinCollected, uint256 protocolQuote, uint256 creatorQuote, uint256 clubQuote, uint256 creatorCoin, uint256 burnedCoin)",
);
const SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

export type Row = {
  launch: Launch;
  name?: string;
  symbol?: string;
  logo?: string;
  decimals: number;
  totalSupply?: bigint;
  /** the dead address's share of the supply, in percent */
  burnedPct?: number;
  quote: { address: Address; symbol: string; decimals: number; kind: QuoteKind; ticker?: string };
  /** Price and market cap in the coin's own quote asset, and in USD when that quote can be priced. */
  price?: number;
  marketCap?: number;
  marketCapUsd?: number;
  volumeUsd: number;
  paidToCreatorUsd: number;
  volumeQuote: number;
  buys: number;
  lastBuyBlock: bigint;
  createdBlock: bigint;
  /** a coin under a name launched inside the grid's window: its card asks the activation signal the coin's page uses */
  fresh: boolean;
};

export type QuoteKind = "native" | "stable" | "official" | "ticker" | "coin" | "erc20";

export type MarketData = {
  rows: Row[];
  tickersInvented: number;
  totalVolumeUsd: number;
  totalMarketCapUsd: number;
  paidToCreatorsUsd: number;
  coinsBurned: number;
  officialBurnedPct?: number;
  pricedShare: number;
  cutoffBlock: bigint;
  blockTime: number;
  /** a swap or collection log query failed, so volume and creator totals are incomplete */
  partial: boolean;
};

/** Window used by the grid filter, expressed in seconds. */
export const WINDOWS = { "24h": 86_400, "7d": 604_800, all: 0 } as const;
export type WindowKey = keyof typeof WINDOWS;

const PER = 7;

/**
 * Everything the home grid and the stats row need, in one place: a price for each launch from its own pool, a
 * USD rate for that quote where one can be established, and pool volume from the swap logs.
 *
 * A quote is priced when it is ETH, USDG, an official Stock Token with a live feed, or an invented ticker. A
 * launch quoted in another launch is left unpriced rather than guessed at, and `pricedShare` says how much of
 * the set the USD totals actually cover.
 */
export async function loadMarket(client: PublicClient, list: Launch[], window: WindowKey): Promise<MarketData> {
  if (list.length === 0) {
    return { rows: [], tickersInvented: 0, totalVolumeUsd: 0, totalMarketCapUsd: 0, paidToCreatorsUsd: 0, coinsBurned: 0, pricedShare: 1, partial: false, cutoffBlock: 0n, blockTime: 2 };
  }

  // the head and the name count need nothing else: they start first and are collected below
  const latestP = client.getBlockNumber();
  const tickerCountP = isZero(ADDRESSES.tickerLauncher)
    ? Promise.resolve(0n)
    : client.readContract({ abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "tickerCount" }).catch(() => 0n);
  // 1. per-launch state: the coin's metadata and its pool's price
  const readsP = client.multicall({
    contracts: list.flatMap((l) => [
      { abi: TokenAbi, address: l.token, functionName: "name" },
      { abi: TokenAbi, address: l.token, functionName: "symbol" },
      { abi: TokenAbi, address: l.token, functionName: "logo" },
      { abi: TokenAbi, address: l.token, functionName: "decimals" },
      { abi: TokenAbi, address: l.token, functionName: "totalSupply" },
      { abi: poolManagerAbi, address: ADDRESSES.poolManager, functionName: "extsload", args: [slot0Slot(l.poolId)] },
      { abi: TokenAbi, address: l.token, functionName: "balanceOf", args: [BURN] },
    ] as const),
    allowFailure: true,
  });
  const at = (i: number, k: number) => {
    const r = reads[i * PER + k];
    return r && r.status === "success" ? r.result : undefined;
  };

  // 2. what each launch is quoted in
  const quoteAddrs = Array.from(new Set(list.map((l) => l.pairToken.toLowerCase()))) as Address[];
  const metaP = client.multicall({
    contracts: quoteAddrs.flatMap((a) =>
      isZero(a)
        ? []
        : ([
            { abi: TokenAbi, address: a, functionName: "symbol" },
            { abi: TokenAbi, address: a, functionName: "decimals" },
            { abi: AnchorRegistryAbi, address: ADDRESSES.anchorRegistry, functionName: "anchorOf", args: [a] },
            { abi: TickerLauncherAbi, address: ADDRESSES.tickerLauncher, functionName: "isTicker", args: [a] },
          ] as const),
    ),
    allowFailure: true,
  });
  const [reads, meta, latest] = await Promise.all([readsP, metaP, latestP]);
  const quoteInfo = new Map<string, { symbol: string; decimals: number; kind: QuoteKind; ticker?: string }>();
  let cursor = 0;
  for (const a of quoteAddrs) {
    if (isZero(a)) {
      quoteInfo.set(a.toLowerCase(), { symbol: "ETH", decimals: 18, kind: "native" });
      continue;
    }
    const val = (k: number) => {
      const r = meta[cursor + k];
      return r && r.status === "success" ? r.result : undefined;
    };
    const symbol = (val(0) as string | undefined) ?? "?";
    const decimals = Number(val(1) ?? 18);
    const anchor = val(2) as { ticker: string; kind: number; active: boolean } | undefined;
    const isTicker = val(3) === true;
    const kind: QuoteKind = isTicker
      ? "ticker"
      : anchor && anchor.active && anchor.kind === 2
        ? "official"
        : anchor && anchor.active && anchor.kind === 1
          ? "stable"
          : list.some((l) => sameAddr(l.token, a))
            ? "coin"
            : "erc20";
    quoteInfo.set(a.toLowerCase(), { symbol, decimals, kind, ticker: anchor?.ticker });
    cursor += 4;
  }

  // 3 and 4. the dollar rate per quote, the block time and every fee collection the locker logged are independent
  // of one another, so they are read side by side; the swaps come after, because their window needs the block time
  // one read for the whole window first, which the public RPC answers for a handful of pool ids; a range it refuses
  // is split in two and each half tried again, a few levels deep. a range it still refuses leaves a hole, and
  // the hole is reported rather than shown as zero. block numbers are not a measure of size on this chain, so the
  // split follows the RPC's answer, never a fixed span
  let partial = false;
  const adaptive = async <T,>(read: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to: bigint, depth = 0): Promise<T[]> => {
    try {
      return await read(from, to);
    } catch {
      if (depth >= 4 || to <= from) {
        partial = true;
        return [];
      }
      const mid = from + (to - from) / 2n;
      const [a, b] = await Promise.all([adaptive(read, from, mid, depth + 1), adaptive(read, mid + 1n, to, depth + 1)]);
      return [...a, ...b];
    }
  };
  const [rates, blockTime, collections] = await Promise.all([
    usdRates(client, quoteAddrs, quoteInfo),
    measureBlockTime(client, latest),
    adaptive((a, b) => client.getLogs({ address: ADDRESSES.launchLocker, event: FEES_COLLECTED, args: { token: list.map((l) => l.token) }, fromBlock: a, toBlock: b }), START_BLOCK, latest),
  ]);
  const seconds = WINDOWS[window];
  const cutoffBlock = seconds === 0 ? START_BLOCK : bigMax(START_BLOCK, latest - BigInt(Math.ceil(seconds / blockTime)));
  const byPool = new Map<string, Launch>();
  for (const l of list) byPool.set(l.poolId.toLowerCase(), l);
  const swaps = await adaptive((a, b) => client.getLogs({ address: ADDRESSES.poolManager, event: SWAP, args: { id: list.map((l) => l.poolId) }, fromBlock: a, toBlock: b }), cutoffBlock, latest);
  const vol = new Map<string, { quote: bigint; buys: number; lastBuy: bigint }>();
  for (const log of swaps) {
    const id = (log.args.id ?? "0x").toLowerCase();
    const l = byPool.get(id);
    if (!l) continue;
    const quoteIs0 = BigInt(l.pairToken) < BigInt(l.token);
    const q = (quoteIs0 ? log.args.amount0 : log.args.amount1) ?? 0n;
    const e = vol.get(id) ?? { quote: 0n, buys: 0, lastBuy: 0n };
    e.quote += q < 0n ? -q : q;
    // the swapper paid quote in: a buy
    if (q < 0n) {
      e.buys += 1;
      if ((log.blockNumber ?? 0n) > e.lastBuy) e.lastBuy = log.blockNumber ?? 0n;
    }
    vol.set(id, e);
  }

  // what creators have been paid in the quote, from every collection the locker ever logged, priced like volume
  const creatorQuoteBy = new Map<string, bigint>();
  for (const log of collections) {
    const t = (log.args.token ?? "0x").toLowerCase();
    creatorQuoteBy.set(t, (creatorQuoteBy.get(t) ?? 0n) + (log.args.creatorQuote ?? 0n));
  }

  const rows: Row[] = list.map((l, i) => {
    const q = quoteInfo.get(l.pairToken.toLowerCase()) ?? { symbol: "?", decimals: 18, kind: "erc20" as QuoteKind };
    const decimals = Number(at(i, 3) ?? 18);
    const totalSupply = at(i, 4) as bigint | undefined;
    const slot = at(i, 5) as Hex | undefined;
    const dead = at(i, 6) as bigint | undefined;
    const burnedPct = dead !== undefined && totalSupply !== undefined && totalSupply > 0n ? Number((dead * 10_000n) / totalSupply) / 100 : undefined;
    const v = vol.get(l.poolId.toLowerCase());
    const rate = rates.get(l.pairToken.toLowerCase());

    let price: number | undefined;
    if (slot) {
      const sqrt = sqrtPriceFromSlot0(slot);
      if (sqrt > 0n) price = tokenPriceInQuote(sqrt, BigInt(l.token) < BigInt(l.pairToken), decimals, q.decimals);
    }
    const supply = totalSupply !== undefined ? Number(totalSupply) / 10 ** decimals : undefined;
    const marketCap = price !== undefined && supply !== undefined ? price * supply : undefined;
    const volumeQuote = v ? Number(v.quote) / 10 ** q.decimals : 0;
    return {
      launch: l,
      name: at(i, 0) as string | undefined,
      symbol: at(i, 1) as string | undefined,
      logo: at(i, 2) as string | undefined,
      decimals,
      totalSupply,
      burnedPct,
      quote: { address: l.pairToken, ...q },
      price,
      marketCap,
      marketCapUsd: marketCap !== undefined && rate !== undefined ? marketCap * rate : undefined,
      volumeQuote,
      volumeUsd: rate !== undefined ? volumeQuote * rate : 0,
      paidToCreatorUsd: rate !== undefined ? (Number(creatorQuoteBy.get(l.token.toLowerCase()) ?? 0n) / 10 ** q.decimals) * rate : 0,
      buys: v?.buys ?? 0,
      lastBuyBlock: v?.lastBuy ?? 0n,
      createdBlock: l.blockNumber ?? 0n,
      // a coin under a name launched inside the window is fresh enough for the card to ask the same activation
      // signal the coin's page uses; nothing is inferred here
      fresh: q.kind === "ticker" && l.blockNumber !== undefined && l.blockNumber >= cutoffBlock,
    };
  });

  // a ticker is a wrapper, not a launch, so the count comes from the launcher's list
  const tickerCount = await tickerCountP;
  const priced = rows.filter((r) => rates.get(r.quote.address.toLowerCase()) !== undefined);

  return {
    rows,
    tickersInvented: Number(tickerCount),
    totalVolumeUsd: priced.reduce((s, r) => s + r.volumeUsd, 0),
    totalMarketCapUsd: priced.reduce((s, r) => s + (r.marketCapUsd ?? 0), 0),
    paidToCreatorsUsd: priced.reduce((s, r) => s + r.paidToCreatorUsd, 0),
    coinsBurned: rows.filter((r) => (r.burnedPct ?? 0) > 0).length,
    officialBurnedPct: rows.find((r) => sameAddr(r.launch.token, OFFICIAL.token))?.burnedPct,
    pricedShare: rows.length ? priced.length / rows.length : 1,
    partial,
    cutoffBlock,
    blockTime,
  };
}


function bigMax(a: bigint, b: bigint) {
  return a > b ? a : b;
}

/** Seconds per block, measured from the chain rather than assumed. */
async function measureBlockTime(client: PublicClient, latest: bigint): Promise<number> {
  const span = 500n;
  if (latest <= span) return 2;
  const [a, b] = await Promise.all([client.getBlock({ blockNumber: latest - span }), client.getBlock({ blockNumber: latest })]);
  const dt = Number(b.timestamp - a.timestamp) / Number(span);
  return dt > 0 ? dt : 2;
}

/**
 * USD per whole unit of each quote asset. ETH comes from the canonical ETH/USDG pool, a Stock Token from its own
 * Chainlink feed, and an invented ticker is USDG by construction. USDG is treated as a dollar. Anything else is
 * left out.
 */
async function usdRates(
  client: PublicClient,
  quotes: Address[],
  info: Map<string, { symbol: string; decimals: number; kind: QuoteKind }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // ETH, from the deepest ETH/USDG pool (fee 0.01%). USDG prices at 1.
  let ethUsd = 0;
  try {
    const id = poolIdOf("0x0000000000000000000000000000000000000000", ADDRESSES.usdg, 100, 1, "0x0000000000000000000000000000000000000000");
    const slot = await client.readContract({ abi: poolManagerAbi, address: ADDRESSES.poolManager, functionName: "extsload", args: [slot0Slot(id)] });
    const sqrt = sqrtPriceFromSlot0(slot as Hex);
    if (sqrt > 0n) ethUsd = tokenPriceInQuote(sqrt, true, 18, 6);
  } catch {
    ethUsd = 0;
  }
  if (ethUsd > 0) out.set("0x0000000000000000000000000000000000000000", ethUsd);
  out.set(ADDRESSES.usdg.toLowerCase(), 1);

  const officials = quotes.filter((a) => info.get(a.toLowerCase())?.kind === "official");
  if (officials.length && !isZero(ADDRESSES.stockQuoteLauncher)) {
    const res = await client.multicall({
      contracts: officials.map((a) => ({ abi: StockQuoteLauncherAbi, address: ADDRESSES.stockQuoteLauncher, functionName: "stockPrice", args: [a] }) as const),
      allowFailure: true,
    });
    officials.forEach((a, i) => {
      const r = res[i];
      if (r?.status === "success") {
        const [p, dec] = r.result as readonly [bigint, number];
        out.set(a.toLowerCase(), Number(p) / 10 ** Number(dec));
      }
    });
  }

  // a redeemable name is a one-for-one wrapper of USDG, so its price is USDG's price, by construction. this is
  // keyed on TickerLauncher.isTicker, so a fixed-inventory name never reaches here and is never priced at a dollar
  const tickers = quotes.filter((a) => info.get(a.toLowerCase())?.kind === "ticker");
  if (tickers.length) {
    const usdgRate = out.get(ADDRESSES.usdg.toLowerCase());
    if (usdgRate !== undefined) for (const a of tickers) out.set(a.toLowerCase(), usdgRate);
  }
  return out;
}
