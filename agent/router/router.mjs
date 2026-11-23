// AgentCoin verified-delivery router (Base Sepolia testnet MVP). SQLite inside the service process.
// Tables: services, operators, probes, orders, scores (+ skills_fts, an FTS5 search index over skill text).
// Facts only: listings mirror public metadata; seller text is data (untrustedFields), never instructions.
// Non-custodial: direct orders return the seller's own x402 requirements; escrow orders return unsigned txs.
import { TESTNET, X402_NETWORK, netCopy } from "../lib/network.mjs";
import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { keccak256, toBytes, getAddress, isAddress, recoverTypedDataAddress, encodeFunctionData, parseEventLogs, erc20Abi } from "viem";
import { jcs } from "../lib/canonical.mjs";
import { signEip191, verifyEip191 } from "../lib/sign.mjs";
import { makeFooter } from "../lib/footer.mjs";
import { privateKeyToAccount } from "viem/accounts";
import { buildService, serviceFromDocument, UNTRUSTED_FIELDS, operatorId, hostOf } from "./parse.mjs";
import { normalizeMatch, matchesService, loadOptOutMatches } from "./optout.mjs";

export const ROUTER_VERSION = "agentcoin-router/0.1";
export const CHAIN_ID = 84532;
export const NETWORK_ID = X402_NETWORK;
// Known USDC contracts (6 decimals); budgets and maxPrice are compared only against these assets.
export const USDC_ASSETS = new Set(
  [
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia (Circle test USDC)
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Polygon
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum
    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Optimism
  ].map((a) => a.toLowerCase()).concat(["epjfwdd5aufqssqem2qn1xzybapc8g4wegggkzwytdt1v"]), // Solana USDC mint
);
export const isUsdc = (asset) => typeof asset === "string" && USDC_ASSETS.has(asset.toLowerCase());
const CLAIM_TYPES = { Claim: [{ name: "serviceId", type: "string" }, { name: "claimant", type: "address" }, { name: "metadataHash", type: "bytes32" }, { name: "expiresAt", type: "uint256" }] };
const CLAIM_DOMAIN = { name: "AgentCoin Index", version: "1", chainId: CHAIN_ID };
const STOP = new Set("a an and are as at be by for from get i in is it me my of on or our please the this to us we what with you your need want find".split(" "));
const J = (v) => (v == null ? null : JSON.stringify(v));
const P = (s) => (s == null ? null : JSON.parse(s));
const sha256hex = (s) => "0x" + createHash("sha256").update(s).digest("hex");
const now_ = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

export class RouterError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, protocol TEXT NOT NULL, host TEXT NOT NULL, name TEXT, description TEXT,
  endpoints TEXT, skills TEXT NOT NULL, skill_count INTEGER NOT NULL, min_price INTEGER, networks TEXT, pay_to TEXT, wallets TEXT,
  erc8004_agent_id TEXT, source TEXT, origin TEXT NOT NULL, operated_by TEXT, extra TEXT,
  claimed INTEGER NOT NULL DEFAULT 0, claim_proof TEXT, claim_challenge TEXT,
  metadata_hash TEXT NOT NULL, first_seen INTEGER NOT NULL, last_checked INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS services_host ON services(host);
CREATE INDEX IF NOT EXISTS services_proto ON services(protocol);
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY, host TEXT UNIQUE NOT NULL, wallets TEXT, claimed_by TEXT, opted_out INTEGER NOT NULL DEFAULT 0, opted_out_at INTEGER, opt_out_match TEXT);
CREATE TABLE IF NOT EXISTS probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, status INTEGER, latency_ms INTEGER, evidence_hash TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS probes_svc ON probes(service_id, ts);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, buyer TEXT, service_id TEXT NOT NULL, skill_id TEXT, mode TEXT NOT NULL, price TEXT, asset TEXT, network TEXT, pay_to TEXT,
  payment_tx TEXT, job_id TEXT, deliverable_hash TEXT, verdict TEXT, origin TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, settled_at INTEGER, latency_ms INTEGER, request TEXT, receipt TEXT);
CREATE INDEX IF NOT EXISTS orders_svc ON orders(service_id);
CREATE TABLE IF NOT EXISTS scores (
  service_id TEXT PRIMARY KEY, delivered_after_pay_rate REAL, p50_ms INTEGER, dispute_rate REAL, independent_buyers INTEGER NOT NULL,
  n INTEGER NOT NULL, updated_at INTEGER NOT NULL, sig TEXT, doc TEXT);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(service_id UNINDEXED, skill_idx UNINDEXED, price UNINDEXED, network UNINDEXED, protocol UNINDEXED, text, tokenize='porter unicode61');
