// Self-verifying job proofs: check logic (pass + fail per check), proof signature, read-only guarantee, and an end-to-end run
// against the local Anvil deployment (skipped when 127.0.0.1:8545 is down). LIVE_VERIFY=1 additionally runs the CLI core against
// Base Sepolia jobs 30 (v0.5), 3 (v0.6) read-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { evaluateChecks, proofBundle, verifyProofSignature, crossCheck, collect, NOTARY_SPEC_TEXT, sha256Hex, ESCROWS, LEGACY_SPEC_TEXTS, LEGACY_DELIVERABLES, CROSS_CURRENCY_SETTLERS } from "../lib/job-proof.mjs";
import { jcs } from "../lib/canonical.mjs";
import { signEip191 } from "../lib/sign.mjs";

const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const H = (s) => "0x" + createHash("sha256").update(s).digest("hex");
const CLIENT = A(1), PROVIDER = A(2), EVALUATOR = A(3), ESCROW = A(9), ROUTE = A(7), FACILITATOR = A(8);
const criteriaBytes = Buffer.from('{"criteria":[]}');
const receiptBytes = Buffer.from('{"v":"agentcoin-notary/v1"}');

/** Synthetic, internally consistent evidence for a settled sha256-mode job. */
const evidence = (o = {}) => {
  const ev = {
    escrow: ESCROW, jobId: "5", chainId: 84532, escrowVersion: "v0.5", escrowHasCode: true, exists: true, escrowCodeHash: "0x" + "11".repeat(32),
    job: { state: "Settled", outcome: "Complete", client: CLIENT, provider: PROVIDER, evaluator: EVALUATOR, amount: "10000", instant: false, payoutBps: 10000, deadline: 1, submittedAt: 5, verdictAt: 9, specHash: H(criteriaBytes), deliverableHash: H(receiptBytes), reasonHash: "0x" + "00".repeat(32), configVersion: 1 },
    created: { blockNumber: "100", amount: "10000", client: CLIENT, provider: PROVIDER, evaluator: EVALUATOR, specHash: H(criteriaBytes), deadline: 1 },
    payment: { txHash: "0xaa", blockNumber: "100", logIndex: 1, txSender: FACILITATOR, client: CLIENT, amount: "10000", token: A(5), transfers: [], intoEscrow: [{ from: ROUTE, value: "10000" }], path: "deposit route (client -> route -> escrow)", route: ROUTE, facilitator: FACILITATOR },
    submit: { provider: PROVIDER, deliverableHash: H(receiptBytes), timestamp: 6, blockNumber: "101" },
    verdict: { evaluator: EVALUATOR, outcome: "Complete", payoutBps: 10000, reasonHash: "0x" + "00".repeat(32), txFrom: EVALUATOR, timestamp: 9, blockNumber: "110" },
    settled: { payoutBps: 10000 },
    evaluator: { address: EVALUATOR, registry: A(6), stake: "2000000", minStake: "2000000", atBlock: "110" },
    criteria: { specHash: H(criteriaBytes), sha256: H(criteriaBytes), url: "https://x/c", length: criteriaBytes.length, candidates: [], defaultSpec: { text: NOTARY_SPEC_TEXT, keccak256: keccak256(toBytes(NOTARY_SPEC_TEXT)) } },
    deliverable: { deliverableHash: H(receiptBytes), url: "https://x/d", hashAlgorithm: "sha256", length: receiptBytes.length, candidates: [] },
    sourcify: { match: "exact_match", runtimeMatch: "exact_match" },
    txs: {}, errors: [], blockNumber: "200",
  };
  return Object.assign(ev, o);
};
const status = (ev, id) => evaluateChecks(ev).find((c) => c.id === id)?.status;
const clone = (o) => JSON.parse(JSON.stringify(o));

test("all checks pass on consistent evidence", () => {
  const r = evaluateChecks(evidence());
  assert.deepEqual(r.map((c) => c.id), ["job-onchain", "spec-hash", "deliverable-hash", "payment-flow", "submit-tx", "verdict-signer", "settlement", "evaluator-stake", "escrow-bytecode"]);
  for (const c of r) assert.equal(c.status, "pass", c.id);
  for (const c of r) assert.ok(c.claim && c.how && "expected" in c, c.id);
});

