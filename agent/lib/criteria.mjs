// Opt-in "gvp-criteria-checks/1" mode for POST /v1/notarize (vocabulary read from GET https://x402toll.com/v1/evaluator).
// For one notarize request (digest + optional nonce) this builds a deterministic criteria document, whose sha256 over
// its RFC 8785 (JCS) bytes is the job's on-chain specHash, and the byte-exact deliverable the checks run against.
//   specHash        = "0x" + sha256( utf8( JCS(criteria document) ) )
//   deliverableHash = "0x" + sha256( utf8( JCS(receipt) ) )      (the `deliverable-hash` check: sha256(body) == on-chain deliverableHash)
// The default mode (specHash = keccak256 of a text string, deliverableHash = keccak256(JCS(receipt))) is unchanged.
import { createHash } from "node:crypto";
import { jcs } from "./canonical.mjs";

export const CRITERIA_VOCABULARY = "gvp-criteria-checks/1";
export const CRITERIA_SET = "agentkoin-notary-digest/v1";
export const DELIVERABLE_MAX_BYTES = 4096;
export const CRITERIA_QUERY = { spec: CRITERIA_VOCABULARY };

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Query parameters: spec=gvp-criteria-checks/1&digest=0x<64 hex>[&nonce=<1..32 chars of [0-9a-z]>]. Returns null (mode off), {error} or {digest, nonce, id}. */
export function parseCriteriaParams(get) {
  const spec = get("spec");
  if (spec == null || spec === "") return null;
  if (spec !== CRITERIA_VOCABULARY) return { error: `spec must be ${CRITERIA_VOCABULARY}` };
  const digest = get("digest");
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(digest ?? ""))) return { error: "digest (0x + 64 hex chars, the sha256 to notarize) is required with spec=" + CRITERIA_VOCABULARY };
  const nonce = get("nonce");
  if (nonce != null && nonce !== "" && !/^[0-9a-z]{1,32}$/.test(nonce)) return { error: "nonce must match [0-9a-z]{1,32}" };
  const d = String(digest).toLowerCase();
  const n = nonce ? String(nonce) : null;
  return { digest: d, nonce: n, id: d.slice(2) + (n ? "-" + n : "") };
}

export const parseDeliverableId = (id) => {
  const m = /^([0-9a-f]{64})(?:-([0-9a-z]{1,32}))?$/.exec(String(id));
  return m ? { digest: "0x" + m[1], nonce: m[2] ?? null, id: String(id) } : null;
};

export const deliverableUrl = (baseUrl, id) => `${baseUrl}/v1/deliverables/${id}`;

/** The criteria document for one notarize request. Pure and deterministic in its inputs. */
export function buildNotaryCriteria({ baseUrl, id, digest, chainId, escrow }) {
  const url = deliverableUrl(baseUrl, id);
  const c = (cid, title, check) => ({ id: cid, title, required: true, requirement: `${cid}: ${check.type} on GET ${url}`, check: { ...check, url } });
  return {
    criteria_set: CRITERIA_SET,
    version: "1",
    criteria: [
      c("http-status", "Deliverable is reachable", { type: "http-status", equals: 200 }),
      c("content-type", "Deliverable is application/json", { type: "header", name: "content-type", equals: "application/json" }),
      c("max-bytes", "Deliverable size limit", { type: "body-max-bytes", max: DELIVERABLE_MAX_BYTES }),
      c("json-valid", "Deliverable is valid JSON", { type: "json-valid" }),
      c("receipt-version", "Receipt version", { type: "json-pointer", pointer: "/v", equals: "agentcoin-notary/v1" }),
      c("receipt-digest", "Receipt digest equals the requested digest", { type: "json-pointer", pointer: "/digest", equals: digest }),
      c("receipt-chain", "Receipt chainId", { type: "json-pointer", pointer: "/chainId", equals: chainId }),
      c("receipt-escrow", "Receipt escrow address", { type: "json-pointer", pointer: "/escrow", equals: escrow }),
      c("deliverable-hash", "sha256 of the body equals the on-chain deliverableHash", { type: "deliverable-hash" }),
    ],
  };
}

export const criteriaBytes = (doc) => Buffer.from(jcs(doc), "utf8");
export const criteriaSpecHash = (doc) => "0x" + sha256Hex(criteriaBytes(doc));
export const deliverableBytes = (receipt) => Buffer.from(jcs(receipt), "utf8");
export const deliverableSha256 = (receipt) => "0x" + sha256Hex(deliverableBytes(receipt));

/** Everything the service needs for one criteria-mode request. */
export function criteriaOffer({ baseUrl, params, chainId, escrow }) {
  const document = buildNotaryCriteria({ baseUrl, id: params.id, digest: params.digest, chainId, escrow });
  const specHash = criteriaSpecHash(document);
  return {
    ...params,
    document,
    specHash,
    criteriaUrl: `${baseUrl}/v1/criteria/${specHash.slice(2)}`,
    deliverableUrl: deliverableUrl(baseUrl, params.id),
    metadata: {
      vocabulary: CRITERIA_VOCABULARY,
      specHash,
      specHashAlgorithm: "sha256(utf8(RFC8785(document)))",
      criteriaUrl: `${baseUrl}/v1/criteria/${specHash.slice(2)}`,
      deliverableUrl: deliverableUrl(baseUrl, params.id),
      deliverableHashAlgorithm: "sha256(utf8(RFC8785(receipt))); the receipt is the response body at deliverableUrl",
      document,
    },
  };
}
