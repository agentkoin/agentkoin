import { test } from "node:test";
import assert from "node:assert/strict";
const { a2aReach, mcpReach, x402TestnetReach, operatorOf, freeContactSkill } = await import("../doorknock/v2/reach.mjs");
const { makeRef, buildOfferV2, framingText, renderA2A, renderMCP, renderX402, refLinks, v2ContentKey } = await import("../doorknock/v2/messages.mjs");
const { assign, pickJobSkill, jobSpec, rng, shuffle } = await import("../doorknock/v2/plan.mjs");
const { buildTable } = await import("../doorknock/v2/stats-table.mjs");
const { parseRef } = await import("../service/stats.mjs");
const { optOutSignal, replyOwnText } = await import("../doorknock/knock.mjs");

const BASE = "https://agentcoin.example";

test("v2 reach: clear vs root/extension/auth/paid-door/doc/api-route", () => {
  const v1 = { name: "x", supportedInterfaces: [{ url: "https://a.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }] };
  const r = a2aReach(v1);
  assert.equal(r.status, "clear"); assert.deepEqual(r.iface, { url: "https://a.example/a2a", binding: "JSONRPC", version: "1.0" });
  assert.equal(a2aReach({ name: "x", url: "https://a.example/", protocolVersion: "0.3.0" }).status, "uncertain");
  assert.equal(a2aReach({ ...v1, capabilities: { extensions: [{ uri: "https://github.com/google-a2a/a2a-x402/v0.1", required: true }] } }).status, "excluded");
  assert.equal(a2aReach({ ...v1, security: [{ bearer: [] }] }).status, "excluded");
  assert.equal(a2aReach({ ...v1, description: "This is not an A2A message endpoint." }).status, "excluded");
  assert.equal(a2aReach({ name: "x", url: "https://a.example/openapi.json", protocolVersion: "1.0", preferredTransport: "HTTP+JSON" }).status, "excluded");
  assert.equal(a2aReach({ name: "x", url: "https://a.example/v1/check", protocolVersion: "1.0", preferredTransport: "HTTP+JSON" }).status, "uncertain");
  assert.equal(a2aReach({ name: "x", supportedInterfaces: "bogus", skills: "bogus", url: "https://a.example/a2a" }).status, "clear"); // malformed fields tolerated
  assert.equal(a2aReach(null).status, "excluded");
});

test("v2 reach: MCP remote, x402 testnet only, operators, free contact skill", () => {
  assert.equal(mcpReach({ remote: "https://m.example/mcp", remoteType: "streamable-http", remoteHeaders: [] }).status, "clear");
  assert.equal(mcpReach({ remote: "https://m.example/mcp", remoteType: "streamable-http", remoteHeaders: [{ name: "Authorization", isRequired: true }] }).status, "excluded");
  assert.equal(mcpReach({ remote: "https://m.example/sse", remoteType: "sse" }).status, "excluded");
  assert.equal(x402TestnetReach({ networks: ["eip155:8453"], priceAtomic: "1000" }).status, "excluded");
  assert.equal(x402TestnetReach({ networks: ["eip155:84532"], priceAtomic: "1000", method: "GET" }).status, "clear");
  assert.equal(x402TestnetReach({ networks: ["eip155:84532"], priceAtomic: "999999" }).status, "excluded");
  assert.equal(x402TestnetReach({ networks: ["eip155:84532"], priceAtomic: "1000", method: "POST" }).status, "excluded");
  assert.equal(operatorOf("www.api.foo.com"), "foo.com");
  assert.equal(operatorOf("a.orbit-builder.workers.dev"), "orbit-builder.workers.dev");
  assert.equal(operatorOf("scdo.com.au"), "scdo.com.au");
  assert.equal(freeContactSkill({ skills: [{ id: "quote", description: "paid $0.01" }, { id: "hello", description: "say hi" }] }), "hello");
  assert.equal(freeContactSkill({ skills: [{ id: "contact", description: "x402 paid 0.01 USDC" }] }), null);
});

test("v2 messages: refs on every link, framings, renderers, no false claims", () => {
  const ref = makeRef("a1", "b", "seed", "t1");
  assert.match(ref, /^a1b-[0-9a-f]{8}$/); assert.equal(parseRef(ref), ref); assert.equal(makeRef("a1", "b", "seed", "t1"), ref);
  assert.throws(() => makeRef("zz", "a", "s", "t"));
  const links = refLinks(BASE, ref);
  for (const u of Object.values(links)) assert.ok(u.endsWith(`?ref=${ref}`), u);
  const offer = buildOfferV2({ id: "t1", endpoint: "https://a.example/a2a" }, { base: BASE, ref, framing: "b", channel: "a1", nonce: "n" });
  assert.equal(offer.type, "agentcoin-offer/0.2"); assert.equal(offer.testnet, true); assert.equal(offer.facts.protocolFeeBps, 0); assert.equal(offer.facts.evaluatorFeeBps, 0);
  const tb = framingText("b", { links });
  assert.match(tb, /^AgentCoin testnet offer \(no real value\)/); assert.match(tb, /x402 paid calls are gasless for the payer/);
  assert.doesNotMatch(tb, /\b(guarantee[ds]?|risk-free|free money|always)\b/i);
  assert.ok(tb.includes(`?ref=${ref}`)); assert.ok(tb.includes('{"agentcoin":"opt-out"}'));
  assert.equal(framingText("d", { links }), null);
  assert.throws(() => framingText("c", { links }));
  // v1.0 JSON-RPC + HTTP+JSON, v0.3 JSON-RPC + HTTP+JSON
  const j1 = renderA2A({ url: "https://a.example/a2a", binding: "JSONRPC", version: "1.0" }, offer, tb, { messageId: "m" });
  assert.equal(j1.body.method, "SendMessage"); assert.equal(j1.body.params.message.role, "ROLE_USER"); assert.equal(j1.headers["A2A-Version"], "1.0"); assert.equal(j1.body.params.message.parts[0].kind, undefined);
  const h1 = renderA2A({ url: "https://a.example/a2a/", binding: "HTTP+JSON", version: "1.0" }, offer, tb);
  assert.equal(h1.url, "https://a.example/a2a/message:send"); assert.equal(h1.headers["content-type"], "application/a2a+json");
  const j3 = renderA2A({ url: "https://a.example/a2a", binding: "JSONRPC", version: "0.3" }, offer, tb, { skillId: "hello" });
  assert.equal(j3.body.method, "message/send"); assert.equal(j3.body.params.message.parts[0].kind, "text"); assert.equal(j3.body.params.message.metadata.skillId, "hello");
  assert.equal(renderA2A({ url: "https://a.example/api", binding: "HTTP+JSON", version: "0.3" }, offer, tb).url, "https://a.example/api/v1/message:send");
  // d: data part only
  const od = buildOfferV2({ id: "t1" }, { base: BASE, ref: makeRef("a3", "d", "s", "t1"), framing: "d", channel: "a3" });
  const jd = renderA2A({ url: "https://a.example/a2a", binding: "JSONRPC", version: "0.3" }, od, null);
  assert.equal(jd.body.params.message.parts.length, 1); assert.equal(jd.body.params.message.parts[0].kind, "data");
  assert.ok(od.actions.every((a) => !a.url || a.url.includes("?ref=")));
  // MCP: initialize + initialized only
  const m = renderMCP("https://m.example/mcp", offer);
  assert.deepEqual(m.map((x) => x.body.method), ["initialize", "notifications/initialized"]);
  assert.ok(m[0].body.params.clientInfo.websiteUrl.includes(`?ref=${ref}`));
  assert.ok(!JSON.stringify(m).includes("tools/"));
  // x402: guard pins Base Sepolia test USDC and a cap
  const x = renderX402({ url: "https://x.example/r" }, offer, tb, { maxAtomic: 10000 });
  assert.equal(x[1].guard.network, "eip155:84532"); assert.equal(x[1].guard.asset, "0x036CbD53842c5426634e7929541eC2318f3dCF7e"); assert.equal(x[1].guard.maxAmountAtomic, "10000");
  // content key: identical across targets/refs for the same arm, different across framings
  const ref2 = makeRef("a1", "b", "seed", "t2");
  const o2 = buildOfferV2({ id: "t2" }, { base: BASE, ref: ref2, framing: "b", channel: "a1", nonce: "z" });
  assert.equal(v2ContentKey(offer, tb), v2ContentKey(o2, framingText("b", { links: refLinks(BASE, ref2) })));
  assert.notEqual(v2ContentKey(offer, tb), v2ContentKey(od, null));
});

test("v2 plan: (c) jobs from side-effect-free skills, <=0.10, seeded deterministic balanced assignment, original ops excluded", () => {
  assert.equal(pickJobSkill([{ id: "transfer-usdc" }, { id: "swap", name: "Swap" }]), null);
  assert.equal(pickJobSkill([{ id: "send" }, { id: "price", description: "token price; pay per call via x402" }]).id, "price");
  assert.equal(pickJobSkill([{ id: "a" }, { id: "b", examples: ["what is X?"] }]).id, "b");
  const job = jobSpec({ skills: [{ id: "q", name: "Quote", examples: ["ETH price"] }] }, "a1c-00000000");
  assert.equal(job.amountUsdc, "0.05"); assert.ok(Number(job.amountUsdc) <= 0.10); assert.equal(job.amountAtomic, "50000"); assert.equal(job.openedOnlyAfterAccept, true); assert.match(job.specHash, /^0x[0-9a-f]{64}$/);
  assert.match(framingText("c", { links: refLinks(BASE, "a1c-00000000"), job }), /JobEscrow\.submit.*Base Sepolia ETH for gas/);
  const r = rng("deadbeef"); const s1 = shuffle([1, 2, 3, 4, 5], r); assert.deepEqual(shuffle([1, 2, 3, 4, 5], rng("deadbeef")), s1);
  const mk = (i, v, extra = {}) => ({ id: `c${i}`, host: `h${i}.op${i}.com`, fit: 100 - i, sellsPaid: true, skills: [{ id: "info", examples: ["x"] }],
    reach: { a2a: { status: "clear", iface: { url: `https://h${i}.op${i}.com/a2a`, binding: "JSONRPC", version: v } }, mcp: { status: i % 3 ? "excluded" : "clear", remote: `https://h${i}.op${i}.com/mcp` }, x402Testnet: { status: "excluded" } }, ...extra });
  const cands = Array.from({ length: 70 }, (_, i) => mk(i, i % 2 ? "1.0" : "0.3"));
  cands.push({ ...mk(99, "0.3"), host: "dup.op1.com" }); // same operator as c1 -> dropped
  const a = assign(cands, "8a617b74", { excludeOps: new Set(["op0.com"]) });
  assert.equal(a.length, 50);
  assert.ok(!a.some((p) => p.c.id === "c0"), "original-25 operator excluded");
  assert.equal(new Set(a.map((p) => operatorOf(p.c.host))).size, 50, "one per operator");
  assert.deepEqual(assign(cands, "8a617b74", { excludeOps: new Set(["op0.com"]) }).map((p) => p.c.id + p.channel + p.framing), a.map((p) => p.c.id + p.channel + p.framing));
  assert.ok(a.filter((p) => p.channel === "mc").length <= 12);
  assert.ok(!a.some((p) => p.channel === "mc" && p.framing === "c"));
  const fr = a.reduce((m, p) => ((m[p.framing] = (m[p.framing] ?? 0) + 1), m), {});
  for (const f of ["a", "b", "c", "d"]) assert.ok(fr[f] >= 5, `framing ${f} has ${fr[f]}`);
  // fewer reachable than 50 -> no padding
  assert.equal(assign(cands.slice(0, 10), "8a617b74").length, 10);
});

test("v2 stats table joins send log and per-ref server counters", () => {
  const targets = [{ ref: "a1a-00000001", arm: "a1a" }, { ref: "mcd-00000002", arm: "mcd" }];
  const log = [{ ref: "a1a-00000001", sent: true, status: 200, engaged: true }, { ref: "mcd-00000002", sent: true, status: 500 }, { ref: "mcd-00000002", sent: false }];
  const doorknock = { byRef: { "a1a-00000001": { quickstart: 2, paidCalls: 1, jobsOpened: 1 }, "mcd-00000002": { mcpSessions: 1 } } };
  const t = buildTable({ targets, log, doorknock });
  assert.deepEqual(t.rows.a1a, { targets: 1, sends: 1, delivered: 1, replies: 1, quickstart: 2, mcpSessions: 0, paidCalls: 1, jobsOpened: 1, optouts: 0 });
  assert.equal(t.rows.mcd.sends, 1); assert.equal(t.rows.mcd.delivered, 0); assert.equal(t.rows.mcd.mcpSessions, 1);
  assert.equal(t.total.sends, 2);
});

test("v2 offers echoed back are not opt-outs and are stripped", () => {
  const echo = JSON.stringify({ result: { parts: [{ text: 'AgentCoin testnet job offer (test USDC, no real value): ... Reply {"agentcoin":"opt-out"} to never be contacted again.' }, { data: { type: "agentcoin-offer/0.2", optOut: { reply: { agentcoin: "opt-out" } } } }] } });
  assert.equal(optOutSignal(200, echo), null);
  assert.equal(replyOwnText(echo), "");
});

test("v2 stats table: paid x402 200 counts as delivered; status.message / artifact replies count as replies", async () => {
  const { buildTable: bt, isReply, isDelivered } = await import("../doorknock/v2/stats-table.mjs");
  const sm = JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "task", status: { state: "completed", message: { kind: "message", role: "agent", parts: [{ kind: "text", text: "hi" }] } } } });
  const art = JSON.stringify({ jsonrpc: "2.0", id: "1", result: { kind: "task", status: { state: "completed" }, artifacts: [{ parts: [{ kind: "text", text: "x" }] }] } });
  const err = JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32602, message: "bad" } });
  const log = [
    { sent: true, ref: "xta-00000001", arm: "xta", status: 402, x402: { signed: true, paidStatus: 200 } },
    { sent: true, ref: "xtb-00000002", arm: "xtb", status: 402, x402: { signed: true, paidStatus: 402 } },
    { sent: true, ref: "a3a-00000003", arm: "a3a", status: 200, classification: "no-engagement", response: { text: sm } },
    { sent: true, ref: "a3a-00000004", arm: "a3a", status: 200, classification: "no-engagement", response: { text: sm.slice(0, sm.length - 5) } },
    { sent: true, ref: "a3b-00000005", arm: "a3b", status: 200, classification: "no-engagement", response: { text: art } },
    { sent: true, ref: "a3b-00000006", arm: "a3b", status: 200, classification: "no-engagement", response: { text: err } },
    { sent: true, ref: "mca-00000007", arm: "mca", status: 200, classification: "n/a", response: { text: sm } },
    { sent: false, ref: "a3a-00000008", arm: "a3a" },
  ];
  assert.equal(isDelivered(log[0]), true); assert.equal(isDelivered(log[1]), false);
  assert.deepEqual(log.map(isReply), [false, false, true, true, true, false, false, false]);
  const t = bt({ targets: [], log });
  assert.equal(t.total.sends, 7); assert.equal(t.total.delivered, 6); assert.equal(t.total.replies, 3);
  assert.equal(t.rows.xta.delivered, 1); assert.equal(t.rows.xtb.delivered, 0); assert.equal(t.rows.a3a.replies, 2);
});
