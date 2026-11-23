// /free and /trust: JSON by default, HTML when the client asks for it; /free never sends funds; /trust serves state-dir files; legacy hints are well-formed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function withApp(fn) {
  const { createApp } = await import("../service/app.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "pages-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", loopMs: 1e9 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${app.server.address().port}`, dir); } finally { await app.stop(); }
}
const HTML = { accept: "text/html,application/xhtml+xml" };

test("/free: JSON by default, HTML for browsers; testnet flags; manual fulfilment, no funds endpoint", async () => {
  await withApp(async (base) => {
    const j = await fetch(base + "/free"); assert.equal(j.status, 200); assert.match(j.headers.get("content-type"), /json/);
    const o = await j.json();
    assert.equal(o.v, "agentkoin-free-offer/v1"); assert.equal(typeof o.testnet, "boolean"); assert.equal(o.realValue, false); // testnet label is stamped by the service from its network mode assert.equal(o.chainId, 84532);
    assert.equal(o.offer.amountPerClaim.atomic, "50000"); assert.equal(o.offer.maxClaims, 50);
    assert.equal(o.request.automated, false); assert.equal(o.fulfilment.automated, false); assert.equal(o.fulfilment.endpointThatSendsFunds, null);
    const h = await fetch(base + "/free", { headers: HTML }); assert.equal(h.status, 200); assert.match(h.headers.get("content-type"), /html/);
    const t = await h.text(); assert.match(t, /testnet/i); assert.doesNotMatch(t, /<script/i);
    assert.equal((await fetch(base + "/free.json")).headers.get("content-type").includes("json"), true);
    assert.equal((await fetch(base + "/free", { method: "POST", body: "{}" })).status === 200, false); // nothing to claim through
    assert.equal((await (await fetch(base + "/")).json()).links.free, "http://127.0.0.1:0/free");
  });
});

test("/trust: 404 until files exist; then JSON by default and HTML for browsers; /trust/jobs.json always JSON", async () => {
  await withApp(async (base, dir) => {
    assert.equal((await fetch(base + "/trust")).status, 404);
    mkdirSync(path.join(dir, "trust"));
    writeFileSync(path.join(dir, "trust", "jobs.json"), '{"v":"agentkoin-trust-page/v1","jobs":[]}');
    writeFileSync(path.join(dir, "trust", "index.html"), "<!doctype html><title>t</title>");
    const j = await fetch(base + "/trust"); assert.equal(j.status, 200); assert.equal((await j.json()).v, "agentkoin-trust-page/v1");
    const h = await fetch(base + "/trust", { headers: HTML }); assert.match(h.headers.get("content-type"), /html/); assert.match(await h.text(), /<title>t<\/title>/);
    const jj = await fetch(base + "/trust/jobs.json", { headers: HTML }); assert.match(jj.headers.get("content-type"), /json/);
    assert.equal((await fetch(base + "/trust", { method: "HEAD", headers: HTML })).status, 200);
  });
});

test("legacy hints: jobs 1-4 each carry four tx hashes", async () => {
  const { LEGACY_JOB_HINTS } = await import("../lib/legacy-job-hints.mjs");
  const h = LEGACY_JOB_HINTS["0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D"];
  assert.deepEqual(Object.keys(h), ["1", "2", "3", "4"]);
  for (const v of Object.values(h)) for (const k of ["fundTx", "submitTx", "verdictTx", "settleTx"]) assert.match(v[k], /^0x[0-9a-f]{64}$/);
});

test("0.5.31 discovery paths: robots.txt, agent.json and mcp aliases, agents.json index", async () => {
  await withApp(async (base, dir) => {
    const r = await fetch(base + "/robots.txt"); assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /^text\/plain/);
    assert.equal(await r.text(), "User-agent: *\nAllow: /\n");
    const a = await fetch(base + "/.well-known/agent.json"), b = await fetch(base + "/.well-known/agent-card.json");
    assert.equal(a.status, 200); assert.equal(a.headers.get("content-type"), b.headers.get("content-type")); assert.equal(await a.text(), await b.text());
    const m = await fetch(base + "/.well-known/mcp"), n = await fetch(base + "/.well-known/mcp/server-card.json");
    assert.equal(m.status, 200); assert.equal(m.headers.get("content-type"), n.headers.get("content-type")); assert.equal(await m.text(), await n.text());
    const g = await fetch(base + "/.well-known/agents.json"); assert.equal(g.status, 200); assert.match(g.headers.get("content-type"), /json/);
    const d = await g.json(); assert.equal(d.discovery.concordiumAgentCard, undefined); assert.equal(d.discovery.trustJobs, undefined);
    for (const [k, u] of Object.entries(d.discovery)) if (k !== "openapi") assert.equal((await fetch(u.replace("http://127.0.0.1:0", base))).status, 200, u);
    writeFileSync(path.join(dir, "concordium-agent-card.json"), "{}"); mkdirSync(path.join(dir, "trust")); writeFileSync(path.join(dir, "trust", "jobs.json"), "{}");
    const d2 = await (await fetch(base + "/.well-known/agents.json")).json(); assert.ok(d2.discovery.concordiumAgentCard && d2.discovery.trustJobs);
  });
});

test("criteria spec: served bytes equal the file, digest alias and agents.json agree, content constraints hold", async () => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const file = readFileSync(new URL("../criteria/notarize-binding-v1.json", import.meta.url));
  const want = "0x" + createHash("sha256").update(file).digest("hex");
  await withApp(async (base) => {
    const r = await fetch(base + "/specs/criteria/notarize-binding-v1.json"); assert.equal(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer()); assert.equal(Buffer.compare(buf, file), 0);
    assert.match(r.headers.get("cache-control"), /immutable/);
    assert.equal((await (await fetch(base + "/specs/criteria/notarize-binding-v1.sha256")).text()).trim(), want);
    const ag = await (await fetch(base + "/.well-known/agents.json")).json();
    assert.equal(ag.criteria.notarizeBindingV1.sha256, want);
    const s = JSON.parse(buf.toString("utf8"));
    assert.equal(s.specId, "agentkoin-notarize-binding-criteria/v1"); assert.equal(s.testnet, true);
    assert.ok(s.checks.length >= 6); assert.ok(s.outOfScope.length >= 1);
    assert.ok(s.verdictFields.required.includes("specDigest"));
    for (const c of s.checks) assert.ok(c.id && c.pass && c.recompute);
  });
});
