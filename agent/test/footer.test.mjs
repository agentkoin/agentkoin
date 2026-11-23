// Offline tests for the v0.5.2 receipt footer (additive `agentcoin` field) on orders, receipts, verdicts, scores
// and the verify tool. Signed payloads are unchanged; the router never adds the seller escrow hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { encodeEventTopics, encodeAbiParameters, erc20Abi, keccak256, toBytes } from "viem";
import { Router } from "../router/router.mjs";
import { routerTools } from "../router/tools.mjs";
import { buildService, x402Skills } from "../router/parse.mjs";
import { verifyEip191 } from "../lib/sign.mjs";
import { ABI } from "../lib/config.mjs";
import { FOOTER_VERSION } from "../lib/footer.mjs";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ESCROW = "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D";
const seller = privateKeyToAccount(generatePrivateKey());
const operatorKey = generatePrivateKey();
const operator = privateKeyToAccount(operatorKey);
const buyer = privateKeyToAccount(generatePrivateKey()).address;
const EVAL = privateKeyToAccount(generatePrivateKey()).address;
const PROVIDER = privateKeyToAccount(generatePrivateKey()).address;
const PUB = "https://ac.test";
const item = (host, p, payTo = seller.address) => ({ resource: `https://${host}${p}`, type: "http", accepts: [{ scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo }], description: "translate text" });

