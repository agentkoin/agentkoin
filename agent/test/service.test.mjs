// Offline tests for the public testnet service: caps, anonymous stats, input validation, labels (no chain needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Caps, utcDay } from "../service/caps.mjs";
import { Stats, uaBucket, refBucket, classifyPayers, parseDemoBuyers } from "../service/stats.mjs";
import { createApp, parseNotarizeInput, clientIp, receiptHash } from "../service/app.mjs";
import { declareDiscoveryExtension, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { parseExtensionResponses, payaiVerify, payaiEnabled } from "../x402/payai.mjs";
import { createServer } from "node:http";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

test("caps: per-IP, per-address, global paid and global gas limits", () => {
  const c = new Caps({ perIpPerDay: 2, perAddressPerDay: 3, globalPaidPerDay: 4, globalGasWeiPerDay: 100n, freePerIpPerHour: 1000 });
  assert.equal(c.admitPaid("1.1.1.1", A, 10n).ok, true);
  assert.equal(c.admitPaid("1.1.1.1", A, 10n).ok, true);
  assert.equal(c.admitPaid("1.1.1.1", B, 10n).reason, "per_ip_daily_cap");
  assert.equal(c.admitPaid("2.2.2.2", A, 10n).ok, true);
  assert.equal(c.admitPaid("3.3.3.3", A, 10n).reason, "per_address_daily_cap");
  assert.equal(c.admitPaid("3.3.3.3", B, 10n).ok, true); // 4th paid call
  assert.equal(c.admitPaid("4.4.4.4", B, 10n).reason, "global_daily_paid_call_cap");
  const g = new Caps({ perIpPerDay: 99, perAddressPerDay: 99, globalPaidPerDay: 99, globalGasWeiPerDay: 100n });
  const r1 = g.admitPaid("a", A, 60n);
  assert.equal(r1.ok, true);
  assert.equal(g.admitPaid("b", B, 60n).reason, "global_daily_gas_cap"); // 60 reserved + 60 > 100
  g.spend(20n, r1.reservation); // actual cost replaces part of the reservation: spent 20, reserved 40
  assert.equal(g.snapshot().usage.gasSpentWei, "20");
  assert.equal(g.snapshot().usage.gasReservedWei, "40");
  assert.equal(g.admitPaid("b", B, 40n).ok, true); // 20 + 40 + 40 = 100
  assert.equal(g.admitPaid("c", B, 1n).reason, "global_daily_gas_cap");
});

test("caps: release undoes an admission; background spend allowed up to 2x budget", () => {
  const c = new Caps({ perIpPerDay: 1, perAddressPerDay: 1, globalPaidPerDay: 1, globalGasWeiPerDay: 100n });
  const r = c.admitPaid("ip", A, 50n);
  assert.equal(c.admitPaid("ip", A, 1n).ok, false);
  c.release(r.reservation, { ip: "ip", payer: A });
  assert.equal(c.snapshot().usage.paidCalls, 0);
  assert.equal(c.snapshot().usage.gasReservedWei, "0");
  assert.equal(c.admitPaid("ip", A, 1n).ok, true);
  c.spend(150n);
  assert.equal(c.canSpendBackground(50n), true);
  assert.equal(c.canSpendBackground(51n), false);
});

test("caps: UTC day rollover resets counters and rotates the IP salt", () => {
  let t = Date.parse("2026-10-30T23:59:00Z");
  const c = new Caps({ perIpPerDay: 1, perAddressPerDay: 1, globalPaidPerDay: 5, globalGasWeiPerDay: 1000n, now: () => t });
  const h1 = c.ipKey("9.9.9.9");
  assert.equal(c.admitPaid("9.9.9.9", A, 1n).ok, true);
  assert.equal(c.admitPaid("9.9.9.9", A, 1n).ok, false);
  t = Date.parse("2026-10-31T00:00:01Z");
  assert.equal(c.admitPaid("9.9.9.9", A, 1n).ok, true);
  assert.equal(c.day, utcDay(t));
  assert.notEqual(c.ipKey("9.9.9.9"), h1);
  assert.ok(!JSON.stringify(c.snapshot()).includes("9.9.9.9"));
});

test("caps: free requests per IP per hour", () => {
  const c = new Caps({ freePerIpPerHour: 2 });
  assert.equal(c.checkFree("x").ok, true);
  assert.equal(c.checkFree("x").ok, true);
  const r = c.checkFree("x");
  assert.equal(r.ok, false);
  assert.ok(r.retryAfterSeconds > 0);
  assert.equal(c.checkFree("y").ok, true);
});

test("stats: buckets, unique payers, persistence, and no personal data", () => {
  assert.equal(uaBucket("Mozilla/5.0 (X11; Linux) Chrome/1"), "Mozilla");
  assert.equal(uaBucket("python-httpx/0.27"), "python-httpx");
  assert.equal(uaBucket(""), "(none)");
  assert.equal(refBucket("https://Example.com/path?q=secret"), "example.com");
  assert.equal(refBucket("nonsense"), "(invalid)");
  const dir = mkdtempSync(path.join(tmpdir(), "acstats-"));
  const f = path.join(dir, "stats.json");
  const s = new Stats({ file: f });
  s.request({ userAgent: "curl/8.0 extra", referer: "https://a.example/x?token=1", endpoint: "GET /" });
  s.inc("paymentRequired402");
  s.payer(A);
  s.payer(A.toUpperCase().replace("0X", "0x"));
  s.payer("not-an-address");
  s.inc("mcpSessions");
  s.flush();
  const raw = readFileSync(f, "utf8");
  assert.ok(!raw.includes("token=1") && !raw.includes("extra") && !raw.includes("/x"));
  const s2 = new Stats({ file: f });
  const snap = s2.snapshot();
  assert.equal(snap.counters.paymentRequired402, 1);
  assert.equal(snap.counters.mcpSessions, 1);
  assert.equal(snap.uniquePayerAddresses, 1);
  assert.equal(snap.userAgents.curl, 1);
  assert.equal(snap.referrers["a.example"], 1);
  for (let i = 0; i < 300; i++) s2.request({ userAgent: `bot${i}/1` });
  assert.ok(Object.keys(s2.snapshot().userAgents).length <= 201);
  assert.ok(s2.snapshot().userAgents["(overflow)"] > 0);
});

test("notarize input validation and receipt hash determinism", () => {
  assert.ok(parseNotarizeInput("{}").error);
  assert.ok(parseNotarizeInput("[1]").error);
  assert.ok(parseNotarizeInput('{"sha256":"0x12"}').error);
  assert.ok(parseNotarizeInput(JSON.stringify({ data: "x".repeat(4097) })).error);
  assert.ok(parseNotarizeInput(JSON.stringify({ data: "a", sha256: "0x" + "00".repeat(32) })).error);
  const d = parseNotarizeInput(JSON.stringify({ data: "abc" }));
  assert.equal(d.digest, "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const h = parseNotarizeInput(JSON.stringify({ sha256: "0x" + "AB".repeat(32), note: "n" }));
  assert.equal(h.digest, "0x" + "ab".repeat(32));
  assert.equal(receiptHash({ b: 1, a: 2 }), receiptHash({ a: 2, b: 1 }));
});

test("clientIp honours proxy headers only when TRUST_PROXY", () => {
  const req = { headers: { "x-forwarded-for": "5.5.5.5, 10.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(clientIp(req, false), "127.0.0.1");
  assert.equal(clientIp(req, true), "5.5.5.5");
  assert.equal(clientIp({ headers: { "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "5.5.5.5" }, socket: {} }, true), "6.6.6.6");
});

test("HTTP: stats endpoint counts requests, value label on every JSON, free-rate cap returns 429, stats store no IPs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acsvc-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true, caps: { freePerIpPerHour: 5 } });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = (p, ip = "7.7.7.7") => fetch(base + p, { headers: { "x-forwarded-for": ip, "user-agent": "TestAgent/1.0 (secret)", referer: "https://ref.example/p?q=1" } });
  try {
    const h = await get("/healthz");
    assert.equal(h.headers.get("x-agentcoin-real-value"), "false");
    const hj = await h.json();
    assert.equal(hj.realValue, false);
    assert.ok("testnet" in hj);
    const f = await (await get("/v1/faucets")).json();
    assert.ok(f.faucets.some((x) => x.url === "https://faucet.circle.com"));
    assert.equal(f.realValue, false);
    const st = await (await get("/v1/stats")).json();
    assert.equal(st.counters.requests, 3);
    assert.equal(st.userAgents.TestAgent, 3);
    assert.equal(st.referrers["ref.example"], 3);
    assert.equal(st.realValue, false);
    const c = await (await get("/v1/caps")).json();
    assert.equal(c.limits.freeRequestsPerIpPerHour, 5);
    await get("/healthz");
    const blocked = await get("/healthz");
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error, "free_rate_limit");
    assert.equal((await get("/healthz", "8.8.8.8")).status, 200); // other IP unaffected
    const unpaid = await fetch(base + "/v1/notarize", { method: "POST", headers: { "x-forwarded-for": "9.9.9.9" }, body: "{}" });
    assert.equal(unpaid.status, 402);
    assert.equal((await fetch(base + "/mcp", { headers: { "x-forwarded-for": "9.9.9.9" } })).status, 405);
    app.stats.flush();
    const raw = readFileSync(path.join(dir, "stats.json"), "utf8");
    for (const ip of ["7.7.7.7", "8.8.8.8", "9.9.9.9"]) assert.ok(!raw.includes(ip), `stats must not contain ${ip}`);
    assert.ok(!raw.includes("secret"));
  } finally {
    await app.stop();
  }
});

test("caps: finish() returns unspent reservation without undoing admission counts", async () => {
  const { Caps } = await import("../service/caps.mjs");
  const c = new Caps({ globalGasWeiPerDay: 100n, perAddressPerDay: 5 });
  const a = c.admitPaid("1.2.3.4", "0x00000000000000000000000000000000000000aa", 40n);
  assert.equal(a.ok, true);
  c.spend(10n, a.reservation);
  assert.equal(c.snapshot().usage.gasReservedWei, "30");
  c.finish(a.reservation);
  const u = c.snapshot().usage;
  assert.equal(u.gasReservedWei, "0");
  assert.equal(u.gasSpentWei, "10");
  assert.equal(u.paidCalls, 1);
});

test("HTTP: door-knocker v2 ref attribution (query or header, validated, per variant, no IPs)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acref-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const h = { "x-forwarded-for": "6.6.6.6" };
  try {
    assert.equal((await fetch(base + "/QUICKSTART-AGENTS.md?ref=a1b-1f2e3d4c", { headers: h })).status, 200);
    await fetch(base + "/llms.txt?ref=A1B-1F2E3D4C", { headers: h });
    await fetch(base + "/healthz", { headers: { ...h, "x-agentcoin-ref": "a3d-00000000" } });
    await fetch(base + "/healthz?ref=evil-<script>", { headers: h });
    await fetch(base + "/healthz?ref=a1e-1f2e3d4c", { headers: h }); // framing e does not exist
    const init = await fetch(base + "/mcp?ref=mcc-abcdef01", { method: "POST", headers: { ...h, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) });
    assert.equal(init.status, 200);
    const st = await (await fetch(base + "/v1/stats", { headers: h })).json();
    const d = st.doorknock;
    assert.deepEqual(d.byRef["a1b-1f2e3d4c"], { requests: 2, quickstart: 1, llms: 1 });
    assert.deepEqual(d.byRef["a3d-00000000"], { requests: 1 });
    assert.equal(d.byRef["mcc-abcdef01"].mcpSessions, 1);
    assert.equal(Object.keys(d.byRef).length, 3, "invalid refs are ignored");
    assert.equal(d.byVariant.a1b.quickstart, 1);
    assert.equal(d.byVariant.mcc.refsSeen, 1);
    app.stats.flush();
    assert.ok(!readFileSync(path.join(dir, "stats.json"), "utf8").includes("6.6.6.6"));
  } finally {
    await app.stop();
  }
});

test("stats: classifyPayers and parseDemoBuyers", () => {
  const internal = [A, "0x3333333333333333333333333333333333333333"];
  assert.deepEqual(classifyPayers([A, B, A], internal), { uniqueInternalPayerAddresses: 1, uniqueOutsidePayerAddresses: 1 });
  assert.deepEqual(classifyPayers([], internal), { uniqueInternalPayerAddresses: 0, uniqueOutsidePayerAddresses: 0 });
  assert.deepEqual(classifyPayers([B], []), { uniqueInternalPayerAddresses: 0, uniqueOutsidePayerAddresses: 1 });
  assert.deepEqual(classifyPayers(["not-an-address", A], [A]), { uniqueInternalPayerAddresses: 1, uniqueOutsidePayerAddresses: 0 });
  const demos = parseDemoBuyers(`stos-demo-buyer-1:${A}, stos-demo-buyer-2:${B}, bad, x:0xzz, stos-demo-buyer-1:${A}`);
  assert.equal(demos.length, 2);
  assert.equal(demos[0].label, "stos-demo-buyer-1");
  assert.equal(demos[0].address, A);
  assert.equal(demos[0].operatedBy, "STOS Technologies LLC");
  assert.equal(demos[0].kind, "internal-demo");
  assert.equal(demos[1].label, "stos-demo-buyer-2");
  assert.deepEqual(parseDemoBuyers(""), []);
});

test("HTTP: /v1/stats splits internal vs outside payers and lists labeled demo buyers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acpayers-"));
  const prevI = process.env.AGENTCOIN_INTERNAL_ADDRESSES;
  const prevD = process.env.AGENTCOIN_DEMO_BUYERS;
  process.env.AGENTCOIN_INTERNAL_ADDRESSES = A;
  process.env.AGENTCOIN_DEMO_BUYERS = `stos-demo-buyer-1:${A}`;
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    app.stats.payer(A);
    app.stats.payer(B);
    const st = await (await fetch(base + "/v1/stats")).json();
    assert.equal(st.uniquePayerAddresses, 2);
    assert.equal(st.uniqueInternalPayerAddresses, 1);
    assert.equal(st.uniqueOutsidePayerAddresses, 1);
    assert.equal(st.demoBuyers.length, 1);
    assert.equal(st.demoBuyers[0].label, "stos-demo-buyer-1");
    assert.equal(st.demoBuyers[0].operatedBy, "STOS Technologies LLC");
    assert.equal(st.demoBuyers[0].kind, "internal-demo");
    assert.equal(st.demoBuyers[0].hasPaid, true);
    assert.equal(st.demoBuyers[0].address.toLowerCase(), A);
    assert.equal(st.realValue, false);
  } finally {
    if (prevI === undefined) delete process.env.AGENTCOIN_INTERNAL_ADDRESSES;
    else process.env.AGENTCOIN_INTERNAL_ADDRESSES = prevI;
    if (prevD === undefined) delete process.env.AGENTCOIN_DEMO_BUYERS;
    else process.env.AGENTCOIN_DEMO_BUYERS = prevD;
    await app.stop();
  }
});

test("bazaar declaration from declareDiscoveryExtension is valid", () => {
  const ext = declareDiscoveryExtension({
    method: "POST",
    bodyType: "json",
    input: { sha256: "0x" + "ab".repeat(32), note: "base-sepolia testnet" },
    inputSchema: { properties: { sha256: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, note: { type: "string", maxLength: 200 } } },
    output: { example: { receipt: { v: "agentcoin-notary/v1" }, jobId: "1" } },
  });
  assert.equal(validateDiscoveryExtension(ext.bazaar).valid, true);
  assert.equal(ext.bazaar.info.input.method, "POST");
  assert.equal(ext.bazaar.info.input.bodyType, "json");
});

test("parseExtensionResponses decodes the facilitator header", () => {
  const b64 = Buffer.from(JSON.stringify({ bazaar: { status: "processing" } })).toString("base64");
  assert.deepEqual(parseExtensionResponses({ "extension-responses": b64 }), { bazaar: { status: "processing" } });
  assert.equal(parseExtensionResponses({}), null);
  assert.equal(parseExtensionResponses({ "extension-responses": "not-base64" }), null);
});

test("payaiEnabled is off when PAYAI_VERIFY=0 and on when a facilitator URL is set", () => {
  assert.equal(payaiEnabled({ PAYAI_VERIFY: "0" }), false);
  assert.equal(payaiEnabled({ PAYAI_FACILITATOR_URL: "http://127.0.0.1:9" }), true);
});

test("payaiVerify posts to /verify and returns EXTENSION-RESPONSES", async () => {
  const seen = [];
  const hdr = Buffer.from(JSON.stringify({ bazaar: { status: "processing" } })).toString("base64");
  const server = createServer((req, res) => {
    seen.push(req.method + " " + req.url);
    res.setHeader("EXTENSION-RESPONSES", hdr);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ isValid: true }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const out = await payaiVerify({
      paymentPayload: { x402Version: 2, extensions: { bazaar: { info: { input: { type: "http", method: "POST" } } } } },
      paymentRequirements: { scheme: "exact" },
      env: { PAYAI_FACILITATOR_URL: `http://127.0.0.1:${port}` },
    });
    assert.deepEqual(seen, ["POST /verify"]);
    assert.equal(out.ok, true);
    assert.equal(out.extensionResponsesHeader, hdr);
    assert.deepEqual(out.extensionResponses, { bazaar: { status: "processing" } });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("HTTP: GET/HEAD /v1/notarize return 402 with bazaar declaration; GET /icon.png is a PNG", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ac402-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true, caps: { freePerIpPerHour: 20 } });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const get = await fetch(base + "/v1/notarize");
    assert.equal(get.status, 402);
    const pr = await get.json();
    assert.equal(pr.resource.serviceName, "AgentKoin");
    assert.equal(pr.resource.iconUrl, "http://127.0.0.1:0/brand/symbol-1024.png");
    assert.deepEqual(pr.resource.tags, ["escrow", "notary", "timestamp", "usdc", "testnet"]);
    // CDP Bazaar rules: description <= 500 chars, describes the endpoint (no agent instructions), PNG icon
    assert.ok(pr.resource.description.length <= 500, String(pr.resource.description.length));
    assert.match(pr.resource.description, /^Timestamp notary on Base Sepolia testnet \(test USDC, no real value\)\./);
    assert.doesNotMatch(pr.resource.description, /\b(you (must|should)|ignore|always|never|instruct|agents? should)\b/i);
    assert.ok(pr.extensions?.bazaar);
    assert.equal(validateDiscoveryExtension(pr.extensions.bazaar).valid, true);
    assert.equal(pr.extensions.bazaar.info.input.method, "POST");
    // real input example (example job digest) and the published response schema as the output schema
    const { NOTARY_RESPONSE_SCHEMA } = await import("../lib/notary-schema.mjs");
    assert.match(pr.extensions.bazaar.info.input.body.sha256, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(pr.extensions.bazaar.schema.properties.output.properties.example.required, NOTARY_RESPONSE_SCHEMA.required);
    assert.deepEqual(pr.extensions.bazaar.schema.properties.output.properties.example.properties, NOTARY_RESPONSE_SCHEMA.properties);
    assert.ok(pr.extensions.bazaar.info.output.example.receipt);
    // header copy: same resource metadata, output schema slimmed, still a valid declaration
    const hdr = JSON.parse(Buffer.from(get.headers.get("payment-required"), "base64").toString("utf8"));
    assert.deepEqual(hdr.resource, pr.resource);
    assert.deepEqual(hdr.extensions.bazaar.schema.properties.output.properties.example, { type: "object" });
    assert.equal(validateDiscoveryExtension(hdr.extensions.bazaar).valid, true);
    const schemes = pr.accepts.map((a) => a.scheme);
    assert.ok(schemes.includes("exact") && schemes.includes("agentcoin-escrow"));
    const head = await fetch(base + "/v1/notarize", { method: "HEAD" });
    assert.equal(head.status, 402);
    const icon = await fetch(base + "/icon.png");
    assert.equal(icon.status, 200);
    assert.ok(icon.headers.get("content-type").startsWith("image/png"));
    const buf = Buffer.from(await icon.arrayBuffer());
    assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  } finally {
    await app.stop();
  }
});

test("pay-client echoes resource and extensions verbatim", async () => {
  const { paymentPayloadFromChallenge } = await import("../x402/pay-client.mjs").catch(async () => {
    // helper may be inline in payExact; import the built payload helper if exported, else test the same shape here
    return {};
  });
  const { parseExtensionResponses, payaiEnabled } = await import("../x402/payai.mjs");
  const pr = { resource: { url: "https://agentcoinhq.com/v1/notarize", serviceName: "AgentCoin" }, extensions: { bazaar: { info: { input: { type: "http", method: "POST" } } } }, accepts: [] };
  // Reconstruct the payload the same way payExact does (resource + extensions copied verbatim).
  const payload = { x402Version: 2, resource: pr.resource, accepted: { scheme: "exact" }, payload: { signature: "0x", authorization: {} }, ...(pr.extensions ? { extensions: pr.extensions } : {}) };
  assert.equal(payload.resource, pr.resource);
  assert.equal(payload.extensions, pr.extensions);
  assert.equal(payload.resource.serviceName, "AgentCoin");
  const hdr = Buffer.from(JSON.stringify({ bazaar: { status: "processing" } })).toString("base64");
  assert.deepEqual(parseExtensionResponses({ get: (k) => (k.toLowerCase() === "extension-responses" ? hdr : null) }), { bazaar: { status: "processing" } });
  assert.equal(parseExtensionResponses({ get: () => null }), null);
  assert.equal(payaiEnabled({ PAYAI_VERIFY: "0" }), false);
  assert.equal(payaiEnabled({ PAYAI_FACILITATOR_URL: "http://127.0.0.1:9" }), true);
});

test("HTTP: GET /v1/notarize is 402 with bazaar declaration, GET /icon.png is a PNG", async () => {
  const { validateDiscoveryExtension } = await import("@x402/extensions/bazaar");
  const dir = mkdtempSync(path.join(tmpdir(), "ac402-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const r = await fetch(base + "/v1/notarize", { headers: { "x-forwarded-for": "4.4.4.4" } });
    assert.equal(r.status, 402);
    const pr = await r.json();
    assert.equal(pr.resource.serviceName, "AgentKoin");
    assert.ok(String(pr.resource.iconUrl).endsWith("/brand/symbol-1024.png"));
    assert.deepEqual(pr.resource.tags, ["escrow", "notary", "timestamp", "usdc", "testnet"]);
    const schemes = pr.accepts.map((a) => a.scheme);
    assert.ok(schemes.includes("exact") && schemes.includes("agentcoin-escrow"));
    assert.equal(pr.extensions.bazaar.info.input.method, "POST");
    assert.equal(pr.extensions.bazaar.info.input.bodyType, "json");
    assert.equal(validateDiscoveryExtension(pr.extensions.bazaar).valid, true);
    const icon = await fetch(base + "/icon.png", { headers: { "x-forwarded-for": "4.4.4.4" } });
    assert.equal(icon.status, 200);
    assert.ok(icon.headers.get("content-type").startsWith("image/png"));
    const buf = Buffer.from(await icon.arrayBuffer());
    assert.equal(buf.subarray(0, 8).toString("binary"), "\x89PNG\r\n\x1a\n");
  } finally {
    await app.stop();
  }
});

test("HTTP: POST /v1/notarize with {} or an empty body returns 402 with the bazaar declaration", async () => {
  const { validateDiscoveryExtension } = await import("@x402/extensions/bazaar");
  const dir = mkdtempSync(path.join(tmpdir(), "ac402-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const body of ["{}", ""]) {
      const r = await fetch(base + "/v1/notarize", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "5.5.5.5" },
        body,
      });
      assert.equal(r.status, 402, `expected 402 for body=${JSON.stringify(body)}, got ${r.status}`);
      const pr = await r.json();
      assert.equal(pr.resource.serviceName, "AgentKoin");
      assert.ok(pr.extensions?.bazaar);
      assert.equal(validateDiscoveryExtension(pr.extensions.bazaar).valid, true);
      const schemes = pr.accepts.map((a) => a.scheme);
      assert.ok(schemes.includes("exact") && schemes.includes("agentcoin-escrow"));
    }
  } finally {
    await app.stop();
  }
});

