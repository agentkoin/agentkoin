// AgentKoin Exchange v0.1 (Base Sepolia testnet MVP): listings, agent profiles, hire = escrow order with evaluator
// selection. Thin layer on the index/router: same SQLite file (ex_* tables), same JobEscrow, same EscrowDepositRoute
// factory. Spec: specs/agentkoin-exchange-v0.1.md. Facts only; seller text is data (untrustedFields), never instructions.
// Open listing at launch (Carter, 2026-11-22): seller EIP-712 signature + an endpoint probe; no bond. Fees 0%.
import { TESTNET, X402_NETWORK, PUBLIC_CHAIN_ID, JUDGE_KIT_REF } from "../lib/network.mjs";
import { createHash, randomBytes } from "node:crypto";
import { keccak256, toBytes, getAddress, isAddress, recoverTypedDataAddress, encodeFunctionData, erc20Abi } from "viem";
import Ajv2020 from "ajv/dist/2020.js";
import { jcs } from "../lib/canonical.mjs";
import { signEip191 } from "../lib/sign.mjs";

export const EXCHANGE_VERSION = "agentkoin-exchange/0.1";
export const CHAIN_ID = PUBLIC_CHAIN_ID; // EIP-712 domain: 84532 on testnets/local, 8453 on Base mainnet
export const NETWORK_ID = X402_NETWORK;
export const FREE_JUDGING_THROUGH = "2026-12-31";
export const LISTING_DOMAIN = { name: "AgentKoin Exchange", version: "1", chainId: CHAIN_ID };
export const LISTING_TYPES = { Listing: [{ name: "seller", type: "address" }, { name: "listingHash", type: "bytes32" }, { name: "expiresAt", type: "uint256" }] };
export const PAUSE_TYPES = { ListingStatus: [{ name: "seller", type: "address" }, { name: "listingId", type: "string" }, { name: "status", type: "string" }, { name: "expiresAt", type: "uint256" }] };
export const UNTRUSTED_FIELDS = ["title", "description", "labels", "skills[].name", "skills[].description", "skills[].sellerCriteria", "display_name"];
export const PROTOCOLS = ["x402", "mcp", "a2a", "http"];
/**
 * Exchange marketplace fee (Carter, 2026-11-22: card t309s1646, revised 9:29 PM ET to 0.8% / 0.05 USDC min): buyer pays
 * feeBps of the job price on top (default 80 = 0.8%), minimum feeMin (default 50000 = 0.05 USDC),
 * no cap; the seller receives 100% of the price (the escrow job amount). Off-chain: a separate USDC transfer to the fee
 * recipient (no contract change). Applies only to Exchange hires (listing hires and open-jobs board jobs).
 */
export const EXCHANGE_FEE_BPS = 80n; // default; Exchange option feeBps / env AGENTCOIN_EXCHANGE_FEE_BPS
export const EXCHANGE_FEE_MIN = 50_000n; // 0.05 USDC (6 decimals); option feeMin / env AGENTCOIN_EXCHANGE_FEE_MIN
/** fee(price) = max(ceil(price * bps / 10000), min) in USDC base units (defaults: 80 bps, 50000). */
export function exchangeFee(price, bps = EXCHANGE_FEE_BPS, min = EXCHANGE_FEE_MIN) {
  const p = BigInt(price);
  if (p <= 0n) throw new Error("price must be positive");
  const pct = (p * BigInt(bps) + 9_999n) / 10_000n;
  return pct > BigInt(min) ? pct : BigInt(min);
}
/** Human-readable fee terms, e.g. "0.8%, min 0.05 USDC". */
export const feeTerms = (bps = EXCHANGE_FEE_BPS, min = EXCHANGE_FEE_MIN) => `${Number(bps) / 100}%, min ${Number(min) / 1e6} USDC`;
export const feeQuote = (price, bps = EXCHANGE_FEE_BPS, min = EXCHANGE_FEE_MIN) => {
  const fee = exchangeFee(price, bps, min);
  return { price: String(price), fee: String(fee), total: String(BigInt(price) + fee), unit: "USDC base units (6 decimals)" };
};
export const PROBE_OK = "HTTP status 200-299, 401, 402, 403 or 405 from GET <endpoint> within 8 s (https, public address, no redirects followed)";
export const DEFAULT_LIMITS = {
  maxListingsPerSeller: 10,
  maxSkillsPerListing: 20,
  maxActiveListings: 5000,
  maxJobAmount: 5_000_000n, // 5 test USDC per job (EscrowDepositRoute facilitator max)
  minJobAmount: 1n,
  maxCreatesPerIpPerHour: 20,
  maxOrdersPerBuyerPerDay: 50,
  minSlaSeconds: 600,
  maxSlaSeconds: 30 * 86400,
  maxDeliverableBytes: 65_536,
  maxInputBytes: 8_192,
};
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ex_listings (
  id TEXT PRIMARY KEY, seller TEXT NOT NULL, doc TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL,
  metadata_hash TEXT NOT NULL, claim TEXT, probe TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ex_listings_seller ON ex_listings(seller);
CREATE TABLE IF NOT EXISTS ex_criteria (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL, listing_id TEXT, skill_id TEXT, machine_checkable INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ex_orders (
  id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, skill_id TEXT NOT NULL, buyer TEXT NOT NULL, seller TEXT NOT NULL, evaluator TEXT NOT NULL,
  amount TEXT NOT NULL, escrow TEXT NOT NULL, spec_hash TEXT NOT NULL, deadline_seconds INTEGER NOT NULL, route TEXT, job_id TEXT,
  channel TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, txs TEXT NOT NULL, input TEXT, deliverable BLOB, deliverable_hash TEXT,
  job TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ex_orders_job ON ex_orders(escrow, job_id);
CREATE INDEX IF NOT EXISTS ex_orders_seller ON ex_orders(seller);
CREATE INDEX IF NOT EXISTS ex_orders_buyer ON ex_orders(buyer);
`;
const J = (v) => (v == null ? null : JSON.stringify(v));
const P = (s) => (s == null ? null : JSON.parse(s));
const iso = (ms) => new Date(ms).toISOString();
const lc = (a) => String(a ?? "").toLowerCase();
export const sha256Hex = (b) => "0x" + createHash("sha256").update(b).digest("hex");
const tie = (id, seed) => createHash("sha256").update(`${seed}:${id}`).digest().readUInt32BE(0);
const TERMINAL = new Set(["Settled", "Expired", "Cancelled"]);
const STATE_OUTCOME = { Completed: "complete", Rejected: "reject", Partial: "partial" };

export class ExchangeError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Default criteria document for a skill: three machine-checkable checks. Its sha256 is the escrow job specHash. */
export function buildCriteria({ listingId, skill, seller, escrow, sellerCriteria = null, chainId = CHAIN_ID }) {
  return {
    v: "agentkoin-exchange-criteria/v1",
    chainId,
    escrow,
    listingId,
    skillId: skill.skill_id,
    seller: getAddress(seller),
    deliverableFormat: "UTF-8 JSON object {\"jobId\": \"<decimal job id>\", \"output\": <any JSON>}; the provider submits deliverableHash = sha256(exact deliverable bytes)",
    outputSchema: skill.deliverable_schema ?? { type: "object" },
    checks: [
      { id: "deliverable-hash", pass: "sha256(deliverable bytes) == getJob(jobId).deliverableHash" },
      { id: "job-binding", pass: "deliverable.jobId == jobId (decimal string)" },
      { id: "output-schema", pass: "deliverable.output validates against outputSchema (JSON Schema 2020-12)" },
    ],
    verdict: { complete: "every check passes (payoutBps 10000)", reject: "any check fails (payoutBps 0)" },
    machineCheckable: true,
    sellerCriteria, // untrusted seller text; not judged by the automated checks
    outOfScope: ["truth, quality or usefulness of the output beyond outputSchema", "identity of buyer or seller", "any mainnet or real-value transaction"],
    testnet: TESTNET,
    realValue: false,
  };
}
export const criteriaBytes = (doc) => Buffer.from(jcs(doc), "utf8");

/** Deterministic machine checks of a deliverable against a criteria document (used by the reference evaluator). */
export function checkDeliverable({ criteria, bytes, jobId, onchainDeliverableHash }) {
  const out = [];
  const h = sha256Hex(bytes);
  out.push({ id: "deliverable-hash", status: lc(h) === lc(onchainDeliverableHash) ? "pass" : "fail", expected: onchainDeliverableHash, actual: h });
  let d = null;
  try {
    d = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {}
  out.push({ id: "job-binding", status: d && typeof d === "object" && String(d.jobId) === String(jobId) ? "pass" : "fail", expected: String(jobId), actual: d?.jobId ?? null });
  let ok = false, errs = null;
  if (d && typeof d === "object" && "output" in d) {
    try {
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      const v = ajv.compile(criteria.outputSchema ?? { type: "object" });
      ok = !!v(d.output);
      errs = ok ? null : (v.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`);
    } catch (e) {
      errs = [String(e.message).slice(0, 120)];
    }
  }
  out.push({ id: "output-schema", status: ok ? "pass" : "fail", ...(errs ? { errors: errs } : {}) });
  const pass = out.every((c) => c.status === "pass");
  return { pass, outcome: pass ? 1 : 2, payoutBps: pass ? 10000 : 0, checks: out };
}

