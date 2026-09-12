import { NextResponse } from "next/server";
import { createPublicClient, http, parseEther, type Address } from "viem";
import { decodeUploadAuth, verifyUploadAuth } from "@/lib/uploadAuth";
import { CHAIN_ID, robinhoodChain } from "@/lib/chain";
import { askWorker, decideBudget, type BudgetDecision } from "@/lib/pinBudget";

/**
 * Pins a coin's image to IPFS through Pinata. The key lives in `PINATA_JWT` on the server and never reaches the
 * browser. Without it the route answers 503 and the create page stores the image with the coin instead.
 *
 * What stands between a script and the pinning bill, in order: the origin check (advisory, a header can be forged),
 * shared counters in the tokens Worker (per address, for everyone, and a hard daily budget), and a memory of files
 * already pinned so the same bytes are never pinned or counted twice. When those counters cannot be asked, or do not
 * answer properly within three seconds, the upload is refused with a 503, never let through on a count of this
 * instance's own (lib/pinBudget.ts). A wallet signature can be demanded on top
 * (UPLOAD_SIGNATURE=on), which ties every upload to a funded address; it is off, because signing to pick a picture
 * reads as a transaction to the person doing it. Every decision is logged as one JSON line for the Worker's observability. A creator never sees any
 * of it fail: whenever this route says no, the create page stores the image on-chain with the coin instead.
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
  const dev = process.env.NODE_ENV !== "production" ? ["localhost:3000", "127.0.0.1:3000"] : [];
  const allowed = ["tickrfun.gg", "www.tickrfun.gg", "tickr-zeta.vercel.app", "tickrfun.vercel.app", ...dev, ...own];
  const mine = req.headers.get("host") ?? "";
  return host === mine || allowed.includes(host);
}

/** a wallet signature on every upload, off unless asked for; the counters and the dedup stand either way */
const SIGN = process.env.UPLOAD_SIGNATURE === "on" && process.env.NEXT_PUBLIC_DEMO !== "1";
/** a signed-in wallet must hold this much on the site's chain: a launch costs more, so every creator has it */
const MIN_FUNDED = parseEther("0.0001");
const balances = new Map<string, { at: number; ok: boolean }>();
async function funded(address: Address): Promise<boolean> {
  const k = address.toLowerCase();
  const c = balances.get(k);
  const now = Date.now();
  if (c && now - c.at < 10 * 60_000) return c.ok;
  try {
    const client = createPublicClient({ chain: robinhoodChain, transport: http(robinhoodChain.rpcUrls.default.http[0]) });
    const ok = (await client.getBalance({ address })) >= MIN_FUNDED;
    if (balances.size > 5_000) balances.clear();
    balances.set(k, { at: now, ok });
    return ok;
  } catch {
    return c?.ok ?? false;
  }
}

/** the shared accounting in the tokens Worker; `undefined` when it cannot be reached, and the caller decides */
const TOKENS = process.env.TOKENS_URL;
const KEY = process.env.BUDGET_KEY;
function shared(): boolean {
  return !!TOKENS && !!KEY;
}
function worker<T>(path: string, body?: unknown): Promise<T | undefined> {
  return askWorker<T>(TOKENS, KEY, path, body);
}
/** a development server with no Worker counts on its own, thirty an hour per address; a deployment never does */
const LOCAL_ONLY = process.env.NODE_ENV !== "production" && !shared();
const LOCAL_WINDOW_MS = 60 * 60_000;
const LOCAL_PER_WINDOW = 30;
const hits = new Map<string, number[]>();
function overLocalBudget(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < LOCAL_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5_000) hits.clear();
  return recent.length > LOCAL_PER_WINDOW;
}
/** the shared budget's answer; unreachable, slow or malformed is a refusal (lib/pinBudget.ts) */
async function overBudget(ip: string, wallet?: string): Promise<BudgetDecision> {
  const answer = shared() ? await worker<unknown>("budget", { ip, wallet }) : undefined;
  return decideBudget(answer, { allowed: LOCAL_ONLY, over: () => overLocalBudget(ip) });
}
function clientIp(req: Request): string {
  return (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}
async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function log(event: Record<string, unknown>) {
  console.log(JSON.stringify({ pin: true, at: new Date().toISOString(), ...event }));
}

/** The request body up to `max` bytes; undefined once it runs over, with the rest never read. */
async function readCapped(req: Request, max: number): Promise<ArrayBuffer | undefined> {
  const reader = req.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    parts.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(size));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer as ArrayBuffer;
}

/** Which controls this deployment has, so an operator can check a deploy without uploading anything. */
// every answer, the diagnostics included, is read at request time, never baked at build
export const dynamic = "force-dynamic";

