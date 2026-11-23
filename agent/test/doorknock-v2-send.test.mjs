import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const TMP = mkdtempSync(path.join(os.tmpdir(), "dk2-"));
process.env.DOORKNOCK_OPTOUT_FILE = path.join(TMP, "dnc.json");
process.env.DOORKNOCK_SERVICE_OPTOUT_FILE = path.join(TMP, "svc.json");
writeFileSync(process.env.DOORKNOCK_OPTOUT_FILE, JSON.stringify({ entries: [] }));
process.env.DOORKNOCK_KILL_FILE = path.join(TMP, "no-kill-file"); // the real KILL file stays in place
const { buildOfferV2, framingText, renderA2A, renderMCP, renderX402, v2ContentKey, makeRef } = await import("../doorknock/v2/messages.mjs");
const { jobSpec } = await import("../doorknock/v2/plan.mjs");
const S = await import("../doorknock/v2/send.mjs");
const { planJobs } = await import("../doorknock/v2/jobs.mjs");

const BASE = "https://agentcoin.example";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // public Anvil dev key (test only)
const SEED = "ab".repeat(32);
const LIVE = { DRY_RUN: "0", DOORKNOCK_LIVE_ACK: "send-to-outside-agents", DOORKNOCK_KILL: "0" };

// approved row exactly as plan.mjs renders it
function row(channel, framing, i = 0) {
  const id = `t${channel}${framing}${i}`;
  const ref = makeRef(channel, framing, SEED, id);
  const c = { id, skills: [{ id: "quote", name: "Quote", examples: ["price of x"] }] };
  const job = framing === "c" ? jobSpec(c, ref) : null;
  const iface = { url: `https://${id}.example/a2a`, binding: "JSONRPC", version: channel === "a1" ? "1.0" : "0.3" };
  const endpoint = channel === "mc" ? `https://${id}.example/mcp` : channel === "xt" ? `https://${id}.example/paid` : iface.url;
  const offer = buildOfferV2({ id, endpoint }, { base: BASE, ref, framing, channel, job, nonce: "<per-send uuid>" });
  offer.signature = "<EIP-191 signature by the AgentCoin operator key, added at send time>";
  const text = framingText(framing, { links: offer.links, job });
  const request = channel === "mc" ? renderMCP(endpoint, offer) : channel === "xt" ? renderX402({ url: endpoint }, offer, text, { maxAtomic: 10000 }) : renderA2A(iface, offer, text, { messageId: "<per-send uuid>", skillId: null });
  return { row: { ref, arm: `${channel}${framing}`, id, name: id, host: `${id}.example`, endpoint, a2a: iface, skillId: null, reachReason: "x402 resource accepting Base Sepolia, 2000 atomic test USDC", contentKey: v2ContentKey(offer, text), request }, job: job && { ref, ...job } };
}

test("v2 send guard: live rebuild matches the approved rendering; any content change aborts", async () => {
  for (const [ch, fr] of [["a3", "a"], ["a3", "c"], ["a1", "b"], ["a1", "d"], ["mc", "b"], ["xt", "d"]]) {
    const { row: r, job } = row(ch, fr);
    const { req } = await S.buildLive(r, { base: BASE, privateKey: KEY, job });
    assert.equal(S.reqDiff(req, r.request), null, `${ch}${fr}`);
  }
  const { row: r } = row("a3", "a");
  const bad = structuredClone(r); bad.request.body.params.message.parts[0].text += " extra claim";
  await assert.rejects(S.buildLive(bad, { base: BASE, privateKey: KEY }), /differs from the approved/);
  await assert.rejects(S.buildLive({ ...r, contentKey: "00" }, { base: BASE, privateKey: KEY }), /content key/);
  await assert.rejects(S.buildLive(r, { base: "https://other.example", privateKey: KEY }), /differs|content key/);
});

