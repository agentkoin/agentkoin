// Concordium anchor: payload, frozen core, queue (mock sender), verify check (mock node), badge client (mock registry), signature coverage.
// Everything here is offline. The real Concordium node and the real registry are NOT contacted (see docs/concordium-anchor-scope.md runbook).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { generatePrivateKey } from "viem/accounts";
import { buildAnchorPayload, parseAnchorPayload, anchorPayloadHex, proofCore, proofCoreSha256, normalizeBlockItemStatus, verifyConcordiumAnchor, sdkNodeReader } from "../lib/ccd-anchor.mjs";
import { createAnchorQueue, AnchorStore, anchorKey } from "../lib/ccd-anchor-queue.mjs";
import { checkBadge } from "../lib/ccd-badge.mjs";
import { signEip191 } from "../lib/sign.mjs";
import { verifyProofSignature } from "../lib/job-proof.mjs";

const ESCROW = "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D";
const bundle = () => ({ schema: "agentkoin-job-proof/v1", escrow: ESCROW, chainId: 84532, jobId: "30", job: { state: "Settled" }, checks: [{ id: "a", expected: 1 }], generatedAt: "2026-11-20T00:00:00Z" });

test("payload: 68 bytes, AGK1 layout, round-trips, rejects bad input", () => {
  const sha = "0x" + "ab".repeat(32);
  const b = buildAnchorPayload({ coreSha256: sha, jobId: "30", escrow: ESCROW, chainId: 84532 });
  assert.equal(b.length, 68); assert.ok(b.length <= 256);
  assert.equal(b.toString("ascii", 0, 4), "AGK1");
  assert.deepEqual(parseAnchorPayload(b), { coreSha256: sha, jobId: "30", escrow: ESCROW.toLowerCase(), chainId: 84532 });
  assert.equal(anchorPayloadHex({ coreSha256: sha, jobId: 30, escrow: ESCROW, chainId: 84532 }), b.toString("hex"));
  assert.throws(() => buildAnchorPayload({ coreSha256: "0x12", jobId: 1, escrow: ESCROW, chainId: 1 }));
  assert.throws(() => buildAnchorPayload({ coreSha256: sha, jobId: -1, escrow: ESCROW, chainId: 1 }));
  assert.throws(() => buildAnchorPayload({ coreSha256: sha, jobId: 1n << 64n, escrow: ESCROW, chainId: 1 }));
  assert.throws(() => buildAnchorPayload({ coreSha256: sha, jobId: 1, escrow: "0x1234", chainId: 1 }));
  assert.throws(() => buildAnchorPayload({ coreSha256: sha, jobId: 1, escrow: ESCROW, chainId: 2 ** 32 }));
  assert.throws(() => parseAnchorPayload(Buffer.alloc(68)), /magic/);
  assert.throws(() => parseAnchorPayload(Buffer.alloc(10)), /68 bytes/);
});

test("proof core: ignores signature and anchors, changes with any other field", () => {
  const p = bundle(), h = proofCoreSha256(p);
  assert.equal(h, proofCoreSha256({ ...p, signature: { value: "0x1" }, anchors: { concordium: { status: "queued" } } }));
  assert.notEqual(h, proofCoreSha256({ ...p, jobId: "31" }));
  assert.deepEqual(Object.keys(proofCore({ ...p, signature: 1, anchors: 2 })).includes("anchors"), false);
});

const mockSender = (o = {}) => {
  const s = { sent: [], statuses: o.statuses ?? [], failSends: o.failSends ?? 0,
    async send(hex) { if (s.failSends-- > 0) throw new Error("node down"); s.sent.push(hex); return { txHash: "ab".repeat(32) }; },
    async status() { return s.statuses.shift() ?? { state: "finalized", blockHash: "cd".repeat(32), blockHeight: "123", sender: "4Zsender" }; } };
  return s;
};