`;

function skillPrice(s) {
  return s.price != null && /^[0-9]{1,18}$/.test(String(s.price)) && isUsdc(s.asset) ? Number(s.price) : null;
}
function ftsQuery(text) {
  const toks = [...new Set(String(text ?? "").toLowerCase().match(/[a-z0-9]{2,30}/g) ?? [])].filter((t) => !STOP.has(t)).slice(0, 16);
  return toks.length ? toks.map((t) => `"${t}"`).join(" OR ") : null;
}
function tie(id, seed) {
  return createHash("sha256").update(`${seed}:${id}`).digest().readUInt32BE(0);
}

export class Router {
  /**
   * @param {object} o
   *  dbFile, publicUrl, seedFile, optOutFiles[], signerKey (operator key, for signed scores/delivery records),
   *  chain: { usdc, escrow, evaluator, readJob(jobId), getReceipt(hash), ownerOf(agentId), quoteFees(amount) },
   *  fetchDoc(url) -> {status, headers, body} (GET only; used by POST /v1/services and well-known claims),
   *  agentcoinAddresses[] (buyers counted as AgentCoin-originated), now()
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? now_;
    if (o.dbFile !== ":memory:") mkdirSync(path.dirname(o.dbFile), { recursive: true });
    this.db = new Database(o.dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.db.function("tie", { deterministic: true }, (id, seed) => tie(id, seed));
    this.publicUrl = (o.publicUrl ?? "").replace(/\/$/, "");
    this.agentcoin = new Set((o.agentcoinAddresses ?? []).filter(Boolean).map((a) => a.toLowerCase()));
    this.seeded = new Map(); // serviceId -> { liveQuote(), escrow: {provider, evaluator, specHash, sellerCall} }
    this.footer = makeFooter(this.publicUrl);
    this.signer = o.signerKey ? privateKeyToAccount(o.signerKey).address : null;
    this._prep();
  }
  _prep() {
    const d = this.db;
    this.q = {
      getSvc: d.prepare("SELECT * FROM services WHERE id = ?"),
      delSvc: d.prepare("DELETE FROM services WHERE id = ?"),
      delFts: d.prepare("DELETE FROM skills_fts WHERE service_id = ?"),
      insFts: d.prepare("INSERT INTO skills_fts (service_id, skill_idx, price, network, protocol, text) VALUES (?, ?, ?, ?, ?, ?)"),
      upSvc: d.prepare(`INSERT INTO services (id, operator_id, protocol, host, name, description, endpoints, skills, skill_count, min_price, networks, pay_to, wallets, erc8004_agent_id, source, origin, operated_by, extra, claimed, claim_proof, metadata_hash, first_seen, last_checked)
        VALUES (@id, @operator_id, @protocol, @host, @name, @description, @endpoints, @skills, @skill_count, @min_price, @networks, @pay_to, @wallets, @erc8004_agent_id, @source, @origin, @operated_by, @extra, @claimed, @claim_proof, @metadata_hash, @first_seen, @last_checked)
        ON CONFLICT(id) DO UPDATE SET operator_id=excluded.operator_id, protocol=excluded.protocol, host=excluded.host, name=excluded.name, description=excluded.description, endpoints=excluded.endpoints, skills=excluded.skills,
        skill_count=excluded.skill_count, min_price=excluded.min_price, networks=excluded.networks, pay_to=excluded.pay_to, wallets=excluded.wallets, erc8004_agent_id=excluded.erc8004_agent_id, source=excluded.source,
        origin=CASE WHEN services.origin='agentcoin' THEN services.origin ELSE excluded.origin END, operated_by=excluded.operated_by, extra=excluded.extra, metadata_hash=excluded.metadata_hash, last_checked=excluded.last_checked,
        claimed=CASE WHEN excluded.claimed=1 THEN 1 ELSE services.claimed END, claim_proof=COALESCE(excluded.claim_proof, services.claim_proof)`),
      getOp: d.prepare("SELECT * FROM operators WHERE host = ?"),
      upOp: d.prepare("INSERT INTO operators (id, host, wallets) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET wallets = excluded.wallets"),
      optOp: d.prepare("INSERT INTO operators (id, host, opted_out, opted_out_at, opt_out_match) VALUES (?, ?, 1, ?, ?) ON CONFLICT(host) DO UPDATE SET opted_out = 1, opted_out_at = excluded.opted_out_at, opt_out_match = excluded.opt_out_match"),
      score: d.prepare("SELECT * FROM scores WHERE service_id = ?"),
      count: d.prepare("SELECT COUNT(*) n, SUM(skill_count > 0) withSkills, SUM(claimed) claimed, SUM(skill_count) skills FROM services"),
      getMeta: d.prepare("SELECT v FROM meta WHERE k = ?"),
      setMeta: d.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
    };
  }
  close() {
    this.db.close();
  }

  // ---------------- writes: listings ----------------
  _optedOutHost(host) {
    const op = this.q.getOp.get(host);
    if (op?.opted_out) return true;
    // parent-domain host opt-outs
    const parts = host.split(".");
    for (let i = 1; i < parts.length - 1; i++) if (this.q.getOp.get(parts.slice(i).join("."))?.opted_out) return true;
    return false;
  }
  _isOptedOut(svc) {
    if (this._optedOutHost(svc.host)) return true;
    return (this._optMatches ?? []).some((nm) => matchesService(nm, svc));
  }
  upsert(svc, { claimed = false, claimProof = null, operatedBy = null } = {}) {
    if (this._isOptedOut(svc)) return { status: "opted-out", id: svc.id };
    const t = this.now();
    const prev = this.q.getSvc.get(svc.id);
    if (prev && prev.metadata_hash === svc.metadataHash && !claimed) return { status: "unchanged", id: svc.id };
    const prices = svc.skills.map(skillPrice).filter((x) => x != null);
    const nets = [...new Set(svc.skills.flatMap((s) => [s.network, ...(s.accepts ?? []).map((a) => a.network)]).filter(Boolean))];
    const { id, operatorId: opId, protocol, host, name, description, endpoints, skills, erc8004AgentId, payTo, wallets, source, origin, metadataHash: mh, ...rest } = svc;
    const tx = this.db.transaction(() => {
      this.q.upSvc.run({ id, operator_id: opId, protocol, host, name, description, endpoints: J(endpoints), skills: J(skills), skill_count: skills.length, min_price: prices.length ? Math.min(...prices) : null, networks: nets.join(","), pay_to: payTo, wallets: J(wallets ?? []), erc8004_agent_id: erc8004AgentId, source: J(source), origin, operated_by: operatedBy, extra: J(rest), claimed: claimed ? 1 : 0, claim_proof: J(claimProof), metadata_hash: mh, first_seen: prev?.first_seen ?? t, last_checked: t });
      this.q.upOp.run(opId, host, J(wallets ?? []));
      this.q.delFts.run(id);
      if (!skills.length) this.q.insFts.run(id, -1, null, null, protocol, `${name ?? ""} ${description ?? ""} ${host}`);
      skills.forEach((s, i) => this.q.insFts.run(id, i, skillPrice(s), [s.network, ...(s.accepts ?? []).map((a) => a.network)].filter(Boolean).join(","), protocol, `${s.name ?? ""} ${s.id ?? ""} ${s.description ?? ""} ${(s.tags ?? []).join(" ")} ${name ?? ""}`));
    });
    tx();
    return { status: prev ? "updated" : "created", id };
  }

  /** Import the seed (unclaimed listings from public metadata). Re-imports only when the seed hash changes. */
  importSeed(file = this.o.seedFile) {
    if (!file || !existsSync(file)) return { imported: 0, reason: "no seed file" };
    const raw = readFileSync(file);
    const h = createHash("sha256").update(raw).digest("hex");
    this.applyOptOutFiles();
    if (this.q.getMeta.get("seedHash")?.v === h) return { imported: 0, reason: "seed unchanged", seedHash: h };
    const seed = JSON.parse(gunzipSync(raw).toString("utf8"));
    let n = 0, skipped = 0;
    const tx = this.db.transaction(() => {
      for (const s of seed.services) {
        const r = this.upsert(s);
        if (r.status === "opted-out") skipped++;
        else n++;
      }
      this.q.setMeta.run("seedHash", h);
      this.q.setMeta.run("seedSummary", J({ v: seed.v, builtAt: seed.builtAt, inputs: seed.inputs, counts: seed.counts }));
    });
    tx();
    return { imported: n, skippedOptedOut: skipped, seedHash: h };
  }

  /** Load opt-out match files and delist matching services. */
  applyOptOutFiles(files = this.o.optOutFiles ?? []) {
    const ms = loadOptOutMatches(files);
    this._optMatches = ms.map(normalizeMatch).filter((m) => m.kind !== "none");
    let n = 0;
    for (const m of ms) n += this.optOut(m, { record: false }).delisted.length;
    return { matches: ms.length, delisted: n };
  }

  /** Opt-out: delist every service matching (URL/host -> whole host; svc_/op_/erc8004/address). One call. */
  optOut(match, { record = true } = {}) {
    const nm = normalizeMatch(match);
    if (nm.kind === "none") return { delisted: [], kind: "none" };
    if (record) (this._optMatches ??= []).push(nm);
    let rows;
    if (nm.kind === "host") rows = this.db.prepare("SELECT id, operator_id, host, erc8004_agent_id, pay_to, wallets FROM services WHERE host = ? OR host LIKE ?").all(nm.v, `%.${nm.v}`);
    else if (nm.kind === "service") rows = this.db.prepare("SELECT id, operator_id, host, erc8004_agent_id, pay_to, wallets FROM services WHERE id = ?").all(nm.v);
    else if (nm.kind === "operator") rows = this.db.prepare("SELECT id, operator_id, host, erc8004_agent_id, pay_to, wallets FROM services WHERE operator_id = ?").all(nm.v);
    else if (nm.kind === "erc8004") rows = nm.chain === "84532" ? this.db.prepare("SELECT id, operator_id, host, erc8004_agent_id, pay_to, wallets FROM services WHERE erc8004_agent_id = ?").all(nm.v) : [];
    else rows = this.db.prepare("SELECT id, operator_id, host, erc8004_agent_id, pay_to, wallets FROM services WHERE lower(pay_to) = ? OR lower(wallets) LIKE ?").all(nm.v, `%${nm.v}%`);
    rows = rows.filter((r) => matchesService(nm, { id: r.id, operatorId: r.operator_id, host: r.host, erc8004AgentId: r.erc8004_agent_id, payTo: r.pay_to, wallets: P(r.wallets) ?? [] }));
    const t = this.now();
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        if (this.seeded.has(r.id)) continue; // AgentCoin's own seed listing is never delisted by a third-party match
        this.q.delSvc.run(r.id);
        this.q.delFts.run(r.id);
      }
      const hosts = new Set(rows.filter((r) => !this.seeded.has(r.id)).map((r) => r.host));
      if (nm.kind === "host") hosts.add(nm.v);
      if (nm.kind === "operator" || nm.kind === "service") for (const r of rows) hosts.add(r.host);
      for (const h of hosts) if (!this._seededHost(h)) this.q.optOp.run(operatorId(h), h, t, String(match).slice(0, 300));
    });
    tx();
    return { delisted: rows.filter((r) => !this.seeded.has(r.id)).map((r) => r.id), kind: nm.kind };
  }
  _seededHost(h) {
    return [...this.seeded.values()].some((s) => s.host === h);
  }

  /** Register an AgentCoin-operated seed service (claimed, origin agentcoin) with a live quote function. */
  registerSeed(svc, { liveQuote = null, escrow = null } = {}) {
    this.seeded.set(svc.id, { host: svc.host, liveQuote, escrow });
    this.upsert({ ...svc, origin: "agentcoin" }, { claimed: true, claimProof: { method: "operator", basis: "operated by AgentCoin (seed seller); orders from AgentCoin wallets are excluded from scores" }, operatedBy: "AgentCoin" });
    return svc.id;
  }

  // ---------------- reads ----------------
  stats() {
    const c = this.q.count.get();
    const byProtocol = Object.fromEntries(this.db.prepare("SELECT protocol, COUNT(*) n FROM services GROUP BY protocol").all().map((r) => [r.protocol, r.n]));
    const opted = this.db.prepare("SELECT COUNT(*) n FROM operators WHERE opted_out = 1").get().n;
    const orders = this.db.prepare("SELECT origin, COUNT(*) n FROM orders GROUP BY origin").all();
    return { services: c.n, withSkills: c.withSkills ?? 0, claimed: c.claimed ?? 0, skills: c.skills ?? 0, unclaimed: c.n - (c.claimed ?? 0), byProtocol, operatorsOptedOut: opted, orders: Object.fromEntries(orders.map((r) => [r.origin, r.n])), seed: P(this.q.getMeta.get("seedSummary")?.v ?? null) };
  }
  _row(id) {
    const r = this.q.getSvc.get(id);
    if (!r) return null;
    return { ...r, endpoints: P(r.endpoints), skills: P(r.skills), wallets: P(r.wallets), source: P(r.source), extra: P(r.extra), claim_proof: P(r.claim_proof), claim_challenge: P(r.claim_challenge) };
  }
  _scoreOf(id) {
    const s = this.q.score.get(id);
    return s ? { deliveredAfterPayRate: s.delivered_after_pay_rate, p50Ms: s.p50_ms, disputeRate: s.dispute_rate, independentBuyers: s.independent_buyers, n: s.n, updatedAt: iso(s.updated_at) } : null;
  }
  listingUrl(id) {
    return `${this.publicUrl}/v1/services/${id}`;
  }
  _compact(r) {
    return { id: r.id, name: r.name, protocol: r.protocol, host: r.host, status: r.claimed ? "claimed" : "unclaimed", operatedBy: r.operated_by ?? null, skillCount: r.skill_count, minPriceUsdc: r.min_price == null ? null : String(r.min_price), networks: r.networks ? r.networks.split(",") : [], score: this._scoreOf(r.id), url: this.listingUrl(r.id) };
  }
  /** GET /v1/services: q, protocol, maxPrice, minScore, claimed, network, cursor, limit. Ties shuffled with a per-cursor seed. */
  search({ q = null, protocol = null, maxPrice = null, minScore = null, claimed = null, network = null, cursor = null, limit = 20 } = {}) {
    limit = Math.max(1, Math.min(50, Number(limit) || 20));
    let off = 0, seed = String(Math.floor(this.now() / 86400000));
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(String(cursor), "base64url").toString());
        off = Math.max(0, Number(c.o) | 0);
        seed = String(c.s ?? seed);
      } catch {
        throw new RouterError(400, "invalid cursor");
      }
    }
    if (protocol && !["x402", "a2a", "mcp", "openapi", "erc8004"].includes(protocol)) throw new RouterError(400, "protocol must be x402, a2a, mcp, openapi or erc8004");
    if (maxPrice != null && !/^[0-9]{1,18}$/.test(String(maxPrice))) throw new RouterError(400, "maxPrice must be USDC base units (decimal string)");
    if (minScore != null && !(Number(minScore) >= 0 && Number(minScore) <= 1)) throw new RouterError(400, "minScore must be between 0 and 1 (deliveredAfterPayRate)");
    const where = [], args = [];
    if (protocol) where.push("s.protocol = ?"), args.push(protocol);
    if (maxPrice != null) where.push("s.min_price IS NOT NULL AND s.min_price <= ?"), args.push(Number(maxPrice));
    if (claimed != null) where.push("s.claimed = ?"), args.push(claimed === true || claimed === "true" || claimed === "1" ? 1 : 0);
    if (network) where.push("(',' || s.networks || ',') LIKE ?"), args.push(`%,${network},%`);
    if (minScore != null) where.push("sc.delivered_after_pay_rate >= ?"), args.push(Number(minScore));
    const fq = q ? ftsQuery(q) : null;
    let rows, total;
    if (fq) {
      const hits = this.db.prepare("SELECT service_id, bm25(skills_fts) r FROM skills_fts WHERE skills_fts MATCH ? ORDER BY r LIMIT 5000").all(fq);
      const rel = new Map();
      for (const h of hits) if (!rel.has(h.service_id)) rel.set(h.service_id, h.r);
      const sql = `SELECT s.* FROM services s LEFT JOIN scores sc ON sc.service_id = s.id WHERE s.id IN (SELECT value FROM json_each(?)) ${where.length ? "AND " + where.join(" AND ") : ""}`;
      const all = this.db.prepare(sql).all(JSON.stringify([...rel.keys()]), ...args);
      for (const x of all) x.r = rel.get(x.id);
      const best = Math.min(...all.map((x) => x.r), -1e-9);
      for (const x of all) x.bucket = Math.min(4, Math.floor((4 * x.r) / best)); // 4 = most relevant
      all.sort((a, b) => b.bucket - a.bucket || (b.claimed - a.claimed) || tie(a.id, seed) - tie(b.id, seed));
      total = all.length;
      rows = all.slice(off, off + limit);
    } else {
      const w = where.length ? "WHERE " + where.join(" AND ") : "";
      total = this.db.prepare(`SELECT COUNT(*) n FROM services s LEFT JOIN scores sc ON sc.service_id = s.id ${w}`).get(...args).n;
      rows = this.db.prepare(`SELECT s.* FROM services s LEFT JOIN scores sc ON sc.service_id = s.id ${w} ORDER BY s.claimed DESC, COALESCE(sc.delivered_after_pay_rate, -1) DESC, tie(s.id, ?) LIMIT ? OFFSET ?`).all(...args, seed, limit, off);
    }
    const next = off + rows.length < total ? Buffer.from(JSON.stringify({ o: off + rows.length, s: seed })).toString("base64url") : null;
    return { total, count: rows.length, nextCursor: next, ordering: q ? "text-match bucket (FTS5 bm25, 5 buckets), then claimed, then seeded shuffle" : "claimed, then deliveredAfterPayRate, then seeded shuffle", results: rows.map((r) => this._compact(r)) };
  }

  /** GET /v1/services/{id} */
  get(id, { skillsOffset = 0, skillsLimit = 100 } = {}) {
    const r = this._row(id);
    if (!r) throw new RouterError(404, "unknown service id (or delisted by opt-out)");
    const so = Math.max(0, Number(skillsOffset) | 0), sl = Math.max(1, Math.min(200, Number(skillsLimit) || 100));
    const skills = r.skills.slice(so, so + sl).map((s) => ({ ...s, priceUnit: s.price != null ? (isUsdc(s.asset) ? "USDC base units (6 decimals)" : "asset base units") : null, request: this.requestFor(r, s) }));
    const probes = this.db.prepare("SELECT ts, kind, status, latency_ms, evidence_hash FROM probes WHERE service_id = ? ORDER BY ts DESC LIMIT 5").all(id);
    return {
      id: r.id, operatorId: r.operator_id, name: r.name, description: r.description, protocol: r.protocol, host: r.host,
      status: r.claimed ? "claimed" : "unclaimed", operatedBy: r.operated_by ?? null, verification: probes.length || this._scoreOf(id)?.n ? "has-evidence" : "unverified",
      endpoints: r.endpoints, payTo: r.pay_to, wallets: r.wallets, erc8004AgentId: r.erc8004_agent_id,
      skillsTotal: r.skill_count, skillsOffset: so, skills, extra: r.extra,
      source: r.source, origin: r.origin, metadataHash: r.metadata_hash, firstSeen: iso(r.first_seen), lastChecked: iso(r.last_checked),
      claimed: !!r.claimed, claimProof: r.claim_proof ? { method: r.claim_proof.method, basis: r.claim_proof.basis, claimant: r.claim_proof.claimant ?? null, verifiedAt: r.claim_proof.verifiedAt ?? null } : null,
      score: this._scoreOf(id), recentProbes: probes.map((p) => ({ ts: iso(p.ts), kind: p.kind, status: p.status, latencyMs: p.latency_ms, evidenceHash: p.evidence_hash })),
      untrustedFields: UNTRUSTED_FIELDS,
      links: { reputation: `${this.publicUrl}/v1/reputation/${id}`, claim: { method: "POST", url: `${this.listingUrl(id)}/claim` }, optOut: { method: "POST", url: `${this.publicUrl}/v1/optout`, body: { match: id } } },
    };
  }

  /** The exact request a seller expects for one skill, from its own published metadata. */
  requestFor(r, s) {
    const e = r.endpoints ?? {};
    if (r.protocol === "x402" || (r.protocol === "openapi" && s.url)) {
      const ex = s.inputExample ?? {};
      return {
        protocol: r.protocol === "x402" ? "x402" : "http",
        method: s.method ?? (ex.body ? "POST" : "GET"),
        url: s.url,
        query: ex.queryParams ?? null,
        headers: ex.body ? { "content-type": "application/json" } : {},
        body: ex.body ?? null,
        inputSchema: s.inputSchema ?? null,
        payment: r.protocol === "x402" ? { x402Version: 2, flow: "unpaid request returns HTTP 402 with PAYMENT-REQUIRED; the paid retry carries PAYMENT-SIGNATURE", accepts: s.accepts ?? (s.price ? [{ scheme: s.scheme ?? "exact", network: s.network, asset: s.asset, amount: s.price, payTo: s.payTo }] : []) } : null,
        source: "seller metadata (indexed)",
      };
    }
    if (r.protocol === "a2a") {
      const i = e.a2a ?? {};
      const msg = { role: "user", messageId: "<uuid>", parts: [{ kind: "data", data: { skill: s.id, arguments: {} } }] };
      const v1 = String(i.version ?? "").startsWith("1");
      if (i.binding === "HTTP+JSON") return { protocol: "a2a", binding: "HTTP+JSON", version: i.version ?? null, method: "POST", url: `${String(i.url ?? "").replace(/\/$/, "")}/message:send`, body: { message: { ...msg, role: v1 ? "ROLE_USER" : "user", parts: [{ data: { skill: s.id, arguments: {} } }] } }, authDeclared: !!r.extra?.authDeclared, source: "agent card (indexed)" };
      return { protocol: "a2a", binding: i.binding ?? "JSONRPC", version: i.version ?? null, method: "POST", url: i.url ?? null, body: { jsonrpc: "2.0", id: 1, method: v1 ? "SendMessage" : "message/send", params: { message: v1 ? { ...msg, role: "ROLE_USER", parts: [{ data: { skill: s.id, arguments: {} } }] } : msg } }, authDeclared: !!r.extra?.authDeclared, dataPartShape: "skill id + arguments (generic; seller-specific argument names are not published in most cards)", source: "agent card (indexed)" };
    }
    if (r.protocol === "mcp") return { protocol: "mcp", transport: e.transport ?? "streamable-http", url: e.mcp ?? null, sequence: [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "<client>", version: "<v>" } } }, s?.id ? { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: s.id, arguments: {} } } : { jsonrpc: "2.0", id: 2, method: "tools/list" }], inputSchema: s?.inputSchema ?? null, source: "MCP registry / server card (indexed)" };
    return { protocol: r.protocol, endpoints: e, source: "registration (indexed)" };
  }

  // ---------------- route ----------------
  /** POST /v1/route {task, budget, constraints}. Ranked candidates; quotes from the index (live for AgentCoin seeds). */
  async route({ task, budget = null, constraints = {} } = {}) {
    if (typeof task !== "string" || task.trim().length < 2 || task.length > 2000) throw new RouterError(400, "task must be a string of 2..2000 chars");
    if (budget != null && !/^[0-9]{1,18}$/.test(String(budget))) throw new RouterError(400, "budget must be USDC base units (6 decimals), decimal string");
    const c = constraints ?? {};
    const limit = Math.max(1, Math.min(20, Number(c.limit) || 5));
    const includeUnpriced = c.includeUnpriced !== false;
    const fq = ftsQuery(task);
    if (!fq) throw new RouterError(400, "task has no searchable terms");
    const t0 = performance.now();
    const where = [], args = [fq];
    if (c.protocol) where.push("f.protocol = ?"), args.push(String(c.protocol));
    if (budget != null) where.push(includeUnpriced ? "(f.price IS NULL OR CAST(f.price AS INTEGER) <= ?)" : "(f.price IS NOT NULL AND CAST(f.price AS INTEGER) <= ?)"), args.push(Number(budget));
    else if (!includeUnpriced) where.push("f.price IS NOT NULL");
    if (c.network) where.push("(',' || f.network || ',') LIKE ?"), args.push(`%,${c.network},%`);
    const rows = this.db.prepare(`SELECT f.service_id, f.skill_idx, f.price, bm25(skills_fts) r FROM skills_fts f WHERE skills_fts MATCH ? ${where.length ? "AND " + where.join(" AND ") : ""} ORDER BY r LIMIT 400`).all(...args);
    const best = new Map();
    for (const x of rows) if (!best.has(x.service_id)) best.set(x.service_id, x);
    const seed = sha256hex(task + Math.floor(this.now() / 3600000));
    const top = rows.length ? rows[0].r : -1;
    let cands = [...best.values()].map((x) => {
      const svc = this._row(x.service_id);
      if (!svc) return null;
      if (c.claimed != null && !!svc.claimed !== !!c.claimed) return null;
      const sc = this._scoreOf(svc.id);
      if (c.minScore != null && !(sc?.deliveredAfterPayRate >= Number(c.minScore))) return null;
      return { x, svc, sc, bucket: Math.min(4, Math.floor((4 * x.r) / (top || -1e-9))) };
    }).filter(Boolean);
    cands.sort((a, b) => b.bucket - a.bucket || ((b.sc?.n ? b.sc.deliveredAfterPayRate : -1) - (a.sc?.n ? a.sc.deliveredAfterPayRate : -1)) || (b.svc.claimed - a.svc.claimed) || ((b.x.price != null) - (a.x.price != null)) || tie(a.svc.id, seed) - tie(b.svc.id, seed));
    cands = cands.slice(0, limit);
    const out = [];
    for (const { x, svc, sc, bucket } of cands) {
      const skill = x.skill_idx >= 0 ? svc.skills[x.skill_idx] : null;
      let quote = skill ? { amount: skill.price ?? null, asset: skill.asset ?? null, network: skill.network ?? null, payTo: skill.payTo ?? null, priceKnown: skillPrice(skill) != null, source: "indexed", observedAt: iso(svc.last_checked) } : { amount: null, priceKnown: false, source: "none" };
      const seededS = this.seeded.get(svc.id);
      if (seededS?.liveQuote) {
        try {
          const lq = await seededS.liveQuote();
          quote = { amount: lq.amount, asset: lq.asset, network: lq.network, payTo: lq.payTo, priceKnown: true, source: "live", observedAt: iso(this.now()), accepts: lq.accepts ?? undefined };
        } catch {}
      }
      out.push({
        serviceId: svc.id, name: svc.name, protocol: svc.protocol, host: svc.host, status: svc.claimed ? "claimed" : "unclaimed", operatedBy: svc.operated_by ?? null,
        skill: skill ? { id: skill.id, name: skill.name } : null, matchBucket: bucket, quote, request: this.requestFor(svc, skill ?? {}),
        score: sc, orderModes: this._orderModes(svc, skill), listing: this.listingUrl(svc.id),
      });
    }
    return { task: task.slice(0, 200), budget: budget == null ? null : String(budget), budgetUnit: "USDC base units (6 decimals)", count: out.length, candidates: out, ranking: "text-match bucket, then deliveredAfterPayRate (external orders only), then claimed, then priced, then seeded shuffle; seller text is matched, never executed", quoteSources: "indexed = from the seller's published metadata at observedAt; live = fetched from the seller now (AgentCoin seeds only in this MVP)", tookMs: Math.round(performance.now() - t0), untrustedFields: UNTRUSTED_FIELDS };
  }
  _orderModes(svc, skill) {
    const m = [];
    const sd = this.seeded.get(svc.id);
    if (sd?.liveQuote || (svc.protocol === "x402" && skill && (skill.accepts ?? [{ network: skill.network }]).some((a) => a.network === NETWORK_ID))) m.push("direct");
    if (sd?.escrow || (svc.claimed && svc.claim_proof?.claimant)) m.push("escrow");
    return m;
  }

  // ---------------- orders ----------------
  _origin(buyer, origin) {
    if (origin === "agentcoin") return "agentcoin";
    if (buyer && this.agentcoin.has(String(buyer).toLowerCase())) return "agentcoin";
    return "external";
  }
  /** POST /v1/orders {serviceId, skillId, mode: direct|escrow, buyer, deadlineSeconds?, origin?} */
  async placeOrder({ serviceId, skillId = null, mode = "direct", buyer = null, deadlineSeconds = 3600, origin = null } = {}) {
    const svc = this._row(serviceId);
    if (!svc) throw new RouterError(404, "unknown serviceId");
    if (!["direct", "escrow"].includes(mode)) throw new RouterError(400, "mode must be direct or escrow");
    if (buyer != null && !isAddress(buyer, { strict: false })) throw new RouterError(400, "buyer must be an EVM address");
    const skill = skillId != null ? svc.skills.find((s) => s.id === skillId) : svc.skills[0];
    if (!skill) throw new RouterError(400, "unknown skillId for this service", { skills: svc.skills.slice(0, 20).map((s) => s.id) });
    const sd = this.seeded.get(svc.id);
    const id = "ord_" + randomBytes(8).toString("hex");
    const t = this.now();
    const org = this._origin(buyer, origin);
    if (mode === "direct") {
      let req;
      if (sd?.liveQuote) req = await sd.liveQuote();
      else {
        const a = (skill.accepts ?? []).find((x) => x.network === NETWORK_ID) ?? (skill.network === NETWORK_ID ? { scheme: skill.scheme ?? "exact", network: skill.network, asset: skill.asset, amount: skill.price, payTo: skill.payTo } : null);
        if (!a) throw new RouterError(422, netCopy("no Base Sepolia (eip155:84532) payment option in this seller's metadata; orders on this testnet deployment are limited to eip155:84532"), { networks: [...new Set((skill.accepts ?? []).map((x) => x.network))] });
        req = { ...a, accepts: [a] };
      }
      this.db.prepare("INSERT INTO orders (id, buyer, service_id, skill_id, mode, price, asset, network, pay_to, origin, status, created_at, request) VALUES (?, ?, ?, ?, 'direct', ?, ?, ?, ?, ?, 'awaiting-payment', ?, ?)").run(id, buyer ? getAddress(buyer) : null, svc.id, skill.id, String(req.amount), req.asset, req.network, req.payTo, org, t, J({ skill: skill.id }));
      return { orderId: id, mode, origin: org, countedInScore: org === "external", serviceId: svc.id, skill: { id: skill.id, name: skill.name }, custody: "none: the buyer pays the seller directly with the seller's own x402 requirements", paymentRequirements: req.accepts ?? [req], request: this.requestFor(svc, skill), receipt: { method: "POST", url: `${this.publicUrl}/v1/orders/${id}/receipt`, body: { paymentTx: "0x<settlement tx hash on eip155:84532>", deliverable: "<response body as received>", latencyMs: "<optional integer>" } }, status: `${this.publicUrl}/v1/orders/${id}`, agentcoin: this.footer({ serviceId: svc.id, verified: false, checks: { paymentRecorded: false } }) };
    }
    // escrow
    let provider, evaluator, specHash, sellerCall = null;
    if (sd?.escrow) ({ provider, evaluator, specHash, sellerCall } = sd.escrow);
    else if (svc.claimed && svc.claim_proof?.claimant) {
      provider = svc.claim_proof.claimant;
      evaluator = this.o.chain?.evaluator;
      specHash = keccak256(toBytes(jcs({ v: "agentcoin-order-spec/v1", serviceId: svc.id, skill: skill.id, request: this.requestFor(svc, skill) })));
    } else throw new RouterError(422, "escrow needs a provider address that will call JobEscrow.submit: available for AgentCoin seeds and claimed listings only");
    if (!buyer) throw new RouterError(400, "buyer (the address that signs the escrow transactions) is required for mode escrow");
    const amount = sd?.liveQuote ? String((await sd.liveQuote()).amount) : skill.price;
    if (!amount || !/^[0-9]+$/.test(amount)) throw new RouterError(422, "escrow amount unknown (no price in listing)");
    const ch = this.o.chain;
    const deadline = BigInt(Math.floor(t / 1000) + Math.max(600, Math.min(30 * 86400, Number(deadlineSeconds) || 3600)));
    const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ch.escrow, BigInt(amount)] });
    const createData = encodeFunctionData({ abi: ch.escrowAbi, functionName: "createAndFundFor", args: [getAddress(buyer), getAddress(provider), getAddress(evaluator), BigInt(amount), deadline, specHash] });
    const fees = ch.quoteFees ? await ch.quoteFees(amount).catch(() => null) : null;
    this.db.prepare("INSERT INTO orders (id, buyer, service_id, skill_id, mode, price, asset, network, pay_to, origin, status, created_at, request) VALUES (?, ?, ?, ?, 'escrow', ?, ?, ?, ?, ?, 'awaiting-escrow', ?, ?)").run(id, getAddress(buyer), svc.id, skill.id, amount, ch.usdc, NETWORK_ID, getAddress(provider), org, t, J({ skill: skill.id, provider, evaluator, specHash, deadline: deadline.toString() }));
    return {
      orderId: id, mode, origin: org, countedInScore: org === "external", serviceId: svc.id, skill: { id: skill.id, name: skill.name },
      custody: "JobEscrow holds the amount until the staked evaluator's verdict; refund on reject or expiry", quote: fees,
      escrow: { chainId: CHAIN_ID, contract: ch.escrow, token: ch.usdc, client: getAddress(buyer), provider: getAddress(provider), evaluator: getAddress(evaluator), amount, deadline: deadline.toString(), specHash },
      transactions: [{ step: 1, label: "USDC.approve(escrow, amount)", chainId: CHAIN_ID, from: getAddress(buyer), to: ch.usdc, data: approveData, value: "0" }, { step: 2, label: "JobEscrow.createAndFundFor(client, provider, evaluator, amount, deadline, specHash)", chainId: CHAIN_ID, from: getAddress(buyer), to: ch.escrow, data: createData, value: "0" }],
      sellerCall, receipt: { method: "POST", url: `${this.publicUrl}/v1/orders/${id}/receipt`, body: { jobId: "<id from the JobCreated event>", paymentTx: "0x<createAndFundFor tx hash>" } }, status: `${this.publicUrl}/v1/orders/${id}`,
      agentcoin: this.footer({ serviceId: svc.id, verified: false, checks: { paymentRecorded: false } }),
    };
  }

  _order(id) {
    const o = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    if (!o) throw new RouterError(404, "unknown orderId");
    return { ...o, request: P(o.request), receipt: P(o.receipt) };
  }
  orderView(o) {
    return { orderId: o.id, serviceId: o.service_id, skillId: o.skill_id, mode: o.mode, buyer: o.buyer, price: o.price, asset: o.asset, network: o.network, payTo: o.pay_to, paymentTx: o.payment_tx, jobId: o.job_id, deliverableHash: o.deliverable_hash, verdict: o.verdict, status: o.status, origin: o.origin, countedInScore: o.origin === "external" && !!o.verdict, createdAt: iso(o.created_at), settledAt: o.settled_at ? iso(o.settled_at) : null, deliveryRecord: o.receipt?.deliveryRecord ?? null, escrow: o.mode === "escrow" ? o.request : undefined };
  }
  /** GET /v1/orders/{id}: refreshes escrow orders from chain. */
  async getOrder(id) {
    let o = this._order(id);
    if (o.mode === "escrow" && o.job_id && !["complete", "reject", "partial"].includes(o.verdict ?? "")) {
      await this._refreshEscrow(o).catch(() => {});
      o = this._order(id);
    }
    let fromBlock;
    if (o.mode === "escrow" && o.job_id && o.payment_tx && this.o.chain?.getReceipt) fromBlock = (await this.o.chain.getReceipt(o.payment_tx).catch(() => null))?.blockNumber;
    const job = o.mode === "escrow" && o.job_id && this.o.chain?.jobStatus ? await this.o.chain.jobStatus(o.job_id, { fromBlock }).catch(() => null) : null;
    const view = { ...this.orderView(o), jobState: o.mode === "escrow" ? job?.state ?? o.receipt?.jobState ?? null : undefined, job };
    return { ...view, agentcoin: await this._orderFooter(view, { job, payment: o.receipt?.payment }) };
  }

  /** POST /v1/orders/{id}/receipt {paymentTx, deliverable|deliverableSha256, latencyMs} (direct) or {jobId, paymentTx} (escrow). */
  async receipt(id, b = {}) {
    const o = this._order(id);
    const ch = this.o.chain;
    if (o.mode === "direct") {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(b.paymentTx ?? ""))) throw new RouterError(400, "paymentTx (0x + 64 hex) required");
      const dup = this.db.prepare("SELECT id FROM orders WHERE lower(payment_tx) = lower(?) AND id != ?").get(b.paymentTx, id);
      if (dup) throw new RouterError(409, "paymentTx already recorded for another order", { orderId: dup.id });
      const pay = await this._verifyPayment(b.paymentTx, { from: o.buyer, to: o.pay_to, asset: o.asset, amount: o.price });
      let deliverableHash = null;
      if (b.deliverableSha256 != null) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(String(b.deliverableSha256))) throw new RouterError(400, "deliverableSha256 must be 0x + 64 hex");
        deliverableHash = String(b.deliverableSha256).toLowerCase();
      } else if (b.deliverable != null) deliverableHash = sha256hex(typeof b.deliverable === "string" ? b.deliverable : jcs(b.deliverable));
      const verdict = !pay.ok ? "payment-unverified" : deliverableHash ? "delivered" : "not-delivered";
      const lat = Number.isFinite(Number(b.latencyMs)) && Number(b.latencyMs) >= 0 ? Math.round(Number(b.latencyMs)) : null;
      const record = await this._deliveryRecord({ orderId: id, serviceId: o.service_id, mode: "direct", buyer: pay.from ?? o.buyer, paymentTx: b.paymentTx, payment: pay, deliverableHash, deliverableHashKind: b.deliverableSha256 != null ? "sha256 (buyer-supplied)" : "sha256(utf8 body or RFC8785 JSON)", verdict, origin: o.origin });
      this.db.prepare("UPDATE orders SET payment_tx = ?, buyer = COALESCE(buyer, ?), deliverable_hash = ?, verdict = ?, status = ?, settled_at = ?, latency_ms = ?, receipt = ? WHERE id = ?").run(b.paymentTx, pay.from ?? null, deliverableHash, verdict, pay.ok ? "settled" : "payment-unverified", this.now(), lat, J({ payment: pay, deliveryRecord: record }), id);
      const score = await this.recomputeScore(o.service_id);
      const view = { ...this.orderView(this._order(id)), payment: pay, score };
      return { ...view, agentcoin: await this._orderFooter(view, { payment: pay }) };
    }
    // escrow
    if (!/^[0-9]{1,30}$/.test(String(b.jobId ?? ""))) throw new RouterError(400, "jobId (decimal) required for escrow orders");
    const dup = this.db.prepare("SELECT id FROM orders WHERE job_id = ? AND id != ?").get(String(b.jobId), id);
    if (dup) throw new RouterError(409, "jobId already recorded for another order", { orderId: dup.id });
    const job = await ch.readJob(String(b.jobId));
    const r = o.request;
    const mism = [];
    if (!job) mism.push("job not found");
    else {
      if (getAddress(job.provider) !== getAddress(r.provider)) mism.push("provider");
      if (getAddress(job.evaluator) !== getAddress(r.evaluator)) mism.push("evaluator");
      if (job.specHash !== r.specHash) mism.push("specHash");
      if (BigInt(job.amount) < BigInt(o.price)) mism.push("amount");
      if (getAddress(job.client) !== getAddress(o.buyer)) mism.push("client");
    }
    if (mism.length) throw new RouterError(422, `escrow job does not match the order: ${mism.join(", ")}`);
    this.db.prepare("UPDATE orders SET job_id = ?, payment_tx = COALESCE(?, payment_tx), status = 'funded' WHERE id = ?").run(String(b.jobId), b.paymentTx ?? null, id);
    await this._refreshEscrow(this._order(id));
    const score = await this.recomputeScore(o.service_id);
    const view = { ...this.orderView(this._order(id)), score };
    return { ...view, agentcoin: await this._orderFooter(view, { job: await ch.readJob(String(b.jobId)).catch(() => null) }) };
  }
  /** Footer for an order view: verified = signed delivery record recovers to the operator signer AND
   *  (escrow) the job read from chain in this call matches it, or (direct) the payment Transfer log was verified. */
  async _orderFooter(view, { job = null, payment = null } = {}) {
    const rec = view.deliveryRecord ?? null;
    let sigOk = null;
    if (rec) {
      const v = rec.signature ? await verifyEip191(rec).catch(() => null) : null;
      sigOk = !!v?.valid && (!this.signer || (v.signer && getAddress(v.signer) === this.signer));
    }
    const checks = { deliveryRecordSignatureValid: sigOk, operatorSigner: this.signer };
    let chainOk;
    if (view.mode === "escrow") {
      const lc = (x) => String(x ?? "").toLowerCase();
      chainOk = view.jobId ? !!job && !!job.state && (!rec?.deliverableHash || lc(job.deliverableHash) === lc(rec.deliverableHash)) && (!view.buyer || !job.client || lc(job.client) === lc(view.buyer)) : null;
      checks.onchainJobMatches = chainOk;
      checks.onchainSource = "JobEscrow.getJob read in this response";
    } else {
      chainOk = payment ? payment.ok === true : null;
      checks.paymentTransferVerified = chainOk;
      checks.onchainSource = "USDC Transfer log in the payment tx receipt, read when the receipt was recorded";
    }
    return this.footer({ serviceId: view.serviceId, verified: sigOk === true && chainOk === true, checks });
  }
  async _refreshEscrow(o) {
    const job = await this.o.chain.readJob(o.job_id);
    if (!job) return;
    const st = job.state;
    const map = { Completed: "complete", Rejected: "reject", Partial: "partial", Settled: job.outcome ? String(job.outcome).toLowerCase() : "settled", Disputed: "disputed", Submitted: null, Funded: null, Expired: "expired", Cancelled: "cancelled" };
    let verdict = map[st] ?? null;
    if (st === "Settled") verdict = { Complete: "complete", Reject: "reject", Partial: "partial" }[job.outcome] ?? "settled";
    const zero = /^0x0{64}$/;
    const dh = job.deliverableHash && !zero.test(job.deliverableHash) ? job.deliverableHash : null;
    const status = st === "Settled" ? "settled" : verdict ? "verdict" : dh ? "submitted" : "funded";
    let rec = o.receipt?.deliveryRecord ?? null;
    if (verdict && (!rec || rec.verdict !== verdict)) rec = await this._deliveryRecord({ orderId: o.id, serviceId: o.service_id, mode: "escrow", buyer: o.buyer, jobId: o.job_id, escrow: this.o.chain.escrow, deliverableHash: dh, verdict, jobState: st, evidence: job.evidence ?? null, origin: o.origin });
    this.db.prepare("UPDATE orders SET deliverable_hash = ?, verdict = ?, status = ?, settled_at = CASE WHEN ? THEN COALESCE(settled_at, ?) ELSE settled_at END, receipt = ? WHERE id = ?").run(dh, verdict, status, st === "Settled" ? 1 : 0, this.now(), J({ ...(o.receipt ?? {}), deliveryRecord: rec, jobState: st }), o.id);
    if (verdict) await this.recomputeScore(o.service_id);
  }
  async _verifyPayment(hash, { from, to, asset, amount }) {
    const ch = this.o.chain;
    const rc = await ch.getReceipt(hash).catch(() => null);
    if (!rc) return { ok: false, reason: "transaction receipt not found on eip155:84532" };
    if (rc.status !== "success") return { ok: false, reason: "transaction reverted" };
    const logs = parseEventLogs({ abi: erc20Abi, logs: rc.logs, eventName: "Transfer" }).filter((l) => l.address.toLowerCase() === String(asset).toLowerCase());
    const hit = logs.find((l) => getAddress(l.args.to) === getAddress(to) && (!from || getAddress(l.args.from) === getAddress(from)) && l.args.value >= BigInt(amount));
    if (!hit) return { ok: false, reason: `no ${asset} Transfer of >= ${amount} to ${to}${from ? ` from ${from}` : ""} in tx` };
    return { ok: true, txHash: hash, blockNumber: rc.blockNumber.toString(), from: getAddress(hit.args.from), to: getAddress(hit.args.to), value: hit.args.value.toString(), asset: getAddress(asset), network: NETWORK_ID };
  }
  async _deliveryRecord(fields) {
    const rec = { v: "agentcoin-delivery/v1", chainId: CHAIN_ID, ...fields, recordedAt: iso(this.now()), testnet: TESTNET, realValue: !TESTNET };
    return this.o.signerKey ? await signEip191(JSON.parse(JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), this.o.signerKey) : rec;
  }

  // ---------------- probes + scores ----------------
  async addProbe(serviceId, { kind, status, latencyMs, url, bodySha256 = null }) {
    const ts = this.now();
    const ev = { v: "agentcoin-probe/v1", serviceId, kind, url, status, latencyMs, bodySha256, ts: iso(ts) };
    const h = keccak256(toBytes(jcs(ev)));
    this.db.prepare("INSERT INTO probes (service_id, ts, kind, status, latency_ms, evidence_hash, detail) VALUES (?, ?, ?, ?, ?, ?, ?)").run(serviceId, ts, kind, status, latencyMs, h, J(ev));
    this.db.prepare("DELETE FROM probes WHERE service_id = ? AND id NOT IN (SELECT id FROM probes WHERE service_id = ? ORDER BY ts DESC LIMIT 200)").run(serviceId, serviceId);
    return h;
  }
  /** Score from external orders (AgentCoin-originated excluded) + probes. Signed (EIP-191, RFC8785) with the operator key. */
  async recomputeScore(serviceId) {
    const orders = this.db.prepare("SELECT * FROM orders WHERE service_id = ? AND verdict IS NOT NULL ORDER BY created_at").all(serviceId);
    const ext = orders.filter((o) => o.origin === "external");
    const paid = ext.filter((o) => (o.mode === "direct" && o.verdict !== "payment-unverified") || (o.mode === "escrow" && o.job_id));
    const delivered = paid.filter((o) => ["delivered", "complete", "partial"].includes(o.verdict));
    const escrowV = ext.filter((o) => o.mode === "escrow" && ["complete", "reject", "partial", "disputed"].includes(o.verdict));
    const disputed = escrowV.filter((o) => ["reject", "disputed"].includes(o.verdict));
    const probes = this.db.prepare("SELECT ts, kind, status, latency_ms, evidence_hash FROM probes WHERE service_id = ? ORDER BY ts DESC LIMIT 50").all(serviceId);
    const lats = [...probes.filter((p) => p.latency_ms != null && p.status && p.status < 500).map((p) => p.latency_ms), ...paid.filter((o) => o.latency_ms != null).map((o) => o.latency_ms)].sort((a, b) => a - b);
    const p50 = lats.length ? lats[Math.floor((lats.length - 1) / 2)] : null;
    const evidence = [
      ...orders.map((o) => ({ type: "order", orderId: o.id, mode: o.mode, paymentTx: o.payment_tx, jobId: o.job_id, deliverableHash: o.deliverable_hash, verdict: o.verdict, origin: o.origin, countedInScore: o.origin === "external" })),
      ...probes.map((p) => ({ type: "probe", kind: p.kind, ts: iso(p.ts), status: p.status, latencyMs: p.latency_ms, evidenceHash: p.evidence_hash })),
    ];
    const t = this.now();
    const doc = {
      v: "agentcoin-score/v1", chainId: CHAIN_ID, serviceId,
      deliveredAfterPayRate: paid.length ? delivered.length / paid.length : null, p50Ms: p50, disputeRate: escrowV.length ? disputed.length / escrowV.length : null,
      independentBuyers: new Set(paid.map((o) => (o.buyer ?? "").toLowerCase()).filter(Boolean)).size, n: paid.length,
      excludedAgentcoinOrders: orders.filter((o) => o.origin === "agentcoin").length, probes: probes.length,
      evidenceRoot: keccak256(toBytes(jcs(evidence))), updatedAt: iso(t), testnet: TESTNET, realValue: !TESTNET,
      method: "deliveredAfterPayRate = delivered / paid over external orders; AgentCoin-originated orders are listed in evidence with countedInScore=false; p50Ms over probes and external order latencies",
    };
    const signed = this.o.signerKey ? await signEip191(doc, this.o.signerKey) : doc;
    this.db.prepare(`INSERT INTO scores (service_id, delivered_after_pay_rate, p50_ms, dispute_rate, independent_buyers, n, updated_at, sig, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_id) DO UPDATE SET delivered_after_pay_rate=excluded.delivered_after_pay_rate, p50_ms=excluded.p50_ms, dispute_rate=excluded.dispute_rate, independent_buyers=excluded.independent_buyers, n=excluded.n, updated_at=excluded.updated_at, sig=excluded.sig, doc=excluded.doc`).run(serviceId, doc.deliveredAfterPayRate, p50, doc.disputeRate, doc.independentBuyers, doc.n, t, signed.signature?.value ?? null, J({ score: signed, evidence }));
    return signed;
  }
  /** GET /v1/reputation/{serviceId} */
  reputation(serviceId) {
    const r = this.q.getSvc.get(serviceId);
    if (!r) throw new RouterError(404, "unknown service id");
    const s = this.q.score.get(serviceId);
    if (!s) return { serviceId, score: null, evidence: [], note: "no orders or probes recorded for this service" };
    const d = P(s.doc);
    return { serviceId, score: d.score, evidence: d.evidence, verify: "keccak256(RFC8785(evidence)) == score.evidenceRoot; score.signature is EIP-191 by score.signature.signer over keccak256(RFC8785(score without signature))", signer: d.score.signature?.signer ?? null };
  }
  /** GET /v1/reputation/{serviceId} with the footer (score and evidence unchanged; footer outside the signed score). */
  async reputationWithFooter(serviceId) {
    const rep = this.reputation(serviceId);
    const v = rep.score ? await this.verifyScore(serviceId) : null;
    return { ...rep, agentcoin: this._scoreFooter(serviceId, v) };
  }
  _scoreFooter(serviceId, v) {
    const signerOk = !!v?.signer && (!this.signer || getAddress(v.signer) === this.signer);
    return this.footer({ serviceId, verified: !!v?.valid && signerOk, checks: v ? { scoreSignatureValid: !!v.signatureValid, evidenceRootMatches: !!v.evidenceRootMatches, signerIsOperator: signerOk, operatorSigner: this.signer } : { score: null } });
  }
  async verifyScore(serviceId) {
    const rep = this.reputation(serviceId);
    if (!rep.score) return { serviceId, valid: false, reason: "no score" };
    const sig = rep.score.signature ? await verifyEip191(rep.score) : { valid: false, reason: "unsigned" };
    const rootOk = keccak256(toBytes(jcs(rep.evidence))) === rep.score.evidenceRoot;
    return { serviceId, valid: !!sig.valid && rootOk, signatureValid: !!sig.valid, signer: sig.signer ?? null, evidenceRootMatches: rootOk, score: rep.score, evidenceCount: rep.evidence.length };
  }

  // ---------------- submit + claim ----------------
  /** POST /v1/services {url}: GET the URL (public metadata), parse, upsert. Idempotent by metadataHash. */
  async submit({ url } = {}) {
    if (typeof url !== "string" || url.length > 500 || !/^https:\/\//.test(url)) throw new RouterError(400, "url must be an https URL (<= 500 chars)");
    const host = hostOf(url);
    if (!host || this._optedOutHost(host)) throw new RouterError(409, "this host has opted out of the index");
    let res = await this.o.fetchDoc(url);
    if (!(res.status === 200 || res.status === 402) || !(res.body || res.headers?.["payment-required"])) {
      if (/\/mcp\/?$/.test(new URL(url).pathname)) res = await this.o.fetchDoc(`https://${host}/.well-known/mcp/server-card.json`);
      if (!(res.status === 200 || res.status === 402)) throw new RouterError(422, `GET ${url} returned ${res.status || res.error || "no response"}`);
    }
    let svc;
    try {
      svc = serviceFromDocument(res.body, url, { status: res.status, headers: res.headers ?? {} });
    } catch (e) {
      throw new RouterError(422, e.message);
    }
    svc.origin = "submitted";
    svc.source = { ...svc.source, submitted: true };
    const prev = this._row(svc.id);
    if (prev && prev.metadata_hash === svc.metadataHash) return { status: "unchanged", listing: this.get(svc.id) };
    const r = this.upsert(svc);
    if (r.status === "opted-out") throw new RouterError(409, "this listing matches an opt-out");
    return { status: r.status, listing: this.get(svc.id) };
  }
  async _allowedClaimants(r) {
    const payTo = (r.wallets ?? []).map((a) => getAddress(a));
    let owner = null;
    const reg = r.extra?.identityRegistry ?? null;
    if (r.erc8004_agent_id && this.o.chain?.ownerOf && (!reg || String(reg).startsWith(`eip155:${CHAIN_ID}:`))) owner = await this.o.chain.ownerOf(r.erc8004_agent_id).catch(() => null);
    return { payTo, erc8004Owner: owner ? getAddress(owner) : null };
  }
  typedData(serviceId, claimant, metadataHash, expiresAt) {
    return { domain: CLAIM_DOMAIN, types: CLAIM_TYPES, primaryType: "Claim", message: { serviceId, claimant: getAddress(claimant), metadataHash, expiresAt: String(expiresAt) } };
  }
  /** POST /v1/services/{id}/claim {claimant?}: returns the EIP-712 challenge and the well-known token. */
  async claimChallenge(id, { claimant = null } = {}) {
    const r = this._row(id);
    if (!r) throw new RouterError(404, "unknown service id");
    if (this.seeded.has(id)) throw new RouterError(409, "AgentCoin-operated seed listing");
    const allowed = await this._allowedClaimants(r);
    const expiresAt = Math.floor(this.now() / 1000) + 3600;
    const token = `agentcoin-claim-v1:${id}:${randomBytes(12).toString("hex")}`;
    this.db.prepare("UPDATE services SET claim_challenge = ? WHERE id = ?").run(J({ token, issuedAt: this.now() }), id);
    const c = claimant && isAddress(claimant, { strict: false }) ? getAddress(claimant) : allowed.payTo[0] ?? allowed.erc8004Owner ?? "0x0000000000000000000000000000000000000000";
    return {
      serviceId: id, status: r.claimed ? "claimed" : "unclaimed", allowedSigners: allowed,
      eip712: { typedData: this.typedData(id, c, r.metadata_hash, expiresAt), rule: "claimant must be a payTo address in this listing or the ERC-8004 owner of erc8004AgentId on eip155:84532; expiresAt (unix seconds) at most 24h ahead; the typed data is deterministic, so it can be signed without calling this endpoint first" },
      wellKnown: { url: `https://${r.host}/.well-known/agentcoin-claim`, content: token, validForSeconds: 3600 },
      verify: { method: "POST", url: `${this.listingUrl(id)}/claim/verify`, body: { claimant: c, expiresAt: String(expiresAt), signature: "0x<EIP-712 signature>" }, altBody: { method: "well-known" } },
    };
  }
  /** POST /v1/services/{id}/claim/verify {claimant, expiresAt, signature} | {method: "well-known"} */
  async claimVerify(id, b = {}) {
    const r = this._row(id);
    if (!r) throw new RouterError(404, "unknown service id");
    if (this.seeded.has(id)) throw new RouterError(409, "AgentCoin-operated seed listing");
    let proof;
    if (b.method === "well-known") {
      const tok = r.claim_challenge?.token;
      if (!tok || this.now() - r.claim_challenge.issuedAt > 3600_000) throw new RouterError(400, "no live well-known token: POST /claim first");
      const res = await this.o.fetchDoc(`https://${r.host}/.well-known/agentcoin-claim`, { text: true });
      const body = typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? "");
      if (res.status !== 200 || !body.includes(tok)) throw new RouterError(403, "well-known token not found at https://<host>/.well-known/agentcoin-claim");
      proof = { method: "well-known", basis: "host control", url: `https://${r.host}/.well-known/agentcoin-claim`, token: tok, claimant: b.claimant && isAddress(b.claimant, { strict: false }) ? getAddress(b.claimant) : null, verifiedAt: iso(this.now()) };
    } else {
      const { claimant, expiresAt, signature } = b;
      if (!claimant || !isAddress(claimant, { strict: false })) throw new RouterError(400, "claimant (EVM address) required");
      if (!/^[0-9]{1,12}$/.test(String(expiresAt ?? ""))) throw new RouterError(400, "expiresAt (unix seconds) required");
      const nowS = Math.floor(this.now() / 1000);
      if (Number(expiresAt) < nowS || Number(expiresAt) > nowS + 86400) throw new RouterError(400, "expiresAt must be in the future and at most 24h ahead");
      if (!/^0x[0-9a-fA-F]{130}$/.test(String(signature ?? ""))) throw new RouterError(400, "signature (65-byte hex) required");
      const td = this.typedData(id, claimant, r.metadata_hash, expiresAt);
      let rec;
      try {
        rec = await recoverTypedDataAddress({ ...td, message: { ...td.message, expiresAt: BigInt(expiresAt) }, signature });
      } catch {
        throw new RouterError(400, "signature does not parse");
      }
      if (getAddress(rec) !== getAddress(claimant)) throw new RouterError(403, "signature is not by claimant", { recovered: rec });
      const allowed = await this._allowedClaimants(r);
      const basis = allowed.payTo.includes(getAddress(claimant)) ? "payTo" : allowed.erc8004Owner === getAddress(claimant) ? "erc8004Owner" : null;
      if (!basis) throw new RouterError(403, "claimant is neither a payTo address in this listing nor the ERC-8004 owner", { allowedSigners: allowed });
      proof = { method: "eip712", basis, claimant: getAddress(claimant), typedData: { ...td, message: td.message }, signature, verifiedAt: iso(this.now()) };
    }
    this.db.prepare("UPDATE services SET claimed = 1, claim_proof = ?, claim_challenge = NULL WHERE id = ?").run(J(proof), id);
    if (proof.claimant) this.db.prepare("UPDATE operators SET claimed_by = ? WHERE host = ?").run(proof.claimant, r.host);
    return { serviceId: id, status: "claimed", claimProof: { method: proof.method, basis: proof.basis, claimant: proof.claimant, verifiedAt: proof.verifiedAt }, effects: ["status=claimed in search and route results", "claimed listings rank ahead of unclaimed ties", "escrow orders name the claimant as provider"], listing: this.listingUrl(id) };
  }

  // ---------------- dump ----------------
  /** GET /.well-known/agentcoin-index.json?cursor= : paged dump for aggregators. */
  dump({ cursor = null, limit = 500 } = {}) {
    limit = Math.max(1, Math.min(1000, Number(limit) || 500));
    const after = cursor ? String(cursor) : "";
    const rows = this.db.prepare("SELECT * FROM services WHERE id > ? ORDER BY id LIMIT ?").all(after, limit);
    const st = this.stats();
    return {
      v: "agentcoin-index/0.1", generatedAt: iso(this.now()), testnet: TESTNET, realValue: !TESTNET, total: st.services, count: rows.length,
      nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      listingPolicy: { unclaimed: "mirrors only metadata the operator publishes (A2A card, x402 catalog entry, MCP registry entry, ERC-8004 registration); unverified unless evidence is attached", optOut: { method: "POST", url: `${this.publicUrl}/v1/optout`, body: { match: "<host | URL | service id | erc8004:84532:<agentId> | payTo address>" }, effect: "matching listings are removed immediately and excluded from future imports" }, untrustedFields: UNTRUSTED_FIELDS },
      sources: st.seed?.inputs ?? null,
      services: rows.map((r) => ({ ...this._compact(r), operatorId: r.operator_id, payTo: r.pay_to, erc8004AgentId: r.erc8004_agent_id, source: P(r.source), metadataHash: r.metadata_hash, lastChecked: iso(r.last_checked) })),
    };
  }
}

