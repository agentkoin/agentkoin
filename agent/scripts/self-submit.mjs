#!/usr/bin/env node
// AD-011 Fix 2: pay the AgentCoin notary WITHOUT the service's relayer. The payer submits the on-chain settle itself
// (pays its own gas), then presents {jobId, txHash} under the agentcoin-escrow scheme. Same escrow job, same result.
//   1. GET <url>[?evaluator=<address>] -> 402; take the USDC `exact` entry (payTo = EscrowDepositRoute for the offer).
//   2. Check payTo == routeFactory.routeFor(offer) on chain (the offer names provider, evaluator, amount, spec).
//   3. Sign EIP-3009 TransferWithAuthorization(from = payer, to = payTo, value = amount).
//   4. The payer itself calls routeFactory.settle(offer, from, value, validAfter, validBefore, nonce, signature).
//   5. POST <url> with PAYMENT-SIGNATURE {scheme: "agentcoin-escrow", payload: {jobId, txHash}} -> notary receipt.
// Usage: AGENTCOIN_PAYER_KEY_FILE=<file> node scripts/self-submit.mjs <url> [evaluator]   (key never printed)
// Loopback URLs only unless PAY_ALLOW_REMOTE=1. Needs test USDC (amount) and a little test ETH (gas) in the payer wallet.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getAddress, toHex, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, ABI, TOKEN_EIP712, isLoopback } from "../lib/config.mjs";
import { contracts, read, send, wallet, publicClient } from "../lib/chain.mjs";

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export async function selfSubmitExact(url, { payerKey, evaluator = null, body = { sha256: "0x" + "00".repeat(32) }, allowRemote = process.env.PAY_ALLOW_REMOTE === "1" } = {}) {
  if (!allowRemote && !isLoopback(url)) throw new Error(`refusing non-loopback URL ${url} (PAY_ALLOW_REMOTE=1 for a remote testnet resource)`);
  const u = new URL(url);
  if (evaluator) u.searchParams.set("evaluator", evaluator);
  const c = contracts();
  const payer = privateKeyToAccount(payerKey);
  const r1 = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`);
  const pr = await r1.json();
  const req = pr.accepts.find((a) => a.scheme === "exact" && a.network === `eip155:${CHAIN_ID}` && getAddress(a.asset) === getAddress(c.usdc.address));
  if (!req) throw new Error("no USDC exact entry");
  const o = req.extra.agentcoin.offer;
  const offer = { provider: getAddress(o.provider), evaluator: getAddress(o.evaluator), amount: BigInt(o.amount), deadlineSeconds: BigInt(o.deadlineSeconds), specHash: o.specHash };
  if (getAddress(req.extra.agentcoin.depositRouteFactory) !== getAddress(c.routeFactory.address)) throw new Error("factory != deployment factory");
  const route = await read(c.routeFactory, "routeFor", [offer]);
  if (getAddress(route) !== getAddress(req.payTo)) throw new Error("payTo is not routeFor(offer)");
  if (evaluator && offer.evaluator !== getAddress(evaluator)) throw new Error("offer evaluator differs from the chosen one");
  const now = Number((await publicClient.getBlock()).timestamp); // chain time (validBefore is checked on chain)
  const msg = { from: payer.address, to: getAddress(req.payTo), value: BigInt(req.amount), validAfter: 0n, validBefore: BigInt(now + 600), nonce: toHex(randomBytes(32)) };
  const signature = await payer.signTypedData({ domain: { name: req.extra.name ?? TOKEN_EIP712.name, version: req.extra.version ?? TOKEN_EIP712.version, chainId: CHAIN_ID, verifyingContract: getAddress(req.asset) }, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message: msg });
  // the payer's own transaction: no relayer
  const { hash, receipt } = await send(wallet(payerKey), c.routeFactory, "settle", [offer, msg.from, msg.value, msg.validAfter, msg.validBefore, msg.nonce, signature]);
  const created = parseEventLogs({ abi: ABI.escrow, logs: receipt.logs, eventName: "JobCreated" })[0];
  if (!created) throw new Error(`settle produced no escrow job (${hash})`);
  const jobId = created.args.jobId.toString();
  const pp = { x402Version: 2, resource: pr.resource, accepted: { scheme: "agentcoin-escrow", network: `eip155:${CHAIN_ID}` }, payload: { jobId, txHash: hash } };
  const r2 = await fetch(u, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(pp)).toString("base64") }, body: JSON.stringify(body) });
  const out = await r2.json();
  return { status: r2.status, jobId, settleTx: hash, settledBy: payer.address, evaluator: offer.evaluator, response: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.env.AGENTCOIN_PAYER_KEY_FILE;
  if (!file || !process.argv[2]) {
    console.error("usage: AGENTCOIN_PAYER_KEY_FILE=<file> node scripts/self-submit.mjs <url> [evaluator]");
    process.exit(2);
  }
  const r = await selfSubmitExact(process.argv[2], { payerKey: readFileSync(file, "utf8").trim(), evaluator: process.argv[3] ?? null });
  console.log(JSON.stringify({ status: r.status, jobId: r.jobId, settleTx: r.settleTx, settledBy: r.settledBy, evaluator: r.evaluator, receiptStatus: r.response?.status ?? null }, null, 2));
}