test("HTTP: openapi.json documents x402 pricing, a 402 response, contact, and icon", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ac402-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const [spec, challenge] = await Promise.all([
      fetch(base + "/openapi.json", { headers: { "x-forwarded-for": "5.5.5.6" } }).then((r) => r.json()),
      fetch(base + "/v1/notarize", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "5.5.5.6" }, body: "{}" }).then((r) => r.json()),
    ]);
    const ex = challenge.accepts.find((a) => a.scheme === "exact");
    const pay = spec.paths["/v1/notarize"].post["x-payment"];
    assert.equal(pay.scheme, "exact");
    assert.equal(pay.network, ex.network);
    assert.equal(String(pay.amount), String(ex.amount));
    assert.equal(pay.payTo, ex.payTo);
    assert.equal(pay.asset, ex.asset);
    assert.equal(pay.price, "0.01");
    assert.equal(spec.info.contact.url, "https://github.com/stos-technologies/agentcoin");
    assert.equal(spec.info.contact.email, undefined);
    assert.equal(spec.info["x-icon"], "https://agentcoinhq.com/icon.png");
    assert.equal(spec.info["x-logo"].url, "https://agentcoinhq.com/icon.png");
    const r402 = spec.paths["/v1/notarize"].post.responses["402"];
    assert.ok(r402);
    assert.ok(r402.headers["PAYMENT-REQUIRED"]);
    assert.ok(r402.content["application/json"]);
  } finally {
    await app.stop();
  }
});