/** SSRF-guarded GET for public metadata: https only, public IPs only, no redirects, size + time limits. */
export function makeFetchDoc({ timeoutMs = 8000, maxBytes = 1_000_000, userAgent = "agentcoin-index/0.1 (GET public metadata; testnet)" } = {}) {
  return async function fetchDoc(url, { text = false } = {}) {
    const u = new URL(url);
    if (u.protocol !== "https:") return { status: 0, error: "https only" };
    const dns = await import("node:dns/promises");
    const net = await import("node:net");
    const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) return { status: 0, error: "dns" };
    const priv = (a) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|fc|fd|fe80|::ffff:(127|10|192\.168)\.)/i.test(a);
    if (addrs.some((a) => priv(a.address))) return { status: 0, error: "private address" };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: "GET", headers: { "user-agent": userAgent, accept: "application/json" }, redirect: "manual", signal: ctl.signal });
      const reader = r.body?.getReader();
      let n = 0;
      const chunks = [];
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          n += value.length;
          if (n > maxBytes) {
            ctl.abort();
            return { status: 0, error: "too large" };
          }
          chunks.push(value);
        }
      const s = Buffer.concat(chunks).toString("utf8");
      let body = null;
      if (text) body = s;
      else
        try {
          body = JSON.parse(s);
        } catch {}
      return { status: r.status, headers: Object.fromEntries([...r.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])), body };
    } catch (e) {
      return { status: 0, error: e.name === "AbortError" ? "timeout" : String(e.message ?? e).slice(0, 100) };
    } finally {
      clearTimeout(t);
    }
  };
}