test("v2 send: dry run sends nothing; live = 1 POST per agent, no retry on HTTP status, 1 retry on network error, daily limit counts prior logs", async () => {
  const rows = [row("a3", "a", 1), row("a1", "b", 2), row("a3", "d", 3)].map((x) => x.row);
  const boom = () => { throw new Error("network must not be used"); };
  const dry = await S.runV2({ targets: rows, logFile: path.join(TMP, "dry.jsonl"), privateKey: KEY, base: BASE, env: {}, fetchImpl: boom, seedHex: SEED, optouts: [] });
  assert.equal(dry.sent.length, 0); assert.equal(dry.guarded, 3);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); if (url.includes("t3a1")) return { status: 500, headers: new Map(), text: async () => "err" };
    if (url.includes("t1b2") && calls.filter((c) => c.url === url).length === 1) throw Object.assign(new Error("reset"), { cause: { code: "ECONNRESET" } });
    return { status: 200, headers: new Map([["content-type", "application/json"]]), text: async () => JSON.stringify({ jsonrpc: "2.0", result: { kind: "message", parts: [{ kind: "text", text: "hello, tell me more" }] } }) }; };
  const prior = path.join(TMP, "prior.jsonl");
  writeFileSync(prior, Array.from({ length: 48 }, () => JSON.stringify({ at: new Date().toISOString(), sent: true })).join("\n") + "\n");
  const log = path.join(TMP, "live.jsonl");
  const live = await S.runV2({ targets: rows, logFile: log, priorLogs: [prior], privateKey: KEY, base: BASE, env: LIVE, fetchImpl, seedHex: SEED, optouts: [] });
  assert.equal(live.sent.length, 2); assert.equal(live.skipped.length, 1); assert.match(live.skipped[0].reason, /daily limit 50/);
  for (const c of calls) assert.equal(c.init.redirect, "manual");
  const byUrl = (s) => calls.filter((c) => c.url.includes(s)).length;
  for (const e of live.sent) { if (e.host.startsWith("t3a1")) { assert.equal(e.status, 500); assert.equal(byUrl("t3a1"), 1); } if (e.host.startsWith("t1b2")) assert.equal(e.attempts, 2); }
  // never twice: a second live run sends nothing to already-knocked refs
  const again = await S.runV2({ targets: rows, logFile: log, privateKey: KEY, base: BASE, env: LIVE, fetchImpl: boom, seedHex: SEED, optouts: [] });
  assert.equal(again.sent.length, 1); // only the one cut by the daily limit (prior log not passed here)
  assert.ok(existsSync(path.join(TMP, "followups.pending.jsonl")));
  const opt = await S.runV2({ targets: [row("a3", "b", 9).row], logFile: path.join(TMP, "o.jsonl"), privateKey: KEY, base: BASE, env: LIVE, fetchImpl: boom, seedHex: SEED, optouts: [{ match: "ta3b9.example" }] });
  assert.equal(opt.sent.length, 0); assert.match(opt.skipped[0].reason, /opted out/);
});

test("v2 x402: pay only exact + eip155:84532 + Circle Sepolia USDC within cap; never mainnet", async () => {
  const USDC = S.USDC_SEPOLIA, PAY = "0x1111111111111111111111111111111111111111";
  const h = (o) => ({ status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(o)).toString("base64") }, text: "" });
  const main = { scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000", payTo: PAY };
  const sep = { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "2000", payTo: PAY, extra: { name: "USDC", version: "2" }, maxTimeoutSeconds: 60 };
  const p = S.pickX402(h({ x402Version: 2, accepts: [main, sep] }), { capAtomic: 2000n });
  assert.equal(p.accept.network, "eip155:84532"); assert.equal(p.amount, 2000n);
  assert.ok(S.pickX402(h({ x402Version: 2, accepts: [main] }), { capAtomic: 10000n }).abort);
  assert.ok(S.pickX402(h({ x402Version: 2, accepts: [{ ...sep, amount: "2001" }] }), { capAtomic: 2000n }).abort);
  assert.ok(S.pickX402(h({ x402Version: 2, accepts: [{ ...sep, asset: "0x0000000000000000000000000000000000000001" }] }), { capAtomic: 9000n }).abort);
  assert.ok(S.pickX402(h({ x402Version: 2, accepts: [{ ...sep, network: "base-sepolia" }] }), { capAtomic: 9000n }).abort);
  assert.ok(S.pickX402(h({ x402Version: 2, accepts: [{ ...sep, extra: { name: "Fake", version: "2" } }] }), { capAtomic: 9000n }).abort);
  const s = await S.signX402(p, KEY);
  const dec = JSON.parse(Buffer.from(s.header, "base64").toString());
  assert.equal(dec.accepted.network, "eip155:84532"); assert.equal(dec.payload.authorization.value, "2000"); assert.equal(dec.payload.authorization.to, PAY);
});

