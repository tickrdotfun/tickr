/**
 * Every coin launched on tickr, and every name it is priced in, gets its source published on Sourcify without
 * anyone doing anything. Scanners (GMGN, DexScreener's audit partners, the explorer) read source from there, and a
 * coin without it is flagged "not open-sourced" and "possible honeypot" — for a contract that is the same bytecode
 * as every other coin here. Verification is by runtime bytecode against the compiler input the launcher's own
 * build produced, so one input per contract kind covers every coin ever launched by it.
 *
 * Two places have to hold it. Sourcify is where wallets and most tooling look; the chain's own explorer (Blockscout)
 * is where the scanners look, and it does not import from Sourcify on its own — HOLY sat verified on Sourcify for an
 * hour and stayed "closed source" on every scanner until it was submitted to the explorer as well. So each address
 * is submitted to both, remembered separately, and is done only when both have it.
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
export const EXPLORER = "https://robinhoodchain.blockscout.com";
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
/** `explorerKey`: the explorer's API key when there is one; without it the shared address space this runs from is rate-limited hard. */
export type Deps = { chain: Chain; kv: Store; fetch: typeof fetch; log?: (s: string) => void; sleep?: (ms: number) => Promise<void>; maxPerRun?: number; explorerKey?: string; maxExplorerSubmits?: number };

const NEXT = "verify:next";
const RETRY = "verify:retry";
const done = (a: string) => `verify:${a.toLowerCase()}`;
const doneExplorer = (a: string) => `explorer:${a.toLowerCase()}`;

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

/** what the explorer last answered when it did not answer well, for the log */
export let lastExplorerNote = "";
const explorerHeaders = (key?: string): Record<string, string> => (key ? { accept: "application/json", "x-api-key": key } : { accept: "application/json" });

/** Whether the explorer shows source for the address; null when it could not be asked. */
export async function explorerStatus(fetchImpl: typeof fetch, address: string, key?: string): Promise<boolean | null> {
  try {
    const r = await fetchImpl(`${EXPLORER}/api/v2/smart-contracts/${address}`, { headers: explorerHeaders(key) });
    if (!r.ok) {
      lastExplorerNote = `status ${r.status}: ${(await r.text().catch(() => "")).slice(0, 100).replace(/\s+/g, " ")}`;
      return null;
    }
    const j = (await r.json()) as { is_verified?: boolean };
    return j.is_verified === true;
  } catch {
    return null;
  }
}

/**
 * Submit one address to the explorer as one kind: the same standard JSON, through its standard-input method, the
 * constructor arguments read from the creation transaction. The explorer verifies in the background, and its answer
 * to the submission itself is not the verdict — it has answered 500 to submissions that verified seconds later —
 * so the verdict is the polled status (bounded), and only a rate limit (429) or a refusal (403) is taken at its word.
 */
export async function explorerSubmit(fetchImpl: typeof fetch, address: string, kind: Kind, sleep: (ms: number) => Promise<void>, key?: string): Promise<string> {
  const fd = new FormData();
  fd.append("compiler_version", `v${COMPILER}`);
  fd.append("license_type", "mit");
  fd.append("autodetect_constructor_args", "true");
  fd.append("files[0]", new Blob([JSON.stringify(INPUTS[kind].input)], { type: "application/json" }), "input.json");
  let r: Response;
  try {
    r = await fetchImpl(`${EXPLORER}/api/v2/smart-contracts/${address}/verification/via/standard-input`, { method: "POST", body: fd, headers: explorerHeaders(key) });
  } catch (e) {
    return `unreachable ${(e as Error).message?.slice(0, 60)}`;
  }
  if (r.status === 429 || r.status === 403) return `refused ${r.status}: ${(await r.text().catch(() => "")).slice(0, 100).replace(/\s+/g, " ")}`;
  for (let i = 0; i < 10; i++) {
    await sleep(6_000);
    if (await explorerStatus(fetchImpl, address, key)) return "verified";
  }
  return `not verified after submission (answered ${r.status})`;
}

/**
 * Verified on the explorer, or made so: true once it shows source for the address. `budget` is how many submissions
 * this run may still make: each one is polled for up to a minute, and the explorer rate-limits them, so a run
 * submits a few and leaves the rest in the retry list for the next.
 */
async function ensureExplorer(d: Deps, address: string, kind: Kind, budget: { left: number }): Promise<boolean> {
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  if ((await d.kv.get(doneExplorer(address))) === "verified") return true;
  if (await explorerStatus(d.fetch, address, d.explorerKey)) {
    await d.kv.put(doneExplorer(address), "verified");
    return true;
  }
  if (budget.left <= 0) return false;
  budget.left--;
  const line = await explorerSubmit(d.fetch, address, kind, sleep, d.explorerKey);
  d.log?.(`explorer: ${kind} ${address} -> ${line}`);
  if (line === "verified") {
    await d.kv.put(doneExplorer(address), "verified");
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
  const budget = { left: d.maxExplorerSubmits ?? 6 };
  const count = await d.chain.launchCount();
  const next = Number((await d.kv.get(NEXT)) ?? "0");
  const retry: { address: string; kind: Kind }[] = JSON.parse((await d.kv.get(RETRY)) ?? "[]");
  const verified: string[] = [];
  const failed: { address: string; kind: Kind }[] = [];
  let checked = 0;

  const attempt = async (address: string, kind: Kind) => {
    checked++;
    // both are asked every time: one refusing does not stop the other, and each remembers its own success
    const s = await ensure(d, address, kind);
    const x = await ensureExplorer(d, address, kind, budget);
    if (s && x) verified.push(address);
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
