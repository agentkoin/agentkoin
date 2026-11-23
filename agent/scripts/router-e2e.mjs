#!/usr/bin/env node
// v0.5 router end-to-end against the hosted Base Sepolia service (testnet only, test USDC).
// Phases: direct | escrow | claim | score   (each appends to deployments/base-sepolia-v05-e2e.json; no secrets written)
//   direct  POST /v1/orders (mode direct) on the AgentCoin notary seed, pay it with x402 exact, POST the receipt
//   escrow  POST /v1/orders (mode escrow), sign+send the 2 unsigned txs (deployer = buyer), POST receipt, call the
//           seller (agentcoin-escrow), poll GET /v1/orders/{id} until a verdict
//   claim   POST /v1/services {url: our agent-registration.json} then ONE signed claim/verify (operator = ERC-8004 owner)
//   score   GET /v1/reputation/{notary} and check signature + evidence root locally
// Usage: AGENTCOIN_NETWORK=base-sepolia node scripts/router-e2e.mjs <phase> [baseUrl]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseEventLogs, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT, NETWORK, CHAIN_ID, roleKey } from "../lib/config.mjs";
import { publicClient, wallet, contracts, feeOverrides, txCostWei } from "../lib/chain.mjs";
import { operatorKey } from "../lib/keys.mjs";
import { verifyEip191 } from "../lib/sign.mjs";
import { jcs } from "../lib/canonical.mjs";
import { payExact } from "../x402/pay-client.mjs";

