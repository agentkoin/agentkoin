// Escrow-direct job statistics for GET /v1/stats.
// /v1/notarize payers only cover jobs opened through this service. Jobs funded directly on a JobEscrow
// (v0.5 / v0.6 createAndFund*, fund) are indexed here from on-chain state: jobCount() + getJob(id) per escrow.
// Why not JobFunded logs: sepolia.base.org caps eth_getLogs at 200 blocks (v0.5 deploy block is ~9M blocks behind
// head), so a log scan would need tens of thousands of RPC calls. getJob carries the same facts (client, evaluator,
// state) and a job counts as funded iff state is past Open and the pinned slashBase is set at fund (JobFunded emits
// in the same _fund() call that sets both). Terminal jobs are cached, reads per refresh are bounded and persisted
// to <stateDir>/escrow-stats-cache.json, and the stats response never awaits RPC.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

export const ESCROW_STATS_CACHE_VERSION = 1;
export const DEFAULT_ESCROW_STATS_TTL_MS = 120_000;
export const DEFAULT_ESCROW_STATS_MAX_READS = 150;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TERMINAL = new Set(["Settled", "Expired", "Cancelled"]);
const UNFUNDED = new Set(["None", "Open"]);

/** Base Sepolia escrows: addresses from deployments/base-sepolia.json (v0.5) and deployments/base-sepolia-v06.json (v0.6). */
export const DEFAULT_ESCROWS = {
  84532: [
    { label: "v0.5", address: "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D", primary: true },
    { label: "v0.6", address: "0xd6E00d3419C16a3bEE1B8CC030A7062bf2014b2c" },
  ],
};

const lc = (a) => String(a).toLowerCase();

/** Labeled STOS-operated wallets (public address constants from deployments/*.json and Research's ops records). */
export const INTERNAL_WALLETS = [
  { label: "deployer", address: "0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e" },
  { label: "reference-evaluator", address: "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a" },
  { label: "relayer", address: "0x0a7BFbed71B157Eb3Ce3140CA197f41B43D4877C" },
  { label: "stos-demo-buyer-1", address: "0x600D4d4A0FeeF7877ACCb91351fFe2AA66CF18cb" },
  { label: "stos-demo-buyer-2", address: "0x0b47dc4d735d37f38Cb74b74A52927DafdeDF388" },
  { label: "stos-demo-buyer-3", address: "0xA6400ccE36C97Ad47f65047fB3DfCBc345c114bc" },
  // first Base Sepolia ETH (tx 0x9c972ea2...580b) and first test USDC (tx 0x61f3dbf5...031a) both came from the deployer
  { label: "stos-internal-deployer-funded", address: "0xbCc3df647a88aF9FF82Df31D74A38F26DDD90E3b" },
];

/** Outside wallets that are an integrator's own self-test traffic: still outside, tagged, and excluded from the customer count. */
export const BUILDER_SELF_TESTS = [{ label: "x402toll self-test", address: "0x319f6837c6e7b1a7f1703fd909cdd85416d48c7e" }];

/** Known/internal wallet set from address constants only (never key files). */
export function knownInternalAddresses({ internalAddrs = [], knownEvaluators = [], deploymentsDir = null } = {}) {
  const s = new Set();
  const add = (a) => ADDR.test(String(a ?? "").trim()) && s.add(lc(a.trim()));
  internalAddrs.forEach(add);
  INTERNAL_WALLETS.forEach((w) => add(w.address));
  for (const e of knownEvaluators) {
    if (e.role === "independent" || /not STOS/i.test(String(e.label ?? ""))) continue;
    if (e.role === "reference" || e.role === "test" || /STOS/i.test(String(e.operator ?? ""))) add(e.address);
  }
  if (deploymentsDir) {
    try {
      const d = JSON.parse(readFileSync(path.join(deploymentsDir, "base-sepolia.json"), "utf8"));
      for (const k of ["deployer", "treasury"]) add(d[k]);
      for (const k of d.keeperConfig?.keepers ?? []) add(k);
    } catch {}
    try {
      const d = JSON.parse(readFileSync(path.join(deploymentsDir, "base-sepolia-v06.json"), "utf8"));
      add(d.deployer);
      for (const c of Object.values(d.contracts ?? {})) { add(c.owner); add(c.treasury); }
    } catch {}
  }
  return s;
}

function loadCache(file) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j?.version !== ESCROW_STATS_CACHE_VERSION || !Array.isArray(j.jobs)) return null;
    return { scannedAtMs: Date.parse(j.scannedAt) || 0, jobs: new Map(j.jobs) };
  } catch {
    return null;
  }
}

function saveCache(file, scannedAtMs, jobs) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: ESCROW_STATS_CACHE_VERSION, scannedAt: new Date(scannedAtMs).toISOString(), jobs: [...jobs] }));
    renameSync(tmp, file);
  } catch {}
}

export class EscrowJobIndex {
  /**
   * @param escrows [{label, address, primary?}]
   * @param reader  { jobCount(escrow) -> bigint|number, getJob(escrow, id) -> {client, evaluator, state:string, slashBase} }
   */
  constructor({ escrows, reader, file = null, ttlMs = DEFAULT_ESCROW_STATS_TTL_MS, maxReads = DEFAULT_ESCROW_STATS_MAX_READS, now = () => Date.now() }) {
    this.escrows = escrows;
    this.reader = reader;
    this.file = file;
    this.ttlMs = ttlMs;
    this.maxReads = maxReads;
    this.now = now;
    this.jobs = new Map(); // `${label}:${id}` -> {l,id,client,evaluator,state,funded}
    this.counts = new Map(); // label -> jobCount seen
    this.scannedAtMs = 0;
    this.source = "none";
    this.complete = false;
    this.lastError = null;
    this.inFlight = null;
    const c = file && existsSync(file) ? loadCache(file) : null;
    if (c) {
      this.jobs = c.jobs;
      this.scannedAtMs = c.scannedAtMs;
      this.source = "cache";
    }
  }