export class Exchange {
  /**
   * o: { db (better-sqlite3, shared with the router), publicUrl, now(), signerKey, internalAddresses() -> [addr],
   *      chain: { usdc, escrow, escrowAbi, routeFactory, registry, identityRegistry, readJob(id) -> {state,outcome,client,provider,evaluator,amount,specHash,deliverableHash,...},
   *               routeFor(offer) -> address, feeConfig() -> {feeBps, evaluatorFeeBps} },
   *      evaluators() -> [{address, active, stake, availableExposure, label, operator, default}], referenceEvaluator,
   *      probe(url) -> {status, error?, latencyMs}, fetchBytes(url) -> Buffer, trustJobs() -> [{escrow, jobId, ourVerify}] , limits }
   */
  constructor(o) {
    this.o = o;
    this.db = o.db;
    this.now = o.now ?? Date.now;
    this.publicUrl = String(o.publicUrl ?? "").replace(/\/$/, "");
    this.limits = { ...DEFAULT_LIMITS, ...(o.limits ?? {}) };
    this.feeBps = BigInt(o.feeBps ?? EXCHANGE_FEE_BPS);
    this.feeMin = BigInt(o.feeMin ?? EXCHANGE_FEE_MIN);
    // Escrow default: "always" (testnet behaviour: every hire is an escrow job) or "optin" (base: direct pay unless the
    // order sets escrow:true). Opt-in incentives (optin only): escrow-protected badge, ranking, escrowFeeBps (min unchanged).
    this.escrowMode = o.escrowDefault === "optin" ? "optin" : "always";
    this.escrowFeeBps = BigInt(o.escrowFeeBps ?? this.feeBps);
    this.risksUrl = this.escrowMode === "optin" ? String(o.publicUrl ?? "").replace(/\/$/, "") + "/risks" : null;
    this.chainId = Number(o.chainId ?? CHAIN_ID);
    this.network = `eip155:${this.chainId}`;
    this.domain = { ...LISTING_DOMAIN, chainId: this.chainId };
    this.db.exec(SCHEMA);
    this.createHits = new Map();
    this.routeCache = new Map();
  }
  url(p) {
    return this.publicUrl + p;
  }
  /**
   * ERC-8004 linkage (read-only): ownerOf(agentId) and getAgentWallet(agentId) on the IdentityRegistry.
   * linked = the seller is the owner or the agent wallet; for AgentKoin seed listings (operator) also when owner and seller are
   * both AgentKoin wallets. No registry write, no re-signing.
   */
  async erc8004Link(agentId, seller, { operator = false } = {}) {
    const registry = this.o.chain.identityRegistry ?? null;
    const base = { agentId: String(agentId), registry: registry ? `eip155:${this.chainId}:${getAddress(registry)}` : null, checkedAt: iso(this.now()) };
    if (!registry || !this.o.erc8004Lookup) return { ...base, linked: false, basis: "identity registry lookup unavailable" };
    let r;
    try {
      r = await this.o.erc8004Lookup(String(agentId));
    } catch (e) {
      return { ...base, linked: false, basis: `lookup failed: ${String(e.shortMessage ?? e.message ?? e).slice(0, 80)}` };
    }
    const owner = r?.owner ? getAddress(r.owner) : null;
    const agentWallet = r?.agentWallet && !/^0x0{40}$/i.test(r.agentWallet) ? getAddress(r.agentWallet) : null;
    const s = lc(seller);
    let linked = false, basis = "seller is neither ownerOf(agentId) nor getAgentWallet(agentId)";
    if (owner && lc(owner) === s) [linked, basis] = [true, "seller == ownerOf(agentId)"];
    else if (agentWallet && lc(agentWallet) === s) [linked, basis] = [true, "seller == getAgentWallet(agentId)"];
    else if (operator && owner && this.internal().has(lc(owner)) && this.internal().has(s)) [linked, basis] = [true, "AgentKoin seed: ownerOf(agentId) and seller are both AgentKoin wallets (internalAddresses)"];
    return { ...base, owner, agentWallet, linked, basis };
  }
  internal() {
    return new Set((this.o.internalAddresses?.() ?? []).filter(Boolean).map(lc));
  }
  contracts() {
    const c = this.o.chain;
    return { chainId: this.chainId, network: this.network, escrow: c.escrow, usdc: c.usdc, depositRouteFactory: c.routeFactory ?? null, evaluatorRegistry: c.registry ?? null, identityRegistry: c.identityRegistry ?? null };
  }
  label(o) {
    return { ...o, testnet: TESTNET, realValue: !TESTNET };
  }

