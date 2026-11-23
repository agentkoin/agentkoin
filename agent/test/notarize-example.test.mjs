// AD-008 (C6 FREE_EVALUABILITY): free example of the paid notary response, response JSON Schema, and the 402 links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import canonicalize from "canonicalize";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { parsePaymentRequired } from "@x402/core/schemas";
import { createApp } from "../service/app.mjs";
import { NOTARY_RESPONSE_SCHEMA, NOTARY_RESPONSE_SCHEMA_HASH } from "../lib/notary-schema.mjs";

const SNAP = JSON.parse(readFileSync(new URL("../static/notarize-example-job.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(NOTARY_RESPONSE_SCHEMA);
const POST_KEYS = ["receipt", "receiptSignature", "deliverableHash", "jobId", "settleTx", "submitTx", "verify", "status"];

async function withApp(opts, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "acex-"));
  if (opts.jobs) writeFileSync(path.join(dir, "jobs.json"), JSON.stringify(opts.jobs));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true, caps: { freePerIpPerHour: 50 }, ...(opts.app ?? {}) });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = (u, init = {}) => fetch(base + u, { ...init, headers: { "x-forwarded-for": opts.ip ?? "6.6.6.6", ...(init.headers ?? {}) } });
  try {
    await fn(get);
  } finally {
    await app.stop();
  }
}

test("responseSchemaHash is sha256 of the RFC 8785 schema bytes; the snapshot receipt validates", () => {
  const h = "sha256:" + createHash("sha256").update(canonicalize(NOTARY_RESPONSE_SCHEMA), "utf8").digest("hex");
  assert.equal(h, NOTARY_RESPONSE_SCHEMA_HASH);
  assert.ok(validate(SNAP), JSON.stringify(validate.errors));
});

test("HTTP: GET /v1/notarize/example is free (200, not 402/404), labeled, and has the GET /v1/notarize/{id} keys", async () => {
  const rec = { status: "settled", receipt: SNAP.receipt, deliverableHash: SNAP.deliverableHash, settleTx: SNAP.settleTx, submitTx: SNAP.submitTx, verdictTx: SNAP.verdictTx, finalizeTx: SNAP.finalizeTx };
  await withApp({ jobs: { 7: rec }, app: { exampleJobId: "7" } }, async (get) => {
    const ex = await get("/v1/notarize/example");
    assert.equal(ex.status, 200);
    const e = await ex.json();
    assert.equal(e.example, true);
    assert.match(e.sampleOf, /\/v1\/notarize\/7$/);
    assert.equal(e.sampleSource, "job store");
    assert.equal(e.responseSchemaHash, NOTARY_RESPONSE_SCHEMA_HASH);
    const real = await (await get("/v1/notarize/7")).json();
    const extra = ["example", "sampleOf", "sampleSource", "schema", "responseSchemaHash", "shape"];
    assert.deepEqual(Object.keys(e).filter((k) => !extra.includes(k)).sort(), Object.keys(real).sort());
    assert.deepEqual(e.receipt, real.receipt);
    assert.ok(validate(e), JSON.stringify(validate.errors));
    assert.ok(validate(real), JSON.stringify(validate.errors));
    const post = await (await get("/v1/notarize/example?shape=post")).json();
    assert.equal(post.example, true);
    for (const k of POST_KEYS) assert.ok(k in post, k);
    assert.ok(validate(post), JSON.stringify(validate.errors));
  });
});

test("HTTP: GET /v1/notarize/{id} carries agentcoin.payment only for jobs with a payment record (v0.5.15)", async () => {
  const rec = { status: "settled", receipt: SNAP.receipt, deliverableHash: SNAP.deliverableHash, settleTx: SNAP.settleTx, submitTx: SNAP.submitTx, verdictTx: SNAP.verdictTx, finalizeTx: SNAP.finalizeTx };
  const payment = { scheme: "agentcoin-swap", paid: { symbol: "EURC", asset: "0x808456652fdb597867f38412077A9182bf77359F", amount: "9883" }, received: { symbol: "USDC", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "10051", into: "JobEscrow job (client = buyer)" }, settleTx: "0x6cacd23c7bb0132bc6390dfe86efb9e16810b0debe5cf8f54a038624f3ea7ec1" };
  await withApp({ ip: "6.6.6.11", jobs: { 7: rec, 26: { ...rec, payment } } }, async (get) => {
    const usdc = await (await get("/v1/notarize/7")).json();
    const eurc = await (await get("/v1/notarize/26")).json();
    assert.equal(usdc.agentcoin.payment, undefined);
    assert.deepEqual(eurc.agentcoin.payment, payment);
    const { payment: _p, ...rest } = eurc.agentcoin;
    assert.deepEqual(Object.keys(rest).sort(), Object.keys(usdc.agentcoin).sort());
    assert.deepEqual(Object.keys(eurc).sort(), Object.keys(usdc).sort());
    assert.ok(validate(eurc), JSON.stringify(validate.errors));
  });
});

