import { NextResponse } from "next/server";

/**
 * Pins a coin's image and its metadata JSON to IPFS through Pinata. The key lives in `PINATA_JWT` on the server
 * and never reaches the browser. Without it the route answers 503 and the create page falls back to a pasted
 * link, so a missing key degrades to the old behaviour instead of a broken form.
 */
const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const UPLOAD = "https://uploads.pinata.cloud/v3/files";

async function pin(jwt: string, file: Blob, name: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", file, name);
  fd.append("network", "public");
  fd.append("name", name);
  const r = await fetch(UPLOAD, { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: fd });
  if (!r.ok) throw new Error(`pinning failed (${r.status})`);
  const out = (await r.json()) as { data?: { cid?: string } };
  if (!out.data?.cid) throw new Error("pinning returned no cid");
  return out.data.cid;
}

const WINDOW_MS = 60 * 60_000;
const PER_WINDOW = 12;
const hits = new Map<string, number[]>();
/** the site's own hosts, plus anything listed in PIN_ALLOWED_ORIGINS */
function sameSite(req: Request): boolean {
  const from = req.headers.get("origin") ?? req.headers.get("referer") ?? "";
  let host = "";
  try {
    host = new URL(from).host;
  } catch {
    return false;
  }
  const own = (process.env.PIN_ALLOWED_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const allowed = ["tickrfun.gg", "www.tickrfun.gg", "tickr-zeta.vercel.app", "tickrfun.vercel.app", "localhost:3000", "127.0.0.1:3000", ...own];
  const mine = req.headers.get("host") ?? "";
  return host === mine || allowed.includes(host);
}
/**
 * The per-address budget. On Cloudflare the count lives in KV, shared by every instance; anywhere else it is
 * in memory, which is per instance and enough for a preview. The origin check above is advisory, a script
 * can set any header; this budget is the control that costs an abuser something.
 */
async function overBudget(req: Request): Promise<boolean> {
  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  const now = Date.now();
  const hour = Math.floor(now / WINDOW_MS);
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env as { NEXT_INC_CACHE_KV?: { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> } };
    if (env.NEXT_INC_CACHE_KV) {
      const key = `pin:${ip}:${hour}`;
      const n = Number((await env.NEXT_INC_CACHE_KV.get(key)) ?? "0") + 1;
      await env.NEXT_INC_CACHE_KV.put(key, String(n), { expirationTtl: 2 * 60 * 60 });
      return n > PER_WINDOW;
    }
  } catch {
    // not on Cloudflare
  }
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5_000) hits.clear();
  return recent.length > PER_WINDOW;
}

export async function POST(req: Request) {
  if (!sameSite(req)) return NextResponse.json({ error: "pinning is for the create page only." }, { status: 403 });
  if (await overBudget(req)) return NextResponse.json({ error: "too many uploads from this address. try again in an hour, or paste an image link." }, { status: 429 });
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return NextResponse.json({ error: "pinning is not configured on this deployment yet. paste an image link instead." }, { status: 503 });
  try {
    const form = await req.formData();
    const file = form.get("file");
    const metadata = form.get("metadata");
    let image: string | undefined;
    if (file instanceof File) {
      if (!TYPES.has(file.type)) return NextResponse.json({ error: "png, jpeg, gif or webp only." }, { status: 400 });
      if (file.size > MAX_BYTES) return NextResponse.json({ error: "up to 4 MB." }, { status: 400 });
      image = `ipfs://${await pin(jwt, file, file.name || "image")}`;
    }
    let meta: string | undefined;
    if (typeof metadata === "string" && metadata.length > 0 && metadata.length < 64 * 1024) {
      const parsed = JSON.parse(metadata) as Record<string, unknown>;
      if (image) parsed.image = image;
      meta = `ipfs://${await pin(jwt, new Blob([JSON.stringify(parsed)], { type: "application/json" }), "metadata.json")}`;
    }
    return NextResponse.json({ image, metadata: meta, gateway: "https://gateway.pinata.cloud/ipfs/" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "pinning failed" }, { status: 502 });
  }
}
