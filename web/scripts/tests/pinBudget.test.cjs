// Paid uploads fail closed: an unreachable, slow, failing or malformed shared budget refuses the upload, and only a
// development server with no Worker at all counts on its own.
// Run: node --test scripts/tests/pinBudget.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const fs = require("node:fs"), path = require("node:path");
const fx = require("./fixture.cjs");
const { decideBudget, askWorker } = fx.src("lib/pinBudget.ts");

const deployed = { allowed: false, over: () => assert.fail("a deployment never counts locally") };

test("the shared answer decides when there is one", () => {
  assert.deepEqual(decideBudget({ allowed: true, by: "wallet" }, deployed), { over: false, by: "wallet" });
  assert.deepEqual(decideBudget({ allowed: false, by: "daily" }, deployed), { over: true, by: "daily" });
  assert.deepEqual(decideBudget({ allowed: true }, deployed), { over: false, by: "shared" });
});

test("no answer refuses the upload on a deployment", () => {
  assert.deepEqual(decideBudget(undefined, deployed), { over: true, by: "unavailable", unavailable: true });
});

test("an answer that is not one refuses it too", () => {
  for (const bad of [null, "yes", 1, [], {}, { allowed: "true" }, { allowed: 1 }]) {
    assert.equal(decideBudget(bad, deployed).over, true, JSON.stringify(bad));
    assert.equal(decideBudget(bad, deployed).unavailable, true);
  }
});

test("only a development server with no Worker counts on its own", () => {
  assert.deepEqual(decideBudget(undefined, { allowed: true, over: () => false }), { over: false, by: "local" });
  assert.deepEqual(decideBudget(undefined, { allowed: true, over: () => true }), { over: true, by: "local" });
});

test("the Worker's outage, error status, exception, timeout and missing configuration all read as no answer", async () => {
  const never = () => assert.fail("no request without configuration");
  assert.equal(await askWorker(undefined, "k", "budget", {}, never), undefined, "no url");
  assert.equal(await askWorker("https://w/", undefined, "budget", {}, never), undefined, "no key");
  assert.equal(await askWorker("https://w/", "k", "budget", {}, async () => ({ ok: false, status: 503, json: async () => ({ allowed: true }) })), undefined, "503");
  assert.equal(await askWorker("https://w/", "k", "budget", {}, async () => { throw new Error("down"); }), undefined, "unreachable");
  assert.equal(await askWorker("https://w/", "k", "budget", {}, async () => ({ ok: true, json: async () => { throw new Error("not json"); } })), undefined, "unparseable");
  const hang = (_u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const t0 = Date.now();
  assert.equal(await askWorker("https://w/", "k", "budget", {}, hang, 50), undefined, "too slow");
  assert.ok(Date.now() - t0 < 2_000, "and it gave up on time");
  assert.deepEqual(await askWorker("https://w/", "k", "budget", { ip: "1" }, async () => ({ ok: true, json: async () => ({ allowed: true }) })), { allowed: true });
});

test("the route refuses with 503 when the budget cannot be asked, and a deployment never counts locally", () => {
  const s = fs.readFileSync(path.join(__dirname, "..", "..", "src", "app", "api", "pin", "route.ts"), "utf8");
  assert.match(s, /const LOCAL_ONLY = process\.env\.NODE_ENV !== "production" && !shared\(\);/);
  assert.match(s, /decideBudget\(answer, \{ allowed: LOCAL_ONLY/);
  assert.match(s, /budget\.over && budget\.unavailable[\s\S]{0,300}status: 503/);
  assert.match(s, /const pinning = !!process\.env\.PINATA_JWT && \(LOCAL_ONLY \|\| stats !== undefined\);/, "and says it cannot pin, so the page stores the image with the coin");
});
