// Read-side protocol helpers shared by the MCP server, x402 server and scripts. All values are
// raw on-chain integers (USDC 6-decimal) serialized as decimal strings. Every response carries
// chainId, block and contract addresses so the caller can re-check it against the chain.
import { getAddress, keccak256 } from "viem";
import { publicClient, contracts, read, rawLogsChunked } from "./chain.mjs";
import { parseEventLogs } from "viem";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { AGENT_DIR, MAX_LOG_RANGE } from "./config.mjs";
import { STATES, OUTCOMES, CHAIN_ID, NETWORK, VALUE_LABEL } from "./config.mjs";

const s = (v) => (typeof v === "bigint" ? v.toString() : v);
const BPS = 10000n;

// Bound evidence log scans per call so GET /v1/orders/{id} and /v1/jobs/{id} stay on the
// contract view (getJob) and never walk from deploy to head in one request. Progress is
// stored in jobcache.sqlite (scanned_to) and the next call continues. State comes from
// getJob / getDispute, which already distinguish Funded, Submitted, Completed, Rejected,
// Expired and the other on-chain states (there is no separate Refunded state).
const defaultEvidenceMaxBlocks = () => {
  const env = process.env.AGENTCOIN_JOB_EVIDENCE_MAX_BLOCKS;
  if (env != null && env !== "") return BigInt(env);
  const step = Number(MAX_LOG_RANGE);
  return BigInt(step > 0 ? step * 6 : 1200);
};


// JobEscrow.arbitrator() as last read from chain (AD-011: set to address(0) on Base Sepolia, 2026-11-15).
// envelope() is synchronous, so it reports the cached value and falls back to the deployment record until first read.
let LIVE_ARBITRATOR = null;
export const NO_ARBITRATOR_TEXT = "none: JobEscrow.arbitrator() is address(0); challenge() reverts NoArbitrator, so a verdict cannot be overturned and finalize(jobId) executes it after challengeWindow";
export async function refreshEscrowArbitrator(c = contracts()) {
  LIVE_ARBITRATOR = getAddress(await read(c.escrow, "arbitrator"));
  return LIVE_ARBITRATOR;
}
export const escrowArbitratorCached = () => LIVE_ARBITRATOR;
const ZERO = "0x0000000000000000000000000000000000000000";

export function envelope(c, blockNumber) {
  return {
    chainId: CHAIN_ID,
    network: `eip155:${CHAIN_ID}`,
    networkName: NETWORK,
    ...VALUE_LABEL,
    blockNumber: s(blockNumber),
    contracts: {
      escrow: c.escrow.address,
      evaluatorRegistry: c.registry.address,
      token: c.usdc.address,
      arbitrator: LIVE_ARBITRATOR ?? c.arbitrator.address,
      identityRegistry: c.identity.address,
      evaluatorAdapter: c.adapter.address,
      depositRouteFactory: c.routeFactory.address,
    },
  };
}

export function configToJson(cfg) {
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, typeof v === "number" || typeof v === "bigint" ? String(v) : v]));
}

export async function evaluatorSnapshot(c, evaluator) {
  const [info, active, available] = await Promise.all([
    read(c.registry, "evaluatorInfo", [evaluator]),
    read(c.registry, "isActive", [evaluator]),
    read(c.registry, "availableExposure", [evaluator]),
  ]);
  return {
    address: getAddress(evaluator),
    active,
    stake: s(info.stake),
    exposure: s(info.exposure),
    availableExposure: s(available),
    openJobs: Number(info.openJobs),
    unbondingEndsAt: s(info.unbondingEndsAt),
    slashedTotal: s(info.slashedTotal),
  };
}

