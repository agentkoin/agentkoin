#!/usr/bin/env node
// Door-knocker v2 (c) job flow: ONLY the pre-specified, Carter-approved flow. For each explicit acceptance recorded by
// send.mjs (out/v2/acceptances.jsonl) of an APPROVED job (pinned jobs file): USDC approve(escrow, amount) + JobEscrow
// .createAndFund(provider, evaluator, amount, now+deadlineSeconds, specHash) from the deployer. Nothing else is ever
// done because of a reply. Caps: approved jobs only, <= 0.10 each, <= 20/day, total <= approved total. Stops at the first
// failure and reports which txs landed. Needs JOBS_LIVE_ACK=open-approved-testnet-jobs; otherwise prints the plan only.
// `status` subcommand: read-only on-chain state of every opened job.
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { decodeEventLog, getAddress } from "viem";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "out", "v2");
const readJsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
export const JOB_MAX_ATOMIC = 100000n, JOBS_PER_DAY = 20;

/** Pure: which acceptances may open a job now. */
export function planJobs({ acceptances, approvedJobs, opened, nowMs = Date.now() }) {
  const byRef = new Map(approvedJobs.map((j) => [j.ref, j]));
  const totalApproved = approvedJobs.reduce((s, j) => s + BigInt(j.amountAtomic), 0n);
  const openedRefs = new Set(opened.map((o) => o.ref));
  let spent = opened.reduce((s, o) => s + BigInt(o.amountAtomic), 0n);
  let today = opened.filter((o) => Date.parse(o.at) > nowMs - 86400_000).length;
  const plan = [], refused = [];
  for (const a of acceptances) {
    const j = byRef.get(a.ref);
    if (!j) { refused.push({ ref: a.ref, reason: "not an approved job" }); continue; }
    if (openedRefs.has(a.ref)) { refused.push({ ref: a.ref, reason: "already opened" }); continue; }
    if (a.jobRef !== j.jobRef) { refused.push({ ref: a.ref, reason: "jobRef mismatch" }); continue; }
    const amt = BigInt(j.amountAtomic);
    if (amt > JOB_MAX_ATOMIC) { refused.push({ ref: a.ref, reason: "amount > 0.10" }); continue; }
    if (today >= JOBS_PER_DAY) { refused.push({ ref: a.ref, reason: "20 jobs/day reached" }); continue; }
    if (spent + amt > totalApproved) { refused.push({ ref: a.ref, reason: "approved total reached" }); continue; }
    spent += amt; today++; openedRefs.add(a.ref);
    plan.push({ ref: a.ref, jobRef: j.jobRef, provider: getAddress(a.provider), evaluator: getAddress(j.evaluator), amountAtomic: j.amountAtomic, deadlineSeconds: j.deadlineSeconds, specHash: j.specHash });
  }
  return { plan, refused };
}

async function main() {
  const jf = process.env.DOORKNOCK_JOBS_FILE, jwant = process.env.DOORKNOCK_JOBS_SHA256;
  if (!jf || createHash("sha256").update(readFileSync(jf)).digest("hex") !== jwant) throw new Error("pin DOORKNOCK_JOBS_FILE + DOORKNOCK_JOBS_SHA256");
  process.env.AGENTCOIN_NETWORK ??= "base-sepolia";
  if (process.env.AGENTCOIN_NETWORK !== "base-sepolia") throw new Error("Base Sepolia only");
  const approvedJobs = JSON.parse(readFileSync(jf, "utf8")).jobs;
  const openedFile = path.join(OUT, "jobs-opened.jsonl");
  const opened = readJsonl(openedFile);
  const chain = await import("../../lib/chain.mjs");
  const { roleKey, STATES } = await import("../../lib/config.mjs");
  if (process.argv[2] === "status") {
    const c = chain.contracts(); const rows = [];
    for (const o of opened) { const j = await chain.read(c.escrow, "getJob", [BigInt(o.jobId)]).catch((e) => ({ error: e.shortMessage ?? e.message })); rows.push({ ref: o.ref, jobId: o.jobId, state: j.error ? j.error : STATES[Number(j.state)], provider: o.provider, deliverableHash: j.deliverableHash ?? null }); }
    console.log(JSON.stringify({ opened: opened.length, jobs: rows }, null, 2)); return;
  }
  const { plan, refused } = planJobs({ acceptances: readJsonl(path.join(OUT, "acceptances.jsonl")), approvedJobs, opened });
  if (process.env.JOBS_LIVE_ACK !== "open-approved-testnet-jobs" || !plan.length) { console.log(JSON.stringify({ live: false, plan, refused }, null, 2)); return; }
  await chain.assertChain();
  const c = chain.contracts(); const w = chain.wallet(roleKey("deployer"));
  if (getAddress(c.usdc.address) !== getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e")) throw new Error("token is not Circle Sepolia USDC");
  for (const p of plan) {
    const landed = [];
    try {
      const amt = BigInt(p.amountAtomic);
      const a = await chain.send(w, c.usdc, "approve", [c.escrow.address, amt]); landed.push({ fn: "approve", hash: a.hash });
      const blk = await chain.publicClient.getBlock();
      const deadline = blk.timestamp + BigInt(p.deadlineSeconds);
      const r = await chain.send(w, c.escrow, "createAndFund", [p.provider, p.evaluator, amt, deadline, p.specHash]); landed.push({ fn: "createAndFund", hash: r.hash });
      let jobId = null;
      for (const l of r.receipt.logs) { try { const ev = decodeEventLog({ abi: c.escrow.abi, data: l.data, topics: l.topics }); if (ev.eventName === "JobCreated") jobId = ev.args.jobId.toString(); } catch {} }
      const rec = { at: new Date().toISOString(), ...p, jobId, deadline: deadline.toString(), txs: landed, state: "Funded; waiting for the provider's submit" };
      appendFileSync(openedFile, JSON.stringify(rec) + "\n"); console.log(JSON.stringify(rec));
    } catch (e) {
      console.error(JSON.stringify({ stopped: p.ref, error: e.shortMessage ?? e.message, landed }));
      appendFileSync(path.join(OUT, "jobs-failed.jsonl"), JSON.stringify({ at: new Date().toISOString(), ref: p.ref, error: e.shortMessage ?? e.message, landed }) + "\n");
      process.exit(2);
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => (console.error(e.shortMessage ?? e.message), process.exit(1)));
