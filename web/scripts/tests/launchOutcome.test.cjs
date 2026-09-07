// Offline cases for what a creation run's ending means: a failure before the wallet was asked is never a lost answer.
// Run: node --test scripts/tests/launchOutcome.test.cjs
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const fx = require("./fixture.cjs");
const { afterRun, isRejection } = fx.src("lib/launchOutcome.ts");
const base = { sendInvoked: true, storedStatus: "prepared", failure: new Error("boom"), squat: false, retriedSquat: false };
test("a hash is a settled run", () => assert.equal(afterRun({ ...base, hash: "0x" + "1".repeat(64) }), "settled"));
test("a record the wallet already marked sent stays sent, whatever the runner threw", () => assert.equal(afterRun({ ...base, storedStatus: "sent" }), "sent"));
test("a failure before the wallet was asked is not-sent, never unknown", () => {
  assert.equal(afterRun({ ...base, sendInvoked: false }), "not-sent");
  assert.equal(afterRun({ ...base, sendInvoked: false, failure: new Error("the wallet's active account changed") }), "not-sent");
  assert.equal(afterRun({ ...base, sendInvoked: false, failure: undefined }), "not-sent");
});
test("the wallet's own decline is the one definite decline once asked", () => {
  assert.equal(afterRun({ ...base, failure: Object.assign(new Error("User rejected the request."), { code: 4001 }) }), "declined");
  assert.equal(afterRun({ ...base, failure: new Error("MetaMask Tx Signature: User denied transaction signature.") }), "declined");
  assert.equal(afterRun({ ...base, failure: { cause: { code: 4001 } } }), "declined");
});
test("a taken pool key is retried once", () => {
  assert.equal(afterRun({ ...base, squat: true }), "squat");
  assert.equal(afterRun({ ...base, squat: true, retriedSquat: true }), "unknown");
});
test("anything else after the wallet was asked is unknown and keeps the record", () => {
  assert.equal(afterRun({ ...base, failure: new Error("network error") }), "unknown");
  assert.equal(afterRun({ ...base, failure: new Error("timeout") }), "unknown");
});
test("isRejection reads the code, the cause and the words", () => {
  assert.equal(isRejection({ code: 4001 }), true);
  assert.equal(isRejection(new Error("nonce too low")), false);
  assert.equal(isRejection(undefined), false);
});
