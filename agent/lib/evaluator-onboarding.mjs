// Evaluator onboarding v1 (daily spec 2026-11-19): signed evaluator profiles, full staker listing with status and
// top-up calls, become-a-judge steps, queue-only canary requests. Pure helpers + JSON-file stores. This module does
// not import the chain or key modules: it never constructs a signer and never sends a transaction.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress, isAddress, verifyMessage } from "viem";
import { keccakJcs, omit } from "./canonical.mjs";

export const PROFILE_TYPE = "agentkoin-evaluator-profile/v1";
export const CANARY_TYPE = "agentkoin-canary-request/v1";
export const MAX_AGE_SECONDS = 600; // issuedAt older than 10 min is rejected
export const MAX_SKEW_SECONDS = 120; // issuedAt more than 2 min in the future is rejected
export const CANARY_AMOUNT = "100000"; // 0.1 test USDC (6 decimals)
export const STATUS = Object.freeze({ ACTIVE: "active", BELOW_MIN: "below_min_stake", UNSTAKED: "unstaked" });
export const SIGNING_TEXT =
  "signature = EIP-191 personal_sign over the 32 raw bytes of keccak256(RFC 8785 JCS of the request object without the signature field); signer must equal address";

const HTTPS = (s) => {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
};
const err = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

/** keccak256(JCS(doc without signature)): the 32 bytes the evaluator signs (EIP-191, raw message). */
export const signedDigest = (doc) => keccakJcs(omit(doc, ["signature"]));

/** Field validation for a profile document (no signature check). Returns { error } or { profile }. */
export function validateProfileFields(o) {
  const allowed = ["type", "chainId", "registry", "address", "name", "url", "contact", "verdictEndpoint", "criteriaKinds", "issuedAt", "signature"];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return { error: `unknown field: ${k}` };
  if (typeof o.name !== "string" || o.name.trim().length < 1 || o.name.length > 64) return { error: "name: string, 1-64 chars" };
  if (o.url !== undefined && !(typeof o.url === "string" && o.url.length <= 300 && HTTPS(o.url))) return { error: "url: https URL, <= 300 chars" };
  if (o.contact !== undefined && !(typeof o.contact === "string" && o.contact.length <= 200)) return { error: "contact: string, <= 200 chars (published as given)" };
  if (o.verdictEndpoint !== undefined && !(typeof o.verdictEndpoint === "string" && o.verdictEndpoint.length <= 300 && HTTPS(o.verdictEndpoint))) return { error: "verdictEndpoint: https URL, <= 300 chars" };
  if (o.criteriaKinds !== undefined) {
    if (!Array.isArray(o.criteriaKinds) || o.criteriaKinds.length > 16 || !o.criteriaKinds.every((x) => typeof x === "string" && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(x)))
      return { error: "criteriaKinds: array of <= 16 strings matching ^[a-z0-9][a-z0-9._-]{0,39}$" };
  }
  const profile = { name: o.name };
  for (const k of ["url", "contact", "verdictEndpoint", "criteriaKinds"]) if (o[k] !== undefined) profile[k] = o[k];
  return { profile };
}

/**
 * Envelope + signature check shared by profile and canary requests.
 * ctx: { type, chainId, registry, now (unix seconds) }. Returns { ok: true, address, digest, issuedAt } or err().
 */
export async function verifySignedRequest(o, ctx) {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return err(400, "body must be a JSON object");
  if (o.type !== ctx.type) return err(400, `type must be "${ctx.type}"`);
  if (o.chainId !== ctx.chainId) return err(400, `chainId must be ${ctx.chainId}`);
  if (typeof o.registry !== "string" || !isAddress(o.registry) || getAddress(o.registry) !== getAddress(ctx.registry)) return err(400, `registry must be ${getAddress(ctx.registry)}`);
  if (typeof o.address !== "string" || !isAddress(o.address)) return err(400, "address must be a 0x address");
  if (!Number.isSafeInteger(o.issuedAt)) return err(400, "issuedAt must be unix seconds (integer)");
  const now = ctx.now;
  if (o.issuedAt < now - MAX_AGE_SECONDS) return err(401, "issuedAt is older than 600 seconds", { now });
  if (o.issuedAt > now + MAX_SKEW_SECONDS) return err(401, "issuedAt is more than 120 seconds in the future", { now });
  if (typeof o.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(o.signature)) return err(400, "signature must be a 65-byte 0x hex string");
  const address = getAddress(o.address);
  let digest;
  try {
    digest = signedDigest(o);
  } catch {
    return err(400, "request is not canonicalizable JSON");
  }
  let valid = false;
  try {
    valid = await verifyMessage({ address, message: { raw: digest }, signature: o.signature });
  } catch {
    valid = false;
  }
  if (!valid) return err(401, "signature does not recover to address", { digest });
  return { ok: true, address, digest, issuedAt: o.issuedAt };
}

