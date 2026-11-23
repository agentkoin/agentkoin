#!/usr/bin/env node
// AgentKoin Exchange end-to-end on a LOCAL service instance (Base Sepolia testnet contracts):
//   list (seed listing) -> hire (ONE x402 request: EIP-3009 to the offer-bound EscrowDepositRoute plus, when quoted, a second
//   EIP-3009 for the Exchange buyer fee as payload.feeAuthorization; relayer settles,
//   job funded) -> deliver (seed worker submits) -> reference evaluator verdict -> finalize (payout) -> poll until Settled.
// Usage: AGENTCOIN_PAYER_KEY_FILE=<file> node scripts/exchange-e2e.mjs http://127.0.0.1:<port> [skillId]
// Loopback only. The key is read from the file and never printed. Prints order + tx hashes as JSON lines.
import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { getAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, isLoopback } from "../lib/config.mjs";
import { publicClient } from "../lib/chain.mjs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const skillId = process.argv[3] ?? "notarize";
if (!base || !isLoopback(base)) throw new Error("usage: exchange-e2e.mjs http://127.0.0.1:<port> [skillId] (loopback only)");
const file = process.env.AGENTCOIN_PAYER_KEY_FILE;
if (!file) throw new Error("AGENTCOIN_PAYER_KEY_FILE is required");
const payer = privateKeyToAccount(readFileSync(file, "utf8").trim());
const log = (k, v) => console.log(JSON.stringify({ t: new Date().toISOString(), step: k, ...v }));
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

const ls = await j(await fetch(`${base}/exchange/v1/listings?skill=${skillId}`));
const listing = ls.body.results.find((l) => l.origin === "agentcoin" && l.skills.some((s) => s.skill_id === skillId));
if (!listing) throw new Error(`no seed listing for ${skillId}`);
log("list", { listingId: listing.listing_id, seller: listing.seller, buyer: payer.address });

const input = skillId === "notarize" ? { digest: "0x" + createHash("sha256").update(`agentkoin-exchange-e2e ${Date.now()}`).digest("hex"), note: "exchange e2e (testnet)" } : JSON.parse(process.env.E2E_INPUT ?? "{}");
const hireUrl = `${base}/exchange/v1/listings/${listing.listing_id}/hire?skill=${skillId}`;
const r1 = await fetch(hireUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skill_id: skillId, input }) });
if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status} ${await r1.text()}`);
const pr = await r1.json();
const req = pr.accepts.find((a) => a.scheme === "exact" && a.network === `eip155:${CHAIN_ID}`);
log("402", { payTo: req.payTo, amount: req.amount, evaluator: req.extra.agentcoin.offer.evaluator, specHash: req.extra.agentcoin.offer.specHash });

const now = (await publicClient.getBlock()).timestamp;
// signs one EIP-3009 TransferWithAuthorization for a requirement (price -> route, or Exchange fee -> fee recipient)
async function auth3009(rq) {
  const authorization = { from: payer.address, to: getAddress(rq.payTo), value: rq.amount, validAfter: String(now - 60n), validBefore: String(now + 300n), nonce: toHex(randomBytes(32)) };
  const signature = await payer.signTypedData({
    domain: { name: rq.extra.name, version: rq.extra.version, chainId: CHAIN_ID, verifyingContract: getAddress(rq.asset) },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  return { signature, authorization };
}
const feeReq = req.extra.agentcoin?.exchangeFee?.requirement ?? null;
if (feeReq) log("fee", { amount: feeReq.amount, payTo: feeReq.payTo, quote: req.extra.agentcoin.exchangeFee.quote });
const pp = { x402Version: 2, resource: pr.resource, accepted: req, payload: { ...(await auth3009(req)), ...(feeReq ? { feeAuthorization: await auth3009(feeReq) } : {}) } };
const r2 = await j(await fetch(hireUrl, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(pp)).toString("base64") }, body: JSON.stringify({ skill_id: skillId, input }) }));
if (r2.status !== 200 && r2.status !== 201) throw new Error(`hire failed ${r2.status} ${JSON.stringify(r2.body)}`);
const order = r2.body.order ?? r2.body;
log("hired", { status: r2.status, orderId: order.order_id, jobId: order.job_id, txs: order.txs });

const deadline = Date.now() + Number(process.env.E2E_TIMEOUT_MS ?? 40 * 60_000);
let last = null;
while (Date.now() < deadline) {
  const o = (await j(await fetch(`${base}/exchange/v1/orders/${order.order_id}`))).body;
  if (o && o.status !== last) {
    last = o.status;
    log("order", { status: o.status, jobState: o.job_state, verdict: o.verdict, txs: o.txs, deliverableHash: o.deliverable_hash });
  }
  if (o && ["settled", "expired", "cancelled", "disputed"].includes(o.status)) {
    log("done", { orderId: o.order_id, jobId: o.job_id, escrow: o.escrow, status: o.status, verdict: o.verdict, txs: o.txs, proof: o.proof_url, criteria: o.criteria_url, deliverable: o.deliverable_url });
    process.exit(o.status === "settled" ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
log("timeout", { orderId: order.order_id, last });
process.exit(1);
