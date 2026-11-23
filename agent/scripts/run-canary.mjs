#!/usr/bin/env node
// Operator script for queued canary-job requests (POST /v1/evaluators/canary writes <stateDir>/canary-queue.jsonl).
// Default: read-only plan. Prints the queued requests, the per-batch hash and the calls a live run would make;
// loads no key, constructs no signer, sends nothing.
// --live: Base Sepolia (84532) only. Requires CONFIRM_BATCH=<batchHash printed by the plan run> so each live batch
// is approved by exact content. Per request: registry.isActive check, then USDC.approve + JobEscrow.createAndFund
// (provider = service provider wallet, evaluator = requester, amount 0.1 test USDC) from the deployer (STOS demo) wallet.
// Results are appended to the queue file (status funded | skipped | failed). Keys are never printed.
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { getAddress } from "viem";
import { AGENT_DIR, NETWORK } from "../lib/config.mjs";
import { CanaryQueue, CANARY_AMOUNT } from "../lib/evaluator-onboarding.mjs";
import { jcs } from "../lib/canonical.mjs";

const { values: a } = parseArgs({ options: { live: { type: "boolean", default: false }, queue: { type: "string" }, limit: { type: "string", default: "10" }, "deadline-seconds": { type: "string", default: "86400" } } });
const stateDir = process.env.SERVICE_STATE_DIR ?? path.join(AGENT_DIR, ".state", NETWORK);
const queue = new CanaryQueue(a.queue ?? path.join(stateDir, "canary-queue.jsonl"));
const log = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v)));

export const canarySpec = (r) => ({ v: "agentkoin-canary/v1", requestId: r.id, evaluator: r.address, amount: r.amount, deliverable: "sha256 of the UTF-8 string agentkoin-canary:<requestId>", outcome: "Complete if the submitted deliverableHash equals that sha256, else Reject" });
export const specHashOf = (r) => "0x" + createHash("sha256").update(jcs(canarySpec(r))).digest("hex");
export const batchHash = (rs) => "0x" + createHash("sha256").update(jcs(rs.map((r) => r.id).sort())).digest("hex");

const batch = queue.entries().filter((e) => e.status === "queued").slice(0, Number(a.limit));
const plan = { mode: a.live ? "live" : "plan", network: NETWORK, queueFile: queue.file, batchHash: batchHash(batch), count: batch.length, totalAmount: String(BigInt(CANARY_AMOUNT) * BigInt(batch.length)), requests: batch.map((r) => ({ id: r.id, evaluator: r.address, amount: r.amount, specHash: specHashOf(r), calls: ["USDC.approve(escrow, amount)", "JobEscrow.createAndFund(provider, evaluator, amount, deadline, specHash)"] })) };
log(plan);

if (a.live) {
  if (batch.length === 0) process.exit(0);
  if (process.env.CONFIRM_BATCH !== plan.batchHash) throw new Error("refusing to broadcast: CONFIRM_BATCH must equal this batch's batchHash");
  const { CHAIN_ID, roleKey } = await import("../lib/config.mjs");
  if (CHAIN_ID !== 84532) throw new Error(`refusing chainId ${CHAIN_ID}`);
  const { assertChain, contracts, read, send, wallet, publicClient } = await import("../lib/chain.mjs");
  const { privateKeyToAccount } = await import("viem/accounts");
  await assertChain();
  const c = contracts();
  const w = wallet(roleKey("client"));
  const provider = privateKeyToAccount(roleKey("provider")).address;
  for (const r of batch) {
    const ev = getAddress(r.address);
    if (!(await read(c.registry, "isActive", [ev]))) {
      queue.append({ id: r.id, status: "skipped", reason: "evaluator not isActive at run time", at: Math.floor(Date.now() / 1000) });
      log({ id: r.id, status: "skipped" });
      continue;
    }
    try {
      const amount = BigInt(r.amount);
      const deadline = BigInt((await publicClient.getBlock()).timestamp) + BigInt(a["deadline-seconds"]);
      const t1 = await send(w, c.usdc, "approve", [c.escrow.address, amount]);
      const jobCount = await read(c.escrow, "jobCount", []);
      const t2 = await send(w, c.escrow, "createAndFund", [provider, ev, amount, deadline, specHashOf(r)]);
      queue.append({ id: r.id, status: "funded", approveTx: t1.hash, fundTx: t2.hash, jobIdHint: String(jobCount + 1n), at: Math.floor(Date.now() / 1000) });
      log({ id: r.id, status: "funded", approveTx: t1.hash, fundTx: t2.hash });
    } catch (e) {
      queue.append({ id: r.id, status: "failed", error: String(e.shortMessage ?? e.message).slice(0, 200), at: Math.floor(Date.now() / 1000) });
      log({ id: r.id, status: "failed" });
    }
  }
}