export async function quote({ amount, providerBond = "0", evaluator }) {
  const c = contracts();
  const blockNumber = await publicClient.getBlockNumber();
  const a = BigInt(amount);
  const b = BigInt(providerBond);
  const [q, cfg, regCfg, arb] = await Promise.all([
    read(c.escrow, "quote", [a, b]),
    read(c.escrow, "currentConfig"),
    read(c.registry, "config"),
    refreshEscrowArbitrator(c),
  ]);
  const noArb = arb === ZERO;
  const aq = await read(c.adapter, "quote", [a]);
  const [fee, evaluatorFee, net, challengeBond, arbitrationFee, instantEligible, configVersion] = q;
  const out = {
    ...envelope(c, blockNumber),
    unit: "USDC base units (6 decimals)",
    amount: s(a),
    providerBond: s(b),
    feeBps: Number(cfg.feeBps),
    feeAtFullPayout: s(fee),
    providerNetAtFullPayout: s(net),
    feeChargedOn: "payout to provider only; 0 on reject/refund",
    evaluatorFeeBps: Number(cfg.evaluatorFeeBps),
    evaluatorFeeAtFullPayout: s(evaluatorFee),
    evaluatorFeeChargedOn: "provider gross on settled Complete/Partial when the verdict stands; 0 on reject, overturn, instant release",
    challengeBond: s(challengeBond),
    arbitrationFee: s(arbitrationFee),
    challengeUpfrontTotal: s(challengeBond + arbitrationFee),
    arbitrationFeeModel: noArb ? NO_ARBITRATOR_TEXT : "challenger pays bond + quoted arbitration cost; both held by the contract until the ruling; on a ruling the cost goes to the arbitrator and the losing side reimburses it if the ruling is material; on a stale dispute both are refunded to the challenger",
    challengeAvailable: !noArb,
    instantThreshold: s(cfg.instantThreshold),
    instantBondCoverBps: Number(cfg.instantBondCoverBps),
    instantEligible,
    requiredProviderBondForInstant: a <= cfg.instantThreshold ? s((a * BigInt(cfg.instantBondCoverBps)) / BPS) : null,
    evalWindowSeconds: Number(cfg.evalWindow),
    challengeWindowSeconds: Number(cfg.challengeWindow),
    configVersion: Number(configVersion),
    evaluatorMinStake: s(regCfg.minStake),
    exposureMultiplier: Number(regCfg.exposureMultiplier),
    // E-1a: for ERC-8183 kernel jobs evaluated through the adapter (budget = amount)
    erc8183Adapter: {
      challengeBond: s(aq[0]),
      arbitrationFee: s(aq[1]),
      requiredExpiryDurationSeconds: s(aq[2]),
      minKernelExpiry: s(aq[3]),
      minKernelExpiryRule: "kernel job expiredAt >= assign/accept time + evalWindow + challengeWindow + arbitrationTimeout + expiryMargin; assign and acceptAssignment revert ExpiryTooSoon otherwise",
      configVersion: Number(aq[4]),
    },
  };
  if (evaluator) {
    const ev = await evaluatorSnapshot(c, evaluator);
    out.evaluator = ev;
    out.evaluatorCanTakeAmount = ev.active && BigInt(ev.availableExposure) >= a;
  }
  return out;
}

// Per-job evidence cache (SQLite). A job in a terminal state is never rescanned; a live job is only
// scanned from its last scanned block (or the caller's fromBlock hint, e.g. the funding tx block).
export const TERMINAL_STATES = new Set(["Completed", "Rejected", "Partial", "Settled", "Expired", "Cancelled"]);
let _jc = null;
export function jobCache(file) {
  if (file || !_jc) {
    const f = file ?? process.env.AGENTCOIN_JOBCACHE_DB ?? path.join(process.env.SERVICE_STATE_DIR ?? path.join(AGENT_DIR, ".state", NETWORK), "jobcache.sqlite");
    if (f !== ":memory:") mkdirSync(path.dirname(f), { recursive: true });
    const db = new Database(f);
    db.exec("CREATE TABLE IF NOT EXISTS job_cache (escrow TEXT NOT NULL, job_id TEXT NOT NULL, scanned_to TEXT NOT NULL, state TEXT, final INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL, PRIMARY KEY (escrow, job_id))");
    _jc = db;
  }
  return _jc;
}
export async function jobEvidence(c, id, state, head, fromBlock, getLogs = rawLogsChunked, { maxBlocks } = {}) {
  const db = jobCache();
  const esc = c.escrow.address.toLowerCase();
  const row = db.prepare("SELECT * FROM job_cache WHERE escrow = ? AND job_id = ?").get(esc, String(id));
  const ev = row ? JSON.parse(row.evidence) : [];
  if (row?.final) return ev;
  const deploy = BigInt(c.d?.deployBlock ?? 0);
  let from = row ? BigInt(row.scanned_to) + 1n : fromBlock != null ? BigInt(fromBlock) : deploy;
  if (from < deploy) from = deploy;
  const cap = maxBlocks === undefined ? defaultEvidenceMaxBlocks() : maxBlocks == null ? null : BigInt(maxBlocks);
  let scanTo = head;
  if (cap != null && cap >= 0n && from <= head && scanTo - from + 1n > cap) scanTo = from + cap - 1n;
  if (from <= scanTo && (cap == null || cap > 0n)) {
    const logs = parseEventLogs({ abi: c.escrow.abi, logs: await getLogs(c.escrow.address, from, scanTo), strict: false }).filter((l) => l.args?.jobId === id);
    for (const l of logs) ev.push({ event: l.eventName, txHash: l.transactionHash, blockNumber: s(l.blockNumber), logIndex: l.logIndex });
  }
  const scannedTo = scanTo >= from && (cap == null || cap > 0n) ? scanTo : from - 1n;
  const reachedHead = scannedTo >= head || from > head;
  const fin = TERMINAL_STATES.has(state) && reachedHead ? 1 : 0;
  db.prepare("INSERT INTO job_cache (escrow, job_id, scanned_to, state, final, evidence) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(escrow, job_id) DO UPDATE SET scanned_to = excluded.scanned_to, state = excluded.state, final = excluded.final, evidence = excluded.evidence").run(esc, String(id), String(scannedTo), state, fin, JSON.stringify(ev));
  return ev;
}