test("job-onchain: missing code or missing job fails", () => {
  assert.equal(status(evidence({ escrowHasCode: false }), "job-onchain"), "fail");
  assert.equal(status(evidence({ exists: false }), "job-onchain"), "fail");
});

test("spec-hash: a tampered criteria byte fails; default keccak spec text passes; unknown spec fails", () => {
  const ev = evidence();
  const tampered = Buffer.from(criteriaBytes); tampered[3] ^= 1;
  ev.criteria.sha256 = sha256Hex(tampered);
  assert.equal(status(ev, "spec-hash"), "fail");
  const def = evidence();
  def.criteria.sha256 = undefined;
  def.job.specHash = def.criteria.defaultSpec.keccak256;
  assert.equal(status(def, "spec-hash"), "pass");
  const unknown = evidence();
  unknown.criteria.sha256 = undefined;
  assert.equal(status(unknown, "spec-hash"), "fail");
});

test("deliverable-hash: wrong or missing deliverable bytes fail; unsubmitted job skips", () => {
  const ev = evidence();
  ev.deliverable.url = undefined;
  assert.equal(status(ev, "deliverable-hash"), "fail");
  const open = evidence();
  open.job.submittedAt = 0;
  assert.equal(status(open, "deliverable-hash"), "skip");
});

test("payment-flow: wrong amount, wrong first hop or missing fund tx fail; direct funding passes", () => {
  const short = evidence(); short.payment.intoEscrow = [{ from: ROUTE, value: "9999" }];
  assert.equal(status(short, "payment-flow"), "fail");
  const amt = evidence(); amt.created.amount = "20000";
  assert.equal(status(amt, "payment-flow"), "fail");
  const other = evidence(); other.payment.path = "other";
  assert.equal(status(other, "payment-flow"), "fail");
  assert.equal(status(evidence({ payment: null }), "payment-flow"), "fail");
  const direct = evidence(); direct.payment.path = "direct (client -> escrow)"; direct.payment.route = null; direct.payment.intoEscrow = [{ from: CLIENT, value: "10000" }];
  assert.equal(status(direct, "payment-flow"), "pass");
});

test("submit-tx: wrong provider or deliverable hash, or submit after the verdict, fails", () => {
  const p = evidence(); p.submit.provider = A(77);
  assert.equal(status(p, "submit-tx"), "fail");
  const d = evidence(); d.submit.deliverableHash = H("other");
  assert.equal(status(d, "submit-tx"), "fail");
  const late = evidence(); late.submit.timestamp = 50;
  assert.equal(status(late, "submit-tx"), "fail");
  assert.equal(status(evidence({ submit: null }), "submit-tx"), "fail");
});

test("verdict-signer: the verdict tx sender must be the job evaluator; outcome and payout must match", () => {
  const wrong = evidence(); wrong.verdict.txFrom = A(99);
  assert.equal(status(wrong, "verdict-signer"), "fail");
  const ev2 = evidence(); ev2.verdict.evaluator = A(99);
  assert.equal(status(ev2, "verdict-signer"), "fail");
  const bps = evidence(); bps.verdict.payoutBps = 5000;
  assert.equal(status(bps, "verdict-signer"), "fail");
  const none = evidence(); none.job.verdictAt = 0; none.verdict = null;
  assert.equal(status(none, "verdict-signer"), "skip");
  assert.equal(status(evidence({ verdict: null }), "verdict-signer"), "fail");
});

test("settlement: Settled event must exist and match payoutBps; not-yet-settled skips", () => {
  assert.equal(status(evidence({ settled: null }), "settlement"), "fail");
  assert.equal(status(evidence({ settled: { payoutBps: 1 } }), "settlement"), "fail");
  const ev = evidence(); ev.job.state = "Completed";
  assert.equal(status(ev, "settlement"), "skip");
});

