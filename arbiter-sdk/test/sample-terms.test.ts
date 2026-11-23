// Validates examples/authcapture/terms.base-sepolia.json against the SDK encoder (no network).
// The Solidity encoder check is in crosscheck.test.ts; the JSON Schema check is in the Python tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as sdk from "../src/index.ts";
import * as build from "../../examples/authcapture/build.mts";

const DIR = path.resolve(import.meta.dirname, "../../examples/authcapture");
const sample = JSON.parse(readFileSync(path.join(DIR, "terms.base-sepolia.json"), "utf8"));

test("sample file is exactly what build.mts produces", () => {
  assert.equal(readFileSync(path.join(DIR, "terms.base-sepolia.json"), "utf8"), JSON.stringify(build.sample, null, 2) + "\n");
  assert.deepEqual(new Uint8Array(readFileSync(path.join(DIR, "criteria.json"))), build.criteriaBytes);
  assert.deepEqual(new Uint8Array(readFileSync(path.join(DIR, "schedule.json"))), build.scheduleBytes);
});

test("hashes recompute from the committed documents", () => {
  const crit = readFileSync(path.join(DIR, "criteria.json"));
  const sched = readFileSync(path.join(DIR, "schedule.json"));
  assert.equal(sdk.resultDigest(new Uint8Array(crit)), sample.arbiterTerms.criteriaHash);
  assert.equal(sdk.resultDigest(new Uint8Array(sched)), sample.arbiterTerms.scheduleHash);
  assert.equal(sdk.canonicalJson(JSON.parse(crit.toString("utf8"))), crit.toString("utf8"), "criteria.json is JCS");
  assert.equal(sdk.canonicalJson(JSON.parse(sched.toString("utf8"))), sched.toString("utf8"), "schedule.json is JCS");
  const ov = sample["outside-verdict"].terms;
  assert.equal(ov.criteria.sha256, sample.arbiterTerms.criteriaHash);
  const t: sdk.Terms = { ...sample.arbiterTerms, bpsTable: BigInt(sample.arbiterTerms.bpsTable) };
  assert.equal(sdk.packBpsTable(ov.payoutBps), t.bpsTable);
  assert.equal(ov.requiredChecks, t.requiredTotal);
  assert.equal(ov.payoutBps.length, t.requiredTotal + 1);
  assert.equal(ov.submitBy, t.submitBy);
  assert.equal(ov.evalWindowSeconds, t.evalWindow);
  assert.equal(ov.evaluator, `eip155:84532:${t.evaluator}`);
  assert.equal(sdk.termsHash(t), sample.arbiterTerms.termsHash);
  assert.equal(sdk.termsHash(t), sample["outside-verdict"].termsHash);
  assert.equal(sample.arbiterTerms.typehash, sdk.TERMS_TYPEHASH);
  assert.equal(sample.arbiterTerms.saltTypehash, sdk.AGK_SALT_TYPEHASH);
});

test("deployment facts and PaymentInfo constraints are consistent", () => {
  const d = sample.deployment;
  assert.equal(d.arbiter, "0x8b4B3A8c6389a17AA7f66e18F59Afb36Cc9C453A");
  assert.equal(d.authCaptureEscrow, "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c");
  assert.equal(d.evaluatorRegistry, "0x30576DE005df028D1947C56dEcc85a2a5612036a");
  assert.equal(d.token, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  assert.equal(d.arbitrator, sdk.ZERO);
  assert.equal(d.challengesEnabled, false);
  assert.equal(d.arbiterVersion, "0.1");
  const c = d.config;
  assert.equal(sample["outside-verdict"].terms.challengeWindowSeconds, c.challengeWindow);
  assert.ok(sample.arbiterTerms.evalWindow >= c.evalWindow);
  const span = sample.arbiterTerms.evalWindow + c.challengeWindow + c.rulingWindow + c.minMarginSeconds;
  assert.equal(sample.paymentInfoConstraints.authorizationExpiryAtLeast, sample.arbiterTerms.submitBy + span);
  // A PaymentInfo that meets the constraints passes the SDK's pre-sign checks.
  const t: sdk.Terms = { ...sample.arbiterTerms, bpsTable: BigInt(sample.arbiterTerms.bpsTable) };
  const p = sdk.buildPaymentInfo({ arbiter: d.arbiter, payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", receiver: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    token: d.token, maxAmount: 100_000n, preApprovalExpiry: t.submitBy - 3600, authorizationExpiry: sample.paymentInfoConstraints.authorizationExpiryAtLeast, terms: t, saltNonce: 7n });
  assert.deepEqual(sdk.checkBeforeSigning(p, t, c, 7n), []);
  assert.ok(sdk.checkBeforeSigning({ ...p, authorizationExpiry: p.authorizationExpiry - 1, refundExpiry: p.authorizationExpiry - 1 }, t, c, 7n).length > 0);
  assert.ok(BigInt(d.maxAmountPerPayment) === 1_000_000n);
  // Honesty markers: v0.2-only fields are labelled as such.
  assert.ok(sample.fieldSupport.sourceV0_2Only.some((s: string) => s.includes("resultDigest")));
  assert.ok(sample.fieldSupport.sourceV0_2Only.some((s: string) => s.includes("BuyerAcceptance")));
});