test("queue: freeze is idempotent and byte-identical; submit then finalize; anchors object shape", async () => {
  let t = 1_000_000; const sender = mockSender({ statuses: [{ state: "committed" }] });
  const q = createAnchorQueue({ store: new AnchorStore(null), sender, now: () => t, genesis: "gg" });
  const r1 = q.freeze({ escrow: ESCROW, jobId: "30", chainId: 84532, bundle: bundle() });
  const r2 = q.freeze({ escrow: ESCROW, jobId: "30", chainId: 84532, bundle: { ...bundle(), generatedAt: "LATER" } });
  assert.equal(r1.core, r2.core); assert.equal(r2.status, "queued");
  assert.deepEqual(q.frozenCore(ESCROW, "30"), bundle());
  assert.equal(parseAnchorPayload(r1.payloadHex).coreSha256, proofCoreSha256(bundle()));
  assert.equal(q.anchorsFor(ESCROW, "99"), null);
  await q.tick(); assert.equal(sender.sent.length, 1); assert.equal(sender.sent[0], r1.payloadHex);
  assert.equal(q.anchorsFor(ESCROW, "30").concordium.status, "submitted");
  t += 6000; await q.tick(); assert.equal(q.anchorsFor(ESCROW, "30").concordium.status, "submitted"); // committed, not final
  t += 6000; await q.tick();
  const a = q.anchorsFor(ESCROW, "30").concordium;
  assert.deepEqual(a, { network: "testnet", genesis: "gg", status: "finalized", coreSha256: r1.coreSha256, payloadHex: r1.payloadHex, txHash: "ab".repeat(32), sender: "4Zsender", blockHash: "cd".repeat(32), blockHeight: "123" });
  t += 99999; await q.tick(); assert.equal(sender.sent.length, 1); // finalized records are never re-sent
});

test("queue: retries with backoff, gives up as failed, never throws; dropped tx is resubmitted", async () => {
  let t = 0; const sender = mockSender({ failSends: 2 });
  const q = createAnchorQueue({ store: new AnchorStore(null), sender, now: () => t, maxAttempts: 3, backoffMs: () => 1000 });
  q.freeze({ escrow: ESCROW, jobId: "1", chainId: 84532, bundle: bundle() });
  assert.equal((await q.tick())[0].step, "error"); assert.equal(sender.sent.length, 0);
  assert.deepEqual(await q.tick(), []); // backing off
  t += 1001; assert.equal((await q.tick())[0].step, "error");
  t += 1001; assert.equal((await q.tick())[0].step, "submitted"); assert.equal(sender.sent.length, 1);
  const bad = mockSender({ failSends: 99 }); const q2 = createAnchorQueue({ store: new AnchorStore(null), sender: bad, now: () => t, maxAttempts: 2, backoffMs: () => 0 });
  q2.freeze({ escrow: ESCROW, jobId: "2", chainId: 84532, bundle: bundle() });
  await q2.tick(); await q2.tick();
  const f = q2.anchorsFor(ESCROW, "2").concordium; assert.equal(f.status, "failed"); assert.match(f.error, /node down/);
  const dropped = mockSender({ statuses: Array(5).fill({ state: "unknown" }) });
  const q3 = createAnchorQueue({ store: new AnchorStore(null), sender: dropped, now: () => t });
  q3.freeze({ escrow: ESCROW, jobId: "3", chainId: 84532, bundle: bundle() });
  const steps = []; for (let i = 0; i < 4; i++) { t += 60_000; steps.push(...(await q3.tick()).map((x) => x.step)); }
  assert.ok(!steps.includes("resubmit"), "not resubmitted before the tx expiry has passed"); assert.equal(dropped.sent.length, 1);
  t += 12 * 60_000; steps.push(...(await q3.tick()).map((x) => x.step)); t += 60_000; steps.push(...(await q3.tick()).map((x) => x.step));
  assert.ok(steps.includes("resubmit")); assert.ok(dropped.sent.length >= 2);
});

