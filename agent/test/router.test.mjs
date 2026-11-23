// Offline tests for the seller-side router: parse, seed import, search/route, opt-out, claims, orders, receipts,
// signed scores (AgentCoin-originated orders excluded), submit, the six tools, and the HTTP/MCP/A2A wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeEventTopics, encodeAbiParameters, erc20Abi, decodeFunctionData, keccak256, toBytes, getAddress } from "viem";
import { Router, makeFetchDoc, NETWORK_ID } from "../router/router.mjs";
import { routerTools } from "../router/tools.mjs";
import { buildService, x402Skills, serviceFromDocument, mcpSkills, a2aSkills } from "../router/parse.mjs";
import { normalizeMatch, matchesService } from "../router/optout.mjs";
import { verifyEip191 } from "../lib/sign.mjs";
import { ABI } from "../lib/config.mjs";

const USDC_SEP = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ESCROW = "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D";
const sellerKey = generatePrivateKey();
const seller = privateKeyToAccount(sellerKey);
const operatorKey = generatePrivateKey();
const operator = privateKeyToAccount(operatorKey);
const buyer = privateKeyToAccount(generatePrivateKey()).address;
const internalBuyer = privateKeyToAccount(generatePrivateKey()).address;
const EVAL = privateKeyToAccount(generatePrivateKey()).address;
const PROVIDER = privateKeyToAccount(generatePrivateKey()).address;
const dir = () => mkdtempSync(path.join(tmpdir(), "acrouter-"));

function x402Item(host, p, { price = "10000", network = "eip155:84532", asset = USDC_SEP, payTo = seller.address, desc = "service" } = {}) {
  return { resource: `https://${host}${p}`, type: "http", accepts: [{ scheme: "exact", network, asset, amount: price, payTo }], description: desc, extensions: { bazaar: { info: { input: { type: "http", method: "POST", body: { text: "string" } } } } } };
}
function seedServices() {
  const s = [];
  s.push(buildService({ protocol: "x402", host: "translate.example", name: "Translate", skills: x402Skills([x402Item("translate.example", "/v1/translate", { desc: "translate text between languages" })]), source: { kind: "test" } }));
  s.push(buildService({ protocol: "x402", host: "weather.example", name: "Weather", skills: x402Skills([x402Item("weather.example", "/forecast", { desc: "weather forecast for a city", price: "500000", network: "eip155:8453", asset: USDC_BASE })]), source: { kind: "test" } }));
  s.push(buildService({ protocol: "a2a", host: "agent.example", name: "Summarizer agent", endpoints: { a2a: { url: "https://agent.example/a2a", binding: "JSONRPC", version: "0.3.0" } }, skills: a2aSkills({ skills: [{ id: "summarize", name: "Summarize", description: "summarize a web page or document" }] }), source: { kind: "test" } }));
  s.push(buildService({ protocol: "mcp", host: "mcp.example", name: "Search MCP", endpoints: { mcp: "https://mcp.example/mcp" }, skills: mcpSkills([{ name: "web_search", description: "search the web", inputSchema: { type: "object" } }]), source: { kind: "test" } }));
  s.push(buildService({ protocol: "erc8004", host: "reg.example", name: "Registered agent", erc8004AgentId: "77", skills: [], source: { kind: "test" } }));
  for (let i = 0; i < 30; i++) s.push(buildService({ protocol: "x402", host: `t${i}.translate-farm.example`, name: `Translator ${i}`, skills: x402Skills([x402Item(`t${i}.translate-farm.example`, "/tr", { desc: "translate text", payTo: privateKeyToAccount(generatePrivateKey()).address })]), source: { kind: "test" } }));
  return s;
}
function writeSeed(d, services) {
  const f = path.join(d, "seed.json.gz");
  writeFileSync(f, gzipSync(JSON.stringify({ v: "agentcoin-index-seed/0.1", builtAt: "2026-11-01T00:00:00Z", inputs: { test: true }, counts: {}, services })));
  return f;
}
function transferReceipt({ from, to, value, asset = USDC_SEP, status = "success" }) {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } });
  return { status, blockNumber: 123n, logs: [{ address: asset.toLowerCase(), topics, data: encodeAbiParameters([{ type: "uint256" }], [BigInt(value)]), blockNumber: 123n, logIndex: 0, transactionHash: "0x" + "11".repeat(32), transactionIndex: 0, blockHash: "0x" + "22".repeat(32), removed: false }] };
}
function mkRouter(over = {}) {
  const d = dir();
  const jobs = new Map();
  const receipts = new Map();
  const docs = new Map();
  const r = new Router({
    dbFile: path.join(d, "r.sqlite"), publicUrl: "https://ac.test", seedFile: writeSeed(d, seedServices()), optOutFiles: over.optOutFiles ?? [], signerKey: operatorKey,
    chain: { usdc: USDC_SEP, escrow: ESCROW, escrowAbi: ABI.escrow, evaluator: EVAL, readJob: async (id) => jobs.get(String(id)) ?? null, getReceipt: async (h) => receipts.get(h) ?? null, ownerOf: async (id) => (String(id) === "77" ? seller.address : "0x0000000000000000000000000000000000000001"), quoteFees: async (a) => ({ amount: a, feeBps: 100 }) },
    fetchDoc: async (url) => docs.get(url) ?? { status: 404 },
    agentcoinAddresses: [internalBuyer],
    ...over,
  });
  return { r, d, jobs, receipts, docs };
}