function mk() {
  const d = mkdtempSync(path.join(tmpdir(), "acfooter-"));
  const svc = buildService({ protocol: "x402", host: "translate.example", name: "Translate", skills: x402Skills([item("translate.example", "/v1/translate")]), source: { kind: "test" } });
  const f = path.join(d, "seed.json.gz");
  writeFileSync(f, gzipSync(JSON.stringify({ v: "agentcoin-index-seed/0.1", builtAt: "2026-11-01T00:00:00Z", inputs: {}, counts: {}, services: [svc] })));
  const jobs = new Map(), receipts = new Map();
  const r = new Router({ dbFile: path.join(d, "r.sqlite"), publicUrl: PUB, seedFile: f, optOutFiles: [], signerKey: operatorKey, chain: { usdc: USDC, escrow: ESCROW, escrowAbi: ABI.escrow, evaluator: EVAL, readJob: async (id) => jobs.get(String(id)) ?? null, getReceipt: async (h) => receipts.get(h) ?? null, ownerOf: async () => seller.address, quoteFees: async (a) => ({ amount: a }) }, fetchDoc: async () => ({ status: 404 }), agentcoinAddresses: [] });
  r.importSeed();
  return { r, jobs, receipts, sid: svc.id };
}
function transfer(from, to, value) {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } });
  return { status: "success", blockNumber: 1n, logs: [{ address: USDC.toLowerCase(), topics, data: encodeAbiParameters([{ type: "uint256" }], [BigInt(value)]), blockNumber: 1n, logIndex: 0, transactionHash: "0x" + "11".repeat(32), transactionIndex: 0, blockHash: "0x" + "22".repeat(32), removed: false }] };
}
function checkFooter(f, { serviceId, verified }) {
  assert.equal(f.v, FOOTER_VERSION);
  assert.equal(f.verified, verified);
  assert.equal(f.network, "base-sepolia");
  assert.equal(f.chain_id, 84532);
  if (serviceId) assert.equal(f.seller_score_url, `${PUB}/v1/reputation/${serviceId}`);
  assert.equal(f.get_your_score_url, `${PUB}/v1/services`);
  assert.equal(f.how_to_route.llms_txt, `${PUB}/llms.txt`);
  assert.equal(f.how_to_route.mcp.url, `${PUB}/mcp`);
  assert.ok(f.how_to_route.plugins.length >= 8 && f.how_to_route.plugins.every((p) => p.published === false && p.localPath && p.localPathBase === "https://github.com/agentkoin/agentkoin" && !("install" in p)));
  assert.doesNotMatch(JSON.stringify(f.how_to_route.plugins), /not publicly hosted/i);
  const urls = JSON.stringify(f).match(/https?:\/\/[^"]+/g);
  const SRC = "https://github.com/agentkoin/agentkoin";
  assert.ok(urls.every((u) => u.startsWith(PUB + "/") || u === SRC), "every URL is on our service or the source repository");
  assert.doesNotMatch(JSON.stringify(f), /you should|guarantee|\bplease\b|\bmust\b|best|trusted by/i);
}

test("footer: direct order, receipt, get_order, reputation; existing fields unchanged; signatures still verify", async () => {
  const { r, receipts, sid } = mk();
  const o = await r.placeOrder({ serviceId: sid, mode: "direct", buyer });
  checkFooter(o.agentcoin, { serviceId: sid, verified: false });
  assert.deepEqual(Object.keys(o).filter((k) => k !== "agentcoin"), ["orderId", "mode", "origin", "countedInScore", "serviceId", "skill", "custody", "paymentRequirements", "request", "receipt", "status"]);
  // the router hands back the seller's own requirements: no escrow hint injected, nothing added to accepts
  assert.deepEqual(o.paymentRequirements, [r._row(sid).skills[0].accepts[0]]);
  assert.deepEqual(Object.keys(o.paymentRequirements[0]).sort(), ["amount", "asset", "extra", "maxTimeoutSeconds", "network", "payTo", "scheme"]);
  assert.ok(!JSON.stringify(o.paymentRequirements).includes("agentcoin-escrow"));
  const tx = "0x" + "ab".repeat(32);
  receipts.set(tx, transfer(buyer, seller.address, 10000));
  const rc = await r.receipt(o.orderId, { paymentTx: tx, deliverable: "bonjour" });
  checkFooter(rc.agentcoin, { serviceId: sid, verified: true });
  assert.equal(rc.agentcoin.checks.deliveryRecordSignatureValid, true);
  assert.equal(rc.agentcoin.checks.paymentTransferVerified, true);
  const { agentcoin: _a, ...rest } = rc;
  assert.deepEqual(rest, { ...r.orderView(r._order(o.orderId)), payment: rc.payment, score: rc.score });
  assert.equal((await verifyEip191(rc.deliveryRecord)).signer, operator.address);
  assert.equal((await verifyEip191(rc.score)).valid, true);
  assert.ok(!("agentcoin" in rc.deliveryRecord) && !("agentcoin" in rc.score));
  const g = await r.getOrder(o.orderId);
  checkFooter(g.agentcoin, { serviceId: sid, verified: true });
  assert.equal((await verifyEip191(g.deliveryRecord)).valid, true);
  const rep = await r.reputationWithFooter(sid);
  checkFooter(rep.agentcoin, { serviceId: sid, verified: true });
  const { agentcoin: _b, ...repRest } = rep;
  assert.deepEqual(repRest, r.reputation(sid));
  assert.equal((await verifyEip191(rep.score)).valid, true);
  // underpaid -> payment unverified -> footer not verified
  const o2 = await r.placeOrder({ serviceId: sid, mode: "direct", buyer });
  const tx2 = "0x" + "cd".repeat(32);
  receipts.set(tx2, transfer(buyer, seller.address, 1));
  const r2 = await r.receipt(o2.orderId, { paymentTx: tx2, deliverable: "x" });
  assert.equal(r2.agentcoin.verified, false);
  assert.equal(r2.agentcoin.checks.paymentTransferVerified, false);
  r.close();
});

test("footer: escrow verdict verified only when the on-chain job matches the signed delivery record", async () => {
  const { r, jobs } = mk();
  const SPEC = keccak256(toBytes("spec"));
  const seed = buildService({ protocol: "x402", host: "ac.test", name: "AgentCoin notary", skills: x402Skills([item("ac.test", "/v1/notarize", PROVIDER)]), source: { kind: "agentcoin-operated" } });
  r.registerSeed(seed, { liveQuote: async () => ({ scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: PROVIDER }), escrow: { provider: PROVIDER, evaluator: EVAL, specHash: SPEC, sellerCall: null } });
  const o = await r.placeOrder({ serviceId: seed.id, mode: "escrow", buyer });
  checkFooter(o.agentcoin, { serviceId: seed.id, verified: false });
  jobs.set("5", { state: "Funded", client: buyer, provider: PROVIDER, evaluator: EVAL, amount: "10000", specHash: SPEC, deliverableHash: "0x" + "00".repeat(32) });
  const f = await r.receipt(o.orderId, { jobId: "5" });
  assert.equal(f.agentcoin.verified, false); // funded, no verdict / no signed delivery record yet
  assert.equal(f.agentcoin.checks.onchainJobMatches, true);
  jobs.set("5", { ...jobs.get("5"), state: "Completed", deliverableHash: "0x" + "56".repeat(32) });
  // getOrder in the router has no chain.jobStatus here -> job read absent -> not verified
  const g0 = await r.getOrder(o.orderId);
  assert.equal(g0.verdict, "complete");
  assert.equal(g0.agentcoin.verified, false);
  r.o.chain.jobStatus = async (id) => jobs.get(String(id));
  const g = await r.getOrder(o.orderId);
  assert.equal(g.agentcoin.verified, true);
  assert.equal(g.agentcoin.checks.onchainJobMatches, true);
  assert.equal((await verifyEip191(g.deliveryRecord)).valid, true);
  jobs.set("5", { ...jobs.get("5"), deliverableHash: "0x" + "99".repeat(32) });
  assert.equal((await r.getOrder(o.orderId)).agentcoin.verified, false);
  r.close();
});

test("footer: verify tool and raw place_order; tampered score -> verified false", async () => {
  const { r, receipts, sid } = mk();
  const tools = Object.fromEntries(routerTools({ router: r, quote: async (a) => a, openJob: async () => ({ transactions: [] }), verifyDocument: async () => ({ valid: true, checks: [] }), evaluatorReputation: async () => ({}) }).map((t) => [t.name, t]));
  const o = await r.placeOrder({ serviceId: sid, mode: "direct", buyer });
  const tx = "0x" + "ef".repeat(32);
  receipts.set(tx, transfer(buyer, seller.address, 10000));
  await r.receipt(o.orderId, { paymentTx: tx, deliverable: "ok" });
  const v = await tools.verify.handler({ serviceId: sid });
  checkFooter(v.agentcoin, { serviceId: sid, verified: true });
  assert.equal(v.service.valid, true);
  const raw = await tools.place_order.handler({ provider: PROVIDER, evaluator: EVAL, amount: "10000", buyer });
  assert.equal(raw.agentcoin.verified, false);
  // tamper the stored score: signature no longer verifies -> footer false
  const row = r.db.prepare("SELECT doc FROM scores WHERE service_id = ?").get(sid);
  const d = JSON.parse(row.doc);
  d.score.deliveredAfterPayRate = 0.1;
  r.db.prepare("UPDATE scores SET doc = ? WHERE service_id = ?").run(JSON.stringify(d), sid);
  const rep = await r.reputationWithFooter(sid);
  assert.equal(rep.agentcoin.verified, false);
  assert.equal(rep.agentcoin.checks.scoreSignatureValid, false);
  r.close();
});