/** Listing status from a registry snapshot ({ active, stake, unbondingEndsAt }) and minStake. */
export function stakeStatus(snapshot, minStake) {
  const stake = BigInt(snapshot.stake);
  const min = BigInt(minStake);
  if (stake === 0n) return { status: STATUS.UNSTAKED, shortfall: min.toString() };
  if (snapshot.active) return { status: STATUS.ACTIVE, shortfall: "0" };
  return { status: STATUS.BELOW_MIN, shortfall: (stake >= min ? 0n : min - stake).toString(), unbonding: BigInt(snapshot.unbondingEndsAt ?? 0) !== 0n };
}

/** Exact calls that bring a below-minimum stake back to minStake. EvaluatorRegistry.stake reverts while unbonding. */
export function topUpPlan({ shortfall, registry, token, unbonding }) {
  if (unbonding) return { amount: shortfall, possible: false, reason: "EvaluatorRegistry.stake reverts while unbonding (AlreadyUnbonding)" };
  return {
    amount: shortfall,
    possible: true,
    registry: getAddress(registry),
    token: getAddress(token),
    calls: [
      { to: getAddress(token), function: "approve(address,uint256)", args: [getAddress(registry), shortfall] },
      { to: getAddress(registry), function: "stake(uint256)", args: [shortfall] },
    ],
  };
}

/** Steps for an evaluator without a profile (factual pointers only). */
export function nextSteps(links) {
  return [
    { step: "sign profile", method: "POST", url: links.evaluatorProfile, doc: links.evaluatorDocs },
    { step: "run judge-kit watcher", command: "node src/watch.ts --evaluator <address> --loop", url: links.judgeKit },
    { step: "request canary job", method: "POST", url: links.evaluatorCanary, doc: links.evaluatorDocs },
  ];
}

/** Machine-readable become-a-judge block (served at /v1/evaluators/onboarding and inside /v1/evaluators). */
export function onboardingBlock({ links, registry, token, minStake, chainId }) {
  return {
    v: "agentkoin-evaluator-onboarding/v1",
    chainId,
    registry: getAddress(registry),
    token: getAddress(token),
    minStake: String(minStake),
    signing: SIGNING_TEXT,
    steps: [
      { step: "stake", calls: [{ to: getAddress(token), function: "approve(address,uint256)", args: [getAddress(registry), String(minStake)] }, { to: getAddress(registry), function: "stake(uint256)", args: [String(minStake)] }] },
      { step: "sign profile", method: "POST", url: links.evaluatorProfile, type: PROFILE_TYPE, fields: { required: ["type", "chainId", "registry", "address", "name", "issuedAt", "signature"], optional: ["url", "contact", "verdictEndpoint", "criteriaKinds"] }, eligibility: [STATUS.ACTIVE, STATUS.BELOW_MIN] },
      { step: "run judge-kit watcher", url: links.judgeKit },
      { step: "request canary job", method: "POST", url: links.evaluatorCanary, type: CANARY_TYPE, fields: { required: ["type", "chainId", "registry", "address", "issuedAt", "signature"] }, eligibility: [STATUS.ACTIVE], amount: CANARY_AMOUNT, mode: "queue-only; the on-chain job is created by an operator batch run" },
      { step: "first real job", selection: `?evaluator=<address> on ${links.notarize}` },
    ],
    slashRule: "missed verdict: JobEscrow.timeoutRelease slashes the assigned evaluator (SLASH_MISSED_VERDICT); amount per escrow config; stake below minStake sets isActive=false",
    docs: links.evaluatorDocs,
  };
}