export async function jobStatus(jobId, { fromBlock, maxEvidenceBlocks } = {}) {
  const c = contracts();
  const blockNumber = await publicClient.getBlockNumber();
  const id = BigInt(jobId);
  const count = await read(c.escrow, "jobCount");
  if (id === 0n || id > count) return { ...envelope(c, blockNumber), jobId: s(id), exists: false };
  const [j, d] = await Promise.all([read(c.escrow, "getJob", [id]), read(c.escrow, "getDispute", [id])]);
  const cfg = await read(c.escrow, "config", [j.configVersion]);
  const evidence = await jobEvidence(c, id, STATES[j.state], blockNumber, fromBlock, rawLogsChunked, { maxBlocks: maxEvidenceBlocks });
  const job = {
    jobId: s(id),
    exists: true,
    state: STATES[j.state],
    outcome: OUTCOMES[j.outcome],
    client: j.client,
    provider: j.provider,
    evaluator: j.evaluator,
    amount: s(j.amount),
    providerBond: s(j.providerBond),
    slashBase: s(j.slashBase),
    payoutBps: Number(j.payoutBps),
    instant: j.instant,
    accepted: j.accepted,
    configVersion: Number(j.configVersion),
    deadline: s(j.deadline),
    submittedAt: s(j.submittedAt),
    verdictAt: s(j.verdictAt),
    disputedAt: s(j.disputedAt),
    verdictDeadline: j.submittedAt > 0n ? s(j.submittedAt + cfg.evalWindow) : null,
    challengeDeadline: j.verdictAt > 0n ? s(j.verdictAt + cfg.challengeWindow) : null,
    specHash: j.specHash,
    deliverableHash: j.deliverableHash,
    reasonHash: j.reasonHash,
    dispute:
      d.challenger === "0x0000000000000000000000000000000000000000"
        ? null
        : { challenger: d.challenger, arbitrator: d.arbitrator, bond: s(d.bond), arbitrationFee: s(d.arbFee), disputeId: s(d.disputeId), reasonHash: d.reasonHash },
  };
  return {
    ...envelope(c, blockNumber),
    ...job,
    evidence,
  };
}

/** Bytecode hash of each deployed contract (keccak256 of eth_getCode). Lets a verifier check the manifest addresses. */
export async function codeHashes(c) {
  const out = {};
  for (const [k, v] of Object.entries(manifestContracts(c))) {
    if (!v.address) continue; // e.g. identityRegistry on networks without one
    const code = await publicClient.getCode({ address: v.address });
    out[k] = code ? keccak256(code) : null;
  }
  return out;
}

/** Contracts listed (with code hashes) in the trust manifest. externalKernel is a test mock and is excluded. */
export const manifestContracts = (c) => ({
  escrow: c.escrow,
  evaluatorRegistry: c.registry,
  token: c.usdc,
  arbitrator: c.arbitrator,
  identityRegistry: c.identity,
  evaluatorAdapter: c.adapter,
  depositRouteFactory: c.routeFactory,
});

/** Adapter (ERC-8183 evaluator) job view. */
export async function adapterJob(id) {
  const { ADAPTER_STATES } = await import("./config.mjs");
  const c = contracts();
  const blockNumber = await publicClient.getBlockNumber();
  const [j, d] = await Promise.all([read(c.adapter, "getJob", [BigInt(id)]), read(c.adapter, "getDispute", [BigInt(id)])]);
  return {
    ...envelope(c, blockNumber),
    id: s(BigInt(id)),
    kernel: j.kernel,
    kernelJobId: s(j.kernelJobId),
    state: ADAPTER_STATES[j.state],
    completes: j.completes,
    payoutBps: Number(j.payoutBps),
    budget: s(j.budget),
    slashBase: s(j.slashBase),
    evaluator: j.evaluator,
    dispute: d.challenger === "0x0000000000000000000000000000000000000000" ? null : { challenger: d.challenger, bond: s(d.bond), arbitrationFee: s(d.arbFee) },
  };
}
