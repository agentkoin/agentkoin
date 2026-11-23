#!/usr/bin/env node
// LOCAL x402 prototype (binds 127.0.0.1 only). x402 v2 message shapes. accepts[] lists two schemes:
//  1. "exact" (standard, EVM, assetTransferMethod eip3009): payTo is a per-offer EscrowDepositRoute (CREATE2).
//     The buyer signs a TransferWithAuthorization to payTo; the mock facilitator verifies the EIP-712 signature
//     and settles via EscrowDepositRouteFactory.settle, which pulls the funds and opens an escrow job with
//     client = payer. Funds are held in escrow (not paid to the provider) until the evaluator verdict.
//  2. "agentcoin-escrow" (non-standard alternative): the buyer funds an escrow job itself and sends {jobId, txHash}.
// The facilitator is in-process (mock: not a hosted x402 facilitator). AGENTCOIN_NETWORK=local: Anvil.
// AGENTCOIN_NETWORK=base-sepolia: settles on Base Sepolia TESTNET with Circle test USDC; the relayer is the
// provider's throwaway testnet key (the payer pays no gas). The HTTP server binds 127.0.0.1 only (not hosted).
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { keccak256, toBytes, getAddress, verifyTypedData, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { contracts, wallet, send, read, publicClient, assertChain } from "../lib/chain.mjs";
import { ANVIL_KEYS, AGENT_DIR, ROOT, CHAIN_ID, STATES, PUBLIC_BASE_URL, TOKEN_EIP712, ABI, ARTIFACTS_DIR, NETWORK, roleKey } from "../lib/config.mjs";
import { quote, evaluatorSnapshot, jobStatus } from "../lib/protocol.mjs";
import { evaluatorReputation } from "../lib/indexer.mjs";
import { verifyDocument } from "../lib/verify.mjs";
import { jcs } from "../lib/canonical.mjs";
import { URLS } from "../lib/artifacts.mjs";

const PORT = Number(process.env.X402_PORT ?? new URL(PUBLIC_BASE_URL).port ?? 4020);
const PRICE = BigInt(process.env.DEMO_PRICE ?? (NETWORK === "local" ? "2000000" : "1000000")); // local 2 USDC; testnet 1 test USDC. No provider bond -> evaluator path
const DEADLINE_SECONDS = Number(process.env.DEMO_DEADLINE_SECONDS ?? 3600);
const PROVIDER_KEY = process.env.AGENTCOIN_PROVIDER_KEY ?? roleKey("provider");
const EVALUATOR = getAddress(process.env.AGENTCOIN_EVALUATOR ?? privateKeyToAccount(roleKey("evaluator")).address);
const provider = wallet(PROVIDER_KEY);
// Mock facilitator relayer (pays gas for settle). local: Anvil dev key. base-sepolia: provider testnet key.
const facilitator = wallet(process.env.AGENTCOIN_FACILITATOR_KEY ?? (NETWORK === "local" ? ANVIL_KEYS.deployer : roleKey("facilitator")));
const SPEC_TEXT = "agentcoin-demo-resource/v1: JSON object with fields resource, jobId, payload";
const SPEC_HASH = keccak256(toBytes(SPEC_TEXT));
const usedJobs = new Set();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const artifact = (f) => JSON.parse(readFileSync(path.join(ARTIFACTS_DIR, f), "utf8"));

export const offer = () => ({ provider: provider.account.address, evaluator: EVALUATOR, amount: PRICE, deadlineSeconds: BigInt(DEADLINE_SECONDS), specHash: SPEC_HASH });
const offerJson = (o) => ({ provider: o.provider, evaluator: o.evaluator, amount: o.amount.toString(), deadlineSeconds: Number(o.deadlineSeconds), specHash: o.specHash });

async function exactRequirements() {
  const c = contracts();
  const o = offer();
  const [payTo, cfg, ev, q] = await Promise.all([
    read(c.routeFactory, "routeFor", [o]),
    read(c.escrow, "currentConfig"),
    evaluatorSnapshot(c, EVALUATOR),
    read(c.escrow, "quote", [PRICE, 0n]),
  ]);
  return {
    scheme: "exact",
    network: `eip155:${CHAIN_ID}`,
    amount: PRICE.toString(),
    asset: c.usdc.address,
    payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: TOKEN_EIP712.name,
      version: TOKEN_EIP712.version,
      assetTransferMethod: "eip3009",
      agentcoin: {
        payToKind: "EscrowDepositRoute (CREATE2, offer-bound); settle opens an escrow job with client = authorization.from",
        depositRouteFactory: c.routeFactory.address,
        escrowContract: c.escrow.address,
        offer: offerJson(o),
        evaluatorStake: ev.stake,
        evaluatorActive: ev.active,
        feeBps: Number(cfg.feeBps),
        evaluatorFeeBps: Number(cfg.evaluatorFeeBps),
        challengeBond: q[3].toString(),
        arbitrationFee: q[4].toString(),
        configVersion: Number(q[6]),
        spec: SPEC_TEXT,
        trustManifestUrl: URLS.trustManifest,
      },
    },
  };
}