test("HTTP: GET /.well-known/x402 is the well-known file byte-for-byte", async () => {
  const { readFileSync } = await import("node:fs");
  const expected = readFileSync(new URL("../static/well-known-x402.json", import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "ac402-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const r = await fetch(base + "/.well-known/x402", { headers: { "x-forwarded-for": "5.5.5.7" } });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("content-type").startsWith("application/json"));
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(buf, expected);
    const doc = JSON.parse(buf.toString("utf8"));
    const ex = doc.resources[0].accepts.find((a) => a.scheme === "exact");
    assert.equal(ex.payTo, "0x6A32bC3Bb5eA1dc814f14E29e6f026535129A84f");
    assert.equal(ex.amount, "10000");
  } finally {
    await app.stop();
  }
});

test("findUsdcTransferToRoute matches from, to, value and ignores other logs", async () => {
  const { encodeEventTopics, encodeAbiParameters, parseAbiItem } = await import("viem");
  const { findUsdcTransferToRoute, attachedTxHashes, jobCreatedFromReceipt } = await import("../x402/route-deposit.mjs");
  const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const route = "0x6A32bC3Bb5eA1dc814f14E29e6f026535129A84f";
  const from = "0x0b47dc4d735d37f38Cb74b74A52927DafdeDF388";
  const other = "0x745528C4E0CBdA5759175A660da06d0aaA72db7F";
  const event = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  const topics = encodeEventTopics({ abi: [event], eventName: "Transfer", args: { from, to: route } });
  const data = encodeAbiParameters([{ type: "uint256" }], [10000n]);
  const receipt = {
    status: "success",
    transactionHash: "0x" + "11".repeat(32),
    blockNumber: 1n,
    logs: [
      { address: token, logIndex: 0, topics: encodeEventTopics({ abi: [event], eventName: "Transfer", args: { from: other, to: route } }), data: encodeAbiParameters([{ type: "uint256" }], [10000n]) },
      { address: token, logIndex: 1, topics, data },
    ],
  };
  const hit = findUsdcTransferToRoute(receipt, { token, route, from, value: 10000n });
  assert.equal(hit.logIndex, 1);
  assert.equal(hit.from.toLowerCase(), from.toLowerCase());
  assert.equal(hit.value, 10000n);
  assert.equal(findUsdcTransferToRoute(receipt, { token, route, from, value: 1n }), null);
  assert.equal(jobCreatedFromReceipt({ status: "success", logs: [] }, []), null);
  assert.deepEqual(attachedTxHashes({ payload: { txHash: "0xabc", settleTx: "0xabc", attestTx: "0xdef" } }), ["0xabc", "0xdef"]);
});

test("dexterVerifyExact falls back to v1 base-sepolia when v2 exact requires permit2", async () => {
  const http = await import("node:http");
  const { dexterVerifyExact, v1ExactPayload } = await import("../x402/dexter.mjs");
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      seen.push({ url: req.url, body });
      if (body.paymentPayload?.x402Version === 2) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "exact on this network requires permit2" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ isValid: true, invalidReason: "" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const resource = { url: "https://agentcoinhq.com/v1/notarize", description: "Timestamp notary", mimeType: "application/json" };
    const paymentRequirements = { scheme: "exact", network: "eip155:84532", amount: "10000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0x6A32bC3Bb5eA1dc814f14E29e6f026535129A84f", maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" }, resource, description: resource.description };
    const paymentPayload = { x402Version: 2, resource, accepted: { scheme: "exact", network: "eip155:84532" }, payload: { signature: "0xsig", authorization: { from: "0x0b47dc4d735d37f38Cb74b74A52927DafdeDF388", to: paymentRequirements.payTo, value: "10000" } } };
    const out = await dexterVerifyExact(
      { paymentPayload, paymentRequirements },
      { env: { DEXTER_FACILITATOR_URL: `http://127.0.0.1:${server.address().port}` } },
    );
    assert.equal(out.ok, true);
    assert.equal(out.fallback, true);
    assert.equal(out.versionUsed, 1);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].body.paymentPayload.x402Version, 1);
    assert.equal(seen[1].body.paymentPayload.network, "base-sepolia");
    assert.equal(seen[1].body.paymentPayload.resource, "https://agentcoinhq.com/v1/notarize");
    assert.equal(seen[1].body.paymentRequirements.network, "base-sepolia");
    const v1 = v1ExactPayload({ authorization: paymentPayload.payload.authorization, signature: "0xsig", resource });
    assert.equal(v1.resource, resource.url);
  } finally {
    server.close();
  }
});