test("store persists to a file with mode 600 and reloads", async () => {
  const { mkdtempSync, statSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const path = await import("node:path");
  const f = path.join(mkdtempSync(path.join(tmpdir(), "ccd-")), "a.json");
  const s = new AnchorStore(f); s.put(anchorKey(ESCROW, "7"), { x: 1 });
  assert.equal(statSync(f).mode & 0o777, 0o600); assert.equal(new AnchorStore(f).get(anchorKey(ESCROW, "7")).x, 1);
});

// ---- verify check ----
const anchored = async (over = {}) => {
  const core = bundle();
  const payloadHex = anchorPayloadHex({ coreSha256: proofCoreSha256(core), jobId: "30", escrow: ESCROW, chainId: 84532 });
  const a = { network: "testnet", status: "finalized", coreSha256: proofCoreSha256(core), payloadHex, txHash: "ab".repeat(32), ...over };
  return { proof: { ...core, anchors: { concordium: a } }, payloadHex };
};
const EXPECT = { jobId: "30", escrow: ESCROW, chainId: 84532 };
const goodTx = (payloadHex, o = {}) => ({ state: "finalized", kind: "registerData", success: true, dataHex: payloadHex, sender: "4Zsender", blockHash: "cd".repeat(32), blockHeight: "9", ...o });

test("concordium-anchor: pass, and skips (no anchor / not submitted / no proof)", async () => {
  const { proof, payloadHex } = await anchored();
  const r = await verifyConcordiumAnchor({ proof, expect: EXPECT, reader: { getTx: async () => goodTx(payloadHex) } });
  assert.equal(r.status, "pass"); assert.equal(r.id, "concordium-anchor"); assert.equal(r.detail.blockHeight, "9");
  assert.match((await verifyConcordiumAnchor({ proof: bundle(), expect: EXPECT })).reason, /no Concordium anchor/);
  const pend = (await anchored({ status: "queued", txHash: undefined })).proof;
  const s = await verifyConcordiumAnchor({ proof: pend, expect: EXPECT, reader: { getTx: async () => { throw new Error("must not be called"); } } });
  assert.equal(s.status, "skip"); assert.match(s.reason, /queued/);
  assert.equal((await verifyConcordiumAnchor({ proof: null, expect: EXPECT })).status, "skip");
});

test("concordium-anchor: every mismatch fails", async () => {
  const { proof, payloadHex } = await anchored();
  const run = (p, tx, extra = {}) => verifyConcordiumAnchor({ proof: p, expect: EXPECT, reader: { getTx: async () => tx }, ...extra });
  assert.match((await run({ ...proof, jobId: "30", job: { state: "Tampered" } }, goodTx(payloadHex))).reason, /modified after anchoring/);
  assert.match((await verifyConcordiumAnchor({ proof, expect: { ...EXPECT, jobId: "31" }, reader: { getTx: async () => goodTx(payloadHex) } })).reason, /chain-derived/);
  assert.match((await verifyConcordiumAnchor({ proof, expect: { ...EXPECT, chainId: 1 }, reader: { getTx: async () => goodTx(payloadHex) } })).reason, /chain-derived/);
  const flipped = payloadHex.slice(0, -2) + (payloadHex.endsWith("00") ? "01" : "00");
  assert.match((await run(proof, goodTx(flipped))).reason, /registered data differs/);
  assert.match((await run(proof, goodTx(payloadHex, { state: "committed" }))).reason, /not finalized/);
  assert.match((await run(proof, goodTx(payloadHex, { state: "received" }))).reason, /not finalized/);
  assert.match((await run(proof, goodTx(payloadHex, { kind: "transfer" }))).reason, /not a RegisterData/);
  assert.match((await run(proof, goodTx(payloadHex, { success: false, kind: "registerData" }))).reason, /did not succeed/);
  assert.match((await run(proof, { state: "unknown" })).reason, /no such transaction/);
  assert.match((await run(proof, goodTx(payloadHex), { expectedSender: "4Zother" })).reason, /unexpected account/);
  assert.match((await run(proof, goodTx(payloadHex), { expectedGenesis: "aa" })).status, /pass/); // reader has no genesis(): not checked
  const withGen = await verifyConcordiumAnchor({ proof, expect: EXPECT, reader: { getTx: async () => goodTx(payloadHex), genesis: async () => "bb" }, expectedGenesis: "aa" });
  assert.match(withGen.reason, /different network/);
  assert.equal((await run({ ...proof, anchors: { concordium: { ...proof.anchors.concordium, payloadHex: flipped } } }, goodTx(payloadHex))).status, "fail");
});

test("concordium-anchor: unreachable node or missing SDK skips with a clear message", async () => {
  const { proof } = await anchored();
  const a = await verifyConcordiumAnchor({ proof, expect: EXPECT, reader: { getTx: async () => { throw new Error("UNAVAILABLE: no connection"); } } });
  assert.equal(a.status, "skip"); assert.match(a.reason, /could not reach the Concordium node.*--ccd-grpc/);
  const b = await verifyConcordiumAnchor({ proof, expect: EXPECT, readerFactory: async () => { throw new Error("Cannot find package '@concordium/web-sdk'"); } });
  assert.equal(b.status, "skip"); assert.match(b.reason, /web-sdk/);
});

test("normalizeBlockItemStatus maps SDK-shaped statuses (SDK shapes read from its .d.ts; not captured from a live node)", () => {
  const sum = (o) => ({ type: "accountTransaction", transactionType: "registerData", sender: "4Zs", dataRegistered: { tag: "DataRegistered", data: "0xAB" }, ...o });
  assert.deepEqual(normalizeBlockItemStatus({ status: "finalized", outcome: { blockHash: "bh", summary: sum() } }), { state: "finalized", kind: "registerData", success: true, dataHex: "ab", sender: "4Zs", blockHash: "bh" });
  assert.equal(normalizeBlockItemStatus({ status: "committed", outcomes: [{ blockHash: "bh", summary: sum() }] }).state, "committed");
  assert.equal(normalizeBlockItemStatus({ status: "received" }).state, "received");
  assert.equal(normalizeBlockItemStatus(undefined).state, "unknown");
  const f = normalizeBlockItemStatus({ status: "finalized", outcome: { blockHash: "bh", summary: { type: "accountTransaction", transactionType: "failed", sender: "4Zs" } } });
  assert.equal(f.success, false); assert.equal(f.dataHex, null);
});

test("sdkNodeReader: drives the SDK client read-only (fake SDK), maps NOT_FOUND to unknown", async () => {
  const calls = [];
  const client = { getBlockItemStatus: async (h) => { calls.push(["status", h]); if (h === "missing") { const e = new Error("x"); e.code = "NOT_FOUND"; throw e; } return { status: "finalized", outcome: { blockHash: "BH", summary: { type: "accountTransaction", transactionType: "registerData", sender: "S", dataRegistered: { data: "aa" } } } }; },
    getBlockInfo: async () => ({ blockHeight: 77n }), getConsensusStatus: async () => ({ genesisBlock: "GB" }) };
  const sdk = { ConcordiumGRPCNodeClient: function (host, port, cred, o) { calls.push(["client", host, port, o.timeout]); return client; }, credentials: { createSsl: () => "ssl" },
    TransactionHash: { fromHexString: (h) => h }, BlockHash: { fromHexString: (h) => h, toHexString: (h) => h }, AccountAddress: { toBase58: (a) => a } };
  const r = await sdkNodeReader({ sdk, host: "h", port: 1, timeoutMs: 5 });
  const tx = await r.getTx("0x" + "11".repeat(32));
  assert.equal(tx.state, "finalized"); assert.equal(tx.blockHeight, "77"); assert.equal(await r.genesis(), "GB");
  assert.deepEqual((await r.getTx("missing")).state, "unknown");
  assert.deepEqual(calls[0], ["client", "h", 1, 5]);
});

test("real SDK, offline: RegisterData builds and signs with a throwaway key; serialized tx carries the 68 payload bytes (no network, key never registered)", async () => {
  const sdk = await import("@concordium/web-sdk");
  const payload = buildAnchorPayload({ coreSha256: "0x" + "cd".repeat(32), jobId: "30", escrow: ESCROW, chainId: 84532 });
  const sender = sdk.AccountAddress.fromBuffer(randomBytes(32));
  const signer = sdk.buildBasicAccountSigner(randomBytes(32).toString("hex"));
  const tx = sdk.Transaction.registerData({ data: new sdk.DataBlob(payload) }).addMetadata({ sender, nonce: sdk.SequenceNumber.create(1), expiry: sdk.TransactionExpiry.futureMinutes(10) }).build();
  const fin = await sdk.Transaction.signAndFinalize(tx, signer);
  const wire = Buffer.from(sdk.Transaction.serializeBlockItem(fin));
  assert.ok(wire.includes(payload), "signed block item contains the exact anchor payload");
  assert.match(sdk.TransactionHash.toHexString(sdk.Transaction.getAccountTransactionHash(fin)), /^[0-9a-f]{64}$/);
});

test("signature covers core + anchors: re-signed bundle verifies; editing anchors breaks it; verify strips both for the hash", async () => {
  const key = generatePrivateKey();
  const { proof } = await anchored();
  const signed = await signEip191(proof, key);
  assert.equal((await verifyProofSignature(signed)).valid, true);
  assert.equal(proofCoreSha256(signed), proofCoreSha256(bundle()));
  const t = structuredClone(signed); t.anchors.concordium.txHash = "00".repeat(32);
  assert.equal((await verifyProofSignature(t)).valid, false);
});

// ---- badge ----
// Fixture = the live read-only response of GET /v1/check-badge/Mf22soLh1NuZYFgBK8iSs (mainnet badge), trimmed; fields verified on 2026-11-20.
const CARD = '{"name":"x","evaluators":["0xfb01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa509a"]}';
const CARD_SHA = createHash("sha256").update(CARD).digest("hex");
const REG = { token_address: "Mf22soLh1NuZYFgBK8iSs", agent_uri: "https://agent.example/card.json", card_sha256: CARD_SHA, on_chain: { owner_account: "4DDv", status: "Active", agent_uri: "https://agent.example/card.json", metadata_hash_hex: CARD_SHA }, checks: { status_active: true, hash_matches_on_chain: true, card_fetched: true }, badge_valid: true, issues: [] };
const mockFetch = (reg, card = CARD, status = 200) => async (url) => url.includes("/v1/check-badge/") ? { ok: status === 200, status, json: async () => reg } : { ok: true, status: 200, text: async () => card };

test("badge: pass; fails on wrong evaluator/hash/inactive; skips with no badge, 400, 5xx, unreachable, unknown shape", async () => {
  const EVAL = "0xFB01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa509a";
  assert.equal((await checkBadge({ badge: "Mf22", evaluator: EVAL, fetchImpl: mockFetch(REG) })).status, "pass");
  assert.match((await checkBadge({ badge: "Mf22", evaluator: "0x" + "12".repeat(20), fetchImpl: mockFetch(REG) })).reason, /does not list/);
  assert.match((await checkBadge({ badge: "Mf22", evaluator: EVAL, fetchImpl: mockFetch(REG, CARD + " ") })).reason, /does not hash/);
  assert.equal((await checkBadge({ badge: "Mf22", evaluator: EVAL, fetchImpl: mockFetch({ ...REG, on_chain: { ...REG.on_chain, status: "Revoked" } }) })).status, "fail");
  assert.equal((await checkBadge({ badge: "Mf22", evaluator: EVAL, fetchImpl: mockFetch({ ...REG, badge_valid: false }) })).status, "fail");
  assert.match((await checkBadge({ badge: null })).reason, /no Concordium Agent Registry badge/);
  assert.match((await checkBadge({ badge: "zz", fetchImpl: mockFetch({}, "", 400) })).reason, /HTTP 400/);
  assert.match((await checkBadge({ badge: "zz", fetchImpl: mockFetch({}, "", 503) })).reason, /HTTP 503/);
  assert.match((await checkBadge({ badge: "zz", fetchImpl: async () => { throw new Error("ENOTFOUND"); } })).reason, /could not reach/);
  assert.match((await checkBadge({ badge: "zz", fetchImpl: mockFetch({ foo: 1 }) })).reason, /unrecognised/);
});

test("judge-kit ships byte-identical copies of the shared libs", () => {
  for (const f of ["ccd-anchor.mjs", "ccd-badge.mjs"]) assert.equal(readFileSync(new URL(`../lib/${f}`, import.meta.url), "utf8"), readFileSync(new URL(`../../judge-kit/src/verify/${f}`, import.meta.url), "utf8"), f);
});

test("service wiring: flag defaults OFF (no queue, no timer); opts.ccdAnchor turns the queue on with a pluggable sender", async () => {
  const { createApp } = await import("../service/app.mjs");
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const path = await import("node:path");
  delete process.env.CCD_ANCHOR;
  const off = createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "ccd-off-")), publicUrl: "http://127.0.0.1:0", loopMs: 1e9 });
  assert.equal(off.ccd, null); await off.stop();
  const sender = mockSender();
  const on = createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "ccd-on-")), publicUrl: "http://127.0.0.1:0", loopMs: 1e9, ccdAnchor: { sender, noTimer: true } });
  assert.ok(on.ccd); on.ccd.freeze({ escrow: ESCROW, jobId: "30", chainId: 84532, bundle: bundle() });
  await on.ccd.tick(); assert.equal(sender.sent.length, 1);
  await on.stop();
});