test("evaluator-stake: below minStake fails; unreadable history skips; bytecode needs a Sourcify exact match", () => {
  const low = evidence(); low.evaluator.stake = "1";
  assert.equal(status(low, "evaluator-stake"), "fail");
  assert.equal(status(evidence({ evaluator: { address: EVALUATOR, error: "missing trie node" } }), "evaluator-stake"), "skip");
  assert.equal(status(evidence({ sourcify: { match: null, runtimeMatch: null } }), "escrow-bytecode"), "fail");
  assert.equal(status(evidence({ sourcify: undefined }), "escrow-bytecode"), "skip");
});

test("bundle: checks carry {id, claim, how, expected}; no raw bytes; signature verifies and any tampering fails", async () => {
  const bundle = proofBundle(evidence(), { links: { job: "https://x/j" }, testnet: true, realValue: false });
  assert.ok(bundle.checks.every((c) => Object.keys(c).sort().join() === "claim,expected,how,id"));
  assert.equal(JSON.stringify(bundle).includes('"bytes"'), false);
  const key = generatePrivateKey();
  const signer = privateKeyToAccount(key).address;
  const signed = await signEip191(bundle, key);
  assert.deepEqual(await verifyProofSignature(signed, signer), { valid: true, signer });
  assert.equal((await verifyProofSignature(signed, A(5))).valid, false, "wrong expected signer");
  for (const mutate of [(p) => (p.job.amount = "1"), (p) => (p.checks[0].claim = "x"), (p) => (p.txs = { fund: { hash: "0x1" } }), (p) => (p.criteria.specHash = H("z"))]) {
    const t = clone(signed); mutate(t);
    assert.equal((await verifyProofSignature(t, signer)).valid, false);
  }
  const forged = await signEip191(bundle, generatePrivateKey());
  assert.equal((await verifyProofSignature(forged, signer)).valid, false, "valid signature by another key");
  assert.equal((await verifyProofSignature({ ...bundle, signature: null }, signer)).valid, false);
});

test("crossCheck: a proof whose expected values differ from the independent ones fails that check", () => {
  const ev = evidence();
  const results = evaluateChecks(ev);
  const honest = proofBundle(ev);
  assert.ok(crossCheck(honest, results).every((c) => c.status === "pass"));
  const lying = clone(honest);
  lying.checks.find((c) => c.id === "spec-hash").expected = H("something else");
  const cc = crossCheck(lying, results);
  assert.equal(cc.find((c) => c.id === "spec-hash").status, "fail");
  assert.equal(cc.find((c) => c.id === "job-onchain").status, "pass");
});

test("verify is read-only: no signer is constructed and only read RPC methods are called", async () => {
  for (const f of ["../lib/job-proof.mjs", "../bin/agentkoin-verify.mjs"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.equal(/viem\/accounts|privateKeyToAccount|createWalletClient|writeContract|sendTransaction|sendRawTransaction|signTransaction/.test(src), false, f);
  }
  const calls = [];
  const rec = (name, v) => async (...a) => { calls.push(name); return typeof v === "function" ? v(...a) : v; };
  const client = {
    getChainId: rec("getChainId", 84532),
    getBlock: rec("getBlock", { number: 10n, timestamp: 100n }),
    getCode: rec("getCode", "0x"),
  };
  const ev = await collect({ client, escrow: ESCROW, jobId: 1, sourcify: false });
  assert.equal(ev.escrowHasCode, false);
  assert.deepEqual([...new Set(calls)].sort(), ["getBlock", "getChainId", "getCode"]);
});

// ---------------- local chain end to end ----------------
const anvilUp = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok, () => false);
const OPERATOR_KEY = generatePrivateKey();
if (anvilUp) process.env.AGENTCOIN_OPERATOR_KEY = OPERATOR_KEY; // before the service reads its wallets
const cfgmod = anvilUp ? await import("../lib/config.mjs") : null;
const t = anvilUp && cfgmod.NETWORK === "local" ? test : test.skip;