async function escrowRequirements() {
  const c = contracts();
  const [cfg, ev] = await Promise.all([read(c.escrow, "currentConfig"), evaluatorSnapshot(c, EVALUATOR)]);
  const q = await read(c.escrow, "quote", [PRICE, 0n]);
  return {
    scheme: "agentcoin-escrow",
    network: `eip155:${CHAIN_ID}`,
    amount: PRICE.toString(),
    asset: c.usdc.address,
    payTo: provider.account.address,
    maxTimeoutSeconds: 300,
    extra: {
      price: PRICE.toString(),
      unit: "USDC base units (6 decimals)",
      escrowContract: c.escrow.address,
      evaluator: EVALUATOR,
      evaluatorStake: ev.stake,
      evaluatorActive: ev.active,
      instantThreshold: cfg.instantThreshold.toString(),
      feeBps: Number(cfg.feeBps),
      evaluatorFeeBps: Number(cfg.evaluatorFeeBps),
      challengeBond: q[3].toString(),
      arbitrationFee: q[4].toString(),
      configVersion: Number(q[6]),
      specHash: SPEC_HASH,
      spec: SPEC_TEXT,
      deadlineSeconds: DEADLINE_SECONDS,
      trustManifestUrl: URLS.trustManifest,
      schemeSpec: "payment = escrowContract.createAndFund(provider=payTo, evaluator, amount>=price, deadline, specHash); PAYMENT-SIGNATURE payload = {jobId, txHash}",
    },
  };
}

const resourceInfo = () => ({
  url: URLS.demoResource,
  description: "Demo JSON resource paid through AgentCoin escrow; delivery hash is submitted on chain for evaluator verdict.",
  mimeType: "application/json",
  serviceName: `AgentCoin demo (${NETWORK}, served from 127.0.0.1)`,
  tags: ["escrow", "evaluator", "usdc", NETWORK === "local" ? "local" : "testnet"],
});

function bazaar() {
  return {
    info: {
      input: { type: "http", method: "GET" },
      output: { type: "json", example: { resource: "agentcoin-demo", jobId: "1", payload: { n: 1 }, deliverableHash: "0x" + "00".repeat(32) } },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: { type: "object", properties: { type: { const: "http" }, method: { enum: ["GET"] }, headers: { type: "object", additionalProperties: { type: "string" } } }, required: ["type", "method"], additionalProperties: false },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
      },
      required: ["input"],
    },
  };
}

async function paymentRequired(error) {
  return { x402Version: 2, error, resource: resourceInfo(), accepts: await paymentRequirements(), extensions: { bazaar: bazaar() } };
}

async function paymentRequirements() {
  return [await exactRequirements(), await escrowRequirements()];
}

