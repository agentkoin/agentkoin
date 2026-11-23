// AgentKoin Exchange beta (testnet; Carter 2026-11-22 t312u + card answers 8:56 PM ET):
//  - opt-in/opt-out per agent wallet with an EIP-712 BetaOptIn signature (stored with timestamp; idempotent);
//  - opted-in buyers pay 0% Exchange buyer fee while the beta window is active (default end 2026-12-31 23:59:59 ET);
//  - off-chain fee-credit ledger: a fixed credit (default 0.01 USDC) per completed, evaluator-judged Exchange job to each
//    opted-in buyer/seller; credits only reduce future Exchange buyer fees: never cash, never withdrawable, not transferable;
//  - "beta-tester" badge.
// No revenue share and no payout of fee revenue anywhere.

import { getAddress, isAddress, recoverTypedDataAddress } from "viem";
import { ExchangeError } from "./exchange.mjs";

export const BETA_TYPES = { BetaOptIn: [{ name: "agent", type: "address" }, { name: "optIn", type: "bool" }, { name: "issuedAt", type: "uint256" }] };
export const BETA_DEFAULTS = {
  start: null, // null = active from deploy
  end: "2027-01-01T04:59:59Z", // 2026-12-31 23:59:59 America/New_York
  creditPerJob: 10_000n, // 0.01 test USDC per completed judged job
  maxCreditBalance: 1_000_000n, // 1 test USDC: balance cap (grants above it are recorded as capped, 0)
};
export const BETA_TERMS = {
  waiver: "opted-in buyers pay 0% Exchange buyer fee (instead of the listed fee) while the beta window is active",
  credits: "a fixed fee credit per completed, evaluator-judged Exchange job, to each opted-in buyer and seller of that job; credits only reduce future Exchange buyer fees",
  restrictions: ["not cash", "not withdrawable", "not transferable", "no revenue share", "no payout of fee revenue", "test USDC on testnet"],
};
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ex_beta (
  address TEXT PRIMARY KEY, status TEXT NOT NULL, claim TEXT NOT NULL, opted_in_at INTEGER, opted_out_at INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ex_fee_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, kind TEXT NOT NULL, amount TEXT NOT NULL, ref TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL,
  UNIQUE(address, kind, ref));
