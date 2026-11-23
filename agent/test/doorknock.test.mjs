import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "dk-"));
process.env.DOORKNOCK_OPTOUT_FILE = path.join(tmp, "dnc.json");
process.env.DOORKNOCK_SERVICE_OPTOUT_FILE = path.join(tmp, "svc-optouts.json");
process.env.DOORKNOCK_KILL_FILE = path.join(tmp, "KILL");
const { run, mode, classifyReply, optOutSignal, reviewFileFor } = await import("../doorknock/knock.mjs");
const { verifyOffer, buildOffer } = await import("../doorknock/offer.mjs");
const { score } = await import("../doorknock/crawl.mjs");

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1 (public test key)
const BASE = "https://agentcoin.example";
const LIVE = { DRY_RUN: "0", DOORKNOCK_LIVE_ACK: "send-to-outside-agents" };
const tgt = (i, extra = {}) => ({ id: `t${i}`, host: `h${i}.example`, channel: { kind: "a2a", url: `https://h${i}.example/a2a`, transport: "JSONRPC" }, ...extra });
const freshLog = () => path.join(mkdtempSync(path.join(tmp, "log-")), "log.jsonl");
const noSend = async () => {
  throw new Error("send must not be called");
};

test("default mode is dry run; nothing sent even with many targets", async () => {
  assert.equal(mode({}).dryRun, true);
  assert.equal(mode({ DRY_RUN: "0" }).live, false, "DRY_RUN=0 alone is not enough");
  const r = await run({ targets: [tgt(1), tgt(2)], logFile: freshLog(), privateKey: KEY, base: BASE, env: {}, send: noSend });
  assert.equal(r.sent.length, 0);
  assert.equal(r.planned.length, 2);
});

test("kill switch file overrides DRY_RUN=0 + ack", async () => {
  writeFileSync(process.env.DOORKNOCK_KILL_FILE, "x");
  try {
    assert.equal(mode(LIVE).live, false);
    const r = await run({ targets: [tgt(1)], logFile: freshLog(), privateKey: KEY, base: BASE, env: LIVE, send: noSend });
    assert.equal(r.sent.length, 0);
  } finally {
    (await import("node:fs")).unlinkSync(process.env.DOORKNOCK_KILL_FILE);
  }
  assert.equal(mode({ ...LIVE, DOORKNOCK_KILL: "1" }).live, false);
});

test("live mode: one knock per agent endpoint, 50/day cap, signed offer", async () => {
  const sent = [];
  const send = async (req) => (sent.push(req), { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { kind: "task", status: { state: "completed" } } }) });
  const log = freshLog();
  const targets = [...Array.from({ length: 60 }, (_, i) => tgt(i)), { ...tgt(3), id: "dup" }];
  const r1 = await run({ targets, logFile: log, privateKey: KEY, base: BASE, env: LIVE, send });
  assert.equal(r1.sent.length, 50);
  assert.ok(r1.skipped.some((s) => s.reason === "duplicate endpoint"));
  assert.ok(r1.skipped.some((s) => /daily limit/.test(s.reason)));
  const offer = sent[0].body.params.message.parts[1].data;
  assert.equal(offer.testnet, true);
  assert.equal(offer.realValue, false);
  assert.equal((await verifyOffer(offer)).valid, true);
  const r2 = await run({ targets, logFile: log, privateKey: KEY, base: BASE, env: LIVE, send });
  assert.equal(r2.sent.length, 0, "already knocked + daily cap");
});

