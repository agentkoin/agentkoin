// Minimal event indexer (SPEC-v0 §4). Derives evaluator reputation from escrow + registry events.
// Returns raw counts plus the tx hashes each count was derived from. No scores, no weighting.
import { getAddress } from "viem";
import { publicClient, contracts, read, contractEvents } from "./chain.mjs";
import { envelope } from "./protocol.mjs";

const s = (v) => (typeof v === "bigint" ? v.toString() : v);
const ev = (l) => ({ event: l.eventName, jobId: l.args.jobId !== undefined ? s(l.args.jobId) : undefined, txHash: l.transactionHash, blockNumber: s(l.blockNumber) });

// The full scan reads every escrow + registry log since deployBlock in MAX_LOG_RANGE chunks, which can take minutes on
// Base Sepolia. Callers (MCP verify/get_evaluator_reputation, HTTP) get a bounded wait: a cached result (fresh for
// REP_TTL_MS, then served stale while one background refresh runs), or after REP_TIMEOUT_MS a clear "index building"
// error while the scan continues in the background and fills the cache. One scan per evaluator at a time.
const REP_TTL_MS = Number(process.env.AGENTCOIN_REPUTATION_TTL_MS ?? 10 * 60_000);
const REP_TIMEOUT_MS = Number(process.env.AGENTCOIN_REPUTATION_TIMEOUT_MS ?? 15_000);
const repCache = new Map(); // evaluator -> { at, value }
const repInflight = new Map(); // evaluator -> Promise

export class ReputationPendingError extends Error {
  constructor(evaluator, ms) {
    super(`evaluator reputation for ${evaluator} is still being indexed from on-chain logs (no answer within ${Math.round(ms / 1000)} s); the scan continues in the background, retry in about a minute`);
    this.code = "reputation_index_pending";
    this.status = 503;
  }
}

/** Bounded evaluatorReputation: cache + in-flight dedupe + timeout. scan is injectable for tests. */
export async function evaluatorReputation(evaluatorAddr, { timeoutMs = REP_TIMEOUT_MS, ttlMs = REP_TTL_MS, scan = evaluatorReputationScan, now = Date.now } = {}) {
  const evaluator = getAddress(evaluatorAddr);
  const hit = repCache.get(evaluator);
  const start = () => {
    if (!repInflight.has(evaluator)) {
      const p = Promise.resolve()
        .then(() => scan(evaluator))
        .then((value) => { repCache.set(evaluator, { at: now(), value }); return value; })
        .finally(() => repInflight.delete(evaluator));
      p.catch(() => {});
      repInflight.set(evaluator, p);
    }
    return repInflight.get(evaluator);
  };
  if (hit && now() - hit.at < ttlMs) return hit.value;
  const p = start();
  if (hit) return { ...hit.value, cache: { stale: true, cachedAt: new Date(hit.at).toISOString(), refreshing: true } };
  let timer;
  const to = new Promise((_r, rej) => { timer = setTimeout(() => rej(new ReputationPendingError(evaluator, timeoutMs)), timeoutMs); });
  try {
    return await Promise.race([p, to]);
  } finally {
    clearTimeout(timer);
  }
}
export const _reputationCache = { clear: () => { repCache.clear(); repInflight.clear(); } };