CREATE INDEX IF NOT EXISTS ex_fee_credits_addr ON ex_fee_credits(address);
`;
const iso = (ms) => new Date(ms).toISOString();
const lc = (a) => String(a ?? "").toLowerCase();
const toMs = (v) => (v == null || v === "" ? null : typeof v === "number" ? v : Date.parse(v));

export class Beta {
  constructor(ex, o = {}) {
    this.ex = ex;
    this.db = ex.db;
    this.cfg = { ...BETA_DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) };
    this.cfg.creditPerJob = BigInt(this.cfg.creditPerJob);
    this.cfg.maxCreditBalance = BigInt(this.cfg.maxCreditBalance);
    this.startMs = toMs(this.cfg.start);
    this.endMs = toMs(this.cfg.end);
    this.db.exec(SCHEMA);
    ex.beta = this;
  }
  now() {
    return this.ex.now();
  }
  window() {
    const t = this.now();
    return { start: this.startMs ? iso(this.startMs) : null, end: this.endMs ? iso(this.endMs) : null, active: (this.startMs == null || t >= this.startMs) && (this.endMs == null || t <= this.endMs) };
  }
  typedData(agent, optIn, issuedAt) {
    return { domain: this.ex.domain, types: BETA_TYPES, primaryType: "BetaOptIn", message: { agent: getAddress(agent), optIn: !!optIn, issuedAt: String(issuedAt) } };
  }
  row(agent) {
    if (!agent || !isAddress(agent, { strict: false })) return null;
    const r = this.db.prepare("SELECT * FROM ex_beta WHERE address = ?").get(getAddress(agent));
    return r ? { ...r, claim: JSON.parse(r.claim) } : null;
  }
  isIn(agent) {
    return this.row(agent)?.status === "in";
  }
  /** POST /exchange/v1/beta {agent, optIn, issuedAt, signature}. Without signature: 400 with typed data. Idempotent. */
  async optIn(b = {}) {
    if (!b.agent || !isAddress(b.agent, { strict: false })) throw new ExchangeError(400, "agent (EVM address; signs the opt-in) required");
    const agent = getAddress(b.agent);
    const want = b.optIn === undefined ? true : b.optIn === true || b.optIn === "true";
    const nowS = Math.floor(this.now() / 1000);
    if (!b.signature) throw new ExchangeError(400, "signature required: EIP-712 BetaOptIn signed by agent", { eip712: this.typedData(agent, want, nowS), rule: "issuedAt is unix seconds within 1 h of server time; optIn false opts out; resend with issuedAt and signature", terms: this.terms() });
    const ia = String(b.issuedAt ?? "");
    if (!/^[0-9]{1,12}$/.test(ia) || Math.abs(Number(ia) - nowS) > 3600) throw new ExchangeError(400, "issuedAt must be unix seconds within 1 h of server time");
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(b.signature))) throw new ExchangeError(400, "signature must be 0x + 130 hex");
    const td = this.typedData(agent, want, ia);
    let rec;
    try {
      rec = await recoverTypedDataAddress({ ...td, message: { ...td.message, issuedAt: BigInt(ia) }, signature: b.signature });
    } catch {
      throw new ExchangeError(400, "signature does not parse");
    }
    if (getAddress(rec) !== agent) throw new ExchangeError(403, "signature is not by agent", { recovered: rec });
    const prev = this.row(agent);
    const status = want ? "in" : "out";
    if (prev?.status === status) return { result: "unchanged", ...this.view(agent) };
    if (prev && Number(ia) <= Number(prev.claim.message.issuedAt)) throw new ExchangeError(409, "a newer beta claim is already recorded for this agent");
    const t = this.now();
    const claim = { type: "eip712", domain: td.domain, message: td.message, signature: b.signature, recordedAt: iso(t) };
    this.db
      .prepare("INSERT INTO ex_beta (address, status, claim, opted_in_at, opted_out_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET status = excluded.status, claim = excluded.claim, opted_in_at = COALESCE(excluded.opted_in_at, ex_beta.opted_in_at), opted_out_at = excluded.opted_out_at, updated_at = excluded.updated_at")
      .run(agent, status, JSON.stringify(claim), want ? t : null, want ? null : t, t);
    return { result: want ? "opted-in" : "opted-out", ...this.view(agent) };
  }
  terms() {
    return { ...BETA_TERMS, window: this.window(), creditPerJob: String(this.cfg.creditPerJob), maxCreditBalance: String(this.cfg.maxCreditBalance), unit: "USDC base units (6 decimals)" };
  }
  view(agent) {
    const a = getAddress(agent);
    const r = this.row(a);
    return { agent: a, beta: r ? { status: r.status, opted_in_at: r.opted_in_at ? iso(r.opted_in_at) : null, opted_out_at: r.opted_out_at ? iso(r.opted_out_at) : null, claim: r.claim } : { status: "none" }, badge: r?.status === "in" ? "beta-tester" : null, credits: this.credits(a), terms: this.terms(), testnet: true, realValue: false };
  }

  // ---------------- fee credits (off-chain ledger) ----------------
  balance(agent) {
    const rows = this.db.prepare("SELECT kind, amount FROM ex_fee_credits WHERE address = ?").all(getAddress(agent));
    return rows.reduce((s, r) => (r.kind === "grant" ? s + BigInt(r.amount) : r.kind === "apply" ? s - BigInt(r.amount) : s), 0n);
  }
  /** GET /exchange/v1/beta/{address}/credits: balance + history. Read-only; there is no withdraw or transfer operation. */
  credits(agent) {
    const a = getAddress(agent);
    const history = this.db.prepare("SELECT kind, amount, ref, note, created_at FROM ex_fee_credits WHERE address = ? ORDER BY id").all(a).map((r) => ({ kind: r.kind, amount: r.amount, ref: r.ref, note: r.note, at: iso(r.created_at) }));
    return { agent: a, balance: String(this.balance(a)), unit: "USDC base units (6 decimals)", usableFor: "future AgentKoin Exchange buyer fees only", cash: false, withdrawable: false, transferable: false, history };
  }
  /** Grant one credit per completed, evaluator-judged job to each opted-in buyer/seller. Idempotent per (address, job). */
  grantForOrder(o) {
    if (!o?.job_id || o.status !== "settled" || String(o.job?.outcome ?? "").toLowerCase() !== "complete" || !o.evaluator) return [];
    if (lc(o.buyer) === lc(o.seller)) return [];
    const int = this.ex.internal();
    const ref = `job:${lc(o.escrow)}:${o.job_id}`;
    const out = [];
    for (const who of [o.buyer, o.seller]) {
      if (int.has(lc(who))) continue; // AgentKoin wallets earn no credits
      const r = this.row(who);
      if (r?.status !== "in" || !r.opted_in_at || r.opted_in_at > o.created_at) continue; // opted in before the order
      const bal = this.balance(who);
      const room = this.cfg.maxCreditBalance > bal ? this.cfg.maxCreditBalance - bal : 0n;
      const amt = this.cfg.creditPerJob < room ? this.cfg.creditPerJob : room;
      const res = this.db.prepare("INSERT INTO ex_fee_credits (address, kind, amount, ref, note, created_at) VALUES (?, 'grant', ?, ?, ?, ?) ON CONFLICT(address, kind, ref) DO NOTHING").run(getAddress(who), String(amt), ref, `completed judged job ${o.job_id} (order ${o.id})${amt < this.cfg.creditPerJob ? "; capped at maxCreditBalance" : ""}`, this.now());
      if (res.changes) out.push({ address: getAddress(who), amount: String(amt), ref });
    }
    return out;
  }
  /** Fee after the beta waiver, then credits (credits never exceed the remaining fee). */
  apply(listFee, buyer) {
    const list = BigInt(listFee);
    const w = this.window();
    if (buyer && this.isIn(buyer) && w.active) return { waived: true, waiverReason: `beta tester: Exchange buyer fee waived until ${w.end ?? "beta end"}`, creditAvailable: String(this.balance(buyer)), creditApplied: "0", fee: 0n };
    const avail = buyer && isAddress(buyer, { strict: false }) ? this.balance(buyer) : 0n;
    const use = avail < list ? avail : list;
    return { waived: false, waiverReason: buyer && this.isIn(buyer) ? "beta window not active" : null, creditAvailable: String(avail), creditApplied: String(use), fee: list - use };
  }
  /** Debit credits used for an order's fee; idempotent per order; clamps at the balance (shortfall returned). */
  debit(buyer, amount, orderId) {
    const amt = BigInt(amount);
    if (amt <= 0n) return { debited: "0", shortfall: "0" };
    const a = getAddress(buyer);
    const done = this.db.prepare("SELECT amount FROM ex_fee_credits WHERE address = ? AND kind = 'apply' AND ref = ?").get(a, `order:${orderId}`);
    if (done) return { debited: done.amount, shortfall: "0", existing: true };
    const bal = this.balance(a);
    const use = amt < bal ? amt : bal;
    if (use > 0n) this.db.prepare("INSERT INTO ex_fee_credits (address, kind, amount, ref, note, created_at) VALUES (?, 'apply', ?, ?, ?, ?)").run(a, String(use), `order:${orderId}`, "applied to the Exchange buyer fee", this.now());
    return { debited: String(use), shortfall: String(amt - use) };
  }
}