// ---------------- stores (JSON files in the service state dir) ----------------
function atomicWrite(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export class ProfileStore {
  constructor(file) {
    this.file = file;
    this.d = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { v: 1, profiles: {} };
  }
  get(address) {
    return this.d.profiles[getAddress(address)] ?? null;
  }
  all() {
    return this.d.profiles;
  }
  /** Overwrite only by the same signer with a strictly newer issuedAt. */
  put(address, rec) {
    const a = getAddress(address);
    const cur = this.d.profiles[a];
    if (cur && getAddress(cur.signer) !== getAddress(rec.signer)) return { ok: false, status: 403, error: "profile exists and is owned by a different signer" };
    if (cur && rec.issuedAt <= cur.issuedAt) return { ok: false, status: 409, error: "issuedAt must be newer than the stored profile's issuedAt", storedIssuedAt: cur.issuedAt };
    this.d.profiles[a] = rec;
    atomicWrite(this.file, JSON.stringify(this.d, null, 2) + "\n");
    return { ok: true, replaced: !!cur };
  }
}

export class CanaryQueue {
  constructor(file) {
    this.file = file;
  }
  /** Append-only JSON lines; a later line with the same id updates that request (last write wins per field). */
  entries() {
    if (!existsSync(this.file)) return [];
    const m = new Map();
    for (const l of readFileSync(this.file, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(l);
      m.set(e.id, { ...(m.get(e.id) ?? {}), ...e });
    }
    return [...m.values()];
  }
  pendingFor(address) {
    const a = getAddress(address);
    return this.entries().find((e) => e.address === a && e.status === "queued") ?? null;
  }
  append(rec) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
  }
}

/**
 * Handlers. deps: { chainId, registry, now(), status(address) -> { everStaked, status, stake, minStake, shortfall },
 * profiles: ProfileStore, queue: CanaryQueue }. No signer or wallet is passed in or created.
 */
export async function handleProfile(body, deps) {
  const v = await verifySignedRequest(body, { type: PROFILE_TYPE, chainId: deps.chainId, registry: deps.registry, now: deps.now() });
  if (!v.ok) return v;
  const f = validateProfileFields(body);
  if (f.error) return err(400, f.error);
  const st = await deps.status(v.address);
  if (!st.everStaked && BigInt(st.stake) === 0n) return err(403, "address has never staked on the EvaluatorRegistry", { address: v.address });
  if (![STATUS.ACTIVE, STATUS.BELOW_MIN].includes(st.status)) return err(403, `status ${st.status}: profiles require ${STATUS.ACTIVE} or ${STATUS.BELOW_MIN}`, { address: v.address, stakeStatus: st.status });
  const rec = { ...f.profile, address: v.address, signer: v.address, issuedAt: v.issuedAt, digest: v.digest, signature: body.signature, receivedAt: Math.floor(deps.now()) };
  const put = deps.profiles.put(v.address, rec);
  if (!put.ok) return err(put.status, put.error, put.storedIssuedAt != null ? { storedIssuedAt: put.storedIssuedAt } : {});
  return { ok: true, status: put.replaced ? 200 : 201, body: { result: put.replaced ? "replaced" : "stored", address: v.address, digest: v.digest, profile: publicProfile(rec) } };
}

export async function handleCanary(body, deps) {
  const v = await verifySignedRequest(body, { type: CANARY_TYPE, chainId: deps.chainId, registry: deps.registry, now: deps.now() });
  if (!v.ok) return v;
  for (const k of Object.keys(body)) if (!["type", "chainId", "registry", "address", "issuedAt", "signature"].includes(k)) return err(400, `unknown field: ${k}`);
  const st = await deps.status(v.address);
  if (!st.everStaked && BigInt(st.stake) === 0n) return err(403, "address has never staked on the EvaluatorRegistry", { address: v.address });
  if (st.status !== STATUS.ACTIVE) return err(409, `status ${st.status}: canary jobs require ${STATUS.ACTIVE}`, { address: v.address, stakeStatus: st.status, shortfall: st.shortfall });
  const pending = deps.queue.pendingFor(v.address);
  if (pending) return { ok: true, status: 200, body: { result: "already_queued", request: pending } };
  const rec = { id: `cr_${v.digest.slice(2, 18)}`, address: v.address, amount: CANARY_AMOUNT, asset: "test USDC (6 decimals)", requestedAt: Math.floor(deps.now()), issuedAt: v.issuedAt, digest: v.digest, signature: body.signature, status: "queued" };
  deps.queue.append(rec);
  return { ok: true, status: 202, body: { result: "queued", mode: "queue-only", request: rec, onchain: null, operatorScript: "agent/scripts/run-canary.mjs" } };
}

export const publicProfile = (rec) =>
  rec ? { name: rec.name, url: rec.url ?? null, contact: rec.contact ?? null, verdictEndpoint: rec.verdictEndpoint ?? null, criteriaKinds: rec.criteriaKinds ?? [], issuedAt: rec.issuedAt, signer: rec.signer, digest: rec.digest, signature: rec.signature } : null;

/** One row of the complete listing (every address that ever staked, plus labeled/reference evaluators). */
export function fullRow({ candidate, snapshot, minStake, stakeEvent, profile, links, registry, token }) {
  const st = stakeStatus(snapshot, minStake);
  const row = {
    address: candidate.address,
    status: st.status,
    role: candidate.role ?? "registered",
    label: candidate.label ?? null,
    operator: candidate.operator ?? null,
    stake: String(snapshot.stake),
    minStake: String(minStake),
    shortfall: st.shortfall,
    slashedTotal: String(snapshot.slashedTotal ?? "0"),
    unbondingEndsAt: String(snapshot.unbondingEndsAt ?? "0"),
    openJobs: snapshot.openJobs ?? 0,
    stakeTx: stakeEvent?.tx ?? null,
    stakedAt: stakeEvent?.timestamp != null ? new Date(Number(stakeEvent.timestamp) * 1000).toISOString() : null,
    stakeBlock: stakeEvent?.block != null ? String(stakeEvent.block) : null,
    profile: publicProfile(profile),
    trackRecordUrl: `${links.evaluators}/${candidate.address}`,
  };
  if (st.status === STATUS.BELOW_MIN) row.topUp = topUpPlan({ shortfall: st.shortfall, registry, token, unbonding: st.unbonding });
  if (!profile) row.nextSteps = nextSteps(links);
  return row;
}

/** Fold Staked logs ({ evaluator, txHash, blockNumber }) into address -> latest stake event; timestamps filled later. */
export function foldStakeEvents(map, logs) {
  for (const l of logs) {
    const a = getAddress(l.evaluator);
    const cur = map.get(a);
    const b = BigInt(l.blockNumber);
    if (!cur || BigInt(cur.block) < b) map.set(a, { tx: l.txHash, block: b.toString(), timestamp: l.timestamp ?? null, count: (cur?.count ?? 0) + 1 });
    else cur.count++;
  }
  return map;
}
