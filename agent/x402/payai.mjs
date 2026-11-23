// PayAI x402 facilitator client (Base Sepolia, keyless, $0 testnet rate).
// Used alongside the self-hosted verify/settle path so Bazaar can catalog our
// declaration. We never send PayAI /settle for exact payments to an
// EscrowDepositRoute: PayAI's standard EIP-3009 settle would consume the
// authorization nonce without opening the escrow job.
import { CHAIN_ID } from "../lib/config.mjs";

export const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network";

export function payaiEnabled(env = process.env) {
  if (env.PAYAI_VERIFY === "0") return false;
  if (env.PAYAI_FACILITATOR_URL) return true;
  return CHAIN_ID === 84532;
}

export function payaiUrl(env = process.env) {
  return (env.PAYAI_FACILITATOR_URL ?? PAYAI_FACILITATOR_URL).replace(/\/$/, "");
}

/** Decode the facilitator EXTENSION-RESPONSES header (base64 JSON). */
export function parseExtensionResponses(headers) {
  const raw =
    (typeof headers?.get === "function" ? headers.get("extension-responses") ?? headers.get("EXTENSION-RESPONSES") : null) ??
    headers?.["extension-responses"] ??
    headers?.["EXTENSION-RESPONSES"];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * POST /verify on the PayAI facilitator. Does not move funds.
 * Returns { ok, status, body, extensionResponsesHeader, extensionResponses }.
 */
export async function payaiVerify({ paymentPayload, paymentRequirements, timeoutMs = 8000, env = process.env, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${payaiUrl(env)}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const extensionResponsesHeader = (typeof r.headers?.get === "function" ? r.headers.get("extension-responses") ?? r.headers.get("EXTENSION-RESPONSES") : null) ?? null;
  const body = await r.json().catch(() => null);
  return {
    ok: r.ok,
    status: r.status,
    body,
    extensionResponsesHeader,
    extensionResponses: parseExtensionResponses(r.headers),
  };
}