test("HTTP: example falls back to the bundled snapshot when the job store lacks the job", async () => {
  await withApp({ ip: "6.6.6.7" }, async (get) => {
    const r = await get("/v1/notarize/example");
    assert.equal(r.status, 200);
    const e = await r.json();
    assert.equal(e.jobId, SNAP.jobId);
    assert.deepEqual(e.receipt, SNAP.receipt);
    assert.match(e.sampleSource, /bundled snapshot/);
  });
});

test("HTTP: /v1/notarize/schema.json serves the JCS bytes whose sha256 is responseSchemaHash", async () => {
  await withApp({ ip: "6.6.6.8" }, async (get) => {
    const r = await get("/v1/notarize/schema.json");
    assert.equal(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal("sha256:" + createHash("sha256").update(buf).digest("hex"), NOTARY_RESPONSE_SCHEMA_HASH);
    assert.equal(r.headers.get("x-response-schema-hash"), NOTARY_RESPONSE_SCHEMA_HASH);
  });
});

test("HTTP: 402 links the example and schema; accepts[].extra.responseSchemaHash; price/asset/network unchanged; valid x402 v2", async () => {
  await withApp({ ip: "6.6.6.9" }, async (get) => {
    const r = await get("/v1/notarize", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 402);
    const pr = await r.json();
    assert.match(pr.exampleUrl, /\/v1\/notarize\/example$/);
    assert.match(pr.responseSchemaUrl, /\/v1\/notarize\/schema\.json$/);
    for (const a of pr.accepts) {
      assert.equal(a.extra.responseSchemaHash, NOTARY_RESPONSE_SCHEMA_HASH);
      assert.equal(a.amount, "10000");
      assert.equal(a.asset, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
      assert.equal(a.network, "eip155:84532");
    }
    const ex = pr.accepts.find((a) => a.scheme === "exact");
    assert.equal(ex.extra.name, "USDC");
    assert.equal(ex.extra.assetTransferMethod, "eip3009");
    assert.ok(ex.extra.agentcoin.offer);
    const parsed = parsePaymentRequired(pr);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? parsed.error));
    assert.equal(validateDiscoveryExtension(pr.extensions.bazaar).valid, true);
    const out = pr.extensions.bazaar.info.output.example;
    for (const k of POST_KEYS) assert.ok(k in out, k);
    assert.ok(validate(out), JSON.stringify(validate.errors));
    assert.ok(pr.extensions["agentcoin-escrow"], "body keeps the escrow hint");
    const raw = r.headers.get("payment-required");
    const hdr = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    assert.equal(hdr.exampleUrl, pr.exampleUrl);
    assert.equal(hdr.responseSchemaUrl, pr.responseSchemaUrl);
    // header budget: PAYMENT-REQUIRED and all response headers under 6 KB (8 KB proxy limits)
    assert.ok(raw.length < 6144, `PAYMENT-REQUIRED is ${raw.length} bytes`);
    let total = 0;
    r.headers.forEach((v, k) => (total += k.length + 2 + v.length + 2));
    assert.ok(total <= 6144 - 256, `response headers are ${total} bytes`);
    assert.equal(parsePaymentRequired(hdr).success, true);
    assert.equal(validateDiscoveryExtension(hdr.extensions.bazaar).valid, true);
    assert.equal(hdr.extensions.bazaar.info.output.example, undefined);
    assert.equal(hdr.extensions["agentcoin-escrow"], undefined);
    assert.deepEqual(hdr.accepts, pr.accepts);
    assert.deepEqual(hdr.resource, pr.resource);
  });
});

test("HTTP: openapi.json and llms.txt link the example and schema", async () => {
  await withApp({ ip: "6.6.6.10" }, async (get) => {
    const spec = await (await get("/openapi.json")).json();
    assert.ok(spec.paths["/v1/notarize/example"].get);
    assert.ok(spec.paths["/v1/notarize/schema.json"].get);
    const ok200 = spec.paths["/v1/notarize"].post.responses["200"];
    assert.equal(ok200.content["application/json"].schema.$ref, "#/components/schemas/NotaryResponse");
    assert.ok(ok200.content["application/json"].example.receipt);
    assert.deepEqual(spec.components.schemas.NotaryResponse, NOTARY_RESPONSE_SCHEMA);
    const llms = await (await get("/llms.txt")).text();
    assert.match(llms, /\/v1\/notarize\/example/);
    assert.match(llms, /\/v1\/notarize\/schema\.json/);
    assert.ok(llms.includes(NOTARY_RESPONSE_SCHEMA_HASH));
  });
});
