import { NextResponse } from "next/server";
import stocks from "@/data/stocks.json";

/**
 * Everything the chain and its explorer know about one address, for the pair card. Server-side because the
 * explorer refuses browser-less requests and Robinhood's registry snapshot lives here. Sixty-second cache.
 *
 * "genuine" is the one fact that matters: the address is in Robinhood's own asset registry, or it is not. A name
 * ending in "Robinhood Token" that is not in the registry is a lookalike, and the response says so.
 */
const EX = "https://robinhoodchain.blockscout.com/api/v2";
const H = { "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/120", Accept: "application/json" };

type ExplorerToken = {
  address_hash?: string;
  address?: string;
  name?: string;
  symbol?: string;
  decimals?: string;
  holders_count?: string | number;
  holders?: string | number;
  total_supply?: string;
  exchange_rate?: string | null;
  volume_24h?: string | null;
  circulating_market_cap?: string | null;
  icon_url?: string | null;
  type?: string;
};

async function j<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: H, next: { revalidate: 60 } });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}
const num = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : Number(v));

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return NextResponse.json({ error: "not an address" }, { status: 400 });
  const a = address.toLowerCase();
  const genuine = stocks.assets.find((s) => s.address.toLowerCase() === a) ?? null;

  const [token, addr] = await Promise.all([
    j<ExplorerToken>(`${EX}/tokens/${address}`),
    j<{ is_contract?: boolean; is_verified?: boolean; creator_address_hash?: string; creation_transaction_hash?: string; creation_tx_hash?: string }>(`${EX}/addresses/${address}`),
  ]);

  const symbol = genuine?.symbol ?? token?.symbol;
  let lookalikes: { address: string; name: string; holders: number }[] = [];
  if (symbol) {
    const s = await j<{ items?: ExplorerToken[] }>(`${EX}/tokens?q=${encodeURIComponent(symbol)}&type=ERC-20`);
    lookalikes = (s?.items ?? [])
      .filter((t) => t.symbol === symbol && (t.address_hash ?? t.address ?? "").toLowerCase() !== a)
      .map((t) => ({ address: t.address_hash ?? t.address ?? "", name: t.name ?? "", holders: num(t.holders_count ?? t.holders) ?? 0 }))
      .sort((x, y) => y.holders - x.holders);
  }

  const creationTx = addr?.creation_transaction_hash ?? addr?.creation_tx_hash;
  let createdAt: string | undefined;
  if (creationTx) {
    const tx = await j<{ timestamp?: string }>(`${EX}/transactions/${creationTx}`);
    createdAt = tx?.timestamp;
  }

  const name = token?.name ?? genuine?.onChainName;
  const looksOfficial = /Robinhood Token$/i.test(name ?? "");
  return NextResponse.json(
    {
      address,
      genuine: genuine
        ? { symbol: genuine.symbol, name: genuine.name, isin: genuine.isin, feed: genuine.feed, issuer: stocks.issuer, registry: stocks.source, syncedAt: stocks.syncedAt }
        : null,
      looksOfficial,
      lookalike: looksOfficial && !genuine,
      token: token
        ? {
            name: token.name,
            symbol: token.symbol,
            decimals: num(token.decimals),
            holders: num(token.holders_count ?? token.holders),
            totalSupply: token.total_supply,
            priceUsd: num(token.exchange_rate),
            volume24hUsd: num(token.volume_24h),
            marketCapUsd: num(token.circulating_market_cap),
            icon: token.icon_url ?? undefined,
          }
        : null,
      contract: { isContract: addr?.is_contract ?? undefined, verified: addr?.is_verified ?? undefined, creator: addr?.creator_address_hash ?? undefined, creationTx, createdAt },
      lookalikes: { count: lookalikes.length, holders: lookalikes.reduce((s, l) => s + l.holders, 0), sample: lookalikes.slice(0, 5) },
    },
    { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=600" } },
  );
}
