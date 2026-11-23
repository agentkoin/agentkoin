// JSON Schema (2020-12) for the paid notary response body: POST /v1/notarize 200 and GET /v1/notarize/{jobId} 200.
// responseSchemaHash = "sha256:" + hex(sha256(RFC8785(NOTARY_RESPONSE_SCHEMA))). Served byte-for-byte as JCS at /v1/notarize/schema.json.
import { createHash } from "node:crypto";
import { jcs } from "./canonical.mjs";

const hex32 = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
const addr = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const uintStr = { type: "string", pattern: "^[0-9]+$" };
const nullableHex32 = { anyOf: [hex32, { type: "null" }] };

export const NOTARY_RESPONSE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "agentcoin-notary-response/v1",
  title: "AgentCoin notary response (POST /v1/notarize 200, GET /v1/notarize/{jobId} 200)",
  type: "object",
  required: ["receipt", "deliverableHash", "jobId", "settleTx", "submitTx"],
  properties: {
    receipt: {
      type: "object",
      required: ["v", "chainId", "escrow", "jobId", "client", "digest", "digestKind", "settleTx", "settleBlock", "notarizedAt", "notarizedAtIso"],
      properties: {
        v: { const: "agentcoin-notary/v1" },
        chainId: { type: "integer" },
        escrow: addr,
        jobId: uintStr,
        client: addr,
        digest: hex32,
        digestKind: { type: "string" },
        note: { type: ["string", "null"] },
        settleTx: hex32,
        settleBlock: uintStr,
        notarizedAt: { type: "integer" },
        notarizedAtIso: { type: "string", format: "date-time" },
        testnet: { type: "boolean" },
        realValue: { type: "boolean" },
      },
    },
    receiptSignature: {
      anyOf: [
        {
          type: "object",
          required: ["scheme", "canonicalization", "digest", "signer", "signedDigest", "value"],
          properties: { scheme: { const: "eip191" }, canonicalization: { const: "RFC8785" }, digest: { const: "keccak256" }, signer: addr, signedDigest: hex32, value: { type: "string", pattern: "^0x[0-9a-fA-F]+$" } },
        },
        { type: "null" },
      ],
    },
    deliverableHash: hex32,
    jobId: uintStr,
    settleTx: hex32,
    submitTx: nullableHex32,
    verdictTx: nullableHex32,
    finalizeTx: nullableHex32,
    status: { type: "string" },
    verify: { type: "string" },
    agentcoin: { type: "object" },
    testnet: { type: "boolean" },
    realValue: { type: "boolean" },
  },
};

export const NOTARY_RESPONSE_SCHEMA_JCS = jcs(NOTARY_RESPONSE_SCHEMA);
export const NOTARY_RESPONSE_SCHEMA_HASH = "sha256:" + createHash("sha256").update(NOTARY_RESPONSE_SCHEMA_JCS, "utf8").digest("hex");