// ---------------- mock facilitator (in-process, local chain only) ----------------
export const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/**
 * Chain-independent part of x402 `exact` (EVM, eip3009) verification: payload shape, recipient, value,
 * validity window against `now`, EIP-712 signature. Returns { ok, reason, msg }.
 */
export async function checkExactAuthorization(paymentPayload, requirements, now) {
  const fail = (reason, msg) => ({ ok: false, reason, msg });
  if (paymentPayload?.x402Version !== 2) return fail("unsupported x402Version");
  const acc = paymentPayload.accepted ?? {};
  if (acc.scheme !== "exact" || acc.network !== requirements.network) return fail("invalid_scheme_or_network");
  const Z = "0x0000000000000000000000000000000000000000";
  if (getAddress(acc.payTo ?? Z) !== getAddress(requirements.payTo) || getAddress(acc.asset ?? Z) !== getAddress(requirements.asset)) return fail("accepted payTo/asset != requirements");
  const { signature, authorization: au } = paymentPayload.payload ?? {};
  if (!signature || !au) return fail("payload.signature and payload.authorization required");
  let msg;
  try {
    msg = { from: getAddress(au.from), to: getAddress(au.to), value: BigInt(au.value), validAfter: BigInt(au.validAfter), validBefore: BigInt(au.validBefore), nonce: au.nonce };
  } catch {
    return fail("malformed authorization");
  }
  if (msg.to !== getAddress(requirements.payTo)) return fail("invalid_exact_evm_payload_recipient_mismatch", msg);
  if (msg.value !== BigInt(requirements.amount)) return fail("invalid_exact_evm_payload_authorization_value", msg);
  if (msg.validBefore < BigInt(now) + 6n) return fail("invalid_exact_evm_payload_authorization_valid_before", msg);
  if (msg.validAfter > BigInt(now)) return fail("invalid_exact_evm_payload_authorization_valid_after", msg);
  const domain = { name: requirements.extra.name, version: requirements.extra.version, chainId: CHAIN_ID, verifyingContract: getAddress(requirements.asset) };
  const ok = await verifyTypedData({ address: msg.from, domain, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message: msg, signature }).catch(() => false);
  if (!ok) return fail("invalid_exact_evm_payload_signature", msg);
  return { ok: true, msg };
}

/** Full verify: the checks above plus nonce unused and payer balance on the local chain. */
export async function verifyExact(paymentPayload, requirements) {
  const c = contracts();
  const now = (await publicClient.getBlock()).timestamp;
  const r = await checkExactAuthorization(paymentPayload, requirements, now);
  if (!r.ok) return { isValid: false, invalidReason: r.reason, payer: r.msg?.from };
  const { msg } = r;
  if (await read(c.usdc, "authorizationState", [msg.from, msg.nonce])) return { isValid: false, invalidReason: "authorization nonce already used", payer: msg.from };
  if ((await read(c.usdc, "balanceOf", [msg.from])) < msg.value) return { isValid: false, invalidReason: "insufficient_funds", payer: msg.from };
  return { isValid: true, payer: msg.from };
}

/** x402 `exact` settle: EscrowDepositRouteFactory.settle -> transferWithAuthorization to the route + escrow job. */
export async function settleExact(paymentPayload, requirements) {
  const c = contracts();
  const au = paymentPayload.payload.authorization;
  const o = offer();
  const { hash, receipt } = await send(facilitator, c.routeFactory, "settle", [o, getAddress(au.from), BigInt(au.value), BigInt(au.validAfter), BigInt(au.validBefore), au.nonce, paymentPayload.payload.signature]);
  const created = parseEventLogs({ abi: ABI.escrow, logs: receipt.logs, eventName: "JobCreated" })[0];
  if (!created) return { success: false, errorReason: "settle produced no escrow job", transaction: hash, network: requirements.network, payer: au.from };
  return { success: true, transaction: hash, network: requirements.network, payer: getAddress(au.from), jobId: created.args.jobId };
}

