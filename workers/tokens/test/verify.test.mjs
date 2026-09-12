// Source verification of every launch, against a fake chain, a fake KV and a fake Sourcify.
// Run: node --test workers/tokens/test/verify.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { transpileModule, ModuleKind, ScriptTarget } from "../../../web/node_modules/typescript/lib/typescript.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// verify.ts imports JSON; transpile it to a temp ESM file with the JSON inlined as objects
const src = readFileSync(new URL("../src/verify.ts", import.meta.url), "utf8")
  .replace(/import (\w+) from "\.\/verify\/([\w-]+)\.json";/g, (_, name, file) => `const ${name} = ${readFileSync(new URL(`../src/verify/${file}.json`, import.meta.url), "utf8")};`);
const out = transpileModule(src, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
const dir = mkdtempSync(join(tmpdir(), "verify-"));
writeFileSync(join(dir, "verify.mjs"), out);
const { verifyNewLaunches, COMPILER } = await import(join(dir, "verify.mjs"));

const A = (n) => `0x${n.toString(16).padStart(40, "0")}`;

/** a chain of launches, each coin priced in a name of a given kind (or nothing) */
function world(launches, { sourcify = {}, explorer = {}, explorerRefuse = new Set() } = {}) {
  const kv = new Map();
  const posts = [];
  const verified = new Set(Object.entries(sourcify).filter(([, v]) => v === "match").map(([k]) => k.toLowerCase()));
  const jobs = new Map();
  const explorerVerified = new Set(Object.entries(explorer).filter(([, v]) => v === true).map(([k]) => k.toLowerCase()));
  const explorerPosts = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    let m;
    // the explorer: a status read, and the standard-input submission (multipart), which verifies unless told to refuse
    if ((m = u.match(/blockscout\.com\/api\/v2\/smart-contracts\/(0x[0-9a-fA-F]+)$/))) return { ok: true, json: async () => ({ is_verified: explorerVerified.has(m[1].toLowerCase()) }) };
    if ((m = u.match(/blockscout\.com\/api\/v2\/smart-contracts\/(0x[0-9a-fA-F]+)\/verification\/via\/standard-input$/))) {
      const fd = init.body;
      explorerPosts.push({ address: m[1], compiler: fd.get("compiler_version"), file: fd.get("files[0]") });
      if (explorerRefuse.has(m[1].toLowerCase())) return { ok: false, status: 429, text: async () => "Too many requests" };
      explorerVerified.add(m[1].toLowerCase());
      // what the real explorer does: an error page for the submission, and the verification anyway
      return { ok: false, status: 500, text: async () => "<html>Internal Server Error</html>" };
    }
    if ((m = u.match(/v2\/contract\/4663\/(0x[0-9a-fA-F]+)$/))) return { ok: true, json: async () => ({ match: verified.has(m[1].toLowerCase()) ? "match" : null }) };
    if ((m = u.match(/v2\/verify\/4663\/(0x[0-9a-fA-F]+)$/))) {
      const body = JSON.parse(init.body);
      posts.push({ address: m[1], identifier: body.contractIdentifier, compiler: body.compilerVersion });
      const id = `job-${posts.length}`;
      const c = launches.find((l) => l.coin.toLowerCase() === m[1].toLowerCase());
      const n = launches.find((l) => (l.name ?? "").toLowerCase() === m[1].toLowerCase());
      const kind = c ? "coin" : n ? n.kind : null;
      const rightIdentifier = { coin: "src/Token.sol:Token", "market-name": "src/market/MarketTickerToken.sol:MarketTickerToken", "managed-name": "src/ManagedTickerToken.sol:ManagedTickerToken" }[kind];
      const ok = kind && body.contractIdentifier === rightIdentifier && !(c?.refuse || n?.refuse);
      jobs.set(id, ok ? "match" : "error");
      if (ok) verified.add(m[1].toLowerCase());
      return { status: 202, json: async () => ({ verificationId: id }) };
    }
    if ((m = u.match(/v2\/verify\/(job-\d+)$/))) {
      const r = jobs.get(m[1]);
      return { ok: true, json: async () => ({ isJobCompleted: true, contract: { match: r === "match" ? "match" : null }, error: r === "error" ? { customCode: "no_match" } : undefined }) };
    }
    throw new Error("unexpected url " + u);
  };
  const chain = {
    launchCount: async () => launches.length,
    launchAt: async (i) => launches[i].coin,
    pairOf: async (coin) => launches.find((l) => l.coin === coin).name ?? A(0),
    isMarketName: async (name) => launches.some((l) => l.name === name && l.kind === "market-name"),
    isManagedName: async (name) => launches.some((l) => l.name === name && l.kind === "managed-name"),
  };
  const deps = { chain, kv: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) }, fetch: fetchImpl, sleep: async () => {}, log: () => {} };
  return { deps, kv, posts, verified, explorerPosts, explorerVerified, explorerRefuse };
}

