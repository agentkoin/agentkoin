// Dexter x402 facilitator client (https://x402.dexter.cash).
// Public, no account or API key to start; Dexter publishes a $0 facilitator fee.
// Base Sepolia: v2 exact is permit2; v1 exact uses network "base-sepolia" (EIP-3009).
// This module never prints keys. Callers decide whether to settle; self-hosted
// factory.settle remains the default path on the AgentCoin service.
import { CHAIN_ID } from "../lib/config.mjs";
import { X402_V1_NETWORK } from "../lib/network.mjs"; // "base-sepolia" on testnets, "base" on Base mainnet

export const DEXTER_FACILITATOR_URL = "https://x402.dexter.cash";

export function dexterEnabled(env = process.env) {
  if (env.DEXTER_VERIFY === "0") return false;
  if (env.DEXTER_FACILITATOR_URL) return true;
  return CHAIN_ID === 84532;
}

export function dexterUrl(env = process.env) {
  return (env.DEXTER_FACILITATOR_URL ?? DEXTER_FACILITATOR_URL).replace(/\/$/, "");
}

function looksLikePermit2Required(body, text) {
  const s = `${text ?? ""} ${JSON.stringify(body ?? {})}`.toLowerCase();
  return /permit2/.test(s) && /(requir|only|unsupported|invalid|reject|must|expected)/.test(s);
}

/**
 * POST /verify or /settle on the Dexter facilitator.
 * Returns { ok, status, body, headers, permit2Required }.
 */
export async function dexterPost(path, { paymentPayload, paymentRequirements, timeoutMs = 20000, env = process.env, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${dexterUrl(env)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ x402Version: paymentPayload?.x402Version ?? paymentRequirements?.x402Version ?? 2, paymentPayload, paymentRequirements }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await r.json().catch(() => null);
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return {
    ok: r.ok,
    status: r.status,
    body,
    extensionResponses: (typeof r.headers?.get === "function" ? r.headers.get("extension-responses") ?? r.headers.get("EXTENSION-RESPONSES") : null) ?? null,
    permit2Required: looksLikePermit2Required(body, text),
  };
}

export function dexterVerify(opts) {
  return dexterPost("/verify", opts);
}

export function dexterSettle(opts) {
  return dexterPost("/settle", opts);
}

/** v1 exact paymentRequirements for Base Sepolia EIP-3009 (fallback when v2 exact is permit2-only). */
export function v1ExactRequirements(req, { resource, description } = {}) {
  const url = typeof resource === "string" ? resource : resource?.url;
  return {
    scheme: "exact",
    network: X402_V1_NETWORK,
    maxAmountRequired: String(req.amount),
    resource: url,
    description: description ?? (typeof resource === "object" ? resource?.description : "") ?? "",
    mimeType: (typeof resource === "object" ? resource?.mimeType : null) ?? "application/json",
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    asset: req.asset,
    extra: { name: req.extra?.name ?? "USDC", version: req.extra?.version ?? "2" },
  };
}

/** v1 payment payload; resource is set on the payload as required by the listing brief. */
export function v1ExactPayload({ authorization, signature, resource }) {
  const url = typeof resource === "string" ? resource : resource?.url;
  return {
    x402Version: 1,
    scheme: "exact",
    network: X402_V1_NETWORK,
    payload: { signature, authorization },
    resource: url,
  };
}

/**
 * Try Dexter /verify with a v2 EIP-3009 exact payload first. If Dexter requires permit2
 * or otherwise rejects v2 exact, retry with the v1 base-sepolia exact option.
 */
function validVerify(r) {
  if (!r.ok) return false;
  if (r.body && r.body.isValid === false) return false;
  if (r.body && r.body.success === false) return false;
  return true;
}

export async function dexterVerifyExact(v2, { fetchImpl, env, timeoutMs } = {}) {
  const first = await dexterVerify({ ...v2, env, fetchImpl, timeoutMs });
  if (validVerify(first) && !first.permit2Required) return { ...first, versionUsed: 2, fallback: false };
  if (first.permit2Required || !validVerify(first)) {
    const req = v2.paymentRequirements;
    const pp = v2.paymentPayload;
    const v1 = {
      paymentPayload: v1ExactPayload({
        authorization: pp.payload?.authorization,
        signature: pp.payload?.signature,
        resource: pp.resource ?? req.resource,
      }),
      paymentRequirements: v1ExactRequirements(req, { resource: pp.resource ?? req.resource, description: req.description }),
    };
    const second = await dexterVerify({ ...v1, env, fetchImpl, timeoutMs });
    return { ...second, versionUsed: 1, fallback: true, v2: first, v1 };
  }
  return { ...first, versionUsed: 2, fallback: false };
}

export async function dexterSettleExact(v2, { fetchImpl, env, timeoutMs } = {}) {
  // Prefer the version /verify already selected when the caller passes { versionUsed, paymentPayload, paymentRequirements }
  if (v2.versionUsed === 1) return { ...(await dexterSettle({ paymentPayload: v2.paymentPayload, paymentRequirements: v2.paymentRequirements, env, fetchImpl, timeoutMs })), versionUsed: 1 };
  const first = await dexterSettle({ paymentPayload: v2.paymentPayload, paymentRequirements: v2.paymentRequirements, env, fetchImpl, timeoutMs });
  if (first.ok) return { ...first, versionUsed: 2, fallback: false };
  if (first.permit2Required || first.status >= 400) {
    const req = v2.paymentRequirements;
    const pp = v2.paymentPayload;
    const v1 = {
      paymentPayload: v1ExactPayload({
        authorization: pp.payload?.authorization,
        signature: pp.payload?.signature,
        resource: pp.resource ?? req.resource,
      }),
      paymentRequirements: v1ExactRequirements(req, { resource: pp.resource ?? req.resource, description: req.description }),
    };
    const second = await dexterSettle({ ...v1, env, fetchImpl, timeoutMs });
    return { ...second, versionUsed: 1, fallback: true, v2: first, v1 };
  }
  return { ...first, versionUsed: 2, fallback: false };
}
