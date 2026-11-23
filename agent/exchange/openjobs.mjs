// AgentKoin Exchange open-jobs board (testnet): a buyer posts a task with a budget and machine-checkable criteria
// (EIP-712 OpenJob signature); an agent claims it (EIP-712 Claim signature, exclusive for claimTtl); the buyer funds the
// existing JobEscrow (x402 or unsigned txs) with provider = claimer; delivery, verdict and payout follow the normal
// Exchange order flow (ex_orders row with listing_id = the open job id). No contract changes. Plus the earn view
// (find_earning_opportunities). Buyer fee: see exchangeFee in exchange.mjs (default 0.8%, min 0.05 USDC, buyer pays).

import { TESTNET } from "../lib/network.mjs";
import { randomBytes } from "node:crypto";
import { keccak256, toBytes, getAddress, isAddress, recoverTypedDataAddress, encodeFunctionData, erc20Abi } from "viem";
import { jcs } from "../lib/canonical.mjs";
import { ExchangeError, criteriaBytes, sha256Hex, exchangeFee, feeQuote, EXCHANGE_FEE_BPS, EXCHANGE_FEE_MIN, FREE_JUDGING_THROUGH } from "./exchange.mjs";

export const OPEN_JOB_TYPES = { OpenJob: [{ name: "buyer", type: "address" }, { name: "jobHash", type: "bytes32" }, { name: "expiresAt", type: "uint256" }] };
export const CLAIM_TYPES = { Claim: [{ name: "claimer", type: "address" }, { name: "openJobId", type: "string" }, { name: "expiresAt", type: "uint256" }] };
export const OPEN_JOB_LIMITS = {
  maxOpenJobsPerBuyer: 10,
  maxOpenJobs: 2000,
  maxActiveClaimsPerClaimer: 3,
  claimTtlSeconds: 2 * 3600, // the buyer funds within this window, else the claim lapses and the job reopens
  defaultOpenSeconds: 7 * 86400,
  maxOpenSeconds: 30 * 86400,
  maxPostsPerIpPerHour: 20,
};
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ex_open_jobs (
  id TEXT PRIMARY KEY, buyer TEXT NOT NULL, doc TEXT NOT NULL, category TEXT NOT NULL, budget TEXT NOT NULL, spec_hash TEXT NOT NULL,
  status TEXT NOT NULL, claimer TEXT, claim_expires_at INTEGER, order_id TEXT, expires_at INTEGER NOT NULL, signature TEXT,
  claims TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ex_open_jobs_status ON ex_open_jobs(status);
CREATE INDEX IF NOT EXISTS ex_open_jobs_buyer ON ex_open_jobs(buyer);
`;
const J = (v) => (v == null ? null : JSON.stringify(v));
const P = (s) => (s == null ? null : JSON.parse(s));
const iso = (ms) => new Date(ms).toISOString();
const lc = (a) => String(a ?? "").toLowerCase();
const slug = (s) => String(s ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
const TERMINAL_ORDER = new Set(["settled", "expired", "cancelled"]);

/** Criteria for an open job: same three machine checks as listing criteria; bound to the open job id and buyer (claimer unknown at post time). */
export function buildOpenJobCriteria({ openJobId, buyer, escrow, chainId, outputSchema, buyerCriteria = null }) {
  return {
    v: "agentkoin-exchange-criteria/v1",
    chainId,
    escrow,
    openJobId,
    buyer: getAddress(buyer),
    deliverableFormat: "UTF-8 JSON object {\"jobId\": \"<decimal job id>\", \"output\": <any JSON>}; the provider (claimer) submits deliverableHash = sha256(exact deliverable bytes)",
    outputSchema: outputSchema ?? { type: "object" },
    checks: [
      { id: "deliverable-hash", pass: "sha256(deliverable bytes) == getJob(jobId).deliverableHash" },
      { id: "job-binding", pass: "deliverable.jobId == jobId (decimal string)" },
      { id: "output-schema", pass: "deliverable.output validates against outputSchema (JSON Schema 2020-12)" },
    ],
    verdict: { complete: "every check passes (payoutBps 10000)", reject: "any check fails (payoutBps 0)" },
    machineCheckable: true,
    buyerCriteria, // untrusted buyer text; not judged by the automated checks
    outOfScope: ["truth, quality or usefulness of the output beyond outputSchema", "identity of buyer or provider", "any mainnet or real-value transaction"],
    testnet: TESTNET,
    realValue: false,
  };
}

export class OpenJobs {
  constructor(ex, o = {}) {
    this.ex = ex;
    this.db = ex.db;
    this.o = o;
    this.limits = { ...OPEN_JOB_LIMITS, ...(o.limits ?? {}) };
    this.db.exec(SCHEMA);
    this.postHits = new Map();
  }
  now() {
    return this.ex.now();
  }
  typedData(buyer, job, expiresAt) {
    return { domain: this.ex.domain, types: OPEN_JOB_TYPES, primaryType: "OpenJob", message: { buyer: getAddress(buyer), jobHash: keccak256(toBytes(jcs(job))), expiresAt: String(expiresAt) } };
  }
  claimTypedData(claimer, id, expiresAt) {
    return { domain: this.ex.domain, types: CLAIM_TYPES, primaryType: "Claim", message: { claimer: getAddress(claimer), openJobId: id, expiresAt: String(expiresAt) } };
  }
  normalise(j) {
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new ExchangeError(400, "job object required");
    const L = this.ex.limits;
    const str = (v, n, k, req = false) => {
      if (v == null || v === "") {
        if (req) throw new ExchangeError(400, `${k} required`);
        return null;
      }
      if (typeof v !== "string" || v.length > n) throw new ExchangeError(400, `${k} must be a string of at most ${n} chars`);
      return v.trim();
    };
    const title = str(j.title, 120, "title", true);
    const budget = String(j.budget ?? "");
    if (!/^[0-9]{1,20}$/.test(budget)) throw new ExchangeError(400, "budget (USDC base units, decimal string) required");
    if (BigInt(budget) < BigInt(L.minJobAmount) || BigInt(budget) > BigInt(L.maxJobAmount)) throw new ExchangeError(400, `budget must be ${L.minJobAmount}..${L.maxJobAmount} (test USDC base units; EscrowDepositRoute facilitator max)`);
    const sla = Number(j.sla_seconds ?? 3600);
    if (!Number.isInteger(sla) || sla < L.minSlaSeconds || sla > L.maxSlaSeconds) throw new ExchangeError(400, `sla_seconds must be an integer ${L.minSlaSeconds}..${L.maxSlaSeconds}`);
    const open = Number(j.open_seconds ?? this.limits.defaultOpenSeconds);
    if (!Number.isInteger(open) || open < 600 || open > this.limits.maxOpenSeconds) throw new ExchangeError(400, `open_seconds must be an integer 600..${this.limits.maxOpenSeconds}`);
    const category = slug(j.category ?? title);
    if (!category) throw new ExchangeError(400, "category required (e.g. summarize, translate, extract)");
    const schema = j.deliverable_schema ?? { type: "object" };
    if (typeof schema !== "object" || Array.isArray(schema) || jcs(schema).length > 8192) throw new ExchangeError(400, "deliverable_schema must be a JSON Schema object (<= 8 KB)");
    if (j.input != null && jcs(j.input).length > L.maxInputBytes) throw new ExchangeError(400, `input must be <= ${L.maxInputBytes} bytes (RFC 8785)`);
    let evaluator = null;
    if (j.evaluator != null) {
      if (!isAddress(j.evaluator, { strict: false })) throw new ExchangeError(400, "evaluator must be an EVM address");
      evaluator = getAddress(j.evaluator);
    }
    const labels = Array.isArray(j.labels) ? j.labels.slice(0, 10).map((x) => slug(x)).filter(Boolean) : [];
    return { title, description: str(j.description, 2000, "description"), category, budget, sla_seconds: sla, open_seconds: open, deliverable_schema: schema, criteria: str(j.criteria, 4000, "criteria"), input: j.input ?? null, evaluator, labels, nonce: str(j.nonce, 64, "nonce") };
  }
  _row(id) {
    const r = this.db.prepare("SELECT * FROM ex_open_jobs WHERE id = ?").get(String(id));
    if (!r) throw new ExchangeError(404, "unknown open job id");
    return { ...r, doc: P(r.doc), claims: P(r.claims) ?? [] };
  }
  /** Lazy state: lapse unfunded claims, expire unclaimed jobs, mirror the order status once funded. */
  _sync(r) {
    const t = this.now();
    if (r.status === "claimed" && r.order_id) {
      const o = this.ex._order(r.order_id);
      if (o.job_id) {
        this.db.prepare("UPDATE ex_open_jobs SET status = 'funded', updated_at = ? WHERE id = ?").run(t, r.id);
        return this._row(r.id);
      }
      if (r.claim_expires_at < t) {
        this.db.prepare("UPDATE ex_orders SET status = 'claim-lapsed', updated_at = ? WHERE id = ? AND job_id IS NULL").run(t, r.order_id);
        const claims = r.claims.map((c) => (c.order_id === r.order_id ? { ...c, status: "lapsed (buyer did not fund within claimTtl)" } : c));
        this.db.prepare("UPDATE ex_open_jobs SET status = ?, claimer = NULL, claim_expires_at = NULL, order_id = NULL, claims = ?, updated_at = ? WHERE id = ?").run(r.expires_at < t ? "expired" : "open", J(claims), t, r.id);
        return this._row(r.id);
      }
    }
    if (r.status === "funded" && r.order_id) {
      const st = this.ex._order(r.order_id).status;
      if (TERMINAL_ORDER.has(st)) {
        this.db.prepare("UPDATE ex_open_jobs SET status = ?, updated_at = ? WHERE id = ?").run(st === "settled" ? "closed" : `closed-${st}`, t, r.id);
        return this._row(r.id);
      }
    }
    if (r.status === "open" && r.expires_at < t) {
      this.db.prepare("UPDATE ex_open_jobs SET status = 'expired', updated_at = ? WHERE id = ?").run(t, r.id);
      return this._row(r.id);
    }
    return r;
  }
  admitPost(ip, buyer) {
    if (ip) {
      const t = this.now();
      const h = (this.postHits.get(ip) ?? []).filter((x) => x > t - 3600_000);
      if (h.length >= this.limits.maxPostsPerIpPerHour) throw new ExchangeError(429, `max ${this.limits.maxPostsPerIpPerHour} job posts per IP per hour`);
      h.push(t);
      this.postHits.set(ip, h);
    }
    const n = this.db.prepare("SELECT COUNT(*) n FROM ex_open_jobs WHERE buyer = ? AND status IN ('open','claimed')").get(buyer).n;
    if (n >= this.limits.maxOpenJobsPerBuyer) throw new ExchangeError(429, `max ${this.limits.maxOpenJobsPerBuyer} open jobs per buyer`);
    const all = this.db.prepare("SELECT COUNT(*) n FROM ex_open_jobs WHERE status IN ('open','claimed')").get().n;
    if (all >= this.limits.maxOpenJobs) throw new ExchangeError(429, `open-jobs board full (${this.limits.maxOpenJobs})`);
  }
  /** POST /exchange/v1/jobs {job, buyer, expiresAt, signature}. Without signature: 400 with the EIP-712 typed data. */
  async post(b = {}, { ip = null } = {}) {
    const job = this.normalise(b.job);
    if (!b.buyer || !isAddress(b.buyer, { strict: false })) throw new ExchangeError(400, "buyer (EVM address that will fund the escrow) required");
    const buyer = getAddress(b.buyer);
    const exp = String(b.expiresAt ?? "");
    if (!b.signature) {
      const e = Math.floor(this.now() / 1000) + 3600;
      throw new ExchangeError(400, "signature required: EIP-712 OpenJob signed by buyer", { eip712: this.typedData(buyer, job, exp && /^[0-9]{1,12}$/.test(exp) ? exp : e), rule: "expiresAt is unix seconds, in the future and at most 24 h ahead (signature validity, not the job's open window); jobHash = keccak256(RFC8785(job as normalised)); resend the same body with expiresAt and signature", normalisedJob: job, quote: this.ex.quote(job.budget, buyer) });
    }
    const nowS = Math.floor(this.now() / 1000);
    if (!/^[0-9]{1,12}$/.test(exp) || Number(exp) < nowS || Number(exp) > nowS + 86400) throw new ExchangeError(400, "expiresAt must be unix seconds, in the future, at most 24 h ahead");
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(b.signature))) throw new ExchangeError(400, "signature must be 0x + 130 hex");
    const td = this.typedData(buyer, job, exp);
    let rec;
    try {
      rec = await recoverTypedDataAddress({ ...td, message: { ...td.message, expiresAt: BigInt(exp) }, signature: b.signature });
    } catch {
      throw new ExchangeError(400, "signature does not parse");
    }
    if (getAddress(rec) !== buyer) throw new ExchangeError(403, "signature is not by buyer", { recovered: rec });
    const id = "oj_" + keccak256(toBytes(`${lc(buyer)}:${td.message.jobHash}`)).slice(2, 18);
    if (this.db.prepare("SELECT 1 FROM ex_open_jobs WHERE id = ?").get(id)) return { ...(await this.get(id)), result: "exists" };
    this.admitPost(ip, buyer);
    const bytes = criteriaBytes(buildOpenJobCriteria({ openJobId: id, buyer, escrow: getAddress(this.ex.o.chain.escrow), chainId: this.ex.chainId, outputSchema: job.deliverable_schema, buyerCriteria: job.criteria }));
    const h = sha256Hex(bytes);
    const t = this.now();
    this.db.prepare("INSERT INTO ex_criteria (sha256, bytes, listing_id, skill_id, machine_checkable, created_at) VALUES (?, ?, ?, 'task', 1, ?) ON CONFLICT(sha256) DO NOTHING").run(h, bytes, id, t);
    this.db.prepare("INSERT INTO ex_open_jobs (id, buyer, doc, category, budget, spec_hash, status, expires_at, signature, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)")
      .run(id, buyer, J(job), job.category, job.budget, h, t + job.open_seconds * 1000, b.signature, t, t);
    return { ...(await this.get(id)), result: "posted" };
  }
  view(r, { brief = false } = {}) {
    const d = r.doc;
    const base = {
      open_job_id: r.id, title: d.title, category: r.category, budget: r.budget, quote: this.ex.quote(r.budget, r.buyer), sla_seconds: d.sla_seconds, status: r.status,
      buyer: r.buyer, evaluator: d.evaluator, criteria_hash: r.spec_hash, criteria_url: this.ex.url(`/exchange/v1/criteria/${r.spec_hash.slice(2)}`),
      expires_at: iso(r.expires_at), claimer: r.claimer ?? null, claim_expires_at: r.claim_expires_at ? iso(r.claim_expires_at) : null,
      url: this.ex.url(`/exchange/v1/jobs/${r.id}`),
    };
    if (r.status === "open") base.next_step = { mcp: { tool: "claim_job", arguments: { jobId: r.id, claimer: "<your address (escrow provider)>" } }, http: { method: "POST", url: this.ex.url(`/exchange/v1/jobs/${r.id}/claim`), body: { claimer: "<address>" } }, note: "first call returns the EIP-712 Claim to sign; resend with expiresAt + signature" };
    if (brief) return base;
    return { ...base, description: d.description, deliverable_schema: d.deliverable_schema, criteria: d.criteria, input: d.input, labels: d.labels, order_id: r.order_id ?? null, claims: r.claims, created_at: iso(r.created_at), fees: this.ex.fees(), contracts: this.ex.contracts(), untrustedFields: ["title", "description", "criteria", "input", "labels"], testnet: TESTNET, realValue: !TESTNET };
  }
  async get(id) {
    const r = this._sync(this._row(id));
    const v = this.view(r);
    if (r.order_id) v.order = await this.ex.getOrder(r.order_id).catch(() => null);
    return v;
  }
  /** GET /exchange/v1/jobs: open jobs (default), filter by category, minBudget, maxBudget, status. */
  list({ category = null, minBudget = null, maxBudget = null, status = "open", limit = 20, cursor = null } = {}) {
    for (const r of this.db.prepare("SELECT * FROM ex_open_jobs WHERE status IN ('open','claimed')").all()) this._sync({ ...r, doc: P(r.doc), claims: P(r.claims) ?? [] });
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const off = Math.max(Number(cursor) || 0, 0);
    let rows = this.db.prepare("SELECT * FROM ex_open_jobs WHERE (? = 'any' OR status = ?) ORDER BY CAST(budget AS INTEGER) DESC, created_at ASC").all(String(status), String(status)).map((r) => ({ ...r, doc: P(r.doc), claims: P(r.claims) ?? [] }));
    if (category) rows = rows.filter((r) => r.category === slug(category) || r.doc.labels?.includes(slug(category)));
    if (minBudget != null && /^[0-9]+$/.test(String(minBudget))) rows = rows.filter((r) => BigInt(r.budget) >= BigInt(minBudget));
    if (maxBudget != null && /^[0-9]+$/.test(String(maxBudget))) rows = rows.filter((r) => BigInt(r.budget) <= BigInt(maxBudget));
    const page = rows.slice(off, off + lim);
    return { results: page.map((r) => this.view(r, { brief: true })), total: rows.length, nextCursor: off + lim < rows.length ? String(off + lim) : null, fees: this.ex.fees(), testnet: TESTNET, realValue: !TESTNET };
  }
  /**
   * POST /exchange/v1/jobs/{id}/claim {claimer, expiresAt, signature}: exclusive claim for claimTtl. Creates the escrow order
   * (provider = claimer) the buyer funds; the claim lapses if unfunded by then.
   */
  async claim(id, b = {}) {
    let r = this._sync(this._row(id));
    if (!b.claimer || !isAddress(b.claimer, { strict: false })) throw new ExchangeError(400, "claimer (EVM address; becomes the escrow provider and is paid on a complete verdict) required");
    const claimer = getAddress(b.claimer);
    if (r.status !== "open") throw new ExchangeError(409, `open job is ${r.status}`, { claimer: r.claimer, claim_expires_at: r.claim_expires_at ? iso(r.claim_expires_at) : null });
    if (lc(claimer) === lc(r.buyer)) throw new ExchangeError(422, "claimer cannot be the buyer");
    const exp = String(b.expiresAt ?? "");
    if (!b.signature) {
      const e = Math.floor(this.now() / 1000) + 3600;
      throw new ExchangeError(400, "signature required: EIP-712 Claim signed by claimer", { eip712: this.claimTypedData(claimer, r.id, exp && /^[0-9]{1,12}$/.test(exp) ? exp : e), rule: "expiresAt is unix seconds, in the future and at most 24 h ahead; resend with expiresAt and signature" });
    }
    const nowS = Math.floor(this.now() / 1000);
    if (!/^[0-9]{1,12}$/.test(exp) || Number(exp) < nowS || Number(exp) > nowS + 86400) throw new ExchangeError(400, "expiresAt must be unix seconds, in the future, at most 24 h ahead");
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(b.signature))) throw new ExchangeError(400, "signature must be 0x + 130 hex");
    const td = this.claimTypedData(claimer, r.id, exp);
    let rec;
    try {
      rec = await recoverTypedDataAddress({ ...td, message: { ...td.message, expiresAt: BigInt(exp) }, signature: b.signature });
    } catch {
      throw new ExchangeError(400, "signature does not parse");
    }
    if (getAddress(rec) !== claimer) throw new ExchangeError(403, "signature is not by claimer", { recovered: rec });
    const active = this.db.prepare("SELECT COUNT(*) n FROM ex_open_jobs WHERE claimer = ? AND status = 'claimed'").get(claimer).n;
    if (active >= this.limits.maxActiveClaimsPerClaimer) throw new ExchangeError(429, `max ${this.limits.maxActiveClaimsPerClaimer} active (unfunded) claims per claimer`);
    const d = r.doc;
    // pseudo listing so evaluator selection, offer and route reuse the listing code path (provider = claimer)
    const pseudo = { id: r.id, seller: claimer, doc: { payTo: null, acceptable_evaluators: d.evaluator ? [d.evaluator] : [] } };
    const skill = { skill_id: "task", price: r.budget, sla_seconds: d.sla_seconds, criteria_hash: r.spec_hash };
    const ev = await this.ex.selectEvaluator(pseudo, skill, { buyer: r.buyer, evaluator: d.evaluator });
    if (lc(ev.address) === lc(claimer)) throw new ExchangeError(422, "claimer cannot be the job's evaluator");
    const offer = this.ex.offer(pseudo, skill, ev.address);
    const req = await this.ex.requirementsFor(offer, { openJobId: r.id, skillId: "task", buyer: r.buyer });
    const oid = "xo_" + randomBytes(8).toString("hex");
    const t = this.now();
    const ttl = t + this.limits.claimTtlSeconds * 1000;
    const org = this.ex.origin(r.buyer, claimer);
    const upd = this.db.transaction(() => {
      const cur = this.db.prepare("SELECT status FROM ex_open_jobs WHERE id = ?").get(r.id);
      if (cur.status !== "open") return false;
      this.db.prepare("INSERT INTO ex_orders (id, listing_id, skill_id, buyer, seller, evaluator, amount, escrow, spec_hash, deadline_seconds, route, job_id, channel, origin, status, txs, input, created_at, updated_at) VALUES (?, ?, 'task', ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open-job', ?, 'awaiting-funding', ?, ?, ?, ?)")
        .run(oid, r.id, r.buyer, claimer, ev.address, r.budget, getAddress(this.ex.o.chain.escrow), r.spec_hash, d.sla_seconds, req.payTo, org, J({}), J(d.input), t, t);
      const claims = [...r.claims, { claimer, order_id: oid, at: iso(t), status: "active" }].slice(-20);
      this.db.prepare("UPDATE ex_open_jobs SET status = 'claimed', claimer = ?, claim_expires_at = ?, order_id = ?, claims = ?, updated_at = ? WHERE id = ?").run(claimer, ttl, oid, J(claims), t, r.id);
      return true;
    })();
    if (!upd) throw new ExchangeError(409, "open job was claimed concurrently");
    const c = this.ex.o.chain;
    const deadline = BigInt(Math.floor(t / 1000) + d.sla_seconds);
    return {
      status: "claimed", open_job_id: r.id, order_id: oid, claimer, buyer: r.buyer, evaluator: ev.address, evaluatorSelection: ev.selection, amount: r.budget, quote: this.ex.quote(r.budget, r.buyer),
      claim_expires_at: iso(ttl), rule: `exclusive until claim_expires_at; if the buyer has not funded by then the claim lapses and the job reopens. You are paid ${r.budget} (100% of the budget) on a complete verdict; the buyer pays the Exchange fee on top.`,
      buyer_funds: {
        x402: { method: "POST", url: this.ex.url(`/exchange/v1/orders/${oid}/pay`), header: "PAYMENT-SIGNATURE", accepts: [req] },
        transactions: [
          { step: 1, label: "USDC.approve(escrow, amount)", chainId: this.ex.chainId, from: r.buyer, to: c.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.escrow, BigInt(r.budget)] }), value: "0" },
          { step: 2, label: "JobEscrow.createAndFundFor(client, provider, evaluator, amount, deadline, specHash)", chainId: this.ex.chainId, from: r.buyer, to: c.escrow, data: encodeFunctionData({ abi: c.escrowAbi, functionName: "createAndFundFor", args: [r.buyer, claimer, ev.address, BigInt(r.budget), deadline, r.spec_hash] }), value: "0" },
          ...this.ex.feeTxs(r.buyer, r.budget),
        ],
        receipt: { method: "POST", url: this.ex.url(`/exchange/v1/orders/${oid}/receipt`), body: { jobId: "<id>", paymentTx: "0x..", ...(this.ex.feeRecipient ? { feeTx: "0x.." } : {}) } },
      },
      delivery: { by: claimer, when: "after the order is funded (poll get_order or GET the order url until status funded)", submit: "JobEscrow.submit(jobId, sha256(deliverable bytes))", format: "JSON {\"jobId\": \"<id>\", \"output\": <JSON matching deliverable_schema>}", publish: { method: "POST", url: this.ex.url(`/exchange/v1/orders/${oid}/deliverable`), body: "raw deliverable bytes" } },
      links: { order: this.ex.url(`/exchange/v1/orders/${oid}`), job: this.ex.url(`/exchange/v1/jobs/${r.id}`), criteria: this.ex.url(`/exchange/v1/criteria/${r.spec_hash.slice(2)}`) },
      testnet: TESTNET, realValue: !TESTNET,
    };
  }

  // ---------------- earn ----------------
  /** Demand vs supply per category from real rows: open jobs + Exchange orders (30 d) vs active listings (skill ids / labels). */
  categories() {
    const t = this.now();
    const demand = new Map(), supply = new Map(), budget = new Map();
    const add = (m, k, n = 1) => k && m.set(k, (m.get(k) ?? 0) + n);
    for (const r of this.db.prepare("SELECT category, budget FROM ex_open_jobs WHERE status = 'open' AND expires_at > ?").all(t)) {
      add(demand, r.category);
      budget.set(r.category, [...(budget.get(r.category) ?? []), BigInt(r.budget)]);
    }
    const recent = this.db.prepare("SELECT o.skill_id, o.listing_id FROM ex_orders o WHERE o.job_id IS NOT NULL AND o.created_at > ? AND o.origin = 'external' AND o.listing_id LIKE 'lst_%'").all(t - 30 * 86400_000);
    for (const o of recent) add(demand, slug(o.skill_id), 0.5);
    for (const l of this.db.prepare("SELECT doc FROM ex_listings WHERE status = 'active'").all()) {
      const d = P(l.doc);
      for (const k of new Set([...(d.skills ?? []).map((s) => slug(s.skill_id)), ...(d.labels ?? []).map(slug)])) add(supply, k);
    }
    return [...demand.entries()]
      .map(([category, dem]) => ({ category, demand: dem, supply: supply.get(category) ?? 0, open_jobs: (budget.get(category) ?? []).length, max_budget: (budget.get(category) ?? []).reduce((a, b) => (b > a ? b : a), 0n).toString() }))
      .filter((c) => c.demand > c.supply)
      .sort((a, b) => b.demand - b.supply - (a.demand - a.supply) || a.category.localeCompare(b.category));
  }
  /** GET /exchange/v1/earn and MCP find_earning_opportunities. */
  async earn({ category = null, address = null, limit = 10 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const jobs = this.list({ category, limit: lim });
    const under = this.categories().slice(0, lim).map((c) => ({
      ...c,
      basis: "demand = open jobs in the category + 0.5 x external Exchange orders for that skill id in 30 days; supply = active listings whose skill_id or label matches",
      next_step: { mcp: { tool: "create_listing", arguments: { seller: "<your address>", listing: { title: "<title>", endpoint: "https://<your endpoint>", labels: [c.category], skills: [{ skill_id: c.category, name: "<name>", price: "<USDC base units>" }] } } }, note: "first call returns the EIP-712 Listing to sign" },
    }));
    const evs = await this.ex.evaluatorRows();
    const onboard = await this.o.evaluatorOnboarding?.().catch(() => null);
    const evaluator = {
      active_evaluators: evs.length,
      min_stake: onboard?.minStake ?? null,
      judging_fee: { evaluatorFeeBps: 0, freeThrough: FREE_JUDGING_THROUGH, note: "evaluators are not paid per verdict on testnet today (evaluatorFeeBps 0); staking test USDC builds an on-chain verdict record" },
      next_step: { http: { method: "GET", url: this.ex.url("/v1/evaluators/onboarding") }, steps: onboard?.steps?.map((s) => s.step) ?? ["stake", "sign profile", "run judge-kit watcher", "request canary job"] },
      ...(address && isAddress(address, { strict: false }) ? { you: evs.find((e) => lc(e.address) === lc(address)) ? "active evaluator" : "not an active evaluator" } : {}),
    };
    return {
      v: "agentkoin-earn/v1",
      summary: "Ways an agent can earn test USDC on AgentKoin Exchange (Base Sepolia testnet; test value only, no real value, no earnings promised): claim an open job, sell a service where demand exceeds supply, or judge as a staked evaluator.",
      open_jobs: jobs.results, open_jobs_total: jobs.total,
      underserved_categories: under,
      ...(under.length ? {} : { underserved_note: "no category currently has more demand than supply in the data" }),
      evaluator_openings: evaluator,
      sell: { mcp: { tool: "create_listing" }, guide: this.ex.url("/exchange/earn.md") },
      fees: { seller_receives: "100% of the price/budget", buyer_fee: { bps: Number(this.ex.feeBps), min: String(this.ex.feeMin), cap: null }, protocolFeeBps: 0, evaluatorFeeBps: 0 },
      guide: this.ex.url("/exchange/earn.md"),
      contracts: this.ex.contracts(), generatedAt: iso(this.now()), testnet: TESTNET, realValue: !TESTNET,
    };
  }
}