// ---- wallet-proxy REST (the path that actually works from restricted networks) ----
// Fixture = real response of GET /v0/submissionStatus/<a finalized testnet RegisterData tx>, fetched read-only on 2026-11-20 (fields verified).
const PROXY_REAL = { blockHashes: ["929fb661228f995cfac26842e96505acce0410be8c009e7625daa044392b1956"], cost: "4005390", outcome: "success", registeredData: "01000000010000000000000000000001a1fa0aa0e7e569a84ffb5780147bae1772a0c3d9a620101457cd0df52697ecfe34cb69ef69", sender: "4qQeWPBYiFFWbMhEK2pUwracBgjUwYiHzgZCeLXNrVnMXPZXcW", status: "finalized", transactionHash: "69405e2e1d537b914c5ad8a0bbc9116f3406f72261a843d916e1afadbcda3588" };
test("wallet-proxy: status normalisation (real fixture), reader, unknown/received/reject", async () => {
  const { normalizeProxyStatus, proxyNodeReader } = await import("../lib/ccd-anchor.mjs");
  assert.deepEqual(normalizeProxyStatus(PROXY_REAL), { state: "finalized", kind: "registerData", success: true, dataHex: PROXY_REAL.registeredData, sender: PROXY_REAL.sender, blockHash: PROXY_REAL.blockHashes[0] });
  assert.equal(normalizeProxyStatus({ status: "absent" }).state, "unknown");
  assert.equal(normalizeProxyStatus({ status: "received" }).state, "received");
  const rej = normalizeProxyStatus({ status: "finalized", outcome: "reject", blockHashes: ["b"], sender: "S" });
  assert.equal(rej.success, false); assert.equal(rej.kind, null);
  const calls = [];
  const f = async (url, o) => { calls.push(url); return url.includes("ccdscan") ? { ok: true, json: async () => ({ data: { blockByBlockHash: { blockHeight: 51068887 } } }) } : { ok: true, json: async () => PROXY_REAL }; };
  const tx = await proxyNodeReader({ fetchImpl: f }).getTx("0x" + PROXY_REAL.transactionHash);
  assert.equal(tx.blockHeight, "51068887"); assert.ok(calls[0].endsWith("/v0/submissionStatus/" + PROXY_REAL.transactionHash));
  await assert.rejects(proxyNodeReader({ fetchImpl: async () => ({ ok: false, status: 503 }) }).getTx("ab".repeat(32)), /503/);
});

