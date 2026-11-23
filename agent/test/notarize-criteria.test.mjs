// Opt-in gvp-criteria-checks/1 mode for /v1/notarize: deterministic criteria document, specHash = sha256(JCS(doc)),
// criteria + deliverable URLs, every check satisfied by the served deliverable, default mode unchanged.
// The first block is pure; the second needs the local Anvil deployment (skipped when 127.0.0.1:8545 is down).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { buildNotaryCriteria, criteriaBytes, criteriaSpecHash, parseCriteriaParams, criteriaOffer, deliverableSha256, deliverableBytes, DELIVERABLE_MAX_BYTES } from "../lib/criteria.mjs";
import { jcs } from "../lib/canonical.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const DIGEST = "0x" + "ab".repeat(32);
const ESCROW = "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D";
const KNOWN_TYPES = ["http-status", "header", "body-sha256", "body-max-bytes", "body-min-bytes", "json-valid", "json-pointer", "deliverable-hash", "gvp-response-hash"];
const doc = (o = {}) => buildNotaryCriteria({ baseUrl: "https://agentcoinhq.com", id: DIGEST.slice(2), digest: DIGEST, chainId: 84532, escrow: ESCROW, ...o });

// minimal evaluator for the structured checks (fetch = the response served at the deliverable URL)
function runCheck(check, { status, headers, body, onchainDeliverableHash }) {
  switch (check.type) {
    case "http-status": return status === check.equals;
    case "header": return String(headers.get(check.name) ?? "").trim() === check.equals;
    case "body-max-bytes": return body.length <= check.max;
    case "json-valid": try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); return true; } catch { return false; }
    case "json-pointer": {
      let v = JSON.parse(body.toString("utf8"));
      for (const seg of check.pointer.split("/").slice(1)) v = v?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
      return jcs(v) === jcs(check.equals);
    }
    case "deliverable-hash": return "0x" + sha(body) === onchainDeliverableHash.toLowerCase();
    default: throw new Error("unhandled check " + check.type);
  }
}