test("parse: x402 Bazaar item -> skill with price, Sepolia preferred, request template", () => {
  const sk = x402Skills([{ ...x402Item("a.example", "/x?y=1"), accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "5", payTo: seller.address }, { scheme: "exact", network: "eip155:84532", asset: USDC_SEP, amount: "7", payTo: seller.address }] }]);
  assert.equal(sk.length, 1);
  assert.equal(sk[0].id, "POST /x?y=1");
  assert.equal(sk[0].network, "eip155:84532");
  assert.equal(sk[0].price, "7");
  const s = serviceFromDocument({ name: "Card", skills: [{ id: "a", name: "A" }], supportedInterfaces: [{ url: "https://c.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }] }, "https://c.example/.well-known/agent-card.json");
  assert.equal(s.protocol, "a2a");
  assert.equal(s.skills[0].id, "a");
  const reg = serviceFromDocument({ type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "R", services: [{ name: "A2A", endpoint: "https://r.example/card" }], registrations: [{ agentId: 5, agentRegistry: "eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e" }] }, "https://r.example/.well-known/agent-registration.json");
  assert.equal(reg.protocol, "erc8004");
  assert.equal(reg.erc8004AgentId, "5");
  assert.throws(() => serviceFromDocument({ hello: 1 }, "https://z.example/x"), /unrecognized/);
  // metadata hash is content-addressed: same input -> same id + hash
  assert.equal(buildService({ protocol: "mcp", host: "h", skills: [], source: {} }).metadataHash, buildService({ protocol: "mcp", host: "h", skills: [], source: { other: 1 } }).metadataHash);
});

test("opt-out matching: host covers subdomains, erc8004 only on 84532, address, service id", () => {
  const svc = { id: "svc_0123456789abcdef", operatorId: "op_0123456789abcdef", host: "api.foo.example", erc8004AgentId: "9", payTo: seller.address, wallets: [seller.address] };
  assert.ok(matchesService(normalizeMatch("https://foo.example/a2a"), svc));
  assert.ok(matchesService(normalizeMatch("foo.example"), svc));
  assert.ok(!matchesService(normalizeMatch("oo.example"), svc));
  assert.ok(matchesService(normalizeMatch("erc8004:84532:9"), svc));
  assert.ok(!matchesService(normalizeMatch("erc8004:1:9"), svc));
  assert.ok(matchesService(normalizeMatch(seller.address.toLowerCase()), svc));
  assert.ok(matchesService(normalizeMatch("svc_0123456789abcdef"), svc));
});

test("seed import: counts, idempotent by seed hash, file opt-outs excluded at import", async () => {
  const d = dir();
  const oo = path.join(d, "dnc.json");
  writeFileSync(oo, JSON.stringify({ entries: [{ match: "weather.example" }] }));
  const { r } = mkRouter({ optOutFiles: [oo] });
  const a = r.importSeed();
  assert.equal(a.imported, 34);
  assert.equal(a.skippedOptedOut, 1);
  assert.equal(r.importSeed().reason, "seed unchanged");
  const st = r.stats();
  assert.equal(st.services, 34);
  assert.equal(st.claimed, 0);
  assert.equal(st.withSkills, 33);
  assert.throws(() => r.get(seedServices()[1].id), /unknown service/);
  r.close();
});

test("search: text, protocol, maxPrice (USDC only), claimed, paging with a stable shuffle seed", () => {
  const { r } = mkRouter();
  r.importSeed();
  const t = r.search({ q: "translate text" });
  assert.ok(t.total >= 31);
  assert.equal(r.search({ protocol: "mcp" }).results[0].host, "mcp.example");
  assert.ok(r.search({ maxPrice: "20000" }).results.every((x) => Number(x.minPriceUsdc) <= 20000));
  assert.equal(r.search({ maxPrice: "100000", q: "weather" }).total, 0); // weather costs 500000
  assert.equal(r.search({ claimed: "true" }).total, 0);
  const p1 = r.search({ q: "translate", limit: 10 });
  const p2 = r.search({ q: "translate", limit: 10, cursor: p1.nextCursor });
  assert.equal(new Set([...p1.results, ...p2.results].map((x) => x.id)).size, 20);
  assert.deepEqual(r.search({ q: "translate", limit: 10 }).results.map((x) => x.id), p1.results.map((x) => x.id));
  assert.throws(() => r.search({ protocol: "ftp" }), /protocol/);
  assert.throws(() => r.search({ cursor: "!!" }), /cursor/);
  const one = r.get(seedServices()[2].id);
  assert.equal(one.status, "unclaimed");
  assert.equal(one.verification, "unverified");
  assert.equal(one.skills[0].request.protocol, "a2a");
  assert.equal(one.skills[0].request.body.method, "message/send");
  assert.deepEqual(one.untrustedFields.slice(0, 2), ["name", "description"]);
  r.close();
});

test("route: ranks by text match, budget filter, quote source labels, request per protocol", async () => {
  const { r } = mkRouter();
  r.importSeed();
  const x = await r.route({ task: "translate this text to French", budget: "20000" });
  assert.ok(x.count > 0 && x.count <= 5);
  assert.ok(x.candidates.every((c) => c.quote.amount == null || Number(c.quote.amount) <= 20000));
  const c0 = x.candidates.find((c) => c.host === "translate.example") ?? x.candidates[0];
  assert.equal(c0.quote.source, "indexed");
  assert.equal(c0.request.protocol, "x402");
  assert.deepEqual(c0.orderModes, ["direct"]);
  const w = await r.route({ task: "weather forecast", budget: "1000" });
  assert.ok(!w.candidates.some((c) => c.host === "weather.example"));
  const w2 = await r.route({ task: "weather forecast" });
  assert.equal(w2.candidates[0].host, "weather.example");
  const m = await r.route({ task: "search the web", constraints: { protocol: "mcp" } });
  assert.equal(m.candidates[0].request.sequence[1].method, "tools/call");
  await assert.rejects(r.route({ task: "x" }), /task/);
  await assert.rejects(r.route({ task: "the a of", budget: "1" }), /searchable/);
  await assert.rejects(r.route({ task: "translate", budget: "1.5" }), /budget/);
  r.close();
});

test("opt-out: one call delists every listing for the host and blocks re-import and submit", async () => {
  const { r, d, docs } = mkRouter();
  r.importSeed();
  const before = r.stats().services;
  const res = r.optOut("https://translate-farm.example/anything");
  assert.equal(res.delisted.length, 30);
  assert.equal(r.stats().services, before - 30);
  assert.equal(r.search({ q: "Translator" }).results.filter((x) => x.host.endsWith("translate-farm.example")).length, 0);
  // a changed seed (new hash) does not bring them back
  const s2 = seedServices();
  s2.push(buildService({ protocol: "mcp", host: "new.example", skills: [], source: {} }));
  r.o.seedFile = writeSeed(d, s2);
  const imp = r.importSeed();
  assert.equal(imp.skippedOptedOut, 30);
  assert.equal(r.stats().services, before - 30 + 1);
  docs.set("https://t1.translate-farm.example/.well-known/agent-card.json", { status: 200, body: { name: "x", skills: [] } });
  await assert.rejects(r.submit({ url: "https://t1.translate-farm.example/.well-known/agent-card.json" }), /opted out/);
  // by service id and by payTo address
  const tr = seedServices()[0].id;
  assert.deepEqual(r.optOut(tr).delisted, [tr]);
  r.close();
});

test("claim: EIP-712 by payTo in one signed call; wrong signer, expiry, erc8004 owner, well-known", async () => {
  const { r, docs } = mkRouter();
  r.importSeed();
  const svc = r.get(seedServices()[0].id);
  const expiresAt = String(Math.floor(Date.now() / 1000) + 600);
  const td = r.typedData(svc.id, seller.address, svc.metadataHash, expiresAt);
  const sig = await seller.signTypedData({ ...td, message: { ...td.message, expiresAt: BigInt(expiresAt) } });
  // wrong signer
  const other = privateKeyToAccount(generatePrivateKey());
  const td2 = r.typedData(svc.id, other.address, svc.metadataHash, expiresAt);
  const sig2 = await other.signTypedData({ ...td2, message: { ...td2.message, expiresAt: BigInt(expiresAt) } });
  await assert.rejects(r.claimVerify(svc.id, { claimant: other.address, expiresAt, signature: sig2 }), /neither a payTo/);
  await assert.rejects(r.claimVerify(svc.id, { claimant: other.address, expiresAt, signature: sig }), /not by claimant/);
  await assert.rejects(r.claimVerify(svc.id, { claimant: seller.address, expiresAt: "100", signature: sig }), /future/);
  const ok = await r.claimVerify(svc.id, { claimant: seller.address, expiresAt, signature: sig });
  assert.equal(ok.status, "claimed");
  assert.equal(ok.claimProof.basis, "payTo");
  assert.equal(r.get(svc.id).status, "claimed");
  assert.equal(r.search({ claimed: true }).total, 1);
  // claimed listing now supports escrow orders with the claimant as provider
  const route = await r.route({ task: "translate text" });
  assert.deepEqual(route.candidates.find((c) => c.serviceId === svc.id).orderModes, ["direct", "escrow"]);
  // erc8004 owner
  const reg = r.get(seedServices()[4].id);
  const ch = await r.claimChallenge(reg.id, {});
  assert.equal(ch.allowedSigners.erc8004Owner, seller.address);
  const td3 = r.typedData(reg.id, seller.address, reg.metadataHash, expiresAt);
  const sig3 = await seller.signTypedData({ ...td3, message: { ...td3.message, expiresAt: BigInt(expiresAt) } });
  assert.equal((await r.claimVerify(reg.id, { claimant: seller.address, expiresAt, signature: sig3 })).claimProof.basis, "erc8004Owner");
  // well-known token
  const mcp = seedServices()[3].id;
  const c2 = await r.claimChallenge(mcp, {});
  await assert.rejects(r.claimVerify(mcp, { method: "well-known" }), /not found/);
  docs.set("https://mcp.example/.well-known/agentcoin-claim", { status: 200, body: c2.wellKnown.content });
  assert.equal((await r.claimVerify(mcp, { method: "well-known" })).claimProof.method, "well-known");
  // a re-import of the seed never un-claims
  r.q.setMeta.run("seedHash", "x");
  r.importSeed();
  assert.equal(r.get(svc.id).status, "claimed");
  r.close();
});

test("direct order: seller's own requirements, payment verified from the Transfer log, signed delivery record, score", async () => {
  const { r, receipts } = mkRouter();
  r.importSeed();
  const sid = seedServices()[0].id;
  const o = await r.placeOrder({ serviceId: sid, mode: "direct", buyer });
  assert.equal(o.origin, "external");
  assert.equal(o.paymentRequirements[0].payTo, seller.address);
  assert.equal(o.paymentRequirements[0].network, NETWORK_ID);
  await assert.rejects(r.placeOrder({ serviceId: seedServices()[1].id, mode: "direct", buyer }), /eip155:84532/);
  await assert.rejects(r.placeOrder({ serviceId: sid, mode: "escrow", buyer }), /claimed listings/);
  const tx = "0x" + "ab".repeat(32);
  receipts.set(tx, transferReceipt({ from: buyer, to: seller.address, value: 10000 }));
  const rc = await r.receipt(o.orderId, { paymentTx: tx, deliverable: { translated: "bonjour" }, latencyMs: 420 });
  assert.equal(rc.verdict, "delivered");
  assert.equal(rc.payment.ok, true);
  assert.equal((await verifyEip191(rc.deliveryRecord)).signer, operator.address);
  assert.equal(rc.score.deliveredAfterPayRate, 1);
  assert.equal(rc.score.n, 1);
  assert.equal((await verifyEip191(rc.score)).valid, true);
  // the same tx cannot back a second order
  const o2 = await r.placeOrder({ serviceId: sid, mode: "direct", buyer });
  await assert.rejects(r.receipt(o2.orderId, { paymentTx: tx, deliverable: "x" }), /already recorded/);
  // underpayment -> payment-unverified, not counted as paid
  const tx3 = "0x" + "cd".repeat(32);
  receipts.set(tx3, transferReceipt({ from: buyer, to: seller.address, value: 1 }));
  const r3 = await r.receipt(o2.orderId, { paymentTx: tx3, deliverable: "x" });
  assert.equal(r3.verdict, "payment-unverified");
  assert.equal(r3.score.n, 1);
  // paid but nothing delivered -> rate drops
  const o4 = await r.placeOrder({ serviceId: sid, mode: "direct", buyer: privateKeyToAccount(generatePrivateKey()).address });
  const tx4 = "0x" + "ef".repeat(32);
  receipts.set(tx4, transferReceipt({ from: o4.buyer ?? (await r.getOrder(o4.orderId)).buyer, to: seller.address, value: 10000 }));
  const r4 = await r.receipt(o4.orderId, { paymentTx: tx4 });
  assert.equal(r4.verdict, "not-delivered");
  assert.equal(r4.score.deliveredAfterPayRate, 0.5);
  assert.equal(r4.score.independentBuyers, 2);
  const v = await r.verifyScore(sid);
  assert.equal(v.valid, true);
  assert.equal(v.signer, operator.address);
  assert.equal(r.search({ minScore: 0.4 }).total, 1);
  r.close();
});

test("AgentCoin-originated orders are recorded but excluded from the score", async () => {
  const { r, receipts } = mkRouter();
  r.importSeed();
  const sid = seedServices()[0].id;
  const o = await r.placeOrder({ serviceId: sid, mode: "direct", buyer: internalBuyer });
  assert.equal(o.origin, "agentcoin");
  assert.equal(o.countedInScore, false);
  const tx = "0x" + "12".repeat(32);
  receipts.set(tx, transferReceipt({ from: internalBuyer, to: seller.address, value: 10000 }));
  const rc = await r.receipt(o.orderId, { paymentTx: tx, deliverable: "ok" });
  assert.equal(rc.score.n, 0);
  assert.equal(rc.score.deliveredAfterPayRate, null);
  assert.equal(rc.score.excludedAgentcoinOrders, 1);
  const o2 = await r.placeOrder({ serviceId: sid, mode: "direct", buyer, origin: "agentcoin" });
  assert.equal(o2.origin, "agentcoin");
  const rep = r.reputation(sid);
  assert.equal(rep.evidence.find((e) => e.type === "order").countedInScore, false);
  // tampering with evidence breaks the root
  const tampered = { ...rep.score, deliveredAfterPayRate: 1 };
  assert.equal((await verifyEip191(tampered)).valid, false);
  r.close();
});

test("escrow order (seeded seller): unsigned approve + createAndFundFor, job checks, verdict -> score", async () => {
  const { r, jobs } = mkRouter();
  r.importSeed();
  const SPEC = keccak256(toBytes("spec"));
  const seed = buildService({ protocol: "x402", host: "ac.test", name: "AgentCoin notary", skills: x402Skills([x402Item("ac.test", "/v1/notarize", { payTo: PROVIDER })]), source: { kind: "agentcoin-operated" } });
  r.registerSeed(seed, { liveQuote: async () => ({ scheme: "exact", network: NETWORK_ID, asset: USDC_SEP, amount: "10000", payTo: PROVIDER }), escrow: { provider: PROVIDER, evaluator: EVAL, specHash: SPEC, sellerCall: { method: "POST" } } });
  assert.equal(r.get(seed.id).operatedBy, "AgentCoin");
  assert.equal(r.get(seed.id).status, "claimed");
  const rt = await r.route({ task: "notarize timestamp service" });
  const c = rt.candidates.find((x) => x.serviceId === seed.id);
  assert.equal(c.quote.source, "live");
  assert.deepEqual(c.orderModes, ["direct", "escrow"]);
  const o = await r.placeOrder({ serviceId: seed.id, mode: "escrow", buyer });
  assert.equal(o.transactions.length, 2);
  const dec = decodeFunctionData({ abi: ABI.escrow, data: o.transactions[1].data });
  assert.equal(dec.functionName, "createAndFundFor");
  assert.equal(getAddress(dec.args[0]), getAddress(buyer));
  assert.equal(getAddress(dec.args[1]), PROVIDER);
  assert.equal(dec.args[3], 10000n);
  assert.equal(dec.args[5], SPEC);
  assert.equal(o.transactions[1].to, ESCROW);
  jobs.set("9", { state: "Funded", client: buyer, provider: PROVIDER, evaluator: privateKeyToAccount(generatePrivateKey()).address, amount: "10000", specHash: SPEC, deliverableHash: "0x" + "00".repeat(32) });
  await assert.rejects(r.receipt(o.orderId, { jobId: "9" }), /evaluator/);
  jobs.set("10", { state: "Funded", client: buyer, provider: PROVIDER, evaluator: EVAL, amount: "10000", specHash: SPEC, deliverableHash: "0x" + "00".repeat(32) });
  const f = await r.receipt(o.orderId, { jobId: "10", paymentTx: "0x" + "34".repeat(32) });
  assert.equal(f.status, "funded");
  jobs.set("10", { ...jobs.get("10"), state: "Completed", deliverableHash: "0x" + "56".repeat(32) });
  const g = await r.getOrder(o.orderId);
  assert.equal(g.verdict, "complete");
  assert.equal(g.deliverableHash, "0x" + "56".repeat(32));
  assert.equal((await verifyEip191(g.deliveryRecord)).valid, true);
  const sc = r.reputation(seed.id).score;
  assert.equal(sc.deliveredAfterPayRate, 1);
  assert.equal(sc.disputeRate, 0);
  // seed listing is not delisted by a host opt-out of our own host, and cannot be claimed by others
  assert.deepEqual(r.optOut("ac.test").delisted, []);
  await assert.rejects(r.claimChallenge(seed.id, {}), /AgentCoin-operated/);
  // probes add signed evidence and change the score's evidence root
  const root1 = sc.evidenceRoot;
  await r.addProbe(seed.id, { kind: "reach", status: 200, latencyMs: 12, url: "https://ac.test/healthz" });
  const s2 = await r.recomputeScore(seed.id);
  assert.notEqual(s2.evidenceRoot, root1);
  assert.equal(s2.probes, 1);
  assert.equal((await r.verifyScore(seed.id)).valid, true);
  r.close();
});

test("submit: GET-only parse, idempotent by metadata hash, https only, update on change", async () => {
  const { r, docs } = mkRouter();
  r.importSeed();
  const url = "https://new-agent.example/.well-known/agent-card.json";
  docs.set(url, { status: 200, body: { name: "New agent", skills: [{ id: "ocr", name: "OCR", description: "extract text from images" }], supportedInterfaces: [{ url: "https://new-agent.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }] } });
  const a = await r.submit({ url });
  assert.equal(a.status, "created");
  assert.equal(a.listing.status, "unclaimed");
  assert.equal((await r.submit({ url })).status, "unchanged");
  docs.set(url, { status: 200, body: { name: "New agent", skills: [{ id: "ocr2", name: "OCR v2" }], supportedInterfaces: [{ url: "https://new-agent.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }] } });
  assert.equal((await r.submit({ url })).status, "updated");
  await assert.rejects(r.submit({ url: "http://x.example/card" }), /https/);
  await assert.rejects(r.submit({ url: "https://nothing.example/card" }), /404/);
  const x402 = "https://paid.example/api";
  docs.set(x402, { status: 402, headers: {}, body: { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:84532", asset: USDC_SEP, amount: "1000", payTo: seller.address }], resource: { url: x402 } } });
  const p = await r.submit({ url: x402 });
  assert.equal(p.listing.protocol, "x402");
  assert.equal(p.listing.skills[0].price, "1000");
  r.close();
});

test("fetchDoc guard: https only, private addresses refused (no network used)", async () => {
  const f = makeFetchDoc();
  assert.equal((await f("http://example.com")).error, "https only");
  assert.equal((await f("https://127.0.0.1/x")).error, "private address");
  assert.equal((await f("https://10.1.2.3/x")).error, "private address");
  assert.equal((await f("https://169.254.169.254/latest")).error, "private address");
});

test("dump: paged well-known index with listing policy and opt-out pointer", () => {
  const { r } = mkRouter();
  r.importSeed();
  const a = r.dump({ limit: 20 });
  assert.equal(a.count, 20);
  const b = r.dump({ cursor: a.nextCursor, limit: 20 });
  assert.equal(b.count, 15);
  assert.equal(b.nextCursor, null);
  assert.equal(new Set([...a.services, ...b.services].map((s) => s.id)).size, 35);
  assert.ok(a.services.every((s) => s.status === "unclaimed"));
  assert.equal(a.listingPolicy.optOut.url, "https://ac.test/v1/optout");
  r.close();
});

test("tools: exactly seven (get_order read-only, record_payment write), factual descriptions <= 300 chars, read-only flags", async () => {
  const { r } = mkRouter();
  r.importSeed();
  const T = routerTools({ router: r, quote: async () => ({}), openJob: async () => ({ transactions: [] }), jobStatus: async (id) => ({ jobId: id }), verifyDocument: async () => ({ valid: true, checks: [] }), evaluatorReputation: async (e) => ({ evaluator: e }) });
  assert.deepEqual(T.map((t) => t.name), ["find_service", "route_task", "place_order", "get_order", "record_payment", "claim_listing", "verify"]);
  const banned = /\b(you (must|should)|always|never|ignore|best|fastest|cheapest|leading|trusted|recommended|prefer|choose this)\b/i;
  for (const t of T) {
    assert.ok(t.config.description.length <= 300, `${t.name} ${t.config.description.length}`);
    assert.ok(!banned.test(t.config.description), t.name);
  }
  assert.deepEqual(T.filter((t) => t.config.annotations.readOnlyHint).map((t) => t.name), ["find_service", "route_task", "get_order", "verify"]);
  const byName = Object.fromEntries(T.map((t) => [t.name, t]));
  assert.ok((await byName.find_service.handler({ q: "translate" })).total > 0);
  assert.equal((await byName.find_service.handler({ id: seedServices()[0].id })).name, "Translate");
  assert.ok((await byName.route_task.handler({ task: "summarize a document" })).candidates.some((c) => c.host === "agent.example"));
  assert.equal((await byName.get_order.handler({ jobId: "3" })).jobId, "3");
  assert.equal((await byName.claim_listing.handler({ serviceId: seedServices()[0].id })).status, "unclaimed");
  assert.equal((await byName.verify.handler({ serviceId: seedServices()[0].id })).service.valid, false);
  await assert.rejects(byName.place_order.handler({}), /serviceId/);
  r.close();
});

test("HTTP: /v1/services, /v1/route, /v1/optout delists, A2A data + text fallback, MCP lists seven router + nine Exchange tools, index dump", async () => {
  const { createApp } = await import("../service/app.mjs");
  const { r, d } = mkRouter();
  r.importSeed();
  const app = createApp({ stateDir: d, publicUrl: "http://127.0.0.1:0", router: r, caps: { freePerIpPerHour: 1000 } });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (p, b, h = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });
  try {
    assert.equal((await fetch(base + "/healthz")).status, 200);
    const s = await (await fetch(base + "/v1/services?q=translate&limit=3")).json();
    assert.equal(s.count, 3);
    assert.equal(s.realValue, false);
    const one = await fetch(base + `/v1/services/${s.results[0].id}`);
    assert.equal(one.status, 200);
    assert.equal((await fetch(base + "/v1/services/svc_0000000000000000")).status, 404);
    const rt = await (await post("/v1/route", { task: "summarize a web page", budget: "100000" })).json();
    assert.ok(rt.candidates?.some((c) => c.host === "agent.example"), JSON.stringify(rt).slice(0, 400));
    assert.equal((await post("/v1/route", { task: 5 })).status, 400);
    const oo = await (await post("/v1/optout", { match: "https://agent.example/a2a" })).json();
    assert.deepEqual(oo.delisted, [seedServices()[2].id]);
    assert.equal((await fetch(base + `/v1/services/${seedServices()[2].id}`)).status, 404);
    const a2a = await (await post("/a2a/v1/message:send", { message: { role: "user", messageId: "1", parts: [{ text: "translate text to German" }] } })).json();
    assert.ok(a2a.message.parts[0].data.candidates.length > 0);
    const a2b = await (await post("/a2a/v1/message:send", { message: { role: "user", messageId: "2", parts: [{ data: { skill: "find_service", arguments: { protocol: "mcp" } } }] } })).json();
    assert.equal(a2b.message.parts[0].data.results[0].host, "mcp.example");
    const h = { accept: "application/json, text/event-stream" };
    await post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, h);
    const tl = await (await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, h)).json();
    assert.deepEqual(tl.result.tools.map((t) => t.name), ["find_service", "route_task", "place_order", "get_order", "record_payment", "claim_listing", "verify", "create_listing", "get_agent_profile", "find_earning_opportunities", "post_job", "list_open_jobs", "claim_job", "join_beta", "get_fee_credits", "list_evaluators"]);
    const call = await (await post("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "route_task", arguments: { task: "search the web" } } }, h)).json();
    assert.equal(call.result.structuredContent.candidates[0].host, "mcp.example");
    const card = await (await fetch(base + "/.well-known/mcp/server-card.json")).json();
    assert.equal(card.tools.length, 16);
    const dump = await (await fetch(base + "/.well-known/agentcoin-index.json?limit=5")).json();
    assert.equal(dump.count, 5);
    assert.ok(dump.nextCursor);
    const st = await (await fetch(base + "/v1/stats")).json();
    assert.equal(st.counters.routeCalls, 2);
  } finally {
    await app.stop();
    r.close();
  }
});