test("v2 acceptance + job caps: only an explicit accept-job for our jobRef with a valid address; caps enforced", () => {
  const A = "0x2222222222222222222222222222222222222222";
  assert.equal(S.findAcceptance(JSON.stringify({ result: { parts: [{ kind: "data", data: { agentcoin: "accept-job", jobRef: "job-x", provider: A } }] } }), "job-x"), A);
  assert.equal(S.findAcceptance(JSON.stringify({ result: { parts: [{ kind: "text", text: `ok {"agentcoin":"accept-job","jobRef":"job-x","provider":"${A}"}` }] } }), "job-x"), A);
  assert.equal(S.findAcceptance(JSON.stringify({ result: { parts: [{ kind: "text", text: '{"agentcoin":"accept-job","jobRef":"job-x","provider":"<your Base Sepolia address>"}' }] } }), "job-x"), null);
  assert.equal(S.findAcceptance(JSON.stringify({ agentcoin: "accept-job", jobRef: "job-y", provider: A }), "job-x"), null);
  assert.equal(S.findAcceptance(JSON.stringify({ type: "agentcoin-offer/0.2", job: { accept: { reply: { agentcoin: "accept-job", jobRef: "job-x", provider: A } } } }), "job-x"), null);
  const approvedJobs = ["r1", "r2"].map((ref) => ({ ref, jobRef: `job-${ref}`, amountAtomic: "50000", evaluator: "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a", deadlineSeconds: 86400, specHash: "0x" + "00".repeat(32) }));
  const { plan, refused } = planJobs({ approvedJobs, opened: [], acceptances: [{ ref: "r1", jobRef: "job-r1", provider: A }, { ref: "r1", jobRef: "job-r1", provider: A }, { ref: "zz", jobRef: "job-zz", provider: A }, { ref: "r2", jobRef: "job-other", provider: A }] });
  assert.equal(plan.length, 1); assert.equal(refused.length, 3);
});

test("v2 send order interleaves arms (a daily-limit cut is a balanced sample)", () => {
  const rows = [];
  for (const arm of ["a3a", "a3b", "mcd"]) for (let i = 0; i < 4; i++) rows.push({ ref: `${arm}-${i}`, arm });
  const o = S.sendOrder(rows, SEED);
  assert.equal(o.length, 12);
  assert.deepEqual(new Set(o.slice(0, 3).map((r) => r.arm)).size, 3);
  assert.deepEqual(S.sendOrder(rows, SEED).map((r) => r.ref), o.map((r) => r.ref));
});

test("v2 x402 cap carries across runs: priorX402Spent sums signed authorizations only", async () => {
  const { priorX402Spent } = await import("../doorknock/v2/send.mjs");
  const log = [
    { kind: "knock", x402: { signed: true, accept: { amount: "10000" } } },
    { kind: "knock", x402: { paid: false, reason: "first GET returned 200, not 402" } },
    { kind: "knock", x402: { signed: true, accept: { amount: "3000" } } },
    { kind: "knock" },
  ];
  assert.equal(priorX402Spent(log), 13000n);
  assert.equal(priorX402Spent([]), 0n);
});