test("a coin under a v2 name and a coin under a v1 wrapper: both coins and both names are submitted with the right input", async () => {
  const w = world([
    { coin: A(0x6942), name: A(0xf0), kind: "market-name" },
    { coin: A(0x1111), name: A(0xf9), kind: "managed-name" },
  ]);
  const r = await verifyNewLaunches(w.deps);
  assert.equal(r.checked, 4);
  assert.equal(r.verified.length, 4);
  assert.deepEqual(r.retry, []);
  assert.deepEqual(w.posts.map((p) => p.identifier), ["src/Token.sol:Token", "src/market/MarketTickerToken.sol:MarketTickerToken", "src/Token.sol:Token", "src/ManagedTickerToken.sol:ManagedTickerToken"]);
  assert.ok(w.posts.every((p) => p.compiler === COMPILER), "the exact compiler string, every time");
  assert.equal(w.kv.get("verify:next"), "2", "and it remembers where it got to");
  assert.deepEqual(w.explorerPosts.map((p) => p.address.toLowerCase()), [A(0x6942), A(0xf0), A(0x1111), A(0xf9)], "the explorer gets the same four");
  assert.ok(w.explorerPosts.every((p) => p.compiler === `v${COMPILER}` && p.file instanceof Blob), "as multipart standard input, the explorer's compiler spelling");
});

test("an address is done only when Sourcify and the explorer both have it; the explorer's rate limit is a retry that does not re-ask Sourcify", async () => {
  const w = world([{ coin: A(0x7777) }], { explorerRefuse: new Set([A(0x7777)]) });
  const r = await verifyNewLaunches(w.deps);
  assert.deepEqual(r.verified, []);
  assert.deepEqual(r.retry.map((a) => a.toLowerCase()), [A(0x7777)]);
  assert.equal(w.kv.get(`verify:${A(0x7777)}`), "match", "Sourcify's success is remembered on its own");
  assert.equal(w.kv.get(`explorer:${A(0x7777)}`), undefined);
  w.explorerRefuse.clear(); // next run: the explorer accepts
  const r2 = await verifyNewLaunches(w.deps);
  assert.deepEqual(r2.verified.map((a) => a.toLowerCase()), [A(0x7777)]);
  assert.equal(w.posts.length, 1, "Sourcify was asked once in total");
  assert.equal(w.kv.get(`explorer:${A(0x7777)}`), "verified");
});

test("a run submits only so many to the explorer; the rest wait in the retry list, Sourcify done", async () => {
  const w = world(Array.from({ length: 5 }, (_, i) => ({ coin: A(0x20000 + i) })));
  const r = await verifyNewLaunches({ ...w.deps, maxExplorerSubmits: 2 });
  assert.equal(w.explorerPosts.length, 2);
  assert.equal(r.verified.length, 2);
  assert.equal(r.retry.length, 3);
  assert.equal(w.posts.length, 5, "Sourcify got all five");
  const r2 = await verifyNewLaunches({ ...w.deps, maxExplorerSubmits: 2 });
  assert.equal(r2.verified.length, 2);
  assert.equal(w.posts.length, 5, "and is not asked again");
  const r3 = await verifyNewLaunches({ ...w.deps, maxExplorerSubmits: 2 });
  assert.equal(r3.verified.length, 1);
  assert.deepEqual(r3.retry, []);
});

test("what the explorer already shows is not submitted to it again", async () => {
  const w = world([{ coin: A(0x8888) }], { explorer: { [A(0x8888)]: true } });
  await verifyNewLaunches(w.deps);
  assert.equal(w.explorerPosts.length, 0);
  assert.equal(w.posts.length, 1, "Sourcify still needed it");
});

test("what is already verified, or was verified by an earlier run, is not submitted again", async () => {
  const w = world([{ coin: A(0x6942), name: A(0xf0), kind: "market-name" }], { sourcify: { [A(0x6942)]: "match" } });
  await verifyNewLaunches(w.deps);
  assert.deepEqual(w.posts.map((p) => p.address.toLowerCase()), [A(0xf0)], "only the name needed submitting");
  const again = await verifyNewLaunches(w.deps);
  assert.equal(again.checked, 0, "nothing new: nothing asked");
  assert.equal(w.posts.length, 1);
});

test("a coin priced in ETH, USDG, a stock or another coin submits the coin only", async () => {
  const w = world([{ coin: A(0x2222) }, { coin: A(0x3333), name: A(0xbeef), kind: "other" }]);
  const r = await verifyNewLaunches(w.deps);
  assert.equal(r.checked, 2);
  assert.deepEqual(w.posts.map((p) => p.address.toLowerCase()), [A(0x2222), A(0x3333)]);
});

test("a refusal is kept for retry, tried first next run, and does not stall the rest", async () => {
  const launches = [{ coin: A(0x4444), refuse: true }, { coin: A(0x5555) }];
  const w = world(launches);
  const r = await verifyNewLaunches(w.deps);
  assert.deepEqual(r.retry.map((a) => a.toLowerCase()), [A(0x4444)]);
  assert.deepEqual(r.verified.map((a) => a.toLowerCase()), [A(0x5555)], "the good one went through");
  launches[0].refuse = false; // whatever was wrong is fixed
  const r2 = await verifyNewLaunches(w.deps);
  assert.deepEqual(r2.verified.map((a) => a.toLowerCase()), [A(0x4444)]);
  assert.deepEqual(r2.retry, []);
  assert.equal(w.kv.get("verify:retry"), "[]");
});

test("a run is bounded, and picks up where it stopped", async () => {
  const w = world(Array.from({ length: 30 }, (_, i) => ({ coin: A(0x10000 + i) })));
  const r1 = await verifyNewLaunches({ ...w.deps, maxPerRun: 20, maxExplorerSubmits: 30 });
  assert.equal(r1.checked, 20);
  assert.equal(w.kv.get("verify:next"), "20");
  const r2 = await verifyNewLaunches({ ...w.deps, maxPerRun: 20, maxExplorerSubmits: 30 });
  assert.equal(r2.checked, 10);
  assert.equal(w.kv.get("verify:next"), "30");
  assert.equal(w.verified.size, 30);
});