  /** Single-flight, bounded refresh; never rejects. */
  refresh(force = false) {
    if (this.inFlight) return this.inFlight;
    if (!force && this.source !== "none" && this.now() - this.scannedAtMs < this.ttlMs) return Promise.resolve();
    this.inFlight = (async () => {
      let budget = this.maxReads;
      let complete = true;
      let err = null;
      const tasks = [];
      for (const esc of this.escrows) {
        try {
          const n = Number(await this.reader.jobCount(esc));
          this.counts.set(esc.label, n);
          for (let id = 1; id <= n; id++) {
            const prev = this.jobs.get(`${esc.label}:${id}`);
            if (!TERMINAL.has(prev?.state)) tasks.push({ esc, id, seen: !!prev });
          }
        } catch (e) {
          complete = false;
          err = String(e?.shortMessage ?? e?.message ?? e).slice(0, 160);
        }
      }
      tasks.sort((x, y) => Number(x.seen) - Number(y.seen)); // never-read jobs first so re-reads cannot starve new ones
      for (const { esc, id } of tasks) {
        if (budget <= 0) { complete = false; break; }
        budget--;
        try {
          const j = await this.reader.getJob(esc, id);
          const funded = !UNFUNDED.has(j.state) && !(j.state === "Cancelled" && !(BigInt(j.slashBase ?? 0) > 0n));
          this.jobs.set(`${esc.label}:${id}`, { l: esc.label, id, client: lc(j.client), evaluator: lc(j.evaluator), state: j.state, funded });
        } catch (e) {
          complete = false;
          err = String(e?.shortMessage ?? e?.message ?? e).slice(0, 160);
        }
      }
      this.complete = complete;
      this.lastError = err;
      if (!err) { this.scannedAtMs = this.now(); this.source = "live"; }
      else if (this.source === "none" && this.jobs.size) this.source = "partial";
      if (this.file && this.jobs.size) saveCache(this.file, this.scannedAtMs || this.now(), this.jobs);
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * @param internal Set of lowercase internal addresses
   * @param notarizeJobIds ids (on the primary escrow) that /v1/notarize opened; those are not "escrow-direct"
   * @param notarizePayersOutside Set of lowercase outside payer addresses from the notarize path
   */
  snapshot({ internal = new Set(), notarizeJobIds = [], notarizePayers = [], builderSelfTests = BUILDER_SELF_TESTS } = {}) {
    const selfTest = new Map(builderSelfTests.map((b) => [lc(b.address), b.label]));
    const primary = this.escrows.find((e) => e.primary)?.label;
    const viaNotarize = new Set([...notarizeJobIds].map((id) => `${primary}:${Number(id)}`));
    const funded = [...this.jobs.values()].filter((j) => j.funded);
    const direct = funded.filter((j) => !viaNotarize.has(`${j.l}:${j.id}`));
    const outC = new Set(), outE = new Set(), inC = new Set(), inE = new Set();
    let jobsOutC = 0, jobsOutE = 0;
    for (const j of direct) {
      if (internal.has(j.client)) inC.add(j.client); else { outC.add(j.client); jobsOutC++; }
      if (internal.has(j.evaluator)) inE.add(j.evaluator); else { outE.add(j.evaluator); jobsOutE++; }
    }
    const payersOutside = new Set([...notarizePayers].map(lc).filter((a) => !internal.has(a)));
    const combined = new Set([...payersOutside, ...outC]);
    const customers = new Set([...outC].filter((a) => !selfTest.has(a)));
    const customersCombined = new Set([...combined].filter((a) => !selfTest.has(a)));
    return {
      escrows: this.escrows.map((e) => ({ label: e.label, address: e.address, jobCount: this.counts.get(e.label) ?? null, jobsFunded: funded.filter((j) => j.l === e.label).length })),
      jobsFundedTotal: funded.length,
      jobsFundedViaNotarize: funded.length - direct.length,
      jobsFundedEscrowDirect: direct.length,
      escrowDirectJobsWithOutsideClient: jobsOutC,
      escrowDirectJobsWithOutsideEvaluator: jobsOutE,
      uniqueOutsideClientAddresses: outC.size,
      uniqueOutsideEvaluatorAddresses: outE.size,
      uniqueInternalClientAddresses: inC.size,
      uniqueInternalEvaluatorAddresses: inE.size,
      uniqueOutsideClientAddressesCombined: combined.size,
      uniqueOutsideCustomerAddresses: customers.size,
      uniqueOutsideCustomerAddressesCombined: customersCombined.size,
      builderSelfTestClientAddresses: outC.size - customers.size,
      outsideClients: [...outC].sort().map((address) => ({ address, builderSelfTest: selfTest.has(address), ...(selfTest.has(address) ? { label: selfTest.get(address) } : {}) })),
      outsideEvaluators: [...outE].sort(),
      method: "JobEscrow.jobCount()+getJob(id) per escrow (public RPC caps eth_getLogs at 200 blocks); funded = state past Open (equivalent to a JobFunded emission); known internal wallets excluded; jobs opened by /v1/notarize are deduplicated",
      freshness: { scannedAt: this.scannedAtMs ? new Date(this.scannedAtMs).toISOString() : null, source: this.source, complete: this.complete, ttlSeconds: Math.round(this.ttlMs / 1000), lastError: this.lastError },
    };
  }
}
