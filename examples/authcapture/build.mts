// Builds the sample authCapture terms for the live Base Sepolia arbiter from the SDK, so no hash is typed by
// hand. Local files only: no network, no transactions. Run: node examples/authcapture/build.mts
import { writeFileSync } from "node:fs";
import path from "node:path";
import * as sdk from "../../arbiter-sdk/src/index.ts";

const DIR = import.meta.dirname;
const CHAIN_ID = 84532;
export const ARBITER = "0x8b4B3A8c6389a17AA7f66e18F59Afb36Cc9C453A";
export const REGISTRY = "0x30576DE005df028D1947C56dEcc85a2a5612036a";
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const EVALUATOR = "0x000f3e27EAf5d2C1A30F4fE50FF1bcC4A78f124A"; // AgentKoin test evaluator A (testnet)
const SUBMIT_BY = 1795798800; // 2026-11-27 12:00:00 EST
const EVAL_WINDOW = 21600;
const TABLE = [0, 2500, 5000, 7500, 10000];
// Deployed immutable config (record: jobs/arbiter-deploy/record.md).
const CFG = { evalWindow: 3600, challengeWindow: 600, rulingWindow: 3600, minMarginSeconds: 3600 };

export const criteria = {
  criteria_set: "agentkoin-authcapture-sample-handover",
  version: "1",
  criteria: [
    { id: "result-digest", required: true, title: "Result matches the committed digest",
      requirement: "The SHA-256 of the result bytes the evaluator retrieved equals the digest the receiver committed on-chain at submit." },
    { id: "utf8-json", required: true, title: "Result is JSON",
      requirement: "The result bytes are valid UTF-8 and parse as a single JSON value (RFC 8259)." },
    { id: "jcs-canonical", required: true, title: "Result is canonical",
      requirement: "The result bytes are identical to the RFC 8785 (JCS) serialization of the JSON value they parse to." },
    { id: "max-size", required: true, title: "Result size",
      requirement: "The result is at most 65536 bytes." },
  ],
};
const required = criteria.criteria.filter((c) => c.required).map((c) => c.id);
const enc = (s: string) => new TextEncoder().encode(s);
export const criteriaBytes = enc(sdk.canonicalJson(criteria));
export const criteriaSha256 = sdk.resultDigest(criteriaBytes);

export const schedule = {
  schema: "agentkoin.payout-schedule/1",
  network: `eip155:${CHAIN_ID}`,
  operator: ARBITER,
  asset: USDC,
  criteria_set: criteria.criteria_set,
  criteria_version: criteria.version,
  criteria_sha256: criteriaSha256.slice(2),
  required,
  bps_by_pass_count: TABLE,
  onchain: { requiredTotal: required.length, bpsTable: `0x${sdk.packBpsTable(TABLE).toString(16)}` },
  count_rule: "required_pass = number of ids in required whose result is exactly \"pass\"; \"fail\", \"not-evaluated\" and \"error\" do not count",
  pass_mask: "bit i (value 2^i) is set iff required[i] has result exactly pass; bits at or above required_total are 0",
};
export const scheduleBytes = enc(sdk.canonicalJson(schedule));
export const scheduleSha256 = sdk.resultDigest(scheduleBytes);

export const terms: sdk.Terms = {
  evaluator: EVALUATOR, criteriaHash: criteriaSha256, scheduleHash: scheduleSha256, requiredTotal: required.length,
  bpsTable: sdk.packBpsTable(TABLE), submitBy: SUBMIT_BY, evalWindow: EVAL_WINDOW,
};
const span = EVAL_WINDOW + CFG.challengeWindow + CFG.rulingWindow + CFG.minMarginSeconds;