export async function facilitatorVerify(paymentPayload, requirements) {
  const c = contracts();
  const fail = (invalidReason) => ({ isValid: false, invalidReason });
  if (paymentPayload?.x402Version !== 2) return fail("unsupported x402Version");
  if (paymentPayload.accepted?.scheme !== "agentcoin-escrow" || paymentPayload.accepted?.network !== requirements.network) return fail("scheme/network mismatch");
  const { jobId, txHash } = paymentPayload.payload ?? {};
  if (!jobId || !txHash) return fail("payload.jobId and payload.txHash required");
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt || receipt.status !== "success" || receipt.to?.toLowerCase() !== c.escrow.address.toLowerCase()) return fail("txHash is not a successful escrow tx");
  const j = await read(c.escrow, "getJob", [BigInt(jobId)]).catch(() => null);
  if (!j) return fail("job not found");
  if (STATES[j.state] !== "Funded") return fail(`job state ${STATES[j.state]} != Funded`);
  if (getAddress(j.provider) !== getAddress(requirements.payTo)) return fail("job provider != payTo");
  if (getAddress(j.evaluator) !== getAddress(requirements.extra.evaluator)) return fail("job evaluator mismatch");
  if (j.amount < BigInt(requirements.amount)) return fail("job amount < price");
  if (j.specHash !== requirements.extra.specHash) return fail("specHash mismatch");
  if (usedJobs.has(String(jobId))) return fail("job already redeemed");
  return { isValid: true, payer: j.client };
}

// ---------------- A2A HTTP+JSON (message:send with a data part {skill, input}) ----------------
const SKILLS = {
  quote: (i) => quote(i),
  get_job_status: (i) => jobStatus(i.jobId),
  get_evaluator_reputation: (i) => evaluatorReputation(i.evaluator),
  verify_attestation: (i) => verifyDocument(typeof i.document === "string" ? JSON.parse(i.document) : i.document, { expectedSigner: i.expectedSigner }),
};