test("criteria document is deterministic; specHash is sha256 of its RFC 8785 bytes", () => {
  const a = criteriaBytes(doc());
  const b = criteriaBytes(doc());
  assert.equal(Buffer.compare(a, b), 0);
  assert.equal(a.toString("utf8"), jcs(doc()));
  assert.equal(criteriaSpecHash(doc()), "0x" + sha(a));
  // key order of the input object does not matter
  const reordered = JSON.parse(JSON.stringify(doc(), (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
  assert.equal(criteriaSpecHash(reordered), criteriaSpecHash(doc()));
  // different digest or nonce -> different hash and URL
  const n = doc({ id: DIGEST.slice(2) + "-n1" });
  assert.notEqual(criteriaSpecHash(n), criteriaSpecHash(doc()));
  assert.notEqual(criteriaSpecHash(doc({ digest: "0x" + "cd".repeat(32) })), criteriaSpecHash(doc()));
});

test("document respects x402toll limits and uses only gvp-criteria-checks/1 check types on one https URL", () => {
  const d = doc();
  assert.ok(criteriaBytes(d).length <= 16384);
  assert.ok(d.criteria.length <= 32 && d.criteria.filter((c) => c.required).length <= 15);
  assert.equal(new Set(d.criteria.map((c) => c.id)).size, d.criteria.length);
  const urls = new Set(d.criteria.map((c) => c.check.url));
  assert.equal(urls.size, 1);
  assert.match([...urls][0], /^https:\/\/agentcoinhq\.com\/v1\/deliverables\/[0-9a-f]{64}$/);
  for (const c of d.criteria) {
    assert.ok(KNOWN_TYPES.includes(c.check.type), c.check.type);
    assert.ok(c.id.length <= 128 && c.check.url.length <= 1024);
  }
  assert.ok(d.criteria.some((c) => c.check.type === "deliverable-hash"));
  assert.ok(DELIVERABLE_MAX_BYTES >= 1500, "limit leaves room for note (<=200 chars) and receipt fields");
});

test("parseCriteriaParams: off by default, strict when on", () => {
  const q = (o) => (k) => o[k] ?? null;
  assert.equal(parseCriteriaParams(q({})), null);
  assert.equal(parseCriteriaParams(q({ digest: DIGEST })), null);
  assert.match(parseCriteriaParams(q({ spec: "other/1", digest: DIGEST })).error, /spec must be/);
  assert.match(parseCriteriaParams(q({ spec: "gvp-criteria-checks/1" })).error, /digest/);
  assert.match(parseCriteriaParams(q({ spec: "gvp-criteria-checks/1", digest: "0x12" })).error, /digest/);
  assert.match(parseCriteriaParams(q({ spec: "gvp-criteria-checks/1", digest: DIGEST, nonce: "A B" })).error, /nonce/);
  const ok = parseCriteriaParams(q({ spec: "gvp-criteria-checks/1", digest: DIGEST.toUpperCase().replace("0X", "0x"), nonce: "j1" }));
  assert.deepEqual(ok, { digest: DIGEST, nonce: "j1", id: DIGEST.slice(2) + "-j1" });
});

test("receipt deliverable hash is sha256 over the RFC 8785 receipt bytes", () => {
  const receipt = { v: "agentcoin-notary/v1", z: 1, a: "x" };
  assert.equal(deliverableBytes(receipt).toString("utf8"), '{"a":"x","v":"agentcoin-notary/v1","z":1}');
  assert.equal(deliverableSha256(receipt), "0x" + sha(deliverableBytes(receipt)));
  assert.notEqual(deliverableSha256(receipt), keccak256(toBytes(jcs(receipt))));
  const o = criteriaOffer({ baseUrl: "https://agentcoinhq.com", params: { digest: DIGEST, nonce: null, id: DIGEST.slice(2) }, chainId: 84532, escrow: ESCROW });
  assert.equal(o.criteriaUrl, "https://agentcoinhq.com/v1/criteria/" + o.specHash.slice(2));
  assert.equal(o.metadata.specHash, o.specHash);
});

// ---------------- HTTP + local chain ----------------
const anvilUp = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok, () => false);
const chain = anvilUp ? await import("../lib/chain.mjs") : null;
const { createApp, notaryOffer } = anvilUp ? await import("../service/app.mjs") : {};
const { payExact } = anvilUp ? await import("../x402/pay-client.mjs") : {};
const cfgmod = anvilUp ? await import("../lib/config.mjs") : null;
const t = anvilUp && cfgmod.NETWORK === "local" ? test : test.skip;

async function withApp(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "accrit-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true, caps: { freePerIpPerHour: 500, perAddressPerDay: 50, globalGasWeiPerDay: 10n ** 20n }, loopMs: 1e9 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    await fn(base, app);
  } finally {
    await app.stop();
  }
}
const SPEC_TEXT_HASH = keccak256(toBytes("agentcoin-notary/v1: JSON receipt {v, digest, note, jobId, client, settleTx, notarizedAt, chainId}; deliverableHash = keccak256(RFC8785(receipt))"));
const Q = (digest, nonce) => `?spec=gvp-criteria-checks/1&digest=${digest}${nonce ? "&nonce=" + nonce : ""}`;

t("default 402 is unchanged (keccak specHash, no criteria member); criteria 402 carries specHash, URLs and the document", async () => {
  await withApp(async (base) => {
    const dflt = await (await fetch(base + "/v1/notarize")).json();
    const ex = dflt.accepts.find((a) => a.scheme === "exact");
    const es = dflt.accepts.find((a) => a.scheme === "agentcoin-escrow");
    assert.equal(ex.extra.agentcoin.offer.specHash, SPEC_TEXT_HASH);
    assert.equal(es.extra.specHash, SPEC_TEXT_HASH);
    assert.equal(ex.extra.agentcoin.criteria, undefined);
    assert.equal(es.extra.criteria, undefined);
    assert.equal(JSON.stringify(dflt).includes("gvp-criteria"), false);

    const r = await fetch(base + "/v1/notarize" + Q(DIGEST));
    assert.equal(r.status, 402);
    const pr = await r.json();
    const cx = pr.accepts.find((a) => a.scheme === "exact");
    const ce = pr.accepts.find((a) => a.scheme === "agentcoin-escrow");
    const m = cx.extra.agentcoin.criteria;
    assert.equal(cx.extra.agentcoin.offer.specHash, m.specHash);
    assert.equal(ce.extra.specHash, m.specHash);
    assert.equal(ce.extra.criteria.specHash, m.specHash);
    assert.notEqual(m.specHash, SPEC_TEXT_HASH);
    assert.notEqual(cx.payTo, ex.payTo, "payTo is offer-bound, so it differs per specHash");
    assert.equal(m.specHash, "0x" + sha(criteriaBytes(m.document)));
    assert.equal(m.vocabulary, "gvp-criteria-checks/1");
    assert.equal(m.criteriaUrl, `${base.replace(/:\d+$/, ":0")}/v1/criteria/${m.specHash.slice(2)}`);
    // header form carries the same challenge
    const hdr = JSON.parse(Buffer.from((await fetch(base + "/v1/notarize" + Q(DIGEST), { method: "POST", body: "{}" })).headers.get("payment-required"), "base64").toString());
    assert.equal(hdr.accepts.find((a) => a.scheme === "exact").extra.agentcoin.criteria.specHash, m.specHash);
    const hres = await fetch(base + "/v1/notarize" + Q(DIGEST), { method: "POST", body: "{}" });
    assert.ok(Buffer.byteLength(hres.headers.get("payment-required")) < 5888, "PAYMENT-REQUIRED header stays within the 402 header budget");
    assert.equal(hdr.accepts.find((a) => a.scheme === "exact").extra.agentcoin.criteria.document, undefined, "document is body-only");
    // bad params
    assert.equal((await fetch(base + "/v1/notarize?spec=gvp-criteria-checks/1")).status, 400);
    assert.equal((await fetch(base + "/v1/notarize?spec=nope&digest=" + DIGEST)).status, 400);
  });
});

t("GET /v1/criteria/<sha256> serves the exact bytes, immutable; unknown hash 404", async () => {
  await withApp(async (base) => {
    const pr = await (await fetch(base + "/v1/notarize" + Q(DIGEST, "k1"))).json();
    const m = pr.accepts.find((a) => a.scheme === "exact").extra.agentcoin.criteria;
    const r = await fetch(base + "/v1/criteria/" + m.specHash.slice(2));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/json");
    assert.match(r.headers.get("cache-control"), /immutable/);
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(sha(body), m.specHash.slice(2));
    assert.equal(body.toString("utf8"), jcs(m.document));
    assert.equal((await fetch(base + "/v1/criteria/" + "00".repeat(32))).status, 404);
    assert.equal((await fetch(base + "/v1/deliverables/" + DIGEST.slice(2) + "-zz")).status, 404);
  });
});

t("paid criteria-mode job: on-chain specHash/deliverableHash, every check passes on the served deliverable, reference evaluator completes it", async () => {
  await withApp(async (base, app) => {
    const { contracts, read } = chain;
    const c = contracts();
    const digest = "0x" + createHash("sha256").update("criteria-mode " + Date.now()).digest("hex");
    const r = await payExact(base + "/v1/notarize" + Q(digest, "t1"), { method: "POST", body: { sha256: digest, note: "criteria" } });
    assert.equal(r.status, 200);
    const out = r.resource;
    const j = await read(c.escrow, "getJob", [BigInt(out.jobId)]);
    const refs = out.criteria;
    assert.equal(j.specHash, refs.specHash);
    assert.equal(j.deliverableHash, out.deliverableHash);
    assert.equal(out.deliverableHash, deliverableSha256(out.receipt));
    assert.ok(out.agentcoin.verified, JSON.stringify(out.agentcoin));
    // the criteria document served at criteriaUrl hashes to the on-chain specHash
    const cdoc = Buffer.from(await (await fetch(refs.criteriaUrl.replace(/^http:\/\/127\.0\.0\.1:0/, base))).arrayBuffer());
    assert.equal("0x" + sha(cdoc), j.specHash);
    const document = JSON.parse(cdoc.toString("utf8"));
    // deliverable at the stable URL: every required check holds
    const dr = await fetch(refs.deliverableUrl.replace(/^http:\/\/127\.0\.0\.1:0/, base));
    const body = Buffer.from(await dr.arrayBuffer());
    const resp = { status: dr.status, headers: dr.headers, body, onchainDeliverableHash: j.deliverableHash };
    assert.equal(body.toString("utf8"), jcs(out.receipt), "served bytes are the RFC 8785 receipt");
    for (const cr of document.criteria.filter((x) => x.required)) assert.equal(runCheck(cr.check, resp), true, cr.id);
    assert.match(dr.headers.get("cache-control"), /immutable/);
    // a tampered body would fail the deliverable-hash check
    assert.equal(runCheck({ type: "deliverable-hash" }, { ...resp, body: Buffer.from(body.toString() + " ") }), false);
    // status endpoint shows the same references
    const st = await (await fetch(`${base}/v1/notarize/${out.jobId}`)).json();
    assert.equal(st.criteria.specHash, j.specHash);
    assert.ok(st.agentcoin.verified);
    // same digest + nonce cannot be funded twice
    await assert.rejects(payExact(base + "/v1/notarize" + Q(digest, "t1"), { method: "POST", body: { sha256: digest } }), /criteria id already used/);
    // body digest must match the digest the criteria were built for
    const other = "0x" + "11".repeat(32);
    const pr = await (await fetch(base + "/v1/notarize" + Q(other, "t2"))).json();
    assert.ok(pr.accepts.length);
    await assert.rejects(payExact(base + "/v1/notarize" + Q(other, "t2"), { method: "POST", body: { sha256: digest } }), /400/);
    // reference evaluator (unchanged code path) issues Complete
    await app.tick();
    const after = await read(c.escrow, "getJob", [BigInt(out.jobId)]);
    assert.equal(cfgmod.STATES[after.state], "Completed", `tick error: ${app.lastTickError}`);
  });
});

t("default mode paid job is unchanged: keccak specHash and deliverableHash, no criteria member", async () => {
  await withApp(async (base) => {
    const { contracts, read } = chain;
    const r = await payExact(base + "/v1/notarize", { method: "POST", body: { data: "default path " + Date.now() } });
    const out = r.resource;
    const j = await read(contracts().escrow, "getJob", [BigInt(out.jobId)]);
    assert.equal(j.specHash, SPEC_TEXT_HASH);
    assert.equal(j.deliverableHash, keccak256(toBytes(jcs(out.receipt))));
    assert.equal(out.criteria, undefined);
    assert.ok(out.agentcoin.verified);
    const st = await (await fetch(`${base}/v1/notarize/${out.jobId}`)).json();
    assert.equal(st.criteria, undefined);
  });
});