test("makeProxySender: builds a signed RegisterData offline, submits raw bytes, uses the proxy's submissionId as the tx hash; refuses non-AGK1 payloads", async () => {
  const { makeProxySender } = await import("../lib/ccd-anchor-queue.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const path = await import("node:path");
  const sdk = await import("@concordium/web-sdk");
  const kf = path.join(mkdtempSync(path.join(tmpdir(), "ccdk-")), "k.json");
  writeFileSync(kf, JSON.stringify({ address: sdk.AccountAddress.fromBuffer(randomBytes(32)).address, privateKey: randomBytes(32).toString("hex") }), { mode: 0o600 });
  let put = null;
  const f = async (url, o = {}) => url.includes("/v0/accNonce/") ? { ok: true, json: async () => ({ nonce: 7, allFinal: true }) } : url.endsWith("/v0/submitRawTransaction") ? (put = o, { ok: true, json: async () => ({ submissionId: "ee".repeat(32) }) }) : { ok: false, status: 404 };
  const s = await makeProxySender({ keyFile: kf, fetchImpl: f });
  const hex = anchorPayloadHex({ coreSha256: "0x" + "ab".repeat(32), jobId: 30, escrow: ESCROW, chainId: 84532 });
  assert.deepEqual(await s.send(hex), { txHash: "ee".repeat(32) });
  assert.equal(put.method, "PUT"); assert.ok(Buffer.from(put.body).includes(Buffer.from(hex, "hex")));
  await assert.rejects(s.send("00".repeat(68)), /not an AGK1/);
  const bad = await makeProxySender({ keyFile: kf, fetchImpl: async (u) => (u.includes("accNonce") ? { ok: true, json: async () => ({ nonce: 1 }) } : { ok: true, json: async () => ({}) }) });
  await assert.rejects(bad.send(hex), /no submissionId/);
});

test("GET /.well-known/concordium-agent-card.json serves the exact bytes from the state dir (404 until present), GET and HEAD", async () => {
  const { createApp } = await import("../service/app.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "ccd-card-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", loopMs: 1e9 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    assert.equal((await fetch(base + "/.well-known/concordium-agent-card.json")).status, 404);
    const bytes = Buffer.from('{"name":"x","note":"  exact  bytes\\u00e9"}');
    writeFileSync(path.join(dir, "concordium-agent-card.json"), bytes);
    const r = await fetch(base + "/.well-known/concordium-agent-card.json");
    assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /json/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
    const h = await fetch(base + "/.well-known/concordium-agent-card.json", { method: "HEAD" });
    assert.equal(h.status, 200); assert.equal(h.headers.get("content-length"), String(bytes.length));
  } finally { await app.stop(); }
});

test("badges sit outside the anchored core: adding/changing them never changes the core hash and the anchor check still passes", async () => {
  const p = bundle(), h = proofCoreSha256(p);
  const badges = { concordium: { ["0xFB01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa509a"]: "JyP9V3Bomo2SSX1Kp8qFb" } };
  assert.equal(h, proofCoreSha256({ ...p, badges }));
  assert.equal(Object.keys(proofCore({ ...p, badges })).includes("badges"), false);
  const { proof, payloadHex } = await anchored();
  const r = await verifyConcordiumAnchor({ proof: { ...proof, badges }, expect: EXPECT, reader: { getTx: async () => goodTx(payloadHex) } });
  assert.equal(r.status, "pass");
});