test("follow-up only when engaged, at most once; opt-out honored and recorded", async () => {
  const log = freshLog();
  const replies = { "https://h1.example/a2a": { status: 200, text: JSON.stringify({ result: { kind: "message", parts: [{ kind: "text", text: "tell me more" }] } }) }, "https://h2.example/a2a": { status: 200, text: JSON.stringify({ result: { kind: "message", parts: [{ kind: "data", data: { agentcoin: "opt-out" } }] } }) } };
  const send = async (req) => replies[req.url] ?? { status: 404, text: "" };
  await run({ targets: [tgt(1), tgt(2), tgt(3)], logFile: log, privateKey: KEY, base: BASE, env: LIVE, send });
  const f1 = await run({ targets: [tgt(1), tgt(2), tgt(3)], logFile: log, privateKey: KEY, base: BASE, env: LIVE, send, kind: "follow-up" });
  assert.deepEqual(f1.sent.map((e) => e.endpoint), ["https://h1.example/a2a"]);
  const f2 = await run({ targets: [tgt(1)], logFile: log, privateKey: KEY, base: BASE, env: LIVE, send, kind: "follow-up" });
  assert.equal(f2.sent.length, 0);
  assert.ok(JSON.parse(readFileSync(process.env.DOORKNOCK_OPTOUT_FILE, "utf8")).entries.some((e) => e.match === "https://h2.example/a2a"));
  const again = await run({ targets: [{ ...tgt(2), id: "new-id-same-endpoint" }], logFile: freshLog(), privateKey: KEY, base: BASE, env: LIVE, send: noSend });
  assert.equal(again.skipped[0].reason, "opted out / do-not-contact");
});

test("service-recorded opt-outs are honored; live refuses placeholder base", async () => {
  writeFileSync(process.env.DOORKNOCK_SERVICE_OPTOUT_FILE, JSON.stringify({ entries: [{ match: "h9.example" }] }));
  const r = await run({ targets: [tgt(9)], logFile: freshLog(), privateKey: KEY, base: BASE, env: LIVE, send: noSend });
  assert.equal(r.skipped[0].reason, "opted out / do-not-contact");
  await assert.rejects(run({ targets: [tgt(1)], logFile: freshLog(), privateKey: KEY, base: "https://REPLACE-WITH-PUBLIC-HOST", env: LIVE, send: noSend }));
  assert.throws(() => buildOffer(tgt(1), { base: "http://127.0.0.1:8402" }));
});

