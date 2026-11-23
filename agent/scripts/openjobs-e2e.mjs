#!/usr/bin/env node
// AgentKoin Exchange open-jobs board end-to-end on a LOCAL service instance (Base Sepolia testnet contracts):
//   claimer opts into the beta (EIP-712, off-chain) -> buyer posts a job (EIP-712 OpenJob) -> claimer claims (EIP-712 Claim)
//   -> buyer funds with ONE x402 request carrying two EIP-3009 authorizations (price -> offer-bound route; Exchange fee ->
//   fee recipient) -> claimer submits sha256(deliverable) on chain and publishes the bytes -> reference evaluator verdict
//   -> finalize -> poll until Settled -> claimer's fee credit (beta) is read back.
// Usage: AGENTCOIN_PAYER_KEY_FILE=<buyer key> AGENTCOIN_CLAIMER_KEY_FILE=<claimer key> node scripts/openjobs-e2e.mjs http://127.0.0.1:<port>
// Loopback only. Keys are read from files and never printed.
import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { getAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, isLoopback } from "../lib/config.mjs";
import { publicClient, wallet, contracts, send } from "../lib/chain.mjs";
import { jcs } from "../lib/canonical.mjs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base || !isLoopback(base)) throw new Error("usage: openjobs-e2e.mjs http://127.0.0.1:<port> (loopback only)");
const key = (v) => readFileSync(process.env[v] ?? (() => { throw new Error(`${v} is required`); })(), "utf8").trim();
const buyerKey = key("AGENTCOIN_PAYER_KEY_FILE"), claimerKey = key("AGENTCOIN_CLAIMER_KEY_FILE");
const buyer = privateKeyToAccount(buyerKey), claimer = privateKeyToAccount(claimerKey);
const log = (k, v) => console.log(JSON.stringify({ t: new Date().toISOString(), step: k, ...v }));
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const post = async (p, body, headers = {}) => j(await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const signTd = (acct, td, k) => acct.signTypedData({ ...td, message: { ...td.message, [k]: BigInt(td.message[k]) } });

// 1. claimer opts into the beta
const nowS = Math.floor(Date.now() / 1000);
let r = await post("/exchange/v1/beta", { agent: claimer.address, optIn: true });
const btd = r.body.eip712;
btd.message.issuedAt = String(nowS);
r = await post("/exchange/v1/beta", { agent: claimer.address, optIn: true, issuedAt: String(nowS), signature: await signTd(claimer, btd, "issuedAt") });
if (r.status !== 200) throw new Error(`beta opt-in ${r.status} ${JSON.stringify(r.body)}`);
log("beta", { claimer: claimer.address, result: r.body.result, badge: r.body.badge, credits: r.body.credits.balance });

// 2. buyer posts a job
const job = { title: "E2E: echo a nonce", category: "echo", budget: process.env.E2E_BUDGET ?? "10000", sla_seconds: 3600, deliverable_schema: { type: "object", required: ["echo"], properties: { echo: { type: "string" } } }, input: { nonce: toHex(randomBytes(8)) }, nonce: toHex(randomBytes(8)) };
r = await post("/exchange/v1/jobs", { job, buyer: buyer.address });
const exp = String(nowS + 600);
const otd = { ...r.body.eip712, message: { ...r.body.eip712.message, expiresAt: exp } };
r = await post("/exchange/v1/jobs", { job, buyer: buyer.address, expiresAt: exp, signature: await signTd(buyer, otd, "expiresAt") });
if (r.status !== 201) throw new Error(`post ${r.status} ${JSON.stringify(r.body)}`);
const oj = r.body;
log("posted", { openJobId: oj.open_job_id, budget: oj.budget, quote: oj.quote, criteria: oj.criteria_hash });

// 3. claimer claims
r = await post(`/exchange/v1/jobs/${oj.open_job_id}/claim`, { claimer: claimer.address });
const ctd = { ...r.body.eip712, message: { ...r.body.eip712.message, expiresAt: exp } };
r = await post(`/exchange/v1/jobs/${oj.open_job_id}/claim`, { claimer: claimer.address, expiresAt: exp, signature: await signTd(claimer, ctd, "expiresAt") });
if (r.status !== 201) throw new Error(`claim ${r.status} ${JSON.stringify(r.body)}`);
const cl = r.body;
log("claimed", { orderId: cl.order_id, evaluator: cl.evaluator, quote: cl.quote, claimExpiresAt: cl.claim_expires_at });

// 4. buyer funds: 402 then one paid request with authorization (price) + feeAuthorization (fee)
const payUrl = `/exchange/v1/orders/${cl.order_id}/pay`;
r = await post(payUrl, {});
if (r.status !== 402) throw new Error(`expected 402, got ${r.status} ${JSON.stringify(r.body)}`);
const req = r.body.accepts[0];
const feeReq = req.extra.agentcoin.exchangeFee.requirement;
const blk = (await publicClient.getBlock()).timestamp;
const auth = async (rq) => {
  const a = { from: buyer.address, to: getAddress(rq.payTo), value: rq.amount, validAfter: String(blk - 60n), validBefore: String(blk + 300n), nonce: toHex(randomBytes(32)) };
  const signature = await buyer.signTypedData({
    domain: { name: rq.extra.name, version: rq.extra.version, chainId: CHAIN_ID, verifyingContract: getAddress(rq.asset) },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
  });
  return { signature, authorization: a };
};
const main = await auth(req);
const pp = { x402Version: 2, resource: r.body.resource, accepted: req, payload: { ...main, ...(feeReq ? { feeAuthorization: await auth(feeReq) } : {}) } };
log("402", { payTo: req.payTo, amount: req.amount, fee: feeReq ? { payTo: feeReq.payTo, amount: feeReq.amount } : null });
r = await post(payUrl, {}, { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(pp)).toString("base64") });
if (r.status !== 201) throw new Error(`pay ${r.status} ${JSON.stringify(r.body)}`);
const order = r.body;
log("funded", { orderId: order.order_id, jobId: order.job_id, txs: order.txs, quote: order.quote });