export async function evaluatorReputationScan(evaluatorAddr) {
  const c = contracts();
  const evaluator = getAddress(evaluatorAddr);
  const toBlock = await publicClient.getBlockNumber();
  const fromBlock = BigInt(c.d.deployBlock ?? 0);
  const logs = await contractEvents(c.escrow, { fromBlock, toBlock });
  const regLogs = await contractEvents(c.registry, { fromBlock, toBlock, args: { evaluator } });

  const jobs = new Map(); // jobId -> { amount, submittedTs }
  for (const l of logs) if (l.eventName === "JobCreated" && getAddress(l.args.evaluator) === evaluator) jobs.set(l.args.jobId, { amount: l.args.amount });
  const mine = (l) => l.args.jobId !== undefined && jobs.has(l.args.jobId);

  const blockTs = new Map();
  const ts = async (bn) => {
    if (!blockTs.has(bn)) blockTs.set(bn, (await publicClient.getBlock({ blockNumber: bn })).timestamp);
    return blockTs.get(bn);
  };

  const evidence = { jobsAssigned: [], verdicts: [], jobsCompleted: [], jobsDisputed: [], verdictsOverturned: [], missedVerdicts: [], slashes: [], arbitrationFeeReimbursements: [] };
  let totalVolume = 0n;
  const outcomeCounts = { Complete: 0, Reject: 0, Partial: 0 };
  const submittedAt = new Map();
  let verdictLatencySum = 0n;
  let verdictLatencyN = 0n;
  const OUT = ["None", "Complete", "Reject", "Partial"];

  for (const l of logs) {
    if (!mine(l)) continue;
    switch (l.eventName) {
      case "JobCreated":
        evidence.jobsAssigned.push(ev(l));
        break;
      case "JobFunded":
        totalVolume += l.args.amount;
        break;
      case "JobSubmitted":
        submittedAt.set(l.args.jobId, await ts(l.blockNumber));
        break;
      case "Verdict": {
        evidence.verdicts.push({ ...ev(l), outcome: OUT[l.args.outcome], payoutBps: Number(l.args.payoutBps) });
        outcomeCounts[OUT[l.args.outcome]]++;
        const st = submittedAt.get(l.args.jobId);
        if (st !== undefined) {
          verdictLatencySum += (await ts(l.blockNumber)) - st;
          verdictLatencyN++;
        }
        break;
      }
      case "Settled":
        evidence.jobsCompleted.push({ ...ev(l), payoutBps: Number(l.args.payoutBps) });
        break;
      case "Challenged":
        evidence.jobsDisputed.push(ev(l));
        break;
      case "Ruled":
        if (l.args.overturned) evidence.verdictsOverturned.push({ ...ev(l), verdictPayoutBps: Number(l.args.verdictPayoutBps), rulingPayoutBps: Number(l.args.rulingPayoutBps) });
        break;
      case "VerdictTimedOut":
        evidence.missedVerdicts.push(ev(l));
        break;
    }
  }
  // Registry Slashed/Reimbursed carry the calling slasher; jobIds are per-slasher namespaces (escrow jobId vs adapter id).
  const sourceOf = (a) => (getAddress(a) === getAddress(c.escrow.address) ? "escrow" : c.adapter.address && getAddress(a) === getAddress(c.adapter.address) ? "erc8183Adapter" : "other");
  for (const l of regLogs) {
    if (l.eventName === "Slashed") evidence.slashes.push({ ...ev(l), reason: Number(l.args.reason), amount: s(l.args.amount), slasher: l.args.slasher, source: sourceOf(l.args.slasher) });
    if (l.eventName === "Reimbursed") evidence.arbitrationFeeReimbursements.push({ ...ev(l), amount: s(l.args.amount), to: l.args.to, slasher: l.args.slasher, source: sourceOf(l.args.slasher) });
  }

  // ERC-8183 adapter jobs (external kernels naming the adapter as evaluator).
  const adapter = { jobsAccepted: [], verdicts: [], verdictsOverturned: [], missedVerdicts: [] };
  if (c.adapter.address) {
    const alogs = await contractEvents(c.adapter, { fromBlock, toBlock });
    const ids = new Set(alogs.filter((l) => l.eventName === "AssignmentAccepted" && getAddress(l.args.evaluator) === evaluator).map((l) => l.args.id));
    const aev = (l) => ({ event: l.eventName, id: s(l.args.id), txHash: l.transactionHash, blockNumber: s(l.blockNumber) });
    for (const l of alogs) {
      if (l.args.id === undefined || !ids.has(l.args.id)) continue;
      if (l.eventName === "AssignmentAccepted") adapter.jobsAccepted.push(aev(l));
      if (l.eventName === "VerdictHeld") adapter.verdicts.push({ ...aev(l), payoutBps: Number(l.args.payoutBps), completes: l.args.completes });
      if (l.eventName === "Ruled" && l.args.overturned) adapter.verdictsOverturned.push(aev(l));
      if (l.eventName === "VerdictTimedOut") adapter.missedVerdicts.push(aev(l));
    }
  }
  evidence.adapter = adapter;

  const info = await read(c.registry, "evaluatorInfo", [evaluator]);
  const active = await read(c.registry, "isActive", [evaluator]);
  return {
    ...envelope(c, toBlock),
    evaluator,
    indexedFromBlock: s(fromBlock),
    indexedToBlock: s(toBlock),
    unit: "USDC base units (6 decimals); seconds",
    counts: {
      jobsAssigned: evidence.jobsAssigned.length,
      verdicts: evidence.verdicts.length,
      verdictsByOutcome: outcomeCounts,
      jobsCompleted: evidence.jobsCompleted.length,
      jobsDisputed: evidence.jobsDisputed.length,
      disputesLost: evidence.verdictsOverturned.length,
      verdictsOverturned: evidence.verdictsOverturned.length,
      missedVerdicts: evidence.missedVerdicts.length,
      adapter: {
        jobsAccepted: adapter.jobsAccepted.length,
        verdicts: adapter.verdicts.length,
        verdictsOverturned: adapter.verdictsOverturned.length,
        missedVerdicts: adapter.missedVerdicts.length,
      },
    },
    totalVolume: s(totalVolume),
    currentStake: s(info.stake),
    active,
    slashedTotal: s(info.slashedTotal),
    avgTimeToVerdictSeconds: verdictLatencyN > 0n ? s(verdictLatencySum / verdictLatencyN) : null,
    evidence,
  };
}