test("reply classification and factual scoring", () => {
  assert.equal(classifyReply(500, "x"), "no-engagement");
  assert.equal(classifyReply(200, '{"error":{"code":-32601}}'), "no-engagement");
  assert.equal(classifyReply(200, '{"result":{"agentcoin":"opt-out"}}'), "opt-out");
  const s = score({ source: "erc8004-base-sepolia", agentId: "7", name: "x", description: "x402 escrow agent", channel: { url: "https://a/a2a" }, card: { cardUrl: "https://a/.well-known/agent-card.json" } });
  assert.ok(s.score > 60);
  assert.match(s.reason, /ERC-8004 agent #7/);
});

test("defaultSend: no redirects, 1 retry only on network error, none on 4xx/5xx", async () => {
  const { defaultSend } = await import("../doorknock/knock.mjs");
  let calls = 0;
  const netErr = async () => { calls++; throw new TypeError("fetch failed"); };
  const r1 = await defaultSend({ url: "https://h.example/a2a", body: {} }, { fetchImpl: netErr });
  assert.equal(calls, 2); assert.equal(r1.status, 0); assert.equal(r1.attempts, 2); assert.match(r1.error, /fetch failed/);
  for (const status of [404, 500]) {
    calls = 0; let opts;
    const httpErr = async (u, o) => { calls++; opts = o; return { status, headers: new Map(), text: async () => "nope" }; };
    const r = await defaultSend({ url: "https://h.example/a2a", body: {} }, { fetchImpl: httpErr });
    assert.equal(calls, 1, `no retry on ${status}`); assert.equal(r.status, status); assert.equal(opts.redirect, "manual");
  }
});

test("offerBodyDiff: only per-target fields may differ; JSON-RPC and HTTP+JSON bindings both checked", async () => {
  const { offerBodyDiff, a2aRequest, signOffer } = await import("../doorknock/offer.mjs");
  const mk = async (t) => a2aRequest(t.channel, await signOffer(buildOffer(t, { base: BASE }), KEY));
  const approved = (await mk(tgt(1))).body;
  assert.deepEqual(offerBodyDiff((await mk(tgt(2))).body, approved), []);
  const rest = await mk(tgt(3, { channel: { kind: "a2a", url: "https://h3.example", transport: "HTTP+JSON" } }));
  assert.equal(rest.url, "https://h3.example/v1/message:send");
  assert.deepEqual(offerBodyDiff(rest.body, approved), []);
  const tampered = structuredClone((await mk(tgt(4))).body);
  tampered.params.message.parts[0].text += " extra";
  assert.notDeepEqual(offerBodyDiff(tampered, approved), []);
  const tampered2 = structuredClone((await mk(tgt(5))).body);
  tampered2.params.message.parts[1].data.links.quickstart = "https://evil.example";
  assert.notDeepEqual(offerBodyDiff(tampered2, approved), []);
  // live run logs request + response and the verify hook aborts before a send
  const log = freshLog(); const sent = [];
  await run({ targets: [tgt(6)], logFile: log, privateKey: KEY, base: BASE, env: LIVE, send: async (q) => { sent.push(q); return { status: 200, text: '{"result":{"kind":"message","parts":[{"kind":"text","text":"hi"}]}}', attempts: 1 }; }, verify: (q) => assert.deepEqual(offerBodyDiff(q.body, approved), []) });
  const e = JSON.parse(readFileSync(log, "utf8").trim());
  assert.equal(e.sent, true); assert.ok(e.request.body.params); assert.equal(e.response.status, 200); assert.equal(e.reply, "engaged");
  await assert.rejects(run({ targets: [tgt(7)], logFile: freshLog(), privateKey: KEY, base: BASE, env: LIVE, send: noSend, verify: () => { throw new Error("differs"); } }), /differs/);
});

test("classifyReply: an agent echoing our offer (which contains opt-out instructions) is not an opt-out", async () => {
  const { a2aRequest, signOffer } = await import("../doorknock/offer.mjs");
  const req = a2aRequest(tgt(1).channel, await signOffer(buildOffer(tgt(1), { base: BASE }), KEY));
  const echo = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { kind: "message", parts: [{ kind: "text", text: "Thanks. You said: " + req.body.params.message.parts[0].text }, { kind: "data", data: req.body.params.message.parts[1].data }] } });
  assert.equal(classifyReply(200, echo), "engaged");
  const real = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { kind: "message", parts: [{ kind: "data", data: { agentcoin: "opt-out" } }] } });
  assert.equal(classifyReply(200, real), "opt-out");
  // wording that only sounds like an opt-out is NOT a block (Carter 2026-10-30): review only
  assert.equal(classifyReply(200, JSON.stringify({ result: { parts: [{ kind: "text", text: "please unsubscribe us" }] } })), "engaged");
  assert.equal(optOutSignal(200, JSON.stringify({ result: { parts: [{ kind: "text", text: "please unsubscribe us" }] } })), "ambiguous");
  assert.equal(optOutSignal(200, echo), null);
  assert.equal(optOutSignal(200, JSON.stringify({ result: { parts: [{ kind: "text", text: ' {"agentcoin":"opt-out"} ' }] } })), "explicit");
  assert.equal(optOutSignal(404, '{"agentcoin":"opt-out"}'), "ambiguous", "an error response never blocks");
  assert.equal(optOutSignal(0, ""), null);
});