export async function GET() {
  let kv = false;
  const stats = await worker<unknown>("pin-stats");
  // the create page pins only when this says so, and otherwise stores the image with the coin: so it says so only
  // when an upload could actually pass the budget, which needs the Worker to answer (or a dev server's own count)
  const pinning = !!process.env.PINATA_JWT && (LOCAL_ONLY || stats !== undefined);
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env as Record<string, unknown>;
    kv = !!env.NEXT_INC_CACHE_KV;
    // names only, never values: which secrets the worker was given, and whether they reached process.env
    const secretNames = Object.keys(env).filter((k) => /JWT|KEY|SECRET/i.test(k));
    return NextResponse.json({ pinning, envHasJwt: "PINATA_JWT" in env, secretNames, kv, signature: SIGN, shared: shared(), stats, bindings: Object.keys(env).filter((k) => !/JWT|KEY|SECRET/i.test(k)) });
  } catch {
    return NextResponse.json({ pinning, kv, signature: SIGN, shared: shared(), stats, bindings: [] });
  }
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!sameSite(req)) return NextResponse.json({ error: "pinning is for the create page only.", code: "origin" }, { status: 403 });
  // who is asking, when a signature is demanded: a wallet that signed for uploads and holds ETH here
  let wallet: Address | undefined;
  if (SIGN) {
    const auth = decodeUploadAuth(req.headers.get("x-upload-auth"));
    if (!auth) return NextResponse.json({ error: "connect a wallet and sign once to upload images.", code: "auth" }, { status: 401 });
    const verdict = await verifyUploadAuth(auth, CHAIN_ID);
    if (verdict !== "ok") {
      log({ refused: "signature", verdict, ip });
      return NextResponse.json({ error: "the upload signature is not valid any more. pick the image again.", code: "auth" }, { status: 401 });
    }
    if (!(await funded(auth.address))) {
      log({ refused: "unfunded", wallet: auth.address, ip });
      return NextResponse.json({ error: "uploads need a wallet that holds some eth here.", code: "auth" }, { status: 401 });
    }
    wallet = auth.address;
  }
  // the size is refused from the header, before any of the body is read
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES + 64 * 1024) return NextResponse.json({ error: "up to 4 MB.", code: "size" }, { status: 413 });
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return NextResponse.json({ error: "pinning is not configured on this deployment yet. paste an image link instead.", code: "off" }, { status: 503 });
  try {
    // the body is read with a byte count and cut off at the limit before any of it is parsed, whatever the header said
    const body = await readCapped(req, MAX_BYTES + 64 * 1024);
    if (!body) return NextResponse.json({ error: "up to 4 MB.", code: "size" }, { status: 413 });
    const form = await new Request(req.url, { method: "POST", headers: req.headers, body }).formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "no image in the request.", code: "file" }, { status: 400 });
    if (!TYPES.has(file.type)) return NextResponse.json({ error: "png, jpeg, gif or webp only.", code: "file" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "up to 4 MB.", code: "size" }, { status: 400 });
    // the same bytes pinned before come back from memory: nothing sent to Pinata, nothing counted
    const bytes = await file.arrayBuffer();
    const hash = await sha256(bytes);
    const seen = await worker<{ image?: string }>(`pin-seen?hash=${hash}`);
    if (seen?.image) {
      log({ ok: true, deduplicated: true, wallet, ip, bytes: file.size });
      return NextResponse.json({ image: seen.image, gateway: "https://gateway.pinata.cloud/ipfs/", deduplicated: true });
    }
    const budget = await overBudget(ip, wallet);
    if (budget.over && budget.unavailable) {
      log({ refused: "budget-unavailable", by: budget.by, wallet, ip });
      return NextResponse.json({ error: "uploads are paused right now. the create page stores the image with the coin instead.", code: "budget-unavailable" }, { status: 503 });
    }
    if (budget.over) {
      log({ refused: "budget", by: budget.by, wallet, ip });
      return NextResponse.json({ error: "too many uploads right now. the create page stores the image with the coin instead.", code: "budget" }, { status: 429 });
    }
    const image = `ipfs://${await pin(jwt, new Blob([bytes], { type: file.type }), file.name || "image")}`;
    await worker("pin-record", { hash, image });
    log({ ok: true, wallet, ip, bytes: file.size, counted: budget.by });
    return NextResponse.json({ image, gateway: "https://gateway.pinata.cloud/ipfs/" });
  } catch (e) {
    log({ failed: e instanceof Error ? e.message.slice(0, 120) : "pinning failed", ip });
    return NextResponse.json({ error: e instanceof Error ? e.message : "pinning failed", code: "failed" }, { status: 502 });
  }
}
