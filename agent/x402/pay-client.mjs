#!/usr/bin/env node
// x402 v2 client for the AgentCoin resource server (scheme "exact", EVM, eip3009).
//   1. GET the resource -> 402 + PAYMENT-REQUIRED (base64 JSON) with accepts[].
//   2. Pick accepts[scheme=exact]; check network == this client's chain, payTo == factory.routeFor(extra.agentcoin.offer)
//      on chain (offer-bound escrow route, not an arbitrary address), amount <= MAX_PAY.
//   3. Sign EIP-3009 TransferWithAuthorization(from=payer, to=payTo, value=amount) under the token's EIP-712 domain.
//   4. GET again with PAYMENT-SIGNATURE; print the resource and the decoded PAYMENT-RESPONSE (settle tx, jobId).
// Usage: AGENTCOIN_NETWORK=base-sepolia node x402/pay-client.mjs [url]   (default http://127.0.0.1:4020/v1/demo/resource)
// Payer key: AGENTCOIN_PAYER_KEY, else the network's "client" role key (local: Anvil dev key; base-sepolia: .secrets
// throwaway testnet key). The key is never printed. Only loopback URLs unless PAY_ALLOW_REMOTE=1.
import { getAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { CHAIN_ID, roleKey, isLoopback } from "../lib/config.mjs";
import { contracts, read, publicClient } from "../lib/chain.mjs";
import { swapStructFromEntry, quoteHash, resolveAsset, SETTLER_ABI, RECEIVE_AUTH_TYPES } from "../lib/multiasset.mjs";
import { selectPayableExact } from "./select.mjs";
import { ABI } from "../lib/config.mjs";
import { parseAbi } from "viem";

const ERC20_BAL = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const AGC_VIEWS = parseAbi(["function USDC() view returns (address)"]);
const FACTORY_VIEWS = parseAbi(["function token() view returns (address)", "function escrow() view returns (address)"]);

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
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
/** Build the x402 v2 payment payload, echoing resource and extensions verbatim from the 402 challenge. */
export function echoPaymentPayload(pr, accepted, authorization, signature) {
  return { x402Version: 2, resource: pr.resource, accepted, payload: { signature, authorization }, ...(pr.extensions ? { extensions: pr.extensions } : {}) };
}

export async function payExact(url, { maxPay = BigInt(process.env.MAX_PAY ?? "1000000"), log = () => {}, method = "GET", body = undefined, allowRemote = process.env.PAY_ALLOW_REMOTE === "1" } = {}) {
  if (!allowRemote && !isLoopback(url)) throw new Error(`refusing non-loopback resource URL ${url} (set PAY_ALLOW_REMOTE=1 to pay a remote testnet resource)`);
  const payer = privateKeyToAccount(process.env.AGENTCOIN_PAYER_KEY ?? roleKey("client"));
  const init = (headers = {}) => ({ method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  const r1 = await fetch(url, init());
  if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`);
  const pr = unb64(r1.headers.get("payment-required"));
  if (!pr.accepts.some((a) => a.scheme === "exact")) throw new Error("no exact scheme offered");
  const c = contracts();
  // AD-010: pick the first exact entry (server order) whose asset the payer holds enough of: USDC, or AGC backed by it
  const sel = await selectPayableExact(pr.accepts, (asset) => read({ address: asset, abi: ERC20_BAL }, "balanceOf", [payer.address]), { network: `eip155:${CHAIN_ID}` });
  if (!sel.entry) throw new Error(`${sel.reason} (balances ${JSON.stringify(sel.balances, (_, v) => (typeof v === "bigint" ? v.toString() : v))})`);
  const req = sel.entry;
  if (BigInt(req.amount) > maxPay) throw new Error(`amount ${req.amount} > MAX_PAY ${maxPay}`);
  const ag = req.extra.agentcoin;
  const isUsdc = getAddress(req.asset) === getAddress(c.usdc.address);
  if (isUsdc && getAddress(ag.depositRouteFactory) !== getAddress(c.routeFactory.address)) throw new Error("factory != deployment factory");
  if (!isUsdc) {
    // AGC: the token must wrap this deployment's USDC, and the factory must be bound to that token and the named escrow
    if (getAddress(await read({ address: req.asset, abi: AGC_VIEWS }, "USDC")) !== getAddress(c.usdc.address)) throw new Error("asset is neither the deployment token nor AGC over it");
    const fv = { address: getAddress(ag.depositRouteFactory), abi: FACTORY_VIEWS };
    if (getAddress(await read(fv, "token")) !== getAddress(req.asset) || getAddress(await read(fv, "escrow")) !== getAddress(ag.escrowContract)) throw new Error("factory not bound to asset/escrow");
  }
  const factory = { address: getAddress(ag.depositRouteFactory), abi: ABI.routeFactory };
  const o = { ...ag.offer, amount: BigInt(ag.offer.amount), deadlineSeconds: BigInt(ag.offer.deadlineSeconds) };
  const route = await read(factory, "routeFor", [o]);
  if (getAddress(route) !== getAddress(req.payTo)) throw new Error(`payTo ${req.payTo} != routeFor(offer) ${route}`);
  if (BigInt(ag.offer.amount) !== BigInt(req.amount)) throw new Error("offer amount != requirement amount");
  log({ step: "402", payTo: req.payTo, amount: req.amount, asset: req.asset, acceptIndex: sel.index, offer: ag.offer, evaluatorActive: ag.evaluatorActive });
  const now = (await publicClient.getBlock()).timestamp;
  const authorization = { from: payer.address, to: getAddress(req.payTo), value: req.amount, validAfter: String(now - 60n), validBefore: String(now + BigInt(req.maxTimeoutSeconds)), nonce: toHex(randomBytes(32)) };
  const signature = await payer.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: CHAIN_ID, verifyingContract: getAddress(req.asset) },
    types: AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  // x402 v2: echo resource and extensions verbatim so facilitators (e.g. PayAI Bazaar) can catalog the declaration.
  const payload = echoPaymentPayload(pr, req, authorization, signature);
  const r2 = await fetch(url, init({ "PAYMENT-SIGNATURE": b64(payload) }));
  const out = await r2.json();
  const resp = r2.headers.get("payment-response");
  if (r2.status !== 200) throw new Error(`payment rejected (${r2.status}): ${out.error ? out.error + (out.detail ? `: ${out.detail}` : "") : JSON.stringify(out).slice(0, 300)}`);
  return { status: r2.status, payer: payer.address, asset: getAddress(req.asset), authorizationNonce: authorization.nonce, resource: out, paymentResponse: resp ? unb64(resp) : null };
}

/**
 * agentcoin-swap (AD-009): pay in EURC, seller receives USDC. Reads the full entry from the 402 JSON body, checks the
 * settler's router and quoteHash on chain, signs EIP-3009 ReceiveWithAuthorization(nonce = quoteHash), POSTs it.
 */
export async function paySwap(url, { maxPay = BigInt(process.env.MAX_PAY ?? "1000000"), log = () => {}, method = "POST", body = undefined, allowRemote = process.env.PAY_ALLOW_REMOTE === "1" } = {}) {
  if (!allowRemote && !isLoopback(url)) throw new Error(`refusing non-loopback resource URL ${url} (set PAY_ALLOW_REMOTE=1 to pay a remote testnet resource)`);
  const payer = privateKeyToAccount(process.env.AGENTCOIN_PAYER_KEY ?? roleKey("client"));
  const init = (headers = {}) => ({ method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  const r1 = await fetch(url, init());
  if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`);
  const pr = await r1.json(); // full challenge (the header copy of agentcoin-swap is partial)
  const req = pr.accepts.find((a) => a.scheme === "agentcoin-swap");
  if (!req) throw new Error("no agentcoin-swap scheme offered");
  if (req.network !== `eip155:${CHAIN_ID}`) throw new Error(`network ${req.network} != eip155:${CHAIN_ID}`);
  if (BigInt(req.amount) > maxPay) throw new Error(`amount ${req.amount} > MAX_PAY ${maxPay}`);
  const tin = resolveAsset(req.asset);
  if (!tin) throw new Error(`unknown asset ${req.asset}`);
  const settler = { address: getAddress(req.payTo), abi: SETTLER_ABI };
  const router = getAddress(await read(settler, "router"));
  if (router !== getAddress(req.extra.settlement.router)) throw new Error(`settler router ${router} != advertised ${req.extra.settlement.router}`);
  const struct = swapStructFromEntry(req, payer.address);
  const nonce = quoteHash(struct, { chainId: CHAIN_ID, settler: settler.address, router });
  const onchain = await read(settler, "quoteHash", [struct]);
  if (onchain !== nonce) throw new Error(`quoteHash mismatch: local ${nonce} != settler ${onchain}`);
  log({ step: "402", scheme: req.scheme, payTo: req.payTo, amount: req.amount, asset: tin.symbol, minOut: req.extra.quote.minOut, tokenOut: req.extra.quote.tokenOutSymbol, expiresAt: req.extra.quote.expiresAt, quoteId: req.extra.quote.quoteId });
  const now = (await publicClient.getBlock()).timestamp;
  const authorization = { from: payer.address, to: settler.address, value: req.amount, validAfter: "0", validBefore: String(now + BigInt(req.maxTimeoutSeconds)), nonce };
  const signature = await payer.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: CHAIN_ID, verifyingContract: tin.address },
    types: RECEIVE_AUTH_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  });
  const payload = { x402Version: 2, resource: pr.resource, accepted: { scheme: req.scheme, network: req.network }, payload: { quoteId: req.extra.quote.quoteId, authorization, signature } };
  const r2 = await fetch(url, init({ "PAYMENT-SIGNATURE": b64(payload) }));
  const out = await r2.json();
  const resp = r2.headers.get("payment-response");
  if (r2.status !== 200) throw new Error(`payment rejected (${r2.status}): ${out.error ?? JSON.stringify(out).slice(0, 300)}`);
  return { status: r2.status, payer: payer.address, quoteHash: nonce, resource: out, paymentResponse: resp ? unb64(resp) : null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // node x402/pay-client.mjs [url] [jsonBody]  (a jsonBody switches to POST, e.g. '{"sha256":"0x…"}' for /v1/notarize)
  const url = process.argv[2] ?? "http://127.0.0.1:4020/v1/demo/resource";
  const body = process.argv[3];
  const pay = process.env.PAY_SCHEME === "agentcoin-swap" ? paySwap : payExact; // PAY_SCHEME=agentcoin-swap: pay in EURC
  const out = await pay(url, { log: (x) => console.error(JSON.stringify(x)), ...(body ? { method: "POST", body } : {}) });
  console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}