// 5. claimer delivers: submit sha256(bytes) on chain, then publish bytes
const bytes = Buffer.from(jcs({ jobId: String(order.job_id), output: { echo: job.input.nonce } }), "utf8");
const h = "0x" + createHash("sha256").update(bytes).digest("hex");
const sub = await send(wallet(claimerKey), contracts().escrow, "submit", [BigInt(order.job_id), h]);
log("submitted", { submitTx: sub.hash, deliverableHash: h });
for (let i = 0; i < 20; i++) {
  const d = await j(await fetch(`${base}/exchange/v1/orders/${order.order_id}/deliverable`, { method: "POST", headers: { "content-type": "application/json" }, body: bytes }));
  if (d.status === 200) {
    log("published", { deliverable: d.body.deliverable_url });
    break;
  }
  await new Promise((s) => setTimeout(s, 5000));
}

// 6. poll until settled
const deadline = Date.now() + Number(process.env.E2E_TIMEOUT_MS ?? 40 * 60_000);
let last = null;
while (Date.now() < deadline) {
  const o = (await j(await fetch(`${base}/exchange/v1/orders/${order.order_id}`))).body;
  if (o && o.status !== last) {
    last = o.status;
    log("order", { status: o.status, jobState: o.job_state, verdict: o.verdict, txs: o.txs });
  }
  if (o && ["settled", "expired", "cancelled", "disputed"].includes(o.status)) {
    const credits = (await j(await fetch(`${base}/exchange/v1/beta/${claimer.address}/credits`))).body;
    const ojv = (await j(await fetch(`${base}/exchange/v1/jobs/${oj.open_job_id}`))).body;
    log("done", { openJobId: oj.open_job_id, openJobStatus: ojv.status, orderId: o.order_id, jobId: o.job_id, escrow: o.escrow, status: o.status, verdict: o.verdict, txs: { ...o.txs, submit: o.txs.submit ?? sub.hash }, proof: o.proof_url, claimerCredits: { balance: credits.balance, history: credits.history } });
    process.exit(o.status === "settled" ? 0 : 1);
  }
  await new Promise((s) => setTimeout(s, 15_000));
}
log("timeout", { orderId: order.order_id, last });
process.exit(1);