if (NETWORK !== "base-sepolia") throw new Error("AGENTCOIN_NETWORK=base-sepolia required");
const phase = process.argv[2];
const BASE = process.argv[3] ?? "https://agentcoin.143-244-167-51.sslip.io";
const OUT = path.join(ROOT, "deployments", "base-sepolia-v05-e2e.json");
const st = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { network: NETWORK, chainId: CHAIN_ID, base: BASE, runs: [] };
const J = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
const save = () => writeFileSync(OUT, J(st));
const api = async (method, p, body) => {
  const t = Date.now();
  const r = await fetch(BASE + p, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return { ...j, _ms: Date.now() - t };
};
const buyer = privateKeyToAccount(roleKey("client"));
async function notaryId() {
  const r = await api("GET", "/v1/services?q=notary&limit=10");
  const s = r.results.find((x) => x.status === "claimed" && x.operatedBy === "AgentCoin" && /notary/i.test(x.name));
  if (!s) throw new Error("notary seed not found");
  return s.id;
}
const rec = (x) => { st.runs.push({ phase, at: new Date().toISOString(), ...x }); save(); console.log(J(x)); };

if (phase === "direct") {
  const sid = await notaryId();
  const order = await api("POST", "/v1/orders", { serviceId: sid, mode: "direct", buyer: buyer.address });
  const body = { sha256: "0x" + keccak256(toBytes("agentcoin v0.5 direct order " + order.orderId)).slice(2), note: "router e2e direct" };
  const t = Date.now();
  const paid = await payExact(order.request?.url ?? `${BASE}/v1/notarize`, { method: "POST", body, allowRemote: true, maxPay: 20000n });
  const latencyMs = Date.now() - t;
  const paymentTx = paid.paymentResponse?.transaction ?? paid.paymentResponse?.txHash;
  const r = await api("POST", `/v1/orders/${order.orderId}/receipt`, { paymentTx, deliverable: paid.resource, latencyMs });
  rec({ serviceId: sid, orderId: order.orderId, origin: order.origin, payTo: order.paymentRequirements?.[0]?.payTo, paymentTx, paymentResponse: paid.paymentResponse, verdict: r.verdict, status: r.status, payment: r.payment, countedInScore: r.countedInScore, deliveryRecordSigner: r.deliveryRecord?.signature?.signer, deliveryRecordValid: (await verifyEip191(r.deliveryRecord)).valid, scoreEvidenceRoot: r.score?.evidenceRoot, excludedAgentcoinOrders: r.score?.excludedAgentcoinOrders });
} else if (phase === "escrow") {
  const sid = await notaryId();
  const order = await api("POST", "/v1/orders", { serviceId: sid, mode: "escrow", buyer: buyer.address, deadlineSeconds: 3600 });
  const w = wallet(roleKey("client"));
  const txs = [];
  for (const tx of order.transactions) {
    const hash = await w.sendTransaction({ to: tx.to, data: tx.data, value: 0n, ...(await feeOverrides()) });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${tx.label} reverted ${hash}`);
    txs.push({ label: tx.label, hash, costWei: txCostWei(rc).toString(), rc });
  }
  const c = contracts();
  const ev = parseEventLogs({ abi: c.escrow.abi, logs: txs[1].rc.logs, eventName: "JobCreated" })[0];
  const jobId = ev.args.jobId.toString();
  const fundTx = txs[1].hash;
  await new Promise((r) => setTimeout(r, 4000));
  const rr = await api("POST", `/v1/orders/${order.orderId}/receipt`, { jobId, paymentTx: fundTx });
  const sc = order.sellerCall;
  const pay = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "agentcoin-escrow", network: `eip155:${CHAIN_ID}` }, payload: { jobId, txHash: fundTx } })).toString("base64");
  const sbody = { sha256: "0x" + keccak256(toBytes("agentcoin v0.5 escrow order " + order.orderId)).slice(2), note: "router e2e escrow" };
  const t = Date.now();
  const sr = await fetch(sc.url, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": pay }, body: JSON.stringify(sbody) });
  const sj = await sr.json().catch(() => null);
  const sellerMs = Date.now() - t;
  let o = null;
  for (let i = 0; i < 40; i++) {
    o = await api("GET", `/v1/orders/${order.orderId}`);
    if (o.verdict) break;
    await new Promise((r) => setTimeout(r, 15000));
  }
  rec({ serviceId: sid, orderId: order.orderId, origin: order.origin, jobId, txs: txs.map(({ rc, ...x }) => x), escrow: order.escrow, quote: order.quote, receiptStatus: rr.status, sellerCall: { status: sr.status, ms: sellerMs, body: sj }, final: { verdict: o?.verdict, status: o?.status, deliverableHash: o?.deliverableHash, jobState: o?.job?.state ?? o?.job, deliveryRecordValid: o?.deliveryRecord ? (await verifyEip191(o.deliveryRecord)).valid : null } });
} else if (phase === "claim") {
  const op = operatorKey();
  const sub = await api("POST", "/v1/services", { url: `${BASE}/.well-known/agent-registration.json` });
  const id = sub.listing?.id;
  const svc = await api("GET", `/v1/services/${id}`);
  const metadataHash = svc.metadataHash;
  if (!/^0x[0-9a-f]{64}$/i.test(metadataHash ?? "")) throw new Error("no metadataHash: " + Object.keys(svc).join(","));
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const domain = { name: "AgentCoin Index", version: "1", chainId: CHAIN_ID };
  const types = { Claim: [{ name: "serviceId", type: "string" }, { name: "claimant", type: "address" }, { name: "metadataHash", type: "bytes32" }, { name: "expiresAt", type: "uint256" }] };
  const signature = await privateKeyToAccount(op.privateKey).signTypedData({ domain, types, primaryType: "Claim", message: { serviceId: id, claimant: op.address, metadataHash, expiresAt: BigInt(expiresAt) } });
  const v = await api("POST", `/v1/services/${id}/claim/verify`, { claimant: op.address, expiresAt: String(expiresAt), signature });
  const after = await api("GET", `/v1/services/${id}`);
  rec({ submitted: { id, status: sub.status, protocol: sub.listing?.protocol, statusBefore: sub.listing?.status, ms: sub._ms }, claimCalls: 1, verify: v, statusAfter: after.status });
} else if (phase === "score") {
  const sid = await notaryId();
  const rep = await api("GET", `/v1/reputation/${sid}`);
  const sig = await verifyEip191(rep.score);
  const rootOk = keccak256(toBytes(jcs(rep.evidence))) === rep.score.evidenceRoot;
  rec({ serviceId: sid, signatureValid: sig.valid, signer: sig.signer, evidenceRootMatches: rootOk, score: { ...rep.score, signature: undefined }, evidenceTypes: rep.evidence.reduce((a, e) => ((a[e.type] = (a[e.type] ?? 0) + 1), a), {}), orders: rep.evidence.filter((e) => e.type === "order") });
} else throw new Error("phase: direct | escrow | claim | score");
