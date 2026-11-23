// Anonymous service statistics. Stored: counters, unique payer addresses (public on-chain data), coarse
// user-agent product tokens and referrer hostnames. Not stored: IP addresses, full user-agent strings, URLs with
// query strings, request bodies, or any other personal data.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import path from "node:path";

export function uaBucket(ua) {
  if (!ua || typeof ua !== "string") return "(none)";
  const tok = ua.trim().split(/[\s/;()]+/)[0] ?? "";
  const clean = tok.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
  return clean || "(other)";
}

export function refBucket(ref) {
  if (!ref || typeof ref !== "string") return "(none)";
  try {
    const u = new URL(ref);
    return u.hostname.toLowerCase().slice(0, 64) || "(other)";
  } catch {
    return "(invalid)";
  }
}

const COUNTERS = ["requests", "paymentRequired402", "paidCalls", "paidCallsRejected", "jobsOpened", "jobsSubmitted", "verdicts", "jobsSettled", "jobsDisputed", "mcpSessions", "mcpRequests", "facilitatorVerify", "facilitatorSettle", "capRejections"];
const MAX_BUCKETS = 200;
// Door-knocker v2 attribution: an opaque ref id carried in our links (?ref=) or header (x-agentcoin-ref).
// Format <channel:2><framing:1>-<8 hex>, e.g. "a1b-1f2e3d4c". Only refs in this format are counted (bounded), no IPs.
export const REF_RE = /^(a3|a1|mc|xt)([abcd])-([0-9a-f]{8})$/;
export const REF_FIELDS = ["requests", "quickstart", "llms", "agentCard", "openapi", "mcpSessions", "mcpRequests", "paymentRequired402", "paidCalls", "jobsOpened", "optouts"];
const MAX_REFS = 1000;
export function parseRef(v) {
  const s = String(Array.isArray(v) ? v[0] : (v ?? "")).trim().toLowerCase();
  return REF_RE.test(s) ? s : null;
}

export class Stats {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.data = { since: new Date(now()).toISOString(), counters: Object.fromEntries(COUNTERS.map((k) => [k, 0])), payers: [], userAgents: {}, referrers: {}, endpoints: {}, refs: {} };
    if (file && existsSync(file)) {
      try {
        const d = JSON.parse(readFileSync(file, "utf8"));
        this.data = { ...this.data, ...d, counters: { ...this.data.counters, ...(d.counters ?? {}) } };
      } catch {}
    }
    this.payers = new Set(this.data.payers);
    this.dirty = false;
  }

  inc(name, n = 1) {
    this.data.counters[name] = (this.data.counters[name] ?? 0) + n;
    this.dirty = true;
  }

  _bucket(map, key) {
    if (map[key] === undefined && Object.keys(map).length >= MAX_BUCKETS) key = "(overflow)";
    map[key] = (map[key] ?? 0) + 1;
  }

  request({ userAgent, referer, endpoint }) {
    this.inc("requests");
    this._bucket(this.data.userAgents, uaBucket(userAgent));
    this._bucket(this.data.referrers, refBucket(referer));
    if (endpoint) this._bucket(this.data.endpoints, endpoint);
  }

  /** Count one attributed event for a valid ref (ignored otherwise). */
  ref(ref, field) {
    if (!ref || !REF_FIELDS.includes(field)) return;
    const refs = (this.data.refs ??= {});
    if (!refs[ref]) {
      if (Object.keys(refs).length >= MAX_REFS) return;
      refs[ref] = {};
    }
    refs[ref][field] = (refs[ref][field] ?? 0) + 1;
    this.dirty = true;
  }

  doorknock() {
    const refs = this.data.refs ?? {};
    const byVariant = {};
    for (const [r, c] of Object.entries(refs)) {
      const v = r.split("-")[0];
      const agg = (byVariant[v] ??= { refsSeen: 0 });
      agg.refsSeen++;
      for (const [k, n] of Object.entries(c)) agg[k] = (agg[k] ?? 0) + n;
    }
    return { refFormat: String(REF_RE), variantKey: "channel a3=A2A v0.3, a1=A2A v1.0, mc=MCP, xt=x402 testnet; framing a=factual, b=value-first, c=task-first, d=machine JSON", byVariant, byRef: { ...refs } };
  }

  payer(addr) {
    const a = String(addr).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return;
    if (!this.payers.has(a)) {
      this.payers.add(a);
      this.data.payers = [...this.payers];
      this.dirty = true;
    }
  }

  snapshot() {
    return {
      since: this.data.since,
      generatedAt: new Date(this.now()).toISOString(),
      counters: { ...this.data.counters },
      uniquePayerAddresses: this.payers.size,
      userAgents: { ...this.data.userAgents },
      referrers: { ...this.data.referrers },
      endpoints: { ...this.data.endpoints },
      doorknock: this.doorknock(),
      privacy: "no IP addresses or personal data stored; user agents reduced to the first product token, referrers to hostname; doorknock refs are opaque ids we put in our own links",
    };
  }

  flush() {
    if (!this.file || !this.dirty) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
    this.dirty = false;
  }
}

/** Split recorded payer addresses into internal (AgentCoin / STOS-operated) vs outside. */
export function classifyPayers(payers, internalAddresses = []) {
  const internal = new Set(
    [...internalAddresses]
      .map((a) => String(a).toLowerCase())
      .filter((a) => /^0x[0-9a-f]{40}$/.test(a)),
  );
  const seen = new Set();
  let uniqueInternalPayerAddresses = 0;
  let uniqueOutsidePayerAddresses = 0;
  for (const p of payers ?? []) {
    const a = String(p).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a) || seen.has(a)) continue;
    seen.add(a);
    if (internal.has(a)) uniqueInternalPayerAddresses++;
    else uniqueOutsidePayerAddresses++;
  }
  return { uniqueInternalPayerAddresses, uniqueOutsidePayerAddresses };
}

/** Parse AGENTCOIN_DEMO_BUYERS="label:0xabc...,label2:0xdef...". Labels are public; keys are never accepted. */
export function parseDemoBuyers(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw ?? "").split(",")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.lastIndexOf(":");
    if (i <= 0) continue;
    const label = s.slice(0, i).trim();
    const address = s.slice(i + 1).trim();
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(label)) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    const k = address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ label, address, operatedBy: "STOS Technologies LLC", kind: "internal-demo" });
  }
  return out;
}

