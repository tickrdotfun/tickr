import { createPublicClient, custom } from "viem";
import { serialize } from "@/lib/bigjson";
import { ADDRESSES, DEPLOYED } from "@/lib/addresses";
import { CHAIN_ID, robinhoodChain } from "@/lib/chain";
import { loadLaunches } from "@/lib/launches";
import { loadMarket } from "@/lib/market";

/**
 * The home data, read once on the server and shared by everyone: the launches and the market for the default
 * window. Kept in the site's KV for a short while, so a visit costs one request instead of a run of chain reads,
 * and refreshed behind the answer when it is older than a few seconds. Amounts travel as tagged bigints.
 *
 * Workers share outbound addresses, and the public node rate-limits a burst from that shared space, so the server's
 * reads go one at a time with a gap between them and a pause and retry on a refusal. One build runs at a time.
 */
export const dynamic = "force-dynamic";
const FRESH_MS = 8_000;
const KEEP_S = 600;
const GAP_MS = 250;
const KEY = `snapshot:${CHAIN_ID}:${ADDRESSES.factory}`;
const LOCK = `${KEY}:building`;
type Kv = { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>; delete(k: string): Promise<void> };
type Ctx = { waitUntil(p: Promise<unknown>): void };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(url: string, method: string, params: unknown, attempt = 0): Promise<unknown> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(6_000) });
  if (r.status === 429 || r.status >= 500) {
    if (attempt < 4) {
      await sleep(700 * (attempt + 1));
      return rpc(url, method, params, attempt + 1);
    }
    throw new Error(`rpc ${r.status}`);
  }
  const j = (await r.json()) as { result?: unknown; error?: { message?: string; code?: number } };
  if (j.error) throw Object.assign(new Error(j.error.message ?? "rpc error"), { code: j.error.code });
  return j.result;
}
/** a viem transport whose requests go one at a time, a gap apart */
function paced(url: string) {
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;
  return custom({
    request: ({ method, params }: { method: string; params?: unknown }) => {
      const next = queue.then(async () => {
        const wait = last + GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        return rpc(url, method, params ?? []);
      });
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  });
}

const BUDGET_MS = 25_000;
async function build(): Promise<string> {
  const client = createPublicClient({ chain: robinhoodChain, transport: paced(robinhoodChain.rpcUrls.default.http[0]) });
  // a build that the node keeps refusing stops within its budget rather than holding a request open
  const work = (async () => {
    const launches = await loadLaunches(client);
    const market = await loadMarket(client, launches, "all");
    return serialize({ at: Date.now(), launches, market });
  })();
  const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("snapshot: over budget")), BUDGET_MS));
  return Promise.race([work, late]);
}

// switched off on launch night: the public node rate-limits the shared addresses Cloudflare workers send from, so a
// server build rarely finishes inside its budget. the site paints from its kept reads and its own chain reads until
// the site has a node of its own; set SNAPSHOT=on to turn this back on
const ON = process.env.SNAPSHOT === "on";
export async function GET() {
  if (!ON || !DEPLOYED || process.env.NEXT_PUBLIC_DEMO === "1") return new Response("not found", { status: 404 });
  let kv: Kv | undefined;
  let ctx: Ctx | undefined;
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const cf = getCloudflareContext() as unknown as { env: Record<string, unknown>; ctx?: Ctx };
    kv = cf.env.NEXT_INC_CACHE_KV as Kv | undefined;
    ctx = cf.ctx;
  } catch {
    kv = undefined;
  }
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=3, s-maxage=8, stale-while-revalidate=120" };
  // one build at a time: a second visitor during a build gets what is kept, or nothing and reads the chain itself
  const buildOnce = async (): Promise<string | undefined> => {
    if (kv && (await kv.get(LOCK))) return undefined;
    if (kv) await kv.put(LOCK, "1", { expirationTtl: 30 }).catch(() => undefined);
    try {
      const fresh = await build();
      if (kv) await kv.put(KEY, fresh, { expirationTtl: KEEP_S }).catch(() => undefined);
      return fresh;
    } finally {
      if (kv) await kv.delete(LOCK).catch(() => undefined);
    }
  };
  try {
    const kept = kv ? await kv.get(KEY) : null;
    if (kept) {
      const at = Number((kept.match(/"at":(\d+)/) ?? [])[1] ?? 0);
      if (Date.now() - at >= FRESH_MS) {
        const refresh = buildOnce().catch(() => undefined);
        if (ctx) ctx.waitUntil(refresh);
      }
      return new Response(kept, { headers });
    }
    // nothing kept yet: this visitor reads the chain itself, and the build runs behind this answer for the next one
    const first = buildOnce().catch(() => undefined);
    if (ctx) ctx.waitUntil(first);
    return new Response(JSON.stringify({ building: true }), { status: 503, headers: { "content-type": "application/json", "retry-after": "10" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 300) : "snapshot failed" }), { status: 502, headers: { "content-type": "application/json" } });
  }
}
