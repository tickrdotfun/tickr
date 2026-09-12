/**
 * Every coin launched on tickr, and every name it is priced in, gets its source published on Sourcify without
 * anyone doing anything. Scanners (GMGN, DexScreener's audit partners, the explorer) read source from there, and a
 * coin without it is flagged "not open-sourced" and "possible honeypot" — for a contract that is the same bytecode
 * as every other coin here. Verification is by runtime bytecode against the compiler input the launcher's own
 * build produced, so one input per contract kind covers every coin ever launched by it.
 *
 * Runs on the fifteen-minute cron. It reads the factory's launch list from where it left off, checks Sourcify for
 * each new coin and its name, submits what is missing, and remembers what landed in KV so nothing is asked twice.
 * A coin that Sourcify refuses is kept in a small retry list and tried again next run, bounded, so one bad case
 * cannot stall the rest.
 *
 * Everything that reaches the outside world is passed in, so the test drives it against a fake chain and a fake
 * Sourcify.
 */
import tokenInput from "./verify/token.json";
import marketNameInput from "./verify/market-name.json";
import managedNameInput from "./verify/managed-name.json";

export const SOURCIFY = "https://sourcify.dev/server";
export const CHAIN_ID = "4663";
/** The compiler the launcher's contracts were built with. The exact string matters: "0.8.26" alone is refused. */
export const COMPILER = "0.8.26+commit.8a97fa7a";

export type Kind = "coin" | "market-name" | "managed-name";
const INPUTS: Record<Kind, { input: unknown; identifier: string }> = {
  coin: { input: tokenInput, identifier: "src/Token.sol:Token" },
  "market-name": { input: marketNameInput, identifier: "src/market/MarketTickerToken.sol:MarketTickerToken" },
  "managed-name": { input: managedNameInput, identifier: "src/ManagedTickerToken.sol:ManagedTickerToken" },
};

export type Chain = {
  launchCount(): Promise<number>;
  launchAt(i: number): Promise<string>;
  pairOf(coin: string): Promise<string>;
  /** whether `name` is a fixed-inventory name made by the market deployer; otherwise it is a v1 wrapper or not ours */
  isMarketName(name: string): Promise<boolean>;
  /** whether `name` is a v1 redeemable wrapper made by the ticker launcher */
  isManagedName(name: string): Promise<boolean>;
};
export type Store = { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> };
export type Deps = { chain: Chain; kv: Store; fetch: typeof fetch; log?: (s: string) => void; sleep?: (ms: number) => Promise<void>; maxPerRun?: number };

const NEXT = "verify:next";
const RETRY = "verify:retry";
const done = (a: string) => `verify:${a.toLowerCase()}`;

/** Sourcify's answer for an address: "match", "exact_match", or null when it has nothing. */
export async function status(fetchImpl: typeof fetch, address: string): Promise<string | null> {
  try {
    const r = await fetchImpl(`${SOURCIFY}/v2/contract/${CHAIN_ID}/${address}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { match?: string | null };
    return j.match ?? null;
  } catch {
    return null;
  }
}

/** Submit one address as one kind, and wait (bounded) for Sourcify's verdict. */
export async function submit(fetchImpl: typeof fetch, address: string, kind: Kind, sleep: (ms: number) => Promise<void>): Promise<string> {
  const { input, identifier } = INPUTS[kind];
  const r = await fetchImpl(`${SOURCIFY}/v2/verify/${CHAIN_ID}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stdJsonInput: input, compilerVersion: COMPILER, contractIdentifier: identifier }),
  });
  if (r.status !== 202) return `refused ${r.status}`;
  const { verificationId } = (await r.json()) as { verificationId: string };
  for (let i = 0; i < 12; i++) {
    await sleep(3_000);
    const s = await fetchImpl(`${SOURCIFY}/v2/verify/${verificationId}`);
    if (!s.ok) continue;
    const j = (await s.json()) as { isJobCompleted?: boolean; contract?: { match?: string | null }; error?: { customCode?: string } };
    if (j.isJobCompleted) return j.contract?.match ?? `error ${j.error?.customCode ?? "unknown"}`;
  }
  return "timeout";
}

/** Sourcify's two words for success, and nothing else: its failure code "no_match" also contains "match". */
export const isMatch = (s: string | null | undefined): boolean => s === "match" || s === "exact_match";

/** Verified, or made so: true once Sourcify has a match for the address. */
async function ensure(d: Deps, address: string, kind: Kind): Promise<boolean> {
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  if ((await d.kv.get(done(address))) === "match") return true;
  let s = await status(d.fetch, address);
  if (!isMatch(s)) s = await submit(d.fetch, address, kind, sleep);
  d.log?.(`verify: ${kind} ${address} -> ${s}`);
  if (isMatch(s)) {
    await d.kv.put(done(address), "match");
    return true;
  }
  return false;
}

/** The name a coin is priced in, if it is one of ours: which kind, or null for ETH, USDG, a Stock Token, another coin. */
async function nameKind(chain: Chain, pair: string): Promise<Kind | null> {
  if (/^0x0{40}$/i.test(pair)) return null;
  if (await chain.isMarketName(pair)) return "market-name";
  if (await chain.isManagedName(pair)) return "managed-name";
  return null;
}

/**
 * One pass: every launch since the last run, plus whatever failed last time. Returns what it did, for the log.
 */
export async function verifyNewLaunches(d: Deps): Promise<{ checked: number; verified: string[]; retry: string[] }> {
  const max = d.maxPerRun ?? 20;
  const count = await d.chain.launchCount();
  const next = Number((await d.kv.get(NEXT)) ?? "0");
  const retry: { address: string; kind: Kind }[] = JSON.parse((await d.kv.get(RETRY)) ?? "[]");
  const verified: string[] = [];
  const failed: { address: string; kind: Kind }[] = [];
  let checked = 0;

  const attempt = async (address: string, kind: Kind) => {
    checked++;
    if (await ensure(d, address, kind)) verified.push(address);
    else if (!failed.some((f) => f.address.toLowerCase() === address.toLowerCase())) failed.push({ address, kind });
  };

  // what failed before goes first, so a stuck address is not starved by new launches
  for (const r of retry.slice(0, max)) await attempt(r.address, r.kind);

  let i = next;
  for (; i < count && checked < max; i++) {
    const coin = await d.chain.launchAt(i);
    await attempt(coin, "coin");
    const pair = await d.chain.pairOf(coin);
    const kind = await nameKind(d.chain, pair);
    if (kind) await attempt(pair, kind);
  }
  await d.kv.put(NEXT, String(i));
  await d.kv.put(RETRY, JSON.stringify(failed));
  return { checked, verified, retry: failed.map((f) => f.address) };
}
