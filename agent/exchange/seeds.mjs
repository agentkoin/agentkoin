// AgentKoin's own seed listings for the Exchange (spec section 10.1): origin "agentcoin", seller = the service's provider
// wallet, excluded from scores. Each skill is deterministic so the reference evaluator can judge it by machine checks.
import { createHash } from "node:crypto";
import { keccak256 } from "viem";
import { jcs } from "../lib/canonical.mjs";

const hex32 = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
const addr = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };

export function seedListings(publicUrl) {
  const u = (p) => publicUrl.replace(/\/$/, "") + p;
  return [
    {
      title: "AgentKoin Notary (escrowed)",
      display_name: "AgentKoin",
      description: "Timestamps a 32-byte digest into a receipt bound to the escrow job. Operated by STOS Technologies LLC (AgentKoin). Testnet only.",
      endpoint: u("/v1/notarize"),
      protocols: ["x402", "mcp", "a2a", "http"],
      erc8004_id: "10494",
      labels: ["agentkoin-seed", "notary"],
      skills: [{
        skill_id: "notarize", name: "Notarize a digest", description: "Output: receipt {digest, note, jobId, client, chainId, notarizedAt}.", price: "10000", sla_seconds: 3600,
        input_schema: { type: "object", required: ["digest"], properties: { digest: hex32, note: { type: "string", maxLength: 280 } }, additionalProperties: false },
        deliverable_schema: { type: "object", required: ["v", "digest", "jobId", "client", "chainId", "notarizedAt"], properties: { v: { const: "agentkoin-exchange-notary/v1" }, digest: hex32, note: { type: ["string", "null"] }, jobId: { type: "string" }, client: addr, chainId: { const: 84532 }, notarizedAt: { type: "integer" } } },
      }],
    },
    {
      title: "AgentKoin Job Verifier",
      display_name: "AgentKoin",
      description: "Runs the judge-kit job-proof checks for one AgentKoin JobEscrow job and returns the check list. Operated by STOS Technologies LLC (AgentKoin). Testnet only.",
      endpoint: u("/v1/jobs/1/proof"),
      protocols: ["http", "mcp"],
      erc8004_id: "10494",
      labels: ["agentkoin-seed", "verification"],
      skills: [{
        skill_id: "verify-job", name: "Verify an escrow job", description: "Output: {escrow, jobId, ok, passed, failed, skipped, checks[{id,status}]} from the judge-kit evaluator (same code as npx @agentkoin/judge-kit verify).", price: "10000", sla_seconds: 3600,
        input_schema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string", pattern: "^[0-9]{1,12}$" }, escrow: addr }, additionalProperties: false },
        deliverable_schema: { type: "object", required: ["v", "escrow", "jobId", "ok", "checks"], properties: { v: { const: "agentkoin-exchange-verify/v1" }, escrow: addr, jobId: { type: "string" }, ok: { type: "boolean" }, passed: { type: "integer" }, failed: { type: "integer" }, skipped: { type: "integer" }, checks: { type: "array", items: { type: "object", required: ["id", "status"] } } } },
      }],
    },
    {
      title: "AgentKoin Criteria Review",
      display_name: "AgentKoin",
      description: "Canonicalizes a criteria document (RFC 8785), returns its sha256/keccak256 and a structural lint (checks, verdict rules, out-of-scope list). Operated by STOS Technologies LLC (AgentKoin). Testnet only.",
      endpoint: u("/specs/criteria/notarize-binding-v1.json"),
      protocols: ["http", "mcp"],
      erc8004_id: "10494",
      labels: ["agentkoin-seed", "criteria"],
      skills: [{
        skill_id: "criteria-review", name: "Review a criteria document", description: "Output: {sha256, keccak256, byteLength, findings[]} for the RFC 8785 bytes of the input document.", price: "10000", sla_seconds: 3600,
        input_schema: { type: "object", required: ["criteria"], properties: { criteria: { type: "object" } }, additionalProperties: false },
        deliverable_schema: { type: "object", required: ["v", "sha256", "keccak256", "byteLength", "findings"], properties: { v: { const: "agentkoin-exchange-criteria-review/v1" }, sha256: hex32, keccak256: hex32, byteLength: { type: "integer" }, findings: { type: "array", items: { type: "object", required: ["id", "status"] } } } },
      }],
    },
  ];
}

/** Lint findings for a criteria document (structure only; says nothing about whether the criteria are good). */
export function reviewCriteria(doc) {
  const f = [];
  const has = (k) => doc && Object.prototype.hasOwnProperty.call(doc, k);
  const checks = Array.isArray(doc?.checks) ? doc.checks : Array.isArray(doc?.criteria) ? doc.criteria : null;
  f.push({ id: "checks-present", status: checks && checks.length ? "pass" : "fail", detail: checks ? `${checks.length} entries` : "no checks[] or criteria[] array" });
  f.push({ id: "checks-have-ids", status: checks && checks.every((c) => c && typeof c.id === "string") ? "pass" : "fail" });
  f.push({ id: "checks-have-pass-rule", status: checks && checks.every((c) => c && (typeof c.pass === "string" || typeof c.check === "object")) ? "pass" : "fail" });
  f.push({ id: "verdict-rule", status: has("verdict") || has("verdictFields") || has("verdictValues") ? "pass" : "fail" });
  f.push({ id: "out-of-scope", status: has("outOfScope") ? "pass" : "warn" });
  f.push({ id: "chain-id", status: doc?.chainId === 84532 ? "pass" : "warn", detail: `chainId ${doc?.chainId ?? "absent"}` });
  return f;
}

/**
 * Do the work for one seed order. ctx: { jobId, client, blockTimestamp, verifyJob(escrow, jobId) -> {ok, passed, failed, skipped, results[]}, escrow }
 * Returns the deliverable object {jobId, output}.
 */
export async function runSeed(skillId, input, ctx) {
  const jobId = String(ctx.jobId);
  if (skillId === "notarize") return { jobId, output: { v: "agentkoin-exchange-notary/v1", digest: input?.digest ?? null, note: input?.note ?? null, jobId, client: ctx.client, chainId: 84532, notarizedAt: Number(ctx.blockTimestamp) } };
  if (skillId === "verify-job") {
    const escrow = input?.escrow ?? ctx.escrow;
    const r = await ctx.verifyJob(escrow, String(input?.jobId));
    return { jobId, output: { v: "agentkoin-exchange-verify/v1", escrow, jobId: String(input?.jobId), ok: !!r.ok, passed: r.passed ?? 0, failed: r.failed ?? 0, skipped: r.skipped ?? 0, checks: (r.results ?? []).map((c) => ({ id: c.id, status: c.status })) } };
  }
  if (skillId === "criteria-review") {
    const bytes = Buffer.from(jcs(input?.criteria ?? {}), "utf8");
    return { jobId, output: { v: "agentkoin-exchange-criteria-review/v1", sha256: "0x" + createHash("sha256").update(bytes).digest("hex"), keccak256: keccak256(bytes), byteLength: bytes.length, findings: reviewCriteria(input?.criteria ?? {}) } };
  }
  throw new Error(`no seed worker for skill ${skillId}`);
}
export const deliverableBytesOf = (d) => Buffer.from(jcs(d), "utf8");
