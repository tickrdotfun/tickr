// Offline cases for the signed upload permission: the message, the encoding, the clock and the signature.
// Run: node --test scripts/tests/uploadAuth.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const { privateKeyToAccount } = require("viem/accounts");
const fx = require("./fixture.cjs");
const u = fx.src("lib/uploadAuth.ts");
const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // a well-known test key, never funded
const account = privateKeyToAccount(key);
const CHAIN = 4663;
const NOW = 1_800_000_000_000;
async function signed(until = NOW + u.UPLOAD_AUTH_TTL_MS, chain = CHAIN, address = account.address) {
  const signature = await account.signMessage({ message: u.uploadMessage(address, chain, until) });
  return { address, until, signature };
}
test("the message names the wallet, the chain and the expiry in plain words", () => {
  const m = u.uploadMessage(account.address, CHAIN, NOW);
  assert.match(m, /^tickr image uploads/);
  assert.ok(m.includes(`wallet: ${account.address.toLowerCase()}`));
  assert.ok(m.includes("chain: 4663"));
  assert.ok(m.includes(new Date(NOW).toISOString()));
  assert.ok(m.includes("costs nothing and moves nothing"));
});
test("a fresh signature verifies", async () => {
  assert.equal(await u.verifyUploadAuth(await signed(), CHAIN, NOW), "ok");
});
test("the encoding round-trips and rejects anything else", async () => {
  const a = await signed();
  assert.deepEqual(u.decodeUploadAuth(u.encodeUploadAuth(a)), a);
  assert.equal(u.decodeUploadAuth(undefined), undefined);
  assert.equal(u.decodeUploadAuth("not base64 json"), undefined);
  assert.equal(u.decodeUploadAuth(btoa(JSON.stringify({ address: "0x12", until: 1, signature: "0x00" }))), undefined);
});
test("an expired permission is refused", async () => {
  assert.equal(await u.verifyUploadAuth(await signed(NOW - 1), CHAIN, NOW), "expired");
});
test("a permission that claims more than an hour is refused", async () => {
  assert.equal(await u.verifyUploadAuth(await signed(NOW + 3 * u.UPLOAD_AUTH_TTL_MS), CHAIN, NOW), "too-long");
});
test("a signature for another chain, another wallet or another expiry does not verify", async () => {
  const a = await signed();
  assert.equal(await u.verifyUploadAuth(a, 11155111, NOW), "bad-signature");
  assert.equal(await u.verifyUploadAuth({ ...a, address: "0x00000000000000000000000000000000000000a1" }, CHAIN, NOW), "bad-signature");
  assert.equal(await u.verifyUploadAuth({ ...a, until: a.until - 1000 }, CHAIN, NOW), "bad-signature");
});