export const sample = {
  $schema: "./terms.schema.json",
  kind: "agentkoin.authcapture-terms/0.1",
  status: "sample for a testnet handover; unaudited prototype; Base Sepolia test funds only",
  network: `eip155:${CHAIN_ID}`,
  "outside-verdict": {
    version: "0.1",
    acceptIndex: 0,
    terms: {
      evaluator: `eip155:${CHAIN_ID}:${EVALUATOR}`,
      evaluatorRegistry: `eip155:${CHAIN_ID}:${REGISTRY}`,
      criteria: { uri: "https://raw.githubusercontent.com/agentkoin/agentkoin/main/examples/authcapture/criteria.json", localPath: "examples/authcapture/criteria.json", sha256: criteriaSha256 },
      requiredChecks: required.length,
      payoutBps: TABLE,
      submitBy: SUBMIT_BY,
      evalWindowSeconds: EVAL_WINDOW,
      challengeWindowSeconds: CFG.challengeWindow,
      onMissedVerdict: "void",
    },
    termsHash: sdk.termsHash(terms),
    termsHashScheme: "AgentKoinTerms: keccak256(abi.encode(TERMS_TYPEHASH, evaluator, criteriaHash, scheduleHash, requiredTotal, bpsTable, submitBy, evalWindow)); the arbiter's TERMS_TYPEHASH, not a typehash defined by the x402 draft",
    binding: "salt-commit-v1",
    bindingSaltScheme: "PaymentInfo.salt = uint256(keccak256(abi.encode(keccak256(\"AgentKoinTermsSalt(bytes32 termsHash,uint256 saltNonce)\"), termsHash, saltNonce))); the draft text names x402OutsideVerdictSalt, the deployed arbiter uses AgentKoinTermsSalt",
  },
  arbiterTerms: {
    evaluator: terms.evaluator,
    criteriaHash: terms.criteriaHash,
    scheduleHash: terms.scheduleHash,
    requiredTotal: terms.requiredTotal,
    bpsTable: `0x${terms.bpsTable.toString(16)}`,
    submitBy: terms.submitBy,
    evalWindow: terms.evalWindow,
    termsHash: sdk.termsHash(terms),
    typehash: sdk.TERMS_TYPEHASH,
    saltTypehash: sdk.AGK_SALT_TYPEHASH,
  },
  schedule: { localPath: "examples/authcapture/schedule.json", sha256: scheduleSha256, required },
  deployment: {
    chainId: CHAIN_ID,
    arbiter: ARBITER,
    arbiterVersion: "0.1",
    arbiterSource: "Sourcify exact_match: https://repo.sourcify.dev/84532/0x8b4B3A8c6389a17AA7f66e18F59Afb36Cc9C453A",
    authCaptureEscrow: sdk.AUTH_CAPTURE_ESCROW_V1_1,
    erc3009PaymentCollector: sdk.ERC3009_COLLECTOR_V1_1,
    evaluatorRegistry: REGISTRY,
    token: USDC,
    arbitrator: sdk.ZERO,
    challengesEnabled: false,
    challengesNote: "arbitrator is the zero address, so challenge() reverts NoArbitrator; a verdict becomes final after challengeWindow with no dispute path",
    maxAmountPerPayment: "1000000",
    config: CFG,
    slasherRole: "proposed on the registry; eta 1795231907 (2026-11-20 22:31:47 EST); until executeSlasher runs, bindTerms reverts because the registry refuses lockExposure",
  },
  paymentInfoConstraints: {
    operator: ARBITER,
    token: USDC,
    maxAmountAtMost: "1000000",
    minFeeBps: 0,
    maxFeeBps: 0,
    feeReceiver: sdk.ZERO,
    refundExpiryEqualsAuthorizationExpiry: true,
    authorizationExpiryAtLeast: SUBMIT_BY + span,
    authorizationExpiryRule: "authorizationExpiry >= submitBy + evalWindow + challengeWindow + rulingWindow + minMarginSeconds",
    authorizeNoLaterThan: "now + evalWindowFloor(3600) + challengeWindow + rulingWindow + minMarginSeconds <= authorizationExpiry",
    captureMode: "deferred",
    operatorType: "custom",
    tokenCollector: sdk.ERC3009_COLLECTOR_V1_1,
  },
  lifecycle: [
    { step: "authorize", by: "anyone (facilitator)", call: "authorize(PaymentInfo,uint256,address,bytes)" },
    { step: "bindTerms", by: "the named evaluator", call: "bindTerms(PaymentInfo,Terms,uint256 saltNonce)", before: "submitBy" },
    { step: "submit", by: "receiver", v0_1: "submit(PaymentInfo,bytes32 deliverableHash)", v0_2: "submit(PaymentInfo,bytes32 deliverableHash,bytes32 resultDigest)", before: "submitBy" },
    { step: "verdict", by: "evaluator", v0_1: "verdictScheduled(PaymentInfo,uint16 passMask,uint8 requiredTotal,uint8 requiredPass,bytes32 reasonHash)", v0_2: "verdictScheduled(...,bytes32 resultDigest,bytes32 reasonHash) or verdictBySig(PaymentInfo,OutsideVerdict,bytes)", within: "evalWindow after submit" },
    { step: "finalize", by: "anyone", call: "finalize(PaymentInfo)", after: "challengeWindow after the verdict", effect: "capture amount*payoutBps/10000, void the rest" },
    { step: "timeoutRelease", by: "anyone", call: "timeoutRelease(PaymentInfo)", after: "evalWindow with no verdict", effect: "full void to payer, evaluator slashed" },
    { step: "voidNoSubmit / voidUnbound", by: "anyone", after: "submitBy", effect: "full void to payer, no slash" },
  ],
  fieldSupport: {
    deployedV0_1: ["salt-committed terms", "bindTerms by evaluator", "submit deliverableHash", "verdictScheduled (on-chain evaluator call)", "bps-table partial capture + void remainder", "timeout void + slash"],
    sourceV0_2Only: ["resultDigest committed at submit and required in every verdict", "verdictBySig (EIP-712 OutsideVerdict, domain x402 outside-verdict, version 0.2)", "BuyerAcceptance record (EIP-712, payer-signed, separate storage)", "outcome(key).buyerAccepted / buyerDecision", "Finalized event carries buyerDecision"],
    onDeployedV0_1: {
      resultDigest: "not stored by the contract; a receiver can pass the sha256 result digest as deliverableHash so the digest is still fixed on-chain at submit, and the evaluator's off-chain record can name it",
      buyerAcceptance: "no on-chain record; absence is the only state (buyerAccepted=false), and a capture does not mean the buyer accepted",
    },
  },
  resultDigest: {
    definition: "sha256 over the exact canonical bytes of the result: raw bytes, or UTF-8 of RFC 8785 (JCS) for JSON",
    example: { json: { hello: "agentkoin" }, sha256: sdk.resultDigestJson({ hello: "agentkoin" }) },
  },
  eip712: {
    domain: { name: sdk.EIP712_NAME, version: sdk.EIP712_VERSION, chainId: CHAIN_ID, verifyingContract: "the v0.2 arbiter address (not deployed)" },
    OutsideVerdict: "OutsideVerdict(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 deliverableHash,bytes32 resultDigest,uint16 passMask,uint16 payoutBps,bytes32 reasonHash)",
    OutsideVerdictTypehash: sdk.OUTSIDE_VERDICT_TYPEHASH,
    BuyerAcceptance: "BuyerAcceptance(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 resultDigest,uint8 decision,bytes32 noteHash)",
    BuyerAcceptanceTypehash: sdk.BUYER_ACCEPTANCE_TYPEHASH,
    buyerDecision: { "0": "none (no record)", "1": "accepted", "2": "rejected" },
  },
  variableFields: ["payer", "receiver", "amount", "saltNonce", "preApprovalExpiry", "authorizationExpiry"],
  generatedBy: "AgentKoin arbiter-sdk (termsHash, salt and digests are cross-checked against the arbiter contract); examples/authcapture/verify.mjs recomputes them",
  termsHashInputs: "evaluator, criteriaHash, scheduleHash, requiredTotal, bpsTable, submitBy, evalWindow; any change gives a different termsHash and salt",
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  writeFileSync(path.join(DIR, "criteria.json"), criteriaBytes);
  writeFileSync(path.join(DIR, "schedule.json"), scheduleBytes);
  writeFileSync(path.join(DIR, "terms.base-sepolia.json"), JSON.stringify(sample, null, 2) + "\n");
  console.log("termsHash", sample.arbiterTerms.termsHash, "criteria", criteriaSha256, "schedule", scheduleSha256);
}
