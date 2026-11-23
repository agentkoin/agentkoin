// AD-011 Fix 1: evaluator listing (pure helpers). Buyers pick the evaluator per job; this module only describes what is
// on chain plus the labels in static/evaluators.json (or AGENTCOIN_EVALUATORS, a JSON array, for local chains).
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAddress, isAddress } from "viem";

export const SELECTION_TEXT = "query parameter evaluator=<address> on GET/POST /v1/notarize (any active EvaluatorRegistry evaluator); the address is part of the exact payTo route address (CREATE2 over the offer) and of the escrow job, so it is fixed by what the payer signs";

/** Labeled evaluators for a chain: AGENTCOIN_EVALUATORS (JSON array) overrides the bundled file. */
export function knownEvaluators({ agentDir, chainId, env = process.env }) {
  let list = [];
  if (env.AGENTCOIN_EVALUATORS) {
    try {
      list = JSON.parse(env.AGENTCOIN_EVALUATORS);
    } catch {
      list = [];
    }
  } else {
    try {
      list = JSON.parse(readFileSync(path.join(agentDir, "static", "evaluators.json"), "utf8")).networks?.[String(chainId)] ?? [];
    } catch {
      list = [];
    }
  }
  return list.filter((e) => isAddress(String(e.address ?? ""))).map((e) => ({ ...e, address: getAddress(e.address) }));
}

/** Merge labels, the reference evaluator and indexed stakers into one address -> label map (labels win). */
export function evaluatorCandidates({ known, reference, referenceLabel, stakers = [] }) {
  const m = new Map();
  for (const k of known) m.set(k.address, k);
  const ref = getAddress(reference);
  if (!m.has(ref)) m.set(ref, { address: ref, role: "reference", label: referenceLabel, operator: "STOS Technologies LLC" });
  for (const a of stakers) {
    const g = getAddress(a);
    if (!m.has(g)) m.set(g, { address: g, role: "registered", label: null, operator: null });
  }
  return [...m.values()];
}

/** One listing row (factual fields only). */
export function evaluatorRow(k, { snapshot, exactPayTo, trackRecord, links, isDefault }) {
  return {
    address: k.address,
    role: k.role ?? "registered",
    label: k.label ?? null,
    operator: k.operator ?? null,
    process: k.process ?? null,
    processStatus: k.processStatus ?? null,
    // optional factual tags for evaluators not operated by STOS (present only when set in the label file)
    ...(k.independent != null ? { independent: !!k.independent } : {}),
    ...(k.source ? { source: k.source } : {}),
    ...(Array.isArray(k.funding) ? { funding: k.funding } : {}),
    default: !!isDefault,
    active: snapshot.active,
    stake: snapshot.stake,
    availableExposure: snapshot.availableExposure,
    openJobs: snapshot.openJobs,
    slashedTotal: snapshot.slashedTotal,
    exactPayTo,
    trackRecord: trackRecord ?? null,
    trackRecordUrl: `${links.evaluators}/${k.address}`,
    select: `${links.notarize}?evaluator=${k.address}`,
  };
}

/** Counts over JobEscrow.getJob rows. Evaluators with no jobs are absent (caller serves trackRecord: null). */
export function accumulateTrackRecords(jobs, jobCount) {
  const rep = new Map();
  for (const j of jobs) {
    const r = rep.get(j.evaluator) ?? {
      jobsAssigned: 0,
      verdicts: 0,
      verdictsByOutcome: { Complete: 0, Reject: 0, Partial: 0 },
      settled: 0,
      disputed: 0,
      missedVerdicts: 0,
      refundedBeforeSubmission: 0,
      open: 0,
      indexedJobs: Number(jobCount),
    };
    r.jobsAssigned++;
    if (j.verdictAt > 0 && !j.instant && r.verdictsByOutcome[j.outcome] !== undefined) {
      r.verdicts++;
      r.verdictsByOutcome[j.outcome]++;
    }
    if (j.state === "Settled") r.settled++;
    else if (j.state === "Disputed") r.disputed++;
    else if (j.state === "Expired" && j.submittedAt > 0 && j.verdictAt === 0) r.missedVerdicts++;
    else if (j.state === "Expired" || j.state === "Cancelled") r.refundedBeforeSubmission++;
    else r.open++;
    rep.set(j.evaluator, r);
  }
  return rep;
}

/** The 60s evaluator listing cache must not be written or hit until the first job-index pass succeeds. */
export function shouldCacheEvaluatorList(indexReady) {
  return !!indexReady;
}

/** Await an in-flight first index so a request just after boot does not snapshot trackRecord: null for 60s. */
export function shouldAwaitJobIndex(indexReady, inFlight) {
  return !indexReady && inFlight != null;
}


/** Bug fix (x402 #4324): GET /v1/evaluators `list` was built from the staker index but never triggered a refresh of it
 *  (only `all` / the per-address route did, in the background), so a new staker was missing from `list` until a later
 *  request; and a list built while a refresh finished was cached 60 s with the pre-refresh stakers. */
export function listNeedsFreshScan({ indexReady, scanAtMs, ttlMs, now }) {
  return !!indexReady && now - scanAtMs >= ttlMs;
}

/** A cached list is reusable only if the index was ready, it is under 60 s old, and no refresh finished since it was built. */
export function evaluatorListCacheValid({ indexReady, cached, now, generation, maxAgeMs = 60_000 }) {
  return !!indexReady && !!cached && cached.generation === generation && now - cached.at < maxAgeMs;
}