  // ---------------- listings ----------------
  listingId(seller, title) {
    return "lst_" + keccak256(toBytes(`${lc(seller)}:${String(title).trim().toLowerCase()}`)).slice(2, 18);
  }
  typedData(seller, listing, expiresAt) {
    return { domain: this.domain, types: LISTING_TYPES, primaryType: "Listing", message: { seller: getAddress(seller), listingHash: keccak256(toBytes(jcs(listing))), expiresAt: String(expiresAt) } };
  }
  /** Validate and normalise seller input. Throws ExchangeError(400). */
  normalise(l, { allowHttp = false } = {}) {
    const bad = (m) => {
      throw new ExchangeError(400, m);
    };
    if (!l || typeof l !== "object" || Array.isArray(l)) bad("listing must be a JSON object");
    const str = (v, n, max, req = true) => {
      if (v == null || v === "") {
        if (req) bad(`${n} required`);
        return null;
      }
      if (typeof v !== "string" || v.length > max) bad(`${n} must be a string <= ${max} chars`);
      return v;
    };
    const title = str(l.title, "title", 120);
    const description = str(l.description, "description", 2000, false);
    const endpoint = str(l.endpoint, "endpoint", 500);
    if (!/^https:\/\//.test(endpoint) && !(allowHttp && /^http:\/\//.test(endpoint))) bad("endpoint must be an https URL");
    const protocols = Array.isArray(l.protocols) && l.protocols.length ? l.protocols : ["http"];
    if (!protocols.every((p) => PROTOCOLS.includes(p))) bad(`protocols must be a subset of ${PROTOCOLS.join(", ")}`);
    const acc = Array.isArray(l.acceptable_evaluators) ? l.acceptable_evaluators : [];
    if (acc.length > 20 || !acc.every((a) => isAddress(a, { strict: false }))) bad("acceptable_evaluators must be <= 20 EVM addresses");
    if (l.payTo != null && !isAddress(l.payTo, { strict: false })) bad("payTo must be an EVM address");
    if (l.erc8004_id != null && !/^[0-9]{1,12}$/.test(String(l.erc8004_id))) bad("erc8004_id must be a decimal agent id");
    const labels = Array.isArray(l.labels) ? l.labels : [];
    if (labels.length > 10 || !labels.every((x) => typeof x === "string" && x.length <= 80)) bad("labels must be <= 10 strings of <= 80 chars");
    if (!Array.isArray(l.skills) || !l.skills.length || l.skills.length > this.limits.maxSkillsPerListing) bad(`skills must be 1..${this.limits.maxSkillsPerListing} entries`);
    const ids = new Set();
    const skills = l.skills.map((s, i) => {
      if (!s || typeof s !== "object") bad(`skills[${i}] must be an object`);
      const skill_id = str(s.skill_id, `skills[${i}].skill_id`, 64);
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(skill_id)) bad(`skills[${i}].skill_id must match [a-z0-9][a-z0-9._-]{0,63}`);
      if (ids.has(skill_id)) bad(`duplicate skill_id ${skill_id}`);
      ids.add(skill_id);
      const price = String(s.price ?? "");
      if (!/^[0-9]{1,18}$/.test(price)) bad(`skills[${i}].price must be USDC base units (decimal string)`);
      if (BigInt(price) < this.limits.minJobAmount || BigInt(price) > this.limits.maxJobAmount) bad(`skills[${i}].price must be between ${this.limits.minJobAmount} and ${this.limits.maxJobAmount} (testnet per-job cap)`);
      const sla = Number(s.sla_seconds ?? 3600);
      if (!Number.isInteger(sla) || sla < this.limits.minSlaSeconds || sla > this.limits.maxSlaSeconds) bad(`skills[${i}].sla_seconds must be an integer ${this.limits.minSlaSeconds}..${this.limits.maxSlaSeconds}`);
      for (const k of ["input_schema", "deliverable_schema"]) if (s[k] != null && (typeof s[k] !== "object" || Array.isArray(s[k]) || jcs(s[k]).length > 8192)) bad(`skills[${i}].${k} must be a JSON Schema object <= 8 KB`);
      if (s.deliverable_schema) {
        try {
          new Ajv2020({ strict: false }).compile(s.deliverable_schema);
        } catch (e) {
          bad(`skills[${i}].deliverable_schema does not compile: ${String(e.message).slice(0, 120)}`);
        }
      }
      if (s.criteria != null && (typeof s.criteria !== "string" || s.criteria.length > 4000)) bad(`skills[${i}].criteria (seller terms) must be a string <= 4000 chars`);
      const ext = s.criteria_url != null || s.criteria_hash != null;
      if (ext && !(typeof s.criteria_url === "string" && /^https:\/\//.test(s.criteria_url) && /^0x[0-9a-f]{64}$/.test(String(s.criteria_hash)))) bad(`skills[${i}]: criteria_url (https) and criteria_hash (0x + 64 lowercase hex sha256) go together`);
      return {
        skill_id, name: str(s.name, `skills[${i}].name`, 120), description: str(s.description, `skills[${i}].description`, 1000, false), price, asset: "USDC", sla_seconds: sla,
        input_schema: s.input_schema ?? null, deliverable_schema: s.deliverable_schema ?? null, criteria: s.criteria ?? null,
        ...(ext ? { criteria_url: s.criteria_url, criteria_hash: s.criteria_hash } : {}),
      };
    });
    return { title, description, endpoint, protocols, payTo: l.payTo ? getAddress(l.payTo) : null, erc8004_id: l.erc8004_id != null ? String(l.erc8004_id) : null, acceptable_evaluators: acc.map((a) => getAddress(a)), labels, skills, ...(l.display_name ? { display_name: str(l.display_name, "display_name", 80) } : {}) };
  }
  admitCreate(ip) {
    if (!ip) return true;
    const t = this.now();
    const a = (this.createHits.get(ip) ?? []).filter((x) => t - x < 3600_000);
    if (a.length >= this.limits.maxCreatesPerIpPerHour) return false;
    a.push(t);
    this.createHits.set(ip, a);
    if (this.createHits.size > 10_000) this.createHits.clear();
    return true;
  }
  /** Pin criteria for each skill: default document (machine-checkable) or the seller's external document (bytes fetched, sha256 checked). */
  async pinCriteria(id, seller, listing) {
    const out = [];
    for (const s of listing.skills) {
      let bytes, mc;
      if (s.criteria_url) {
        let b;
        try {
          b = await this.o.fetchBytes(s.criteria_url);
        } catch (e) {
          throw new ExchangeError(422, `criteria_url not fetched: ${String(e.message).slice(0, 120)}`);
        }
        if (sha256Hex(b) !== s.criteria_hash) throw new ExchangeError(422, `sha256(criteria_url bytes) != criteria_hash for ${s.skill_id}`, { computed: sha256Hex(b) });
        bytes = b;
        mc = 0;
      } else {
        bytes = criteriaBytes(buildCriteria({ listingId: id, skill: s, seller, escrow: getAddress(this.o.chain.escrow), sellerCriteria: s.criteria, chainId: this.chainId }));
        mc = 1;
      }
      const h = sha256Hex(bytes);
      this.db.prepare("INSERT INTO ex_criteria (sha256, bytes, listing_id, skill_id, machine_checkable, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING").run(h, bytes, id, s.skill_id, mc, this.now());
      out.push({ ...s, criteria_hash: h, criteria_spec_url: this.url(`/exchange/v1/criteria/${h.slice(2)}`), criteria_machine_checkable: !!mc, ...(s.criteria_url ? { criteria_source_url: s.criteria_url } : {}) });
    }
    return out;
  }
  /**
   * POST /exchange/v1/listings {listing, seller, expiresAt, signature}. Without signature: 400 with the EIP-712 typed data.
   * Gate (open listing): signature by seller, endpoint probe passes, per-seller and global caps.
   */
  async createListing(b = {}, { ip = null, origin = "external", skipAuth = false } = {}) {
    const listing = this.normalise(b.listing, { allowHttp: skipAuth });
    if (!b.seller || !isAddress(b.seller, { strict: false })) throw new ExchangeError(400, "seller (EVM address; signs the listing and is the escrow provider unless payTo is set) required");
    const seller = getAddress(b.seller);
    const id = this.listingId(seller, listing.title);
    const prev = this.db.prepare("SELECT * FROM ex_listings WHERE id = ?").get(id);
    if (prev && prev.origin === "agentcoin" && !skipAuth) throw new ExchangeError(409, "AgentKoin seed listing");
    let claim;
    if (skipAuth) claim = { method: "operator", basis: "operated by AgentKoin (seed listing; orders from AgentKoin wallets are excluded from scores)" };
    else {
      const exp = String(b.expiresAt ?? "");
      if (!b.signature) {
        const e = Math.floor(this.now() / 1000) + 3600;
        throw new ExchangeError(400, "signature required: EIP-712 Listing signed by seller", { eip712: this.typedData(seller, listing, exp && /^[0-9]{1,12}$/.test(exp) ? exp : e), rule: "expiresAt is unix seconds, in the future and at most 24 h ahead; listingHash = keccak256(RFC8785(listing as normalised)); resend the same body with expiresAt and signature", normalisedListing: listing });
      }
      if (!/^[0-9]{1,12}$/.test(exp)) throw new ExchangeError(400, "expiresAt (unix seconds) required with signature");
      const nowS = Math.floor(this.now() / 1000);
      if (Number(exp) < nowS || Number(exp) > nowS + 86400) throw new ExchangeError(400, "expiresAt must be in the future and at most 24 h ahead");
      if (!/^0x[0-9a-fA-F]{130}$/.test(String(b.signature))) throw new ExchangeError(400, "signature must be 0x + 130 hex");
      const td = this.typedData(seller, listing, exp);
      let rec;
      try {
        rec = await recoverTypedDataAddress({ ...td, message: { ...td.message, expiresAt: BigInt(exp) }, signature: b.signature });
      } catch {
        throw new ExchangeError(400, "signature does not parse");
      }
      if (getAddress(rec) !== seller) throw new ExchangeError(403, "signature is not by seller", { recovered: rec });
      claim = { method: "eip712", basis: "seller signature over the listing", claimant: seller, typedData: td, signature: b.signature, verifiedAt: iso(this.now()) };
      if (!this.admitCreate(ip)) throw new ExchangeError(429, `listing writes are capped at ${this.limits.maxCreatesPerIpPerHour} per IP per hour`);
      const n = this.db.prepare("SELECT COUNT(*) n FROM ex_listings WHERE seller = ? AND status != 'removed' AND id != ?").get(seller, id).n;
      if (n >= this.limits.maxListingsPerSeller) throw new ExchangeError(429, `max ${this.limits.maxListingsPerSeller} listings per seller`);
      const tot = this.db.prepare("SELECT COUNT(*) n FROM ex_listings WHERE status = 'active'").get().n;
      if (!prev && tot >= this.limits.maxActiveListings) throw new ExchangeError(503, "global listing cap reached");
      if (this.o.isOptedOut?.(listing.endpoint, seller)) throw new ExchangeError(409, "endpoint or seller matches an opt-out");
    }
    const t0 = this.now();
    const pr = await this.o.probe(listing.endpoint).catch((e) => ({ status: 0, error: String(e.message ?? e).slice(0, 100) }));
    const ok = pr.status >= 200 && pr.status < 300 ? true : [401, 402, 403, 405].includes(pr.status);
    const probe = { v: "agentkoin-exchange-probe/v1", url: listing.endpoint, method: "GET", status: pr.status ?? 0, error: pr.error ?? null, latencyMs: pr.latencyMs ?? this.now() - t0, ok, rule: PROBE_OK, at: iso(this.now()) };
    probe.evidenceHash = keccak256(toBytes(jcs(probe)));
    if (!ok && !skipAuth) throw new ExchangeError(422, "endpoint probe failed", { probe });
    if (listing.erc8004_id) claim = { ...claim, erc8004: await this.erc8004Link(listing.erc8004_id, seller, { operator: skipAuth }) };
    if (!skipAuth && claim.method === "eip712" && claim.erc8004?.linked) this.intents?.markVerified(seller, claim.erc8004, "listing");
    const skills = await this.pinCriteria(id, seller, listing);
    const doc = { ...listing, skills };
    const mh = keccak256(toBytes(jcs(doc)));
    const t = this.now();
    this.db
      .prepare(`INSERT INTO ex_listings (id, seller, doc, status, origin, metadata_hash, claim, probe, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET doc=excluded.doc, status='active', metadata_hash=excluded.metadata_hash, claim=excluded.claim, probe=excluded.probe, updated_at=excluded.updated_at`)
      .run(id, seller, J(doc), skipAuth ? "agentcoin" : origin, mh, J(claim), J(probe), t, t);
    return { status: prev ? "updated" : "created", listing: await this.getListing(id) };
  }
  /** POST /exchange/v1/listings/{id}/status {status: active|paused|removed, expiresAt, signature} (EIP-712 ListingStatus by seller). */
  async setStatus(id, b = {}) {
    const r = this._row(id);
    if (r.origin === "agentcoin") throw new ExchangeError(409, "AgentKoin seed listing");
    if (!["active", "paused", "removed"].includes(b.status)) throw new ExchangeError(400, "status must be active, paused or removed");
    const exp = String(b.expiresAt ?? "");
    const td = { domain: this.domain, types: PAUSE_TYPES, primaryType: "ListingStatus", message: { seller: r.seller, listingId: id, status: b.status, expiresAt: exp || String(Math.floor(this.now() / 1000) + 3600) } };
    if (!b.signature) throw new ExchangeError(400, "signature required: EIP-712 ListingStatus signed by seller", { eip712: td });
    const nowS = Math.floor(this.now() / 1000);
    if (!/^[0-9]{1,12}$/.test(exp) || Number(exp) < nowS || Number(exp) > nowS + 86400) throw new ExchangeError(400, "expiresAt must be unix seconds, in the future, at most 24 h ahead");
    let rec;
    try {
      rec = await recoverTypedDataAddress({ ...td, message: { ...td.message, expiresAt: BigInt(exp) }, signature: b.signature });
    } catch {
      throw new ExchangeError(400, "signature does not parse");
    }
    if (getAddress(rec) !== r.seller) throw new ExchangeError(403, "signature is not by seller", { recovered: rec });
    this.db.prepare("UPDATE ex_listings SET status = ?, updated_at = ? WHERE id = ?").run(b.status, this.now(), id);
    return { listing_id: id, status: b.status };
  }
  /** Opt-out: listings whose endpoint host, seller address or id matches are removed immediately. */
  optOut(match) {
    const m = lc(match).trim();
    if (!m) return 0;
    let n = 0;
    for (const r of this.db.prepare("SELECT id, seller, doc FROM ex_listings WHERE status != 'removed'").all()) {
      const d = P(r.doc);
      let host = "";
      try {
        host = new URL(d.endpoint).hostname.toLowerCase();
      } catch {}
      if (lc(r.id) === m || lc(r.seller) === m || host === m || host.endsWith("." + m) || lc(d.endpoint) === m) {
        this.db.prepare("UPDATE ex_listings SET status = 'removed', updated_at = ? WHERE id = ?").run(this.now(), r.id);
        n++;
      }
    }
    return n;
  }
  _row(id) {
    const r = this.db.prepare("SELECT * FROM ex_listings WHERE id = ?").get(String(id));
    if (!r) throw new ExchangeError(404, "unknown listing_id");
    return { ...r, doc: P(r.doc), claim: P(r.claim), probe: P(r.probe) };
  }
  provider(r) {
    return getAddress(r.doc.payTo ?? r.seller);
  }
  _compact(r, rec = null) {
    const d = r.doc;
    const tr = rec ?? this.trackRecord(r.seller, { asSeller: true });
    return {
      listing_id: r.id, seller: r.seller, title: d.title, status: r.status, origin: r.origin, protocols: d.protocols, endpoint: d.endpoint,
      skills: d.skills.map((s) => ({ skill_id: s.skill_id, name: s.name, price: s.price, fee: String(this.fee(s.price)), total: String(BigInt(s.price) + this.fee(s.price)), sla_seconds: s.sla_seconds, criteria_hash: s.criteria_hash })),
      min_price: d.skills.map((s) => BigInt(s.price)).reduce((a, b) => (b < a ? b : a)).toString(),
      score: tr.score, jobs_settled: tr.jobs_settled, badges: tr.badges, url: this.url(`/exchange/v1/listings/${r.id}`),
    };
  }
  /** GET /exchange/v1/listings: q, skill, maxPrice, minScore, badge, evaluator, protocol, seller, origin, sort, cursor, limit. */
  search({ q = null, skill = null, maxPrice = null, minScore = null, badge = null, evaluator = null, protocol = null, seller = null, origin = null, sort = null, cursor = null, limit = 20, includeInactive = false } = {}) {
    limit = Math.max(1, Math.min(100, Number(limit) || 20));
    if (maxPrice != null && !/^[0-9]{1,18}$/.test(String(maxPrice))) throw new ExchangeError(400, "maxPrice must be USDC base units (decimal string)");
    if (minScore != null && !(Number(minScore) >= 0 && Number(minScore) <= 1)) throw new ExchangeError(400, "minScore must be between 0 and 1");
    if (evaluator != null && !isAddress(evaluator, { strict: false })) throw new ExchangeError(400, "evaluator must be an EVM address");
    if (sort != null && !["default", "price", "score", "jobs", "new"].includes(sort)) throw new ExchangeError(400, "sort must be default, price, score, jobs or new");
    if (protocol != null && !PROTOCOLS.includes(protocol)) throw new ExchangeError(400, `protocol must be one of ${PROTOCOLS.join(", ")}`);
    let off = 0, seed = String(Math.floor(this.now() / 86400000));
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(String(cursor), "base64url").toString());
        off = Math.max(0, Number(c.o) | 0);
        seed = String(c.s ?? seed);
      } catch {
        throw new ExchangeError(400, "invalid cursor");
      }
    }
    const rows = this.db.prepare(`SELECT * FROM ex_listings ${includeInactive ? "WHERE status != 'removed'" : "WHERE status = 'active'"}`).all().map((r) => ({ ...r, doc: P(r.doc) }));
    const toks = q ? [...new Set(String(q).toLowerCase().match(/[a-z0-9]{2,30}/g) ?? [])].slice(0, 16) : [];
    const recs = new Map();
    const recOf = (s) => (recs.has(s) ? recs.get(s) : (recs.set(s, this.trackRecord(s, { asSeller: true })), recs.get(s)));
    let hits = [];
    for (const r of rows) {
      const d = r.doc;
      if (seller && lc(r.seller) !== lc(seller)) continue;
      if (origin && r.origin !== origin) continue;
      if (protocol && !d.protocols.includes(protocol)) continue;
      if (skill && !d.skills.some((s) => s.skill_id === skill || String(s.name).toLowerCase().includes(String(skill).toLowerCase()))) continue;
      if (maxPrice != null && !d.skills.some((s) => BigInt(s.price) <= BigInt(maxPrice))) continue;
      if (evaluator && d.acceptable_evaluators.length && !d.acceptable_evaluators.some((a) => lc(a) === lc(evaluator))) continue;
      const tr = recOf(r.seller);
      if (badge && !tr.badges.includes(badge)) continue;
      if (minScore != null && !(typeof tr.score === "number" && tr.score >= Number(minScore))) continue;
      let rel = 0;
      if (toks.length) {
        const text = [d.title, d.description, ...d.labels, ...d.skills.flatMap((s) => [s.skill_id, s.name, s.description])].join(" ").toLowerCase();
        rel = toks.filter((t) => text.includes(t)).length;
        if (!rel) continue;
      }
      hits.push({ r, tr, rel });
    }
    const minP = (r) => r.doc.skills.map((s) => BigInt(s.price)).reduce((a, b) => (b < a ? b : a));
    const cmpBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const def = (a, b) => b.rel - a.rel || b.tr.badges.length - a.tr.badges.length || (b.tr.score ?? -1) - (a.tr.score ?? -1) || b.tr.jobs_settled - a.tr.jobs_settled || tie(a.r.id, seed) - tie(b.r.id, seed);
    const sorters = { default: def, price: (a, b) => cmpBig(minP(a.r), minP(b.r)) || def(a, b), score: (a, b) => (b.tr.score ?? -1) - (a.tr.score ?? -1) || def(a, b), jobs: (a, b) => b.tr.jobs_settled - a.tr.jobs_settled || def(a, b), new: (a, b) => b.r.created_at - a.r.created_at };
    // opt-in mode: after text match, listings with more escrow-protected settled jobs rank first (direct orders open no job)
    if (this.escrowMode === "optin") sorters.default = (a, b) => b.rel - a.rel || b.tr.jobs_settled - a.tr.jobs_settled || def(a, b);
    hits.sort(sorters[sort ?? "default"]);
    const total = hits.length;
    const page = hits.slice(off, off + limit);
    const next = off + page.length < total ? Buffer.from(JSON.stringify({ o: off + page.length, s: seed })).toString("base64url") : null;
    return {
      total, count: page.length, nextCursor: next,
      ordering: sort && sort !== "default" ? `${sort}, then default` : "text match count, then badge, then score, then settled jobs, then seeded shuffle (daily seed); no paid ranking",
      results: page.map((h) => this._compact(h.r, h.tr)),
      untrustedFields: UNTRUSTED_FIELDS,
    };
  }
  /** GET /exchange/v1/listings/{id}: full listing with per-skill hire entries (MCP call, HTTP body, x402 accepts for the default evaluator). */
  async getListing(id, { withX402 = true } = {}) {
    const r = this._row(id);
    const d = r.doc;
    const tr = this.trackRecord(r.seller, { asSeller: true });
    const skills = [];
    for (const s of d.skills) {
      let x402 = null;
      if (withX402 && r.status === "active") {
        try {
          const ev = await this.selectEvaluator(r, s, { buyer: null, evaluator: null });
          x402 = { evaluator: ev.address, accepts: [await this.exactRequirements(r, s, ev.address)] };
        } catch (e) {
          x402 = { error: e.message };
        }
      }
      skills.push({
        ...s,
        priceUnit: "USDC base units (6 decimals)",
        quote: feeQuote(s.price, this.feeBps, this.feeMin),
        hire: {
          mcp: { tool: "place_order", arguments: { listingId: r.id, skillId: s.skill_id, buyer: "<buyer address>", input: s.input_schema ? "<JSON matching input_schema>" : "<optional JSON>" } },
          http: { method: "POST", url: this.url("/exchange/v1/orders"), body: { listing_id: r.id, skill_id: s.skill_id, buyer: "<buyer address>", evaluator: "<optional evaluator address>", input: "<optional JSON>" } },
          x402: { method: "POST", url: this.url(`/exchange/v1/listings/${r.id}/hire?skill=${encodeURIComponent(s.skill_id)}`), body: { input: "<optional JSON>" }, paymentHeader: "PAYMENT-SIGNATURE", ...(x402 ?? {}) },
        },
      });
    }
    return {
      listing_id: r.id, seller: r.seller, provider: this.provider(r), title: d.title, description: d.description, display_name: d.display_name ?? null, labels: d.labels,
      status: r.status, origin: r.origin, protocols: d.protocols, endpoint: d.endpoint, payTo: d.payTo, erc8004_id: d.erc8004_id,
      acceptable_evaluators: d.acceptable_evaluators, skills, created_at: iso(r.created_at), updated_at: iso(r.updated_at), metadata_hash: r.metadata_hash,
      claim: r.claim ? { method: r.claim.method, basis: r.claim.basis, claimant: r.claim.claimant ?? null, verifiedAt: r.claim.verifiedAt ?? null } : null,
      erc8004: r.claim?.erc8004 ?? (d.erc8004_id ? { agentId: d.erc8004_id, linked: false, basis: "not checked" } : null),
      probe: r.probe, track_record: tr, badges: tr.badges, score: tr.score,
      fees: this.fees(), contracts: this.contracts(), untrustedFields: UNTRUSTED_FIELDS,
      links: { self: this.url(`/exchange/v1/listings/${r.id}`), seller: this.url(`/exchange/v1/agents/${r.seller}`), page: this.url(`/exchange?listing=${r.id}`), status: { method: "POST", url: this.url(`/exchange/v1/listings/${r.id}/status`) }, optOut: { method: "POST", url: this.url("/v1/optout"), body: { match: r.id } } },
    };
  }
  get feeRecipient() {
    return this.o.feeRecipient ? getAddress(this.o.feeRecipient) : null;
  }
  /** Quote for a price: list fee, then the beta waiver (opted-in buyer, window active), then fee credits (capped at the fee). */
  quote(price, buyer = null, bps = this.feeBps) {
    const list = this.feeRecipient ? exchangeFee(price, bps, this.feeMin) : 0n;
    const adj = this.beta && list > 0n ? this.beta.apply(list, buyer) : { waived: false, waiverReason: null, creditAvailable: "0", creditApplied: "0", fee: list };
    return {
      price: String(price), list_fee: String(list), fee: String(adj.fee), total: String(BigInt(price) + adj.fee), unit: "USDC base units (6 decimals)",
      fee_waived: adj.waived, waiver_reason: adj.waiverReason, credit_applied: adj.creditApplied, credit_available: adj.creditAvailable,
      buyer: buyer && isAddress(buyer, { strict: false }) ? getAddress(buyer) : null,
      ...(buyer ? {} : { note: "list quote; pass buyer for the beta waiver and fee credits" }),
      seller_receives: String(price),
    };
  }
  fee(price) {
    return exchangeFee(price, this.feeBps, this.feeMin);
  }
  fees() {
    return {
      protocolFeeBps: 0, evaluatorFeeBps: 0, exchangeFeeBps: Number(this.feeBps),
      exchangeFee: {
        bps: Number(this.feeBps), percent: `${Number(this.feeBps) / 100}%`, min: String(this.feeMin), minUsdc: String(Number(this.feeMin) / 1e6), minAppliesBelow: this.feeBps > 0n ? String((this.feeMin * 10_000n) / this.feeBps) : null, cap: null, payer: "buyer", unit: "USDC base units (6 decimals)",
        rule: `fee = max(ceil(price * ${this.feeBps} / 10000), ${this.feeMin}); total charged to the buyer = price + fee; the escrow job amount (paid to the seller on a complete verdict) = price`,
        recipient: this.feeRecipient, value: TESTNET ? "test USDC on Base Sepolia (testnet); no real value" : "Circle USDC on Base mainnet; real value",
        appliesTo: ["Exchange listing hires", "Exchange open-jobs board jobs"], notAppliedTo: ["JobEscrow protocol fee (feeBps 0)", "evaluator judging (evaluatorFeeBps 0)", "direct escrow jobs outside the Exchange (/v1/notarize, /v1/quote, createJob)"],
        settlement: "x402: a second EIP-3009 authorization (payload.feeAuthorization) to the fee recipient, submitted by the relayer after the escrow settle; unsigned path: USDC.transfer(recipient, fee) tx reported as feeTx in the receipt",
      },
      judging: { fee: "0", freeThrough: FREE_JUDGING_THROUGH, basis: "JobEscrow currentConfig feeBps 0 and evaluatorFeeBps 0" },
      ...(this.beta ? { beta: { ...this.beta.terms(), optIn: { method: "POST", url: this.url("/exchange/v1/beta"), mcp: "join_beta", eip712: "BetaOptIn(address agent, bool optIn, uint256 issuedAt)" }, credits: this.url("/exchange/v1/beta/{address}/credits") } } : {}),
    };
  }

  // ---------------- evaluators + hire ----------------
  async evaluatorRows() {
    const rows = await this.o.evaluators().catch(() => []);
    return rows.filter((r) => r.active);
  }
  /** Pick or validate an active staked evaluator whose available exposure covers the amount. */
  async selectEvaluator(r, skill, { buyer = null, evaluator = null } = {}) {
    const rows = await this.evaluatorRows();
    const provider = this.provider(r);
    const amount = BigInt(skill.price);
    const crit = this.db.prepare("SELECT machine_checkable FROM ex_criteria WHERE sha256 = ?").get(skill.criteria_hash);
    const ref = this.o.referenceEvaluator ? lc(this.o.referenceEvaluator) : null;
    const why = (e) => {
      if (lc(e.address) === lc(provider) || lc(e.address) === lc(r.seller)) return "evaluator is the seller/provider";
      if (buyer && lc(e.address) === lc(buyer)) return "evaluator is the buyer";
      if (r.doc.acceptable_evaluators.length && !r.doc.acceptable_evaluators.some((a) => lc(a) === lc(e.address))) return "not in the listing's acceptable_evaluators";
      if (e.availableExposure != null && BigInt(e.availableExposure) < amount) return "available exposure below the job amount";
      if (lc(e.address) === ref && !crit?.machine_checkable) return "the reference evaluator only judges machine-checkable Exchange criteria";
      return null;
    };
    if (evaluator) {
      const e = rows.find((x) => lc(x.address) === lc(evaluator));
      if (!e) throw new ExchangeError(422, "evaluator is not an active EvaluatorRegistry evaluator", { evaluators: this.url("/exchange/v1/evaluators") });
      const w = why(e);
      if (w) throw new ExchangeError(422, `evaluator not eligible: ${w}`);
      return { ...e, address: getAddress(e.address), selection: "buyer choice" };
    }
    const ok = rows.filter((e) => !why(e));
    if (!ok.length) throw new ExchangeError(422, "no eligible active evaluator for this skill", { evaluators: this.url("/exchange/v1/evaluators") });
    const pick = ok.find((e) => lc(e.address) === ref) ?? ok.find((e) => e.default) ?? [...ok].sort((a, b) => cmp(BigInt(b.stake ?? 0), BigInt(a.stake ?? 0)))[0];
    return { ...pick, address: getAddress(pick.address), selection: lc(pick.address) === ref ? "default: reference evaluator (machine-checkable criteria)" : "default: highest stake among eligible" };
  }
  offer(r, skill, evaluator) {
    return { provider: this.provider(r), evaluator: getAddress(evaluator), amount: BigInt(skill.price), deadlineSeconds: BigInt(skill.sla_seconds), specHash: skill.criteria_hash };
  }
  async routeFor(o) {
    const k = jcs({ ...o, amount: String(o.amount), deadlineSeconds: String(o.deadlineSeconds) });
    if (!this.routeCache.has(k)) this.routeCache.set(k, await this.o.chain.routeFor(o));
    if (this.routeCache.size > 5000) this.routeCache.clear();
    return this.routeCache.get(k);
  }
  /** x402 v2 `exact` requirements: payTo is the CREATE2 EscrowDepositRoute bound to (provider, evaluator, amount, sla, specHash). */
  async exactRequirements(r, skill, evaluator, buyer = null) {
    return this.requirementsFor(this.offer(r, skill, evaluator), { listingId: r.id, skillId: skill.skill_id, ...(buyer ? { buyer: getAddress(buyer) } : {}) });
  }
  /** Fee leg requirement (EIP-3009 to the fee recipient); null when no recipient is configured. */
  feeRequirement(price, buyer = null) {
    if (!this.feeRecipient) return null;
    const fee = BigInt(this.quote(price, buyer).fee);
    if (fee === 0n) return null;
    return { scheme: "exact", network: this.network, amount: String(fee), asset: this.o.chain.usdc, payTo: this.feeRecipient, maxTimeoutSeconds: 300, extra: { name: this.o.tokenEip712?.name ?? "USDC", version: this.o.tokenEip712?.version ?? "2", assetTransferMethod: "eip3009", purpose: `AgentKoin Exchange buyer fee (${feeTerms(this.feeBps, this.feeMin)}); sign as payload.feeAuthorization next to payload.authorization` } };
  }
  async requirementsFor(o, exchangeMeta) {
    const payTo = await this.routeFor(o);
    return {
      scheme: "exact", network: this.network, amount: String(o.amount), asset: this.o.chain.usdc, payTo, maxTimeoutSeconds: 300,
      extra: {
        name: this.o.tokenEip712?.name ?? "USDC", version: this.o.tokenEip712?.version ?? "2", assetTransferMethod: "eip3009",
        agentcoin: { payToKind: "EscrowDepositRoute (CREATE2, offer-bound); settle opens an escrow job with client = authorization.from", depositRouteFactory: this.o.chain.routeFactory, escrowContract: this.o.chain.escrow, offer: { provider: o.provider, evaluator: o.evaluator, amount: String(o.amount), deadlineSeconds: Number(o.deadlineSeconds), specHash: o.specHash }, exchange: exchangeMeta, relayerPaysGas: true, exchangeFee: { ...this.quote(o.amount, exchangeMeta?.buyer ?? null), requirement: this.feeRequirement(o.amount, exchangeMeta?.buyer ?? null), payloadField: "feeAuthorization" } },
      },
    };
  }
  _skill(r, skillId) {
    const s = skillId ? r.doc.skills.find((x) => x.skill_id === skillId) : r.doc.skills[0];
    if (!s) throw new ExchangeError(400, "unknown skill_id for this listing", { skills: r.doc.skills.map((x) => x.skill_id) });
    return s;
  }
  _input(input, skill) {
    if (input == null) return null;
    const s = jcs(input);
    if (s.length > this.limits.maxInputBytes) throw new ExchangeError(400, `input must be <= ${this.limits.maxInputBytes} bytes (RFC 8785)`);
    if (skill.input_schema) {
      let ok = false, errs = [];
      try {
        const v = new Ajv2020({ strict: false, allErrors: true }).compile(skill.input_schema);
        ok = !!v(input);
        errs = (v.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`);
      } catch (e) {
        errs = [String(e.message).slice(0, 100)];
      }
      if (!ok) throw new ExchangeError(400, "input does not match the skill's input_schema", { errors: errs });
    }
    return input;
  }
  origin(buyer, seller) {
    const int = this.internal();
    if (lc(buyer) === lc(seller)) return "self";
    if (int.has(lc(buyer))) return "agentcoin";
    return "external";
  }
  admitBuyer(buyer) {
    const n = this.db.prepare("SELECT COUNT(*) n FROM ex_orders WHERE buyer = ? AND created_at > ?").get(getAddress(buyer), this.now() - 86400_000).n;
    if (n >= this.limits.maxOrdersPerBuyerPerDay) throw new ExchangeError(429, `max ${this.limits.maxOrdersPerBuyerPerDay} Exchange orders per buyer per day`);
  }
  /**
   * POST /exchange/v1/orders {listing_id, skill_id?, buyer, evaluator?, input?}: one call returns everything needed to fund:
   * (a) x402 exact requirements (buyer signs EIP-3009 only; relayer pays gas) and (b) unsigned approve + JobEscrow.createAndFundFor.
   */
  async hire({ listing_id, skill_id = null, buyer, evaluator = null, input = null, channel = "http", escrow = undefined } = {}) {
    const r = this._row(listing_id);
    if (r.status !== "active") throw new ExchangeError(409, `listing is ${r.status}`);
    if (!buyer || !isAddress(buyer, { strict: false })) throw new ExchangeError(400, "buyer (EVM address that funds the escrow) required");
    buyer = getAddress(buyer);
    const skill = this._skill(r, skill_id);
    const inp = this._input(input, skill);
    if (lc(buyer) === lc(this.provider(r))) throw new ExchangeError(422, "buyer cannot be the provider");
    this.admitBuyer(buyer);
    const optin = this.escrowMode === "optin";
    if (optin && escrow !== true && escrow !== "true") return this.hireDirect({ r, skill, inp, buyer, channel });
    const bps = optin ? this.escrowFeeBps : this.feeBps;
    const ev = await this.selectEvaluator(r, skill, { buyer, evaluator });
    const o = this.offer(r, skill, ev.address);
    const req = await this.exactRequirements(r, skill, ev.address, buyer);
    const id = "xo_" + randomBytes(8).toString("hex");
    const t = this.now();
    const c = this.o.chain;
    const deadline = BigInt(Math.floor(t / 1000) + skill.sla_seconds);
    const txs = [
      { step: 1, label: "USDC.approve(escrow, amount)", chainId: this.chainId, from: buyer, to: c.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.escrow, o.amount] }), value: "0" },
      { step: 2, label: "JobEscrow.createAndFundFor(client, provider, evaluator, amount, deadline, specHash)", chainId: this.chainId, from: buyer, to: c.escrow, data: encodeFunctionData({ abi: c.escrowAbi, functionName: "createAndFundFor", args: [buyer, o.provider, o.evaluator, o.amount, deadline, o.specHash] }), value: "0" },
      ...this.feeTxs(buyer, o.amount, bps),
    ];
    const org = this.origin(buyer, r.seller);
    this.db.prepare("INSERT INTO ex_orders (id, listing_id, skill_id, buyer, seller, evaluator, amount, escrow, spec_hash, deadline_seconds, route, job_id, channel, origin, status, txs, input, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'awaiting-funding', ?, ?, ?, ?)")
      .run(id, r.id, skill.skill_id, buyer, r.seller, ev.address, String(o.amount), getAddress(c.escrow), o.specHash, skill.sla_seconds, req.payTo, channel, org, J({}), J(inp), t, t);
    return {
      order_id: id, listing_id: r.id, skill_id: skill.skill_id, buyer, seller: r.seller, provider: o.provider, evaluator: ev.address, evaluatorSelection: ev.selection,
      amount: String(o.amount), asset: c.usdc, escrow: getAddress(c.escrow), spec_hash: o.specHash, criteria_url: skill.criteria_spec_url, sla_seconds: skill.sla_seconds,
      status: "awaiting-funding", origin: org, counted_in_score: org === "external", quote: this.quote(o.amount, buyer, bps), fees: this.fees(), contracts: this.contracts(),
      ...(optin ? { mode: "escrow", escrow_protected: true, badges: ["escrow-protected"], risks_url: this.risksUrl } : {}),
      payment: {
        x402: { method: "POST", url: this.url(`/exchange/v1/orders/${id}/pay`), header: "PAYMENT-SIGNATURE", accepts: [req], note: "EIP-3009 transferWithAuthorization to payTo; the relayer submits EscrowDepositRouteFactory.settle, which opens the job with client = authorization.from" },
        transactions: txs,
        receipt: { method: "POST", url: this.url(`/exchange/v1/orders/${id}/receipt`), body: { jobId: "<id from the JobCreated event>", paymentTx: "0x<createAndFundFor tx hash>", ...(BigInt(this.quote(o.amount, buyer, bps).fee) > 0n ? { feeTx: "0x<USDC.transfer(fee recipient, fee) tx hash>" } : {}) } },
      },
      delivery: { by: o.provider, submit: "JobEscrow.submit(jobId, sha256(deliverable bytes))", format: "JSON {\"jobId\": \"<id>\", \"output\": <JSON>} per the criteria document", publish: { method: "POST", url: this.url(`/exchange/v1/orders/${id}/deliverable`), body: "raw deliverable bytes (application/json); accepted only when sha256 equals the on-chain deliverableHash" } },
      links: { order: this.url(`/exchange/v1/orders/${id}`), listing: this.url(`/exchange/v1/listings/${r.id}`) },
    };
  }
  /**
   * Direct (no escrow) hire, the default when escrowMode is "optin": the buyer pays the provider with USDC.transfer and
   * the Exchange fee at the list rate. No evaluator, no escrow job, no refund path. Opt in with escrow:true.
   */
  hireDirect({ r, skill, inp, buyer, channel }) {
    const ZERO = "0x0000000000000000000000000000000000000000";
    const o = this.offer(r, skill, ZERO);
    const id = "xo_" + randomBytes(8).toString("hex");
    const t = this.now();
    const c = this.o.chain;
    const txs = [
      { step: 1, label: "USDC.transfer(provider, amount) (direct pay, no escrow)", chainId: this.chainId, from: buyer, to: c.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [o.provider, o.amount] }), value: "0" },
      ...this.feeTxs(buyer, o.amount).map((x) => ({ ...x, step: 2 })),
    ];
    const org = this.origin(buyer, r.seller);
    this.db.prepare("INSERT INTO ex_orders (id, listing_id, skill_id, buyer, seller, evaluator, amount, escrow, spec_hash, deadline_seconds, route, job_id, channel, origin, status, txs, input, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'awaiting-payment', ?, ?, ?, ?)")
      .run(id, r.id, skill.skill_id, buyer, r.seller, ZERO, String(o.amount), ZERO, o.specHash, skill.sla_seconds, channel, org, J({ mode: "direct" }), J(inp), t, t);
    const q = this.quote(o.amount, buyer);
    return {
      order_id: id, listing_id: r.id, skill_id: skill.skill_id, mode: "direct", escrow_protected: false, badges: [],
      buyer, seller: r.seller, provider: o.provider, amount: String(o.amount), asset: c.usdc, spec_hash: o.specHash, criteria_url: skill.criteria_spec_url, sla_seconds: skill.sla_seconds,
      status: "awaiting-payment", origin: org, quote: q, fees: this.fees(),
      payment: {
        transactions: txs,
        receipt: { method: "POST", url: this.url(`/exchange/v1/orders/${id}/receipt`), body: { paymentTx: "0x<USDC.transfer tx hash>", ...(BigInt(q.fee) > 0n ? { feeTx: "0x<fee transfer tx hash>" } : {}) } },
        note: "Direct pay: USDC goes straight to the provider. No escrow, no evaluator verdict, no refund through AgentKoin.",
      },
      escrow_opt_in: {
        how: "repeat this request with \"escrow\": true",
        benefits: { badge: "escrow-protected", ranking: "listings rank escrow-protected settled jobs first (after text match)", exchangeFeeBps: Number(this.escrowFeeBps), listFeeBps: Number(this.feeBps), feeMin: String(this.feeMin) },
        risks_url: this.risksUrl,
      },
      risks_url: this.risksUrl,
      links: { order: this.url(`/exchange/v1/orders/${id}`), listing: this.url(`/exchange/v1/listings/${r.id}`) },
    };
  }
  /** Direct order receipt: the USDC transfer buyer -> provider (and the fee leg, if any) is checked on chain. */
  async recordDirectPayment(id, { paymentTx, feeTx = null }) {
    const o = this._order(id);
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(paymentTx ?? ""))) throw new ExchangeError(400, "paymentTx (0x + 64 hex) required for a direct order");
    if (o.status === "paid") return this.orderView(o);
    const provider = this.provider(this._row(o.listing_id));
    if (!(await this.o.chain.verifyFeeTransfer(paymentTx, { from: o.buyer, to: provider, min: o.amount }))) throw new ExchangeError(422, "paymentTx has no USDC Transfer buyer -> provider of at least the amount");
    const fee = BigInt(this.quote(o.amount, o.buyer).fee);
    let feeOk = fee === 0n;
    if (!feeOk && feeTx && /^0x[0-9a-fA-F]{64}$/.test(String(feeTx))) feeOk = await this.o.chain.verifyFeeTransfer(feeTx, { from: o.buyer, to: this.feeRecipient, min: fee });
    this.db.prepare("UPDATE ex_orders SET txs = ?, status = 'paid', updated_at = ? WHERE id = ?").run(J({ ...o.txs, payment: paymentTx, fee: feeTx, feeVerified: feeOk, feeAmount: String(fee) }), this.now(), id);
    return this.orderView(this._order(id));
  }
  /** Escrow provider of an order: the listing provider, or the claimer (order.seller) for open-jobs board orders. */
  orderProvider(o) {
    return o.listing_id.startsWith("oj_") ? getAddress(o.seller) : this.provider(this._row(o.listing_id));
  }
  orderOffer(o) {
    return { provider: this.orderProvider(o), evaluator: getAddress(o.evaluator), amount: BigInt(o.amount), deadlineSeconds: BigInt(o.deadline_seconds), specHash: o.spec_hash };
  }
  _order(id) {
    const o = this.db.prepare("SELECT * FROM ex_orders WHERE id = ?").get(String(id));
    if (!o) throw new ExchangeError(404, "unknown order_id");
    return { ...o, txs: P(o.txs) ?? {}, input: P(o.input), job: P(o.job) };
  }
  orderByJob(escrow, jobId) {
    const o = this.db.prepare("SELECT id FROM ex_orders WHERE lower(escrow) = lower(?) AND job_id = ?").get(String(escrow), String(jobId));
    return o ? this._order(o.id) : null;
  }
  /** Record a funded job for an order after checking it on chain (createAndFundFor path or x402 settle). */
  async recordFunding(id, { jobId, paymentTx = null, payer = null, feeTx = null, feeVerified = false, feePaid = null }) {
    const o = this._order(id);
    if (o.txs?.mode === "direct") return this.recordDirectPayment(id, { paymentTx, feeTx });
    if (!/^[0-9]{1,30}$/.test(String(jobId ?? ""))) throw new ExchangeError(400, "jobId (decimal) required");
    if (o.job_id && o.job_id !== String(jobId)) throw new ExchangeError(409, "order already bound to another job", { jobId: o.job_id });
    const dup = this.orderByJob(o.escrow, jobId);
    if (dup && dup.id !== id) throw new ExchangeError(409, "jobId already recorded for another order", { order_id: dup.id });
    const job = await this.o.chain.readJob(String(jobId));
    const mism = [];
    if (!job) mism.push("job not found");
    else {
      if (lc(job.provider) !== lc(this.orderProvider(o))) mism.push("provider");
      if (lc(job.evaluator) !== lc(o.evaluator)) mism.push("evaluator");
      if (lc(job.specHash) !== lc(o.spec_hash)) mism.push("specHash");
      if (BigInt(job.amount) < BigInt(o.amount)) mism.push("amount");
      if (lc(job.client) !== lc(payer ?? o.buyer)) mism.push("client");
    }
    if (mism.length) throw new ExchangeError(422, `escrow job does not match the order: ${mism.join(", ")}`);
    const buyer = getAddress(job.client);
    const q = this.quote(o.amount, buyer);
    const fee = BigInt(q.fee);
    let paid = feePaid != null ? BigInt(feePaid) : fee;
    if (this.feeRecipient && !feeVerified && fee > 0n) {
      // unsigned path: the buyer reports the fee transfer; checked on chain (Transfer buyer -> recipient >= fee), one order per feeTx
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(feeTx ?? ""))) throw new ExchangeError(402, `exchange fee unpaid: send USDC.transfer(${this.feeRecipient}, ${fee}) and include feeTx`, { quote: q, recipient: this.feeRecipient });
      const used = this.db.prepare("SELECT id FROM ex_orders WHERE id != ? AND json_extract(txs, '$.fee') = ?").get(id, String(feeTx));
      if (used) throw new ExchangeError(409, "feeTx already used for another order", { order_id: used.id });
      const ok = await this.o.chain.verifyFeeTransfer?.(feeTx, { from: buyer, to: this.feeRecipient, min: fee }).catch(() => false);
      if (!ok) throw new ExchangeError(422, "feeTx does not contain a USDC Transfer from the buyer to the fee recipient for at least the fee", { quote: q, recipient: this.feeRecipient });
      paid = fee;
    }
    // credits cover list_fee - paid (never more than the fee; 0 when the beta waiver applies); idempotent per order
    const list = BigInt(q.list_fee);
    const creditNeed = q.fee_waived ? 0n : list > paid ? list - paid : 0n;
    const deb = this.beta && creditNeed > 0n ? this.beta.debit(buyer, creditNeed, id) : { debited: "0", shortfall: "0" };
    const txs = { ...o.txs, fund: paymentTx, ...(this.feeRecipient ? { fee: feeTx ?? null, feeAmount: String(paid), feeList: String(list), feeWaived: q.fee_waived, creditApplied: deb.debited, ...(deb.shortfall !== "0" ? { feeShortfall: deb.shortfall } : {}), feeRecipient: this.feeRecipient } : {}) };
    this.db.prepare("UPDATE ex_orders SET job_id = ?, buyer = ?, origin = ?, status = 'funded', txs = ?, job = ?, updated_at = ? WHERE id = ?").run(String(jobId), buyer, this.origin(buyer, o.seller), J(txs), J(job), this.now(), id);
    return this.orderView(this._order(id));
  }
  /** x402 path: create the order (if needed) and bind it to the job opened by settle. */
  async createFunded({ listing_id, skill_id, evaluator, buyer, input, jobId, paymentTx, channel = "x402", feeTx = null, feeVerified = false }) {
    const ord = await this.hire({ listing_id, skill_id, buyer, evaluator, input, channel, escrow: true }); // x402 settle = escrow job
    return this.recordFunding(ord.order_id, { jobId, paymentTx, payer: buyer, feeTx, feeVerified });
  }
  /** Refresh an order from chain; status: awaiting-funding | funded | submitted | verdict | settled | disputed | expired | cancelled. */
  async refresh(id) {
    let o = this._order(id);
    if (!o.job_id || (o.job && TERMINAL.has(o.job.state))) return o;
    const job = await this.o.chain.readJob(o.job_id).catch(() => null);
    if (!job) return o;
    const zero = /^0x0{64}$/;
    const st = job.state;
    const status = st === "Settled" ? "settled" : st === "Disputed" ? "disputed" : st === "Expired" ? "expired" : st === "Cancelled" ? "cancelled" : STATE_OUTCOME[st] ? "verdict" : job.deliverableHash && !zero.test(job.deliverableHash) ? "submitted" : "funded";
    this.db.prepare("UPDATE ex_orders SET job = ?, status = ?, deliverable_hash = COALESCE(deliverable_hash, ?), updated_at = ? WHERE id = ?").run(J(job), status, job.deliverableHash && !zero.test(job.deliverableHash) ? lc(job.deliverableHash) : null, this.now(), id);
    o = this._order(id);
    if (status === "settled") this.beta?.grantForOrder(o);
    return o;
  }
  feeTxs(buyer, price, bps = this.feeBps) {
    const fee = BigInt(this.quote(price, buyer, bps).fee);
    if (!this.feeRecipient || fee === 0n) return [];
    return [{ step: 3, label: `USDC.transfer(feeRecipient, fee) (Exchange buyer fee, ${feeTerms(bps, this.feeMin)})`, chainId: this.chainId, from: buyer, to: this.o.chain.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [this.feeRecipient, fee] }), value: "0" }];
  }
  setTx(id, k, hash) {
    const o = this._order(id);
    this.db.prepare("UPDATE ex_orders SET txs = ?, updated_at = ? WHERE id = ?").run(J({ ...o.txs, [k]: hash }), this.now(), id);
  }
  orderView(o) {
    const verdict = o.job ? (o.job.state === "Settled" ? String(o.job.outcome ?? "").toLowerCase() || null : STATE_OUTCOME[o.job.state] ?? null) : null;
    const proof = o.job_id ? this.url(`/v1/escrows/${o.escrow}/jobs/${o.job_id}/proof`) : null;
    return {
      order_id: o.id, listing_id: o.listing_id, skill_id: o.skill_id, buyer: o.buyer, seller: o.seller, evaluator: o.evaluator, amount: o.amount, escrow: o.escrow, job_id: o.job_id,
      spec_hash: o.spec_hash, criteria_url: this.url(`/exchange/v1/criteria/${o.spec_hash.slice(2)}`), deliverable_hash: o.deliverable_hash, deliverable_url: o.deliverable ? this.url(`/exchange/v1/orders/${o.id}/deliverable`) : null,
      status: o.status, job_state: o.job?.state ?? null, verdict, txs: o.txs, channel: o.channel, origin: o.origin, counted_in_score: o.origin === "external", quote: o.txs?.feeAmount != null ? { price: o.amount, list_fee: o.txs.feeList ?? o.txs.feeAmount, fee: o.txs.feeAmount, total: String(BigInt(o.amount) + BigInt(o.txs.feeAmount)), fee_waived: !!o.txs.feeWaived, credit_applied: o.txs.creditApplied ?? "0", paid: true, seller_receives: o.amount } : this.quote(o.amount, o.buyer),
      ...(o.listing_id.startsWith("oj_") ? { open_job_id: o.listing_id } : {}),
      input: o.input, created_at: iso(o.created_at), updated_at: iso(o.updated_at), proof_url: proof,
      ...(this.escrowMode === "optin" ? { mode: o.txs?.mode ?? "escrow", escrow_protected: (o.txs?.mode ?? "escrow") === "escrow", badges: (o.txs?.mode ?? "escrow") === "escrow" ? ["escrow-protected"] : [], risks_url: this.risksUrl } : {}),
      verify_command: o.job_id ? `npx ${JUDGE_KIT_REF} verify ${o.job_id} --escrow ${o.escrow}` : null,
    };
  }
  async getOrder(id) {
    return this.orderView(await this.refresh(id));
  }
  /** POST /exchange/v1/orders/{id}/deliverable: raw bytes, stored only when sha256(bytes) equals the on-chain deliverableHash. */
  async putDeliverable(id, bytes) {
    if (!bytes?.length || bytes.length > this.limits.maxDeliverableBytes) throw new ExchangeError(400, `deliverable must be 1..${this.limits.maxDeliverableBytes} bytes`);
    const o = await this.refresh(id);
    if (!o.job_id) throw new ExchangeError(409, "order is not funded");
    const h = sha256Hex(bytes);
    if (!o.job?.deliverableHash || lc(o.job.deliverableHash) !== lc(h)) throw new ExchangeError(422, "sha256(deliverable bytes) does not equal the on-chain deliverableHash (submit first)", { computed: h, onchain: o.job?.deliverableHash ?? null });
    this.db.prepare("UPDATE ex_orders SET deliverable = ?, deliverable_hash = ?, updated_at = ? WHERE id = ?").run(Buffer.from(bytes), h, this.now(), id);
    return this.orderView(this._order(id));
  }
  /** Seed/worker path: store bytes before the on-chain submit (the hash is then committed by the provider). */
  storeDeliverable(id, bytes) {
    const h = sha256Hex(bytes);
    this.db.prepare("UPDATE ex_orders SET deliverable = ?, deliverable_hash = ?, updated_at = ? WHERE id = ?").run(Buffer.from(bytes), h, this.now(), id);
    return h;
  }
  deliverableBytes(id) {
    const o = this.db.prepare("SELECT deliverable FROM ex_orders WHERE id = ?").get(String(id));
    return o?.deliverable ?? null;
  }
  criteria(shaNo0x) {
    const r = this.db.prepare("SELECT bytes, machine_checkable FROM ex_criteria WHERE sha256 = ?").get("0x" + String(shaNo0x).toLowerCase());
    return r ? { bytes: r.bytes, machineCheckable: !!r.machine_checkable } : null;
  }
  /** Reference-evaluator judgement for an order (machine-checkable criteria only). */
  async evaluate(id) {
    const o = await this.refresh(id);
    const c = this.criteria(o.spec_hash.slice(2));
    if (!c?.machineCheckable) return { pass: false, judgeable: false, reason: "criteria not machine-checkable" };
    const bytes = this.deliverableBytes(id);
    if (!bytes) return { pass: false, judgeable: false, reason: "deliverable bytes not published" };
    const crit = JSON.parse(Buffer.from(c.bytes).toString("utf8"));
    const r = checkDeliverable({ criteria: crit, bytes, jobId: o.job_id, onchainDeliverableHash: o.job?.deliverableHash });
    const reason = `agentkoin-exchange-criteria/v1 ${o.spec_hash}: ${r.checks.map((x) => `${x.id}=${x.status}`).join(",")}`;
    return { ...r, judgeable: true, reason };
  }
  /** Hints for /v1/escrows/{escrow}/jobs/{id}/proof (criteria + deliverable URLs, tx hashes). */
  proofHints(escrow, jobId) {
    const o = this.orderByJob(escrow, jobId);
    if (!o) return null;
    return { orderId: o.id, listingId: o.listing_id, criteriaUrls: [this.url(`/exchange/v1/criteria/${o.spec_hash.slice(2)}`)], deliverableUrls: o.deliverable ? [this.url(`/exchange/v1/orders/${o.id}/deliverable`)] : [], fundTx: o.txs.fund ?? undefined, submitTx: o.txs.submit ?? undefined, verdictTx: o.txs.verdict ?? undefined, settleTx: o.txs.settle ?? undefined };
  }
  /** Local answers for our own URLs (no self-HTTP from the proof builder). */
  localBytes(url) {
    const cm = url.startsWith(this.url("/exchange/v1/criteria/")) ? url.slice(this.url("/exchange/v1/criteria/").length).match(/^[0-9a-f]{64}$/) : null;
    if (cm) return this.criteria(cm[0])?.bytes ?? null;
    const dm = url.startsWith(this.url("/exchange/v1/orders/")) ? url.slice(this.url("/exchange/v1/orders/").length).match(/^(xo_[0-9a-f]{16})\/deliverable$/) : null;
    if (dm) return this.deliverableBytes(dm[1]);
    return null;
  }

  // ---------------- reputation ----------------
  trustIndex() {
    const m = new Map();
    for (const j of this.o.trustJobs?.() ?? []) m.set(`${lc(j.escrow)}:${j.jobId}`, j);
    return m;
  }
  /** Track record from Exchange orders (state read from chain) + judge-kit results published on /trust (spec section 8). */
  trackRecord(agent, { asSeller = true } = {}) {
    const a = getAddress(agent);
    const int = this.internal();
    const tidx = this.trustIndex();
    const sold = this.db.prepare("SELECT * FROM ex_orders WHERE seller = ? AND job_id IS NOT NULL").all(a).map((o) => ({ ...o, job: P(o.job), txs: P(o.txs) }));
    const bought = this.db.prepare("SELECT COUNT(*) n FROM ex_orders WHERE buyer = ? AND job_id IS NOT NULL").get(a).n;
    const judged = this.db.prepare("SELECT * FROM ex_orders WHERE evaluator = ? AND job_id IS NOT NULL").all(a).map((o) => ({ ...o, job: P(o.job) }));
    const outcomeOf = (o) => (o.job?.state === "Settled" ? String(o.job.outcome ?? "").toLowerCase() : STATE_OUTCOME[o.job?.state] ?? null);
    const settled = sold.filter((o) => o.job?.state === "Settled");
    const weight = (o) => (lc(o.buyer) === lc(o.seller) || int.has(lc(o.buyer)) || int.has(lc(o.seller)) ? 0 : 1);
    const outside = settled.filter((o) => weight(o) === 1);
    const completedW = outside.filter((o) => outcomeOf(o) === "complete").length + outside.filter((o) => outcomeOf(o) === "partial").reduce((s, o) => s + Number(o.job?.payoutBps ?? 0) / 10000, 0);
    const verified = settled.map((o) => tidx.get(`${lc(o.escrow)}:${o.job_id}`)?.ourVerify ?? null);
    const known = verified.filter(Boolean);
    const verified_pct = known.length ? known.filter((v) => v.ok).length / known.length : null;
    const subTimes = sold.filter((o) => o.job?.submittedAt && o.created_at).map((o) => Number(o.job.submittedAt) * 1000 - o.created_at).filter((x) => x >= 0).sort((x, y) => x - y);
    const rec = {
      agent_id: a,
      jobs_total: sold.length, jobs_settled: settled.length,
      jobs_completed: settled.filter((o) => outcomeOf(o) === "complete").length, jobs_rejected: settled.filter((o) => outcomeOf(o) === "reject").length, jobs_partial: settled.filter((o) => outcomeOf(o) === "partial").length,
      disputes_lost: sold.filter((o) => o.job?.state === "Settled" && o.job?.disputedAt && Number(o.job.disputedAt) > 0 && outcomeOf(o) === "reject").length,
      volume_usdc: settled.reduce((s, o) => s + (BigInt(o.amount) * BigInt(o.job?.payoutBps ?? 0)) / 10000n, 0n).toString(),
      unique_counterparties: new Set(sold.map((o) => lc(o.buyer))).size,
      outside_jobs: outside.length, outside_buyers: new Set(outside.map((o) => lc(o.buyer))).size,
      excluded_self_or_agentkoin: settled.length - outside.length,
      median_time_to_submit_ms: subTimes.length ? subTimes[Math.floor((subTimes.length - 1) / 2)] : null,
      verified_pct, verified_known: known.length,
      jobs_as_buyer: bought,
      evaluator: judged.length ? { verdicts: judged.filter((o) => ["Completed", "Rejected", "Partial", "Settled", "Disputed"].includes(o.job?.state)).length, jobs: judged.length } : null,
    };
    rec.score = outside.length >= 3 ? completedW / outside.length : "new";
    rec.score_rule = "completed (partial by payoutBps) / settled outside jobs; self-dealing and AgentKoin-wallet jobs weight 0; shown only with >= 3 outside jobs";
    const claimed = !!this.db.prepare("SELECT 1 FROM ex_listings WHERE seller = ? AND claim IS NOT NULL").get(a);
    rec.badges = [...(settled.length >= 3 && rec.outside_buyers >= 2 && verified_pct === 1 && known.length === settled.length && rec.disputes_lost === 0 && claimed ? ["verified-track-record"] : []), ...(this.beta?.isIn(a) ? ["beta-tester"] : []), ...(this.intents?.isVerified(a) ? ["verified-agent"] : [])];
    rec.badge_rule = "verified-agent: a signature by this wallet (EIP-712 OrderIntent or Listing) plus ERC-8004 ownerOf(agentId) or getAgentWallet(agentId) equal to the signer, checked read-only; it shows control of a key, not that the caller is not a human; beta-tester: the agent wallet signed the EIP-712 BetaOptIn (opt-in recorded, not opted out); verified-track-record: >= 3 settled jobs, >= 2 distinct outside buyers, judge-kit verify passes for 100% of them (/trust), 0 lost disputes, seller identity signed; testnet data only, no claim about real-world quality";
    rec.evidence = settled.map((o) => ({ escrow: o.escrow, jobId: o.job_id, outcome: outcomeOf(o), buyer: o.buyer, countedInScore: weight(o) === 1, judgeKit: tidx.get(`${lc(o.escrow)}:${o.job_id}`)?.ourVerify ?? null, proof: this.url(`/v1/escrows/${o.escrow}/jobs/${o.job_id}/proof`) }));
    rec.evidenceRoot = keccak256(toBytes(jcs(rec.evidence)));
    return rec;
  }
  async agentProfile(agent) {
    if (!isAddress(agent, { strict: false })) throw new ExchangeError(400, "agent_id must be an EVM address");
    const a = getAddress(agent);
    const listings = this.db.prepare("SELECT * FROM ex_listings WHERE seller = ? AND status != 'removed' ORDER BY created_at").all(a).map((r) => ({ ...r, doc: P(r.doc), claim: P(r.claim) }));
    const ev = (await this.evaluatorRows()).find((e) => lc(e.address) === lc(a)) ?? null;
    const tr = this.trackRecord(a);
    const roles = [...(listings.length ? ["seller"] : []), ...(tr.jobs_as_buyer ? ["buyer"] : []), ...(ev || tr.evaluator ? ["evaluator"] : [])];
    const first = listings.find((l) => l.claim);
    const doc = {
      v: "agentkoin-exchange-profile/v1", agent_id: a, erc8004_id: listings.map((l) => l.doc.erc8004_id).find(Boolean) ?? null,
      erc8004: listings.map((l) => l.claim?.erc8004).find((x) => x?.linked) ?? listings.map((l) => l.claim?.erc8004).find(Boolean) ?? null,
      display_name: listings.map((l) => l.doc.display_name).find(Boolean) ?? listings[0]?.doc.title ?? null, roles,
      claimed_at: first ? iso(first.created_at) : null, labels: [...new Set(listings.flatMap((l) => l.doc.labels))].slice(0, 20),
      evaluator: ev ? { stake: ev.stake, availableExposure: ev.availableExposure, active: ev.active, label: ev.label ?? null } : null,
      track_record: tr, badges: tr.badges, listing_ids: listings.map((l) => l.id),
      links: { trust_url: this.url("/trust"), proofs: tr.evidence.map((e) => e.proof), listings: listings.map((l) => this.url(`/exchange/v1/listings/${l.id}`)) },
      generatedAt: iso(this.now()), chainId: this.chainId, untrustedFields: ["display_name", "labels"], testnet: TESTNET, realValue: !TESTNET,
    };
    return this.o.signerKey ? signEip191(doc, this.o.signerKey) : doc;
  }
  async evaluatorsView() {
    const rows = await this.evaluatorRows();
    return {
      evaluators: rows.map((e) => ({ address: getAddress(e.address), active: e.active, stake: e.stake, availableExposure: e.availableExposure, label: e.label ?? null, operator: e.operator ?? null, default: lc(e.address) === lc(this.o.referenceEvaluator), judgesExchangeCriteriaAutomatically: lc(e.address) === lc(this.o.referenceEvaluator), exchange: this.trackRecord(e.address).evaluator, trackRecordUrl: this.url(`/v1/evaluators/${getAddress(e.address)}`) })),
      selection: "hire picks the buyer's evaluator if active, eligible and its available exposure covers the amount; else the reference evaluator for machine-checkable criteria; else the highest-stake eligible evaluator",
      registry: this.o.chain.registry ?? null, fees: this.fees(),
    };
  }
  stats() {
    const l = this.db.prepare("SELECT origin, status, COUNT(*) n FROM ex_listings GROUP BY origin, status").all();
    const o = this.db.prepare("SELECT origin, status, COUNT(*) n FROM ex_orders GROUP BY origin, status").all();
    const week = this.db.prepare("SELECT COUNT(*) n FROM ex_orders WHERE job_id IS NOT NULL AND created_at > ?").get(this.now() - 7 * 86400_000).n;
    const extBuyers = this.db.prepare("SELECT COUNT(DISTINCT buyer) n FROM ex_orders WHERE origin = 'external' AND job_id IS NOT NULL").get().n;
    const withSettled = this.db.prepare("SELECT COUNT(DISTINCT listing_id) n FROM ex_orders WHERE status = 'settled'").get().n;
    const tidx = this.trustIndex();
    const settled = this.db.prepare("SELECT escrow, job_id FROM ex_orders WHERE status = 'settled'").all();
    const kn = settled.map((s) => tidx.get(`${lc(s.escrow)}:${s.job_id}`)?.ourVerify).filter(Boolean);
    return { v: EXCHANGE_VERSION, listings: l, orders: o, listingsWithSettledJob: withSettled, distinctOutsideBuyers: extBuyers, fundedJobsLast7d: week, judgeKitVerified: { known: kn.length, ok: kn.filter((x) => x.ok).length }, generatedAt: iso(this.now()) };
  }
  /** Exchange rows for the /trust/jobs.json hook (spec section 8: exchange_listing_id and agent ids per job). */
  trustRows() {
    return this.db.prepare("SELECT * FROM ex_orders WHERE job_id IS NOT NULL ORDER BY created_at").all().map((o) => ({ escrow: o.escrow, jobId: o.job_id, exchange_order_id: o.id, exchange_listing_id: o.listing_id.startsWith("oj_") ? null : o.listing_id, exchange_open_job_id: o.listing_id.startsWith("oj_") ? o.listing_id : null, exchange_fee: o.txs ? (P(o.txs)?.feeAmount ?? null) : null, agent_ids: { buyer: o.buyer, seller: o.seller, evaluator: o.evaluator }, origin: o.origin, countedInScore: o.origin === "external", status: o.status }));
  }
  /** Merge Exchange annotations into a /trust/jobs.json document; Exchange jobs missing from it are appended with source "exchange". */
  mergeTrust(doc) {
    const rows = this.trustRows();
    const d = doc && typeof doc === "object" ? { ...doc, jobs: [...(doc.jobs ?? [])] } : { v: "agentkoin-trust-page/v1", testnet: TESTNET, realValue: !TESTNET, jobs: [] };
    const idx = new Map(d.jobs.map((j, i) => [`${lc(j.escrow)}:${j.jobId}`, i]));
    for (const r of rows) {
      const k = `${lc(r.escrow)}:${r.jobId}`;
      const ann = { exchange_order_id: r.exchange_order_id, exchange_listing_id: r.exchange_listing_id, ...(r.exchange_open_job_id ? { exchange_open_job_id: r.exchange_open_job_id } : {}), agent_ids: r.agent_ids };
      if (idx.has(k)) d.jobs[idx.get(k)] = { ...d.jobs[idx.get(k)], ...ann };
      else d.jobs.push({ escrow: r.escrow, jobId: r.jobId, ...ann, state: r.status, source: "exchange (live order; not yet in the generated trust table, no judge-kit result attached)", proofUrl: this.url(`/v1/escrows/${r.escrow}/jobs/${r.jobId}/proof`), verifyCommand: `npx ${JUDGE_KIT_REF} verify ${r.jobId} --escrow ${r.escrow}` });
    }
    d.exchange = { v: EXCHANGE_VERSION, jobs: rows.length, hook: "Exchange orders annotate /trust/jobs.json at serve time (exchange_listing_id, agent_ids)" };
    return d;
  }
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
