import { NextResponse } from "next/server";
import { buildChainTokens, lastStats, type ChainToken } from "@/lib/chainTokens";

export type { ChainToken };

const TTL_MS = 5 * 60_000;
let memo: { at: number; data: ChainToken[] } | undefined;

/**
 * The tokens a launch can be priced in. On Cloudflare the list is built every five minutes by the `tickr-tokens`
 * Worker and read from here in one request, because working it out takes a Blockscout crawl and a pile of chain
 * reads that no visitor should wait for. `TOKENS_URL` names that Worker; without it the list is built in process,
 * which is what a local run and a Vercel deployment do.
 */
export async function GET() {
  const now = Date.now();
  const upstream = process.env.TOKENS_URL;
  if (upstream) {
    try {
      const r = await fetch(upstream, { headers: { accept: "application/json" } });
      if (r.ok) {
        const d = (await r.json()) as { tokens?: ChainToken[]; at?: number; stats?: unknown };
        return NextResponse.json(
          { tokens: d.tokens ?? [], at: d.at ?? now, stats: d.stats ?? null },
          { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=600" } },
        );
      }
    } catch {
      // fall through to the in-process build
    }
  }
  if (!memo || now - memo.at > TTL_MS) {
    try {
      memo = { at: now, data: await buildChainTokens() };
      lastStats.error = undefined;
    } catch (e) {
      lastStats.error = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      memo = memo ?? { at: now, data: [] };
    }
  }
  return NextResponse.json({ tokens: memo.data, at: memo.at, stats: lastStats }, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=900" } });
}