t("local: /v1/jobs/{id}/proof is signed, and verifyJob re-derives every check from the RPC for default and criteria-mode jobs", async () => {
  const { createApp } = await import("../service/app.mjs");
  const { payExact } = await import("../x402/pay-client.mjs");
  const { verifyJob } = await import("../bin/agentkoin-verify.mjs");
  const { publicClient, contracts, read } = await import("../lib/chain.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "acproof-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true, caps: { freePerIpPerHour: 500, perAddressPerDay: 50, globalGasWeiPerDay: 10n ** 20n }, loopMs: 1e9 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const escrow = contracts().escrow.address;
  // the app is configured with publicUrl http://127.0.0.1:0, so rewrite its URLs to the ephemeral listening port
  const fetchBytes = async (url) => {
    const r = await fetch(url.replace("http://127.0.0.1:0", base));
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
    return { bytes: Buffer.from(await r.arrayBuffer()) };
  };
  try {
    const d = "0x" + createHash("sha256").update("proof test " + Date.now()).digest("hex");
    const dflt = (await payExact(base + "/v1/notarize", { method: "POST", body: { data: "proof default " + Date.now() } })).resource;
    const crit = (await payExact(base + `/v1/notarize?spec=gvp-criteria-checks/1&digest=${d}&nonce=p1`, { method: "POST", body: { sha256: d } })).resource;
    assert.match(dflt.proofUrl, /\/v1\/jobs\/\d+\/proof$/);
    assert.match(dflt.verifyCommand, /verify \d+/);
    const signer = privateKeyToAccount(OPERATOR_KEY).address;
    for (const out of [dflt, crit]) {
      const proof = await (await fetch(`${base}/v1/jobs/${out.jobId}/proof`)).json();
      assert.equal(proof.schema, "agentkoin-job-proof/v1");
      assert.deepEqual(await verifyProofSignature(proof, signer), { valid: true, signer });
      assert.equal(proof.signature.kid, `did:pkh:eip155:${cfgmod.CHAIN_ID}:${signer}#secp256k1`);
      assert.equal(proof.job.state, "Submitted");
      assert.equal(proof.txs.submit.hash, out.submitTx);
      assert.equal(proof.payment.scheme, "deposit route (client -> route -> escrow)");
      assert.equal(proof.evaluator.stosOperated, true);
      // the CLI core, reading only the chain plus raw bytes (the proof is fetched by the test and given as a file-like hint source)
      const r = await verifyJob({ jobId: out.jobId, escrow, client: publicClient, server: base, sourcify: false, window: 50000, fetchBytes });
      const bad = r.results.filter((x) => x.status === "fail").map((x) => `${x.id}: ${x.reason ?? ""}`);
      assert.deepEqual(bad.filter((b) => !b.startsWith("proof-signature")), [], JSON.stringify(r.notes));
      assert.equal(r.results.find((x) => x.id === "spec-hash").status, "pass");
      assert.equal(r.results.find((x) => x.id === "deliverable-hash").status, "pass");
      assert.equal(r.results.find((x) => x.id === "verdict-signer").status, "skip");
    }
    // criteria-mode job: spec is sha256 of the served criteria bytes
    assert.equal((await (await fetch(`${base}/v1/jobs/${crit.jobId}/proof`)).json()).criteria.hashAlgorithm, "sha256");
    // verdict + settle, then everything including verdict-signer and settlement must pass
    await app.tick();
    const j = await read(contracts().escrow, "getJob", [BigInt(crit.jobId)]);
    assert.equal(cfgmod.STATES[j.state], "Completed", `tick error: ${app.lastTickError}`);
    const cfg = await read(contracts().escrow, "config", [j.configVersion]);
    const { increaseTime } = await import("../lib/chain.mjs");
    await increaseTime(Number(cfg.challengeWindow) + 1);
    await app.tick();
    for (const out of [crit, dflt]) {
      const r = await verifyJob({ jobId: out.jobId, escrow, client: publicClient, server: base, sourcify: false, window: 50000, fetchBytes });
      for (const id of ["verdict-signer", "settlement", "evaluator-stake", "payment-flow", "submit-tx"]) assert.equal(r.results.find((x) => x.id === id)?.status, "pass", `${out.jobId} ${id}`);
      // explicit values for hand recomputation: finalize payout split, canonical digest, and the signer recovered from the receipt signature
      assert.equal(r.details.settlement.payoutBps, 10000);
      assert.equal(r.details.settlement.transfers.reduce((t, x) => t + BigInt(x.value), 0n), BigInt(r.details.settlement.jobAmount)); // provider + any fee leg = amount
      assert.equal(r.details.settlement.toClient, "0");
      assert.equal(r.details.receipt.onchainDeliverableHash, r.details.receipt.hashAlgorithm === "sha256" ? r.details.receipt.canonicalSha256 : r.details.receipt.canonicalKeccak256);
      assert.equal(r.details.signature.recoveredSigner, signer);
      assert.equal(r.details.signature.matchesClaimed, true);
          }
    // a lying server proof is caught: tamper txs hint + claims; the chain-derived checks still pass but the claim cross-check and signature fail
    const proof = await (await fetch(`${base}/v1/jobs/${crit.jobId}/proof`)).json();
    proof.checks.find((c) => c.id === "spec-hash").expected = H("lie");
    const file = path.join(dir, "lying-proof.json");
    (await import("node:fs")).writeFileSync(file, JSON.stringify(proof));
    const lr = await verifyJob({ jobId: crit.jobId, escrow, client: publicClient, proofFile: file, sourcify: false, window: 50000, fetchBytes });
    assert.equal(lr.ok, false);
    assert.ok(lr.results.find((x) => x.id === "proof-signature").status === "fail");
    assert.equal(lr.results.find((x) => x.id === "proof-claims:spec-hash").status, "fail");
    // unknown job
    assert.equal((await fetch(`${base}/v1/jobs/99999/proof`)).status, 404);
    assert.equal((await fetch(`${base}/v1/escrows/${A(123)}/jobs/1/proof`)).status, 404);
    // job status links
    const st = await (await fetch(`${base}/v1/jobs/${crit.jobId}`)).json();
    assert.match(st.proofUrl, /proof$/);
  } finally {
    await app.stop();
  }
});

const live = process.env.LIVE_VERIFY === "1" ? test : test.skip;
live("LIVE (read-only Base Sepolia): verify job 30 (v0.5), job 3 (v0.6, non-STOS evaluator)", async () => {
  const { verifyJob } = await import("../bin/agentkoin-verify.mjs");
  const a = await verifyJob({ jobId: 30, escrow: "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D", noServer: false, server: "https://agentcoinhq.com" });
  assert.equal(a.results.filter((x) => x.id !== "proof-signature" && !x.id.startsWith("proof-claims") && x.status === "fail").length, 0);
  const b = await verifyJob({ jobId: 3, escrow: "0xd6E00d3419C16a3bEE1B8CC030A7062bf2014b2c", noServer: true });
  assert.equal(b.ok, true, JSON.stringify(b.results.filter((x) => x.status === "fail")));
  assert.equal(b.evaluator, "0x3E8B7382fd85dbad659B2887D88D020C05ca5f93");
});

// ---- legacy v0.5 jobs #1-4 and #26 (0.5.33) ----
test("v0.5 escrow deployBlock is at or before the first legacy job (jobs 1-4 were funded at block 52030872)", () => {
  assert.ok(ESCROWS["0x4eaf6d09f8c22980bb16e719779ace73a7b1cb3d"].deployBlock <= 52030872);
});

test("legacy smoke spec/deliverable strings: hashes equal the on-chain values of jobs 1-4; an unknown hash still fails", () => {
  const k = (t) => keccak256(toBytes(t));
  const specs = new Set(LEGACY_SPEC_TEXTS.map(k));
  for (const h of ["0xdacf18a0d92fe6936233925bb81a36174d456126e865d8bfaa8d39fbf9c2285f", "0xc56624b115881570ec9d8355bb842b5fb25e166c0b573b7ddab45a71405382b9", "0x62b2866853905cb4a639cc033fc42f5e70ce3c12bf9f4f2b136b1b1c4ea34125", "0x40d7d0bdc27b24c4fad9a08f9d49074a051e3f30db87cbab807dc75ff8c6d7a8"]) assert.ok(specs.has(h), h);
  const dels = new Set(LEGACY_DELIVERABLES.map((d) => k(d.kind === "text" ? d.text : jcs(d.value))));
  for (const h of ["0x4289f164ef1c6abf11032d4261bcccce30dbe0e72cb75d2f7907f6fc4f683ab5", "0xa2d320e126448e1f42533e61d45ed39f481df953b39573cc155a91f4f061a52e", "0xdd240568fe8c3547dc45dfef45ea641098c43ab9bee18be8a2a1d10a8be4074e", "0x9705bd2d78116238d889ebb7dc1bb6d235cc0c056b205d4dd8e64201dd4960a7"]) assert.ok(dels.has(h), h);
  const unknown = "0x" + "ab".repeat(32);
  const ev = evidence({ criteria: { specHash: unknown, candidates: [], legacySpec: null, defaultSpec: { text: NOTARY_SPEC_TEXT, keccak256: keccak256(toBytes(NOTARY_SPEC_TEXT)) } }, deliverable: { deliverableHash: unknown, candidates: [], legacy: null } });
  ev.job.specHash = unknown; ev.job.deliverableHash = unknown;
  assert.equal(status(ev, "spec-hash"), "fail");
  assert.equal(status(ev, "deliverable-hash"), "fail");
  const ok = evidence({ criteria: { specHash: "0xdacf", candidates: [], legacySpec: { text: LEGACY_SPEC_TEXTS[0], keccak256: "0xdacf" } }, deliverable: { deliverableHash: "0x4289", candidates: [], legacy: { keccak256: "0x4289" } } });
  ok.job.specHash = "0xdacf"; ok.job.deliverableHash = "0x4289";
  assert.equal(status(ok, "spec-hash"), "pass");
  assert.equal(status(ok, "deliverable-hash"), "pass");
});

test("payment-flow: cross-currency settler path passes only when the amount and client match; 'other' still fails", () => {
  const SETTLER = A(0x66);
  const ev = evidence();
  Object.assign(ev.payment, { path: "cross-currency settler (client -> settler [other token, swapped] -> escrow USDC)", route: null, settler: SETTLER, intoEscrow: [{ from: SETTLER, value: "10000" }] });
  assert.equal(status(ev, "payment-flow"), "pass");
  const short = clone(ev); short.payment.intoEscrow = [{ from: SETTLER, value: "9999" }];
  assert.equal(status(short, "payment-flow"), "fail");
  const other = clone(ev); other.payment.path = "other";
  assert.equal(status(other, "payment-flow"), "fail");
  assert.ok(CROSS_CURRENCY_SETTLERS.includes("0x6258d112bf27006287253424a1fa877c607b564a"));
});

test("verdict-signer: a payout that differs from the Verdict event passes only with a matching arbitrator Ruled event", () => {
  const ev = evidence(); ev.verdict.outcome = "Reject"; ev.verdict.payoutBps = 0; ev.job.outcome = "Reject"; ev.job.payoutBps = 10000;
  assert.equal(status(ev, "verdict-signer"), "fail");
  ev.ruled = { arbitrator: A(0x44), verdictPayoutBps: 0, rulingPayoutBps: 10000, overturned: true };
  assert.equal(status(ev, "verdict-signer"), "pass");
  ev.ruled.rulingPayoutBps = 5000;
  assert.equal(status(ev, "verdict-signer"), "fail");
  ev.ruled = { arbitrator: A(0x44), verdictPayoutBps: 7000, rulingPayoutBps: 10000, overturned: true };
  assert.equal(status(ev, "verdict-signer"), "fail");
});

test("LIVE_VERIFY: legacy jobs 1-4 and 26 verify OK on Base Sepolia (read-only)", { skip: process.env.LIVE_VERIFY !== "1", timeout: 600000 }, async () => {
  const { createPublicClient, http } = await import("viem");
  const client = createPublicClient({ transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://base-sepolia-rpc.publicnode.com") });
  for (const id of [1, 2, 3, 4, 26]) {
    const ev = await collect({ client, escrow: "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D", jobId: id, sourcify: false, hints: id === 26 ? { deliverableUrls: ["https://agentcoinhq.com/v1/notarize/26"] } : {} });
    for (const c of evaluateChecks(ev)) if (c.id !== "escrow-bytecode") assert.notEqual(c.status, "fail", `job ${id} ${c.id}`);
  }
});
