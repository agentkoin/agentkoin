#!/usr/bin/env node
// AgentKoin Exchange OrderIntent end-to-end on a LOCAL service instance (adds: unsigned order marked deprecated, signed EIP-712 OrderIntent, replay and wrong-signer rejected,
// ERC-8004 id check (negative path with a non-owner test key), then x402 pay of the signed order and polling to Settled).
// Original header: AgentKoin Exchange end-to-end on a LOCAL service instance (Base Sepolia testnet contracts):
//   list (seed listing) -> hire (ONE x402 request: EIP-3009 to the offer-bound EscrowDepositRoute plus, when quoted, a second
//   EIP-3009 for the Exchange buyer fee as payload.feeAuthorization; relayer settles,
//   job funded) -> deliver (seed worker submits) -> reference evaluator verdict -> finalize (payout) -> poll until Settled.
// Usage: AGENTCOIN_PAYER_KEY_FILE=<file> node scripts/exchange-e2e.mjs http://127.0.0.1:<port> [skillId]
// Loopback only. The key is read from the file and never printed. Prints order + tx hashes as JSON lines.
import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { getAddress, toHex, keccak256, toBytes, zeroAddress } from "viem";
import { jcs } from "../lib/canonical.mjs";
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
log("list", { listingId: listing.listing_id, buyer: payer.address });
const input = { digest: "0x" + createHash("sha256").update(`agentkoin-orderintent-e2e ${Date.now()}`).digest("hex"), note: "order intent e2e (testnet)" };
const post = (b) => fetch(`${base}/exchange/v1/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const check = (name, ok, extra = {}) => { log(name, { ok, ...extra }); if (!ok) { console.error("FAILED:", name); process.exit(1); } };
const domain = { name: "AgentKoin Exchange", version: "1", chainId: CHAIN_ID };
const types = { OrderIntent: [{ name: "buyer", type: "address" }, { name: "listingId", type: "string" }, { name: "skillId", type: "string" }, { name: "inputHash", type: "bytes32" }, { name: "evaluator", type: "address" }, { name: "expiresAt", type: "uint256" }, { name: "nonce", type: "uint256" }] };
const intent = async (who, o = {}) => {
  const expiresAt = String(Math.floor(Date.now() / 1000) + 600), nonce = BigInt("0x" + randomBytes(8).toString("hex")).toString();
  const message = { buyer: who.address, listingId: listing.listing_id, skillId, inputHash: keccak256(toBytes(jcs(o.input ?? input))), evaluator: zeroAddress, expiresAt: BigInt(expiresAt), nonce: BigInt(nonce) };
  const signature = await who.signTypedData({ domain, types, primaryType: "OrderIntent", message });
  return { expiresAt, nonce, signature };
};
const base0 = { listing_id: listing.listing_id, skill_id: skillId, buyer: payer.address, input };

// 1. unsigned: accepted this release, marked deprecated, typed data included
const u = await post(base0);
check("unsigned-deprecated", u.status === 201 && u.body.deprecated?.code === "unsigned_order_deprecated" && u.body.deprecated.orderIntent.eip712.primaryType === "OrderIntent" && u.body.agentVerification.badge === null, { orderId: u.body?.order_id });
// 2. wrong signer
const other = privateKeyToAccount("0x" + randomBytes(32).toString("hex"));
const wrong = await post({ ...base0, ...(await intent(other)) });
check("wrong-signer-403", wrong.status === 403, { status: wrong.status });
// 3. signed
const sg = await intent(payer);
const s = await post({ ...base0, ...sg });
check("signed-order", s.status === 201 && s.body.agentVerification?.orderIntent === "verified" && s.body.agentVerification.signer === payer.address && !s.body.deprecated, { orderId: s.body?.order_id, badge: s.body?.agentVerification?.badge });
// 4. replay
const rp = await post({ ...base0, ...sg });
check("replay-409", rp.status === 409, { status: rp.status });
// 5. input changed after signing
const tamper = await post({ ...base0, input: { ...input, note: "tampered" }, ...(await intent(payer)) });
check("tampered-input-403", tamper.status === 403, { status: tamper.status });
// 6. ERC-8004 id with a key that is not the owner or agentWallet: no badge, no rejection (real registry read on Base Sepolia)
const e1 = await post({ ...base0, ...(await intent(payer)), erc8004_id: process.env.E2E_ERC8004_ID ?? "10494" });
check("erc8004-not-linked-no-badge", e1.status === 201 && e1.body.agentVerification.erc8004?.linked === false && e1.body.agentVerification.badge === null, { basis: e1.body?.agentVerification?.erc8004?.basis, owner: e1.body?.agentVerification?.erc8004?.owner });

// 7. pay the signed order with x402 (EIP-3009 to the offer-bound route; fee leg when quoted), then follow it to Settled
const orderId = s.body.order_id;
const r1 = await fetch(`${base}/exchange/v1/orders/${orderId}/pay`, { method: "POST" });
if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status} ${await r1.text()}`);
const pr = await r1.json();
const req = pr.accepts.find((a) => a.scheme === "exact" && a.network === `eip155:${CHAIN_ID}`);
const now = (await publicClient.getBlock()).timestamp;
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
const pp = { x402Version: 2, resource: pr.resource, accepted: req, payload: { ...(await auth3009(req)), ...(feeReq ? { feeAuthorization: await auth3009(feeReq) } : {}) } };
const r2 = await j(await fetch(`${base}/exchange/v1/orders/${orderId}/pay`, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(pp)).toString("base64") }, body: "{}" }));
if (r2.status !== 200 && r2.status !== 201) throw new Error(`pay failed ${r2.status} ${JSON.stringify(r2.body)}`);
const order = { order_id: orderId, ...(r2.body.order ?? r2.body) };
log("funded", { status: r2.status, orderId, jobId: order.job_id, txs: order.txs });
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