test("no automatic blocking: errors and ambiguous wording go to optout-review.jsonl, only explicit opt-outs block", async () => {
  const log = freshLog();
  const before = existsSync(process.env.DOORKNOCK_OPTOUT_FILE) ? readFileSync(process.env.DOORKNOCK_OPTOUT_FILE, "utf8") : "";
  const replies = {
    "https://h31.example/a2a": { status: 200, text: JSON.stringify({ result: { parts: [{ kind: "text", text: "stop contacting bots like this, unsubscribe" }] } }) },
    "https://h32.example/a2a": { status: 403, text: "forbidden" },
    "https://h33.example/a2a": { status: 0, text: "", error: "ECONNRESET" },
  };
  const send = async (req) => replies[req.url];
  const r = await run({ targets: [tgt(31), tgt(32), tgt(33)], logFile: log, privateKey: KEY, base: BASE, env: LIVE, send });
  assert.equal(r.sent.length, 3);
  const after = existsSync(process.env.DOORKNOCK_OPTOUT_FILE) ? readFileSync(process.env.DOORKNOCK_OPTOUT_FILE, "utf8") : "";
  assert.equal(after, before, "do-not-contact unchanged");
  const review = readFileSync(reviewFileFor(log), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(review.map((e) => [e.endpoint, e.signal, e.blocked]), [["https://h31.example/a2a", "ambiguous", false]]);
});

test("resend: A2A v1.0 formats, content guard, once only, only to knocked endpoints, skips logged", async () => {
  const { a2aRequest, signOffer, offerContentDiff, offerBodyDiff } = await import("../doorknock/offer.mjs");
  const offer = await signOffer(buildOffer(tgt(41), { base: BASE }), KEY);
  const v03 = a2aRequest(tgt(41).channel, offer);
  const rpc = a2aRequest({ url: "https://h41.example/a2a", transport: "JSONRPC", protocolVersion: "1.0" }, offer);
  assert.equal(rpc.body.method, "SendMessage");
  assert.equal(rpc.body.params.message.role, "ROLE_USER");
  assert.equal(rpc.headers["A2A-Version"], "1.0");
  assert.ok(rpc.body.params.message.parts.every((p) => !("kind" in p)));
  const rest = a2aRequest({ url: "https://h41.example/a2a/", transport: "HTTP+JSON", protocolVersion: "1.0" }, offer);
  assert.equal(rest.url, "https://h41.example/a2a/message:send");
  assert.equal(rest.headers["content-type"], "application/a2a+json");
  assert.deepEqual(offerContentDiff(rpc.body, v03.body), []);
  assert.deepEqual(offerContentDiff(rest.body, v03.body), []);
  assert.notDeepEqual(offerBodyDiff(rpc.body, v03.body), [], "the strict v0.3 diff would reject the v1 shape");
  const tampered = structuredClone(rpc.body); tampered.params.message.parts[0].text += " extra";
  assert.deepEqual(offerContentDiff(tampered, v03.body), ["part 0"]);
  const bad = structuredClone(rpc.body); bad.method = "tools/call";
  assert.deepEqual(offerContentDiff(bad, v03.body), ["JSON-RPC envelope"]);

  const log = freshLog();
  const sendOk = async () => ({ status: 200, text: '{"result":{"parts":[{"text":"hi"}]}}' });
  await run({ targets: [tgt(41), tgt(42)], logFile: log, privateKey: KEY, base: BASE, env: LIVE, send: sendOk });
  const seen = [];
  const send = async (req) => { seen.push(req); return { status: 200, text: "{}" }; };
  const rs = (n, decision, extra = {}) => ({ ...tgt(n), resend: { decision, reason: "why", channel: { protocolVersion: "1.0", transport: "JSONRPC" }, ...extra } });
  const r = await run({ targets: [rs(41, "send"), rs(42, "skip"), rs(43, "send")], logFile: log, privateKey: KEY, base: BASE, env: LIVE, send, kind: "resend" });
  assert.deepEqual(r.sent.map((e) => e.endpoint), ["https://h41.example/a2a"]);
  assert.equal(seen[0].body.method, "SendMessage");
  assert.deepEqual(r.skipped.map((s) => s.reason), ["format: why", "resend only to an already-knocked endpoint"]);
  const again = await run({ targets: [rs(41, "send")], logFile: log, privateKey: KEY, base: BASE, env: LIVE, send, kind: "resend" });
  assert.equal(again.skipped[0].reason, "already resent once");
  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "resend");
  assert.ok(lines.every((e) => e.resend === true));
  assert.equal(lines.filter((e) => e.sent).length, 1);
});