async function readBody(req) {
  let b = "";
  for await (const ch of req) b += ch;
  return b ? JSON.parse(b) : {};
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

const STATIC = {
  "/.well-known/agent-registration.json": () => artifact("agent-registration.json"),
  "/.well-known/agent-registration.sig.json": () => artifact("agent-registration.sig.json"),
  "/.well-known/agent-card.json": () => artifact("agent-card.json"),
  "/.well-known/jwks.json": () => artifact("jwks.json"),
  "/.well-known/agentcoin-trust.json": () => artifact("trust-manifest.json"),
  "/schemas/trust-manifest-0.1.json": () => JSON.parse(readFileSync(path.join(AGENT_DIR, "schemas", "trust-manifest-0.1.json"), "utf8")),
  "/docs/interface.json": () => JSON.parse(readFileSync(path.join(ROOT, "docs", "interface.json"), "utf8")),
};

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, PUBLIC_BASE_URL);
      if (req.method === "GET" && STATIC[url.pathname]) return json(res, 200, STATIC[url.pathname]());

      if (req.method === "GET" && url.pathname === "/v1/quote") {
        const amount = url.searchParams.get("amount");
        if (!amount || !/^[0-9]+$/.test(amount)) return json(res, 400, { error: "amount (USDC 6-decimal integer string) required" });
        const q = await quote({ amount, providerBond: url.searchParams.get("providerBond") ?? "0", evaluator: url.searchParams.get("evaluator") ?? EVALUATOR });
        return json(res, 200, { ...q, trustManifestUrl: URLS.trustManifest });
      }

      if (req.method === "GET" && url.pathname === "/discovery/resources") {
        const pr = await paymentRequired();
        return json(res, 200, {
          x402Version: 2,
          items: [{ resource: URLS.demoResource, type: "http", x402Version: 2, accepts: pr.accepts, lastUpdated: new Date().toISOString(), extensions: pr.extensions }],
          pagination: { limit: 10, offset: 0, total: 1 },
        });
      }

      if (req.method === "GET" && url.pathname === "/facilitator/supported") {
        return json(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: `eip155:${CHAIN_ID}`, extra: { assetTransferMethod: "eip3009" } }, { x402Version: 2, scheme: "agentcoin-escrow", network: `eip155:${CHAIN_ID}` }], extensions: ["bazaar"], note: `mock in-process facilitator for ${NETWORK} (chainId ${CHAIN_ID}); not a hosted facilitator` });
      }

      if (req.method === "GET" && url.pathname === "/v1/demo/resource") {
        const header = req.headers["payment-signature"];
        if (!header) {
          const pr = await paymentRequired("PAYMENT-SIGNATURE header is required");
          return json(res, 402, pr, { "PAYMENT-REQUIRED": b64(pr) });
        }
        let payload;
        try { payload = unb64(header); } catch { return json(res, 400, { error: "PAYMENT-SIGNATURE is not base64 JSON" }); }
        const all = await paymentRequirements();
        const scheme = payload?.accepted?.scheme;
        const reqs = all.find((r) => r.scheme === scheme);
        const reject = async (reason) => {
          const pr = await paymentRequired(reason);
          return json(res, 402, pr, { "PAYMENT-REQUIRED": b64(pr) });
        };
        if (!reqs) return reject(`unsupported scheme ${scheme}`);
        const c = contracts();
        let jobId, settle;
        if (scheme === "exact") {
          // verify -> settle (opens the escrow job; the deliverable references its jobId) -> resource -> submit
          const v = await verifyExact(payload, reqs);
          if (!v.isValid) return reject(v.invalidReason);
          const st = await settleExact(payload, reqs).catch((e) => ({ success: false, errorReason: `settle failed: ${e.shortMessage ?? e.message}` }));
          if (!st.success) return reject(st.errorReason);
          jobId = st.jobId;
          settle = { success: true, transaction: st.transaction, network: st.network, payer: st.payer, amount: reqs.amount };
        } else {
          const v = await facilitatorVerify(payload, reqs);
          if (!v.isValid) return reject(v.invalidReason);
          usedJobs.add(String(payload.payload.jobId));
          jobId = BigInt(payload.payload.jobId);
          settle = { success: true, transaction: payload.payload.txHash, network: `eip155:${CHAIN_ID}`, payer: v.payer, amount: reqs.amount };
        }
        // Deliver, then submit the deliverable hash on chain as provider.
        const content = { resource: "agentcoin-demo", jobId: String(jobId), payload: { n: Number(jobId), servedAt: new Date().toISOString() } };
        const deliverableHash = keccak256(toBytes(jcs(content)));
        const sub = await send(provider, c.escrow, "submit", [jobId, deliverableHash]);
        settle.extensions = { agentcoin: { scheme, jobId: String(jobId), escrowContract: c.escrow.address, submitTx: sub.hash, deliverableHash, note: "funds held in escrow until evaluator verdict + challenge window" } };
        return json(res, 200, { ...content, deliverableHash }, { "PAYMENT-RESPONSE": b64(settle) });
      }

      if (req.method === "POST" && url.pathname === "/a2a/v1/message:send") {
        const body = await readBody(req);
        const part = body?.message?.parts?.find((p) => p.data !== undefined);
        const skill = part?.data?.skill;
        if (!SKILLS[skill]) return json(res, 400, { error: `data part {skill, input} required; skills: ${Object.keys(SKILLS).join(",")} (open_job via MCP only)` });
        const out = await SKILLS[skill](part.data.input ?? {});
        return json(res, 200, { message: { messageId: crypto.randomUUID(), contextId: body.message.contextId ?? crypto.randomUUID(), role: "ROLE_AGENT", parts: [{ data: out, mediaType: "application/json" }] } }, { "content-type": "application/a2a+json" });
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: e.shortMessage ?? e.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await assertChain();
  createServer().listen(PORT, "127.0.0.1", () => console.log(JSON.stringify({ listening: `http://127.0.0.1:${PORT}`, price: PRICE.toString(), provider: provider.account.address, evaluator: EVALUATOR })));
}
