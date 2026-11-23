#!/usr/bin/env node
// Door-knocker v2 LIVE sender (cycle 1, Carter-approved 2026-10-30 23:46 ET). Same gates as knock.mjs:
//   live only with DRY_RUN=0 + DOORKNOCK_LIVE_ACK=send-to-outside-agents + no KILL file (+ DOORKNOCK_KILL != 1).
// Targets: a PINNED approved file (DOORKNOCK_TARGETS_FILE + DOORKNOCK_TARGETS_SHA256). Every request is rebuilt, signed and
// diffed against the approved rendered request for that row (only per-send fields may differ); ANY mismatch aborts the
// whole run before the first send. One knock per agent (per ref, ever), 50 sends per rolling 24 h across ALL door-knocker
// logs (v1 + v2), no retries on any HTTP status, at most 1 retry on a network error (never for a paid x402 request),
// 15 s timeout, redirects not followed. Follow-ups are only PREPARED (out/v2/followups.pending.jsonl), never sent here.
// Replies are untrusted data: recorded, quoted, classified. The only actions they can trigger: an explicit opt-out
// (blocks), or an explicit accept-job for OUR jobRef with a valid address, which only queues the pre-specified job.
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, toHex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mode, readLog, classifyReply, optOutSignal, reviewFileFor, DAILY_LIMIT, SEND_TIMEOUT_MS } from "../knock.mjs";
import { loadOptOuts, isOptedOut, addOptOut } from "../optout.mjs";
import { signOffer } from "../offer.mjs";
import { buildOfferV2, framingText, renderA2A, renderMCP, renderX402, v2ContentKey } from "./messages.mjs";
import { rng, shuffle } from "./plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(HERE, "..", "out", "v2");
export const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const X402_NETWORK = "eip155:84532";
export const X402_MAX_EACH = 10000n, X402_MAX_TOTAL = 23000n;
export const USDC_DOMAIN = { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_SEPOLIA };
const PLACE = "<per-send uuid>", SIG = "<EIP-191 signature by the AgentCoin operator key, added at send time>";

const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
/** Replace per-send fields (signature, nonce, issuedAt, messageId / JSON-RPC id, payment signature) with fixed markers. */
export function normalizeReq(req) {
  const r = structuredClone(req);
  const fixOffer = (o) => { if (o && typeof o === "object" && typeof o.type === "string" && o.type.startsWith("agentcoin-offer/")) { o.signature = SIG; o.nonce = PLACE; o.issuedAt = "<issuedAt>"; } };
  const walk = (v) => { if (!v || typeof v !== "object") return; fixOffer(v); if (Array.isArray(v)) v.forEach(walk); else Object.values(v).forEach(walk); };
  for (const q of Array.isArray(r) ? r : [r]) {
    walk(q.body);
    const m = q.body?.params?.message ?? q.body?.message;
    if (m?.messageId) m.messageId = PLACE;
    if (q.body?.jsonrpc && q.body.id !== undefined && typeof q.body.id === "string") q.body.id = PLACE;
    if (q.headers?.["PAYMENT-SIGNATURE"]) q.headers["PAYMENT-SIGNATURE"] = "<payment>";
    if (q.headers?.["mcp-session-id"]) q.headers["mcp-session-id"] = "<session>";
  }
  return r;
}
export const reqDiff = (live, approved) => canon(normalizeReq(live)) === canon(normalizeReq(approved)) ? null : "rendered request differs from the approved example";

/** Rebuild + sign the request for one approved row. Throws if it differs from the approved rendering. */
export async function buildLive(row, { base, privateKey, job, now = new Date() }) {
  const channel = row.arm.slice(0, 2), framing = row.arm[2];
  if (framing === "c" && !job) throw new Error(`no approved job for ${row.ref}`);
  const unsigned = buildOfferV2({ id: row.id, endpoint: row.endpoint }, { base, ref: row.ref, framing, channel, job: framing === "c" ? stripJob(job) : null, now, nonce: randomUUID() });
  const offer = await signOffer(unsigned, privateKey);
  const text = framingText(framing, { links: offer.links, job: framing === "c" ? stripJob(job) : null });
  const req = channel === "mc" ? renderMCP(row.endpoint, offer) : channel === "xt" ? renderX402({ url: row.endpoint }, offer, text, { maxAtomic: Number(X402_MAX_EACH) }) : renderA2A(row.a2a, offer, text, { skillId: row.skillId });
  const ck = v2ContentKey(offer, text);
  if (ck !== row.contentKey) throw new Error(`content key for ${row.ref} ${ck} != approved ${row.contentKey}`);
  const d = reqDiff(req, row.request);
  if (d) throw new Error(`${row.ref}: ${d}`);
  return { offer, text, req };
}
// jobs.cycle1 rows carry ref/target/host on top of the jobSpec() fields; the offer was rendered from jobSpec() only
const stripJob = (j) => { const { ref, target, host, ...rest } = j; return rest; };

/** One HTTP request. No redirects, 15 s timeout, at most 1 retry ONLY on a network error (no HTTP response). */
export async function httpOnce({ method = "POST", url, headers = {}, body }, { fetchImpl = fetch, timeoutMs = SEND_TIMEOUT_MS, retryOnNetworkError = true } = {}) {
  let last;
  for (let attempt = 1; attempt <= (retryOnNetworkError ? 2 : 1); attempt++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const h = { "user-agent": "agentcoin-doorknock/0.5 (testnet)", accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
      const r = await fetchImpl(url, { method, redirect: "manual", headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: ctl.signal });
      const hk = ["content-type", "location", "mcp-session-id", "payment-required", "payment-response", "x-payment-response"];
      const rh = Object.fromEntries(hk.map((k) => [k, r.headers?.get?.(k) ?? null]).filter(([, v]) => v !== null));
      return { status: r.status, headers: rh, text: (await r.text()).slice(0, 20000), attempts: attempt };
    } catch (e) { last = { status: 0, headers: {}, text: "", error: String(e?.cause?.code ?? e?.name ?? "") + ": " + String(e?.message ?? e), attempts: attempt }; }
    finally { clearTimeout(t); }
  }
  return last;
}

const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
/** Parse a 402 and pick the ONLY acceptable option: exact, eip155:84532, Circle Sepolia USDC, amount <= cap. Else {abort}. */
export function pickX402(res, { capAtomic }) {
  let pr = null;
  try { if (res.headers?.["payment-required"]) pr = unb64(res.headers["payment-required"]); } catch { return { abort: "unparseable PAYMENT-REQUIRED header" }; }
  if (!pr) { try { pr = JSON.parse(res.text); } catch { return { abort: "no PAYMENT-REQUIRED header and body is not JSON" }; } }
  const accepts = Array.isArray(pr?.accepts) ? pr.accepts : [];
  if (!accepts.length) return { abort: "402 without accepts[]" };
  const reasons = [];
  for (const a of accepts) {
    const amt = a?.amount ?? a?.maxAmountRequired;
    if (a?.scheme !== "exact") { reasons.push(`scheme ${a?.scheme}`); continue; }
    if (a?.network !== X402_NETWORK) { reasons.push(`network ${a?.network}`); continue; }
    if (!isAddress(String(a?.asset ?? "")) || getAddress(a.asset) !== getAddress(USDC_SEPOLIA)) { reasons.push(`asset ${a?.asset}`); continue; }
    if (!/^\d+$/.test(String(amt ?? "")) || BigInt(amt) <= 0n || BigInt(amt) > capAtomic) { reasons.push(`amount ${amt} > cap ${capAtomic}`); continue; }
    if (!isAddress(String(a?.payTo ?? "")) || getAddress(a.payTo) === zeroAddress) { reasons.push(`payTo ${a?.payTo}`); continue; }
    if (a.extra && ((a.extra.name && a.extra.name !== USDC_DOMAIN.name) || (a.extra.version && String(a.extra.version) !== USDC_DOMAIN.version))) { reasons.push(`token domain ${a.extra.name}/${a.extra.version}`); continue; }
    return { x402Version: pr.x402Version ?? 1, resource: pr.resource ?? null, accept: a, amount: BigInt(amt) };
  }
  return { abort: `no acceptable option (${reasons.join("; ")})` };
}
export async function signX402(pick, privateKey, nowSec = Math.floor(Date.now() / 1000)) {
  if (pick.x402Version !== 2) throw new Error("only x402 v2 (PAYMENT-SIGNATURE) is supported");
  const acct = privateKeyToAccount(privateKey);
  const a = pick.accept;
  const authorization = { from: acct.address, to: getAddress(a.payTo), value: pick.amount.toString(), validAfter: String(nowSec - 60), validBefore: String(nowSec + Math.min(Number(a.maxTimeoutSeconds ?? 300), 600)), nonce: toHex(randomBytes(32)) };
  const signature = await acct.signTypedData({ domain: USDC_DOMAIN, primaryType: "TransferWithAuthorization",
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) } });
  return { header: b64({ x402Version: 2, resource: pick.resource, accepted: a, payload: { signature, authorization } }), authorization };
}

/** Explicit acceptance of OUR job: {"agentcoin":"accept-job","jobRef":<ours>,"provider":<valid address>} in the agent's own content. */
export function findAcceptance(bodyText, jobRef) {
  const hits = [];
  const consider = (o) => { if (o && o.agentcoin === "accept-job" && o.jobRef === jobRef && typeof o.provider === "string" && isAddress(o.provider) && getAddress(o.provider) !== zeroAddress) hits.push(getAddress(o.provider)); };
  const fromText = (s) => { for (const m of String(s).matchAll(/\{[^{}]*"agentcoin"\s*:\s*"accept-job"[^{}]*\}/g)) { try { consider(JSON.parse(m[0])); } catch {} } };
  let j; try { j = JSON.parse(bodyText); } catch { fromText(bodyText ?? ""); return hits[0] ?? null; }
  const walk = (v) => { if (typeof v === "string") return fromText(v); if (!v || typeof v !== "object") return; if (typeof v.type === "string" && v.type.startsWith("agentcoin-offer/")) return; consider(v); (Array.isArray(v) ? v : Object.values(v)).forEach(walk); };
  walk(j);
  return hits[0] ?? null;
}

/** Interleave arms (seeded) so any prefix cut by the daily limit is a balanced random sample. */
export function sendOrder(rows, seedHex) {
  const rand = rng(seedHex); const byArm = new Map();
  for (const r of shuffle(rows, rand)) { if (!byArm.has(r.arm)) byArm.set(r.arm, []); byArm.get(r.arm).push(r); }
  const arms = shuffle([...byArm.keys()].sort(), rand); const out = [];
  while (out.length < rows.length) for (const a of arms) { const q = byArm.get(a); if (q.length) out.push(q.shift()); }
  return out;
}

const redactReq = (req) => { const r = structuredClone(req); for (const q of Array.isArray(r) ? r : [r]) if (q.headers?.["PAYMENT-SIGNATURE"]) q.headers["PAYMENT-SIGNATURE"] = "<redacted: EIP-3009 authorization, see x402.authorization>"; return r; };

export async function runV2({ targets, jobs = [], logFile = path.join(OUT, "knock-log.jsonl"), priorLogs = [], privateKey, payerKey = null, base, env = process.env, now = () => new Date(), fetchImpl = fetch, limit = DAILY_LIMIT, seedHex, x402Spent = 0n, optouts = loadOptOuts() } = {}) {
  const m = mode(env);
  if (!/^https:\/\/[^/]+\.[^/]+/.test(base ?? "") || /REPLACE/i.test(base)) throw new Error("v2 needs the real public https AGENTCOIN_BASE_URL");
  mkdirSync(path.dirname(logFile), { recursive: true });
  const log = readLog(logFile);
  const dayAgo = now().getTime() - 86400_000;
  const allSent = [...log, ...priorLogs.flatMap((f) => readLog(f))].filter((e) => e.sent && Date.parse(e.at) > dayAgo);
  let budget = limit - allSent.length;
  const done = new Set(log.filter((e) => e.kind === "knock" && e.sent).map((e) => e.ref));
  const jobByRef = new Map(jobs.map((j) => [j.ref, j]));
  // 1) build + guard EVERY request before anything is sent (a mismatch aborts with nothing sent)
  const built = [];
  for (const row of sendOrder(targets, seedHex)) built.push({ row, ...(await buildLive(row, { base, privateKey, job: jobByRef.get(row.ref), now: now() })) });
  const out = { mode: m, guarded: built.length, sent: [], skipped: [], acceptances: [], followups: [], x402Spent };
  for (const { row, offer, text, req } of built) {
    const skip = (reason) => { out.skipped.push({ ref: row.ref, arm: row.arm, host: row.host, reason }); appendFileSync(logFile, JSON.stringify({ at: now().toISOString(), kind: "knock", ref: row.ref, arm: row.arm, id: row.id, host: row.host, endpoint: row.endpoint, sent: false, skipped: reason, dryRun: m.dryRun }) + "\n"); };
    if (isOptedOut(optouts, { id: row.id, host: row.host, channel: { url: row.endpoint } })) { skip("opted out / do-not-contact"); continue; }
    if (done.has(row.ref)) { skip("already knocked this cycle"); continue; }
    if (budget <= 0) { skip(`daily limit ${limit} per rolling 24h reached (all door-knocker sends counted)`); continue; }
    if (!m.live) { skip("dry run"); continue; }
    budget--;
    const ch = row.arm.slice(0, 2);
    const e = { at: now().toISOString(), kind: "knock", ref: row.ref, arm: row.arm, id: row.id, name: row.name, host: row.host, endpoint: row.endpoint, sent: true, offerDigest: offer.signature.signedDigest };
    if (ch === "a3" || ch === "a1") {
      const r = await httpOnce(req, { fetchImpl });
      Object.assign(e, { request: req, status: r.status, attempts: r.attempts, ...(r.error ? { error: r.error } : {}), response: { status: r.status, headers: r.headers, text: r.text } });
      e.classification = classifyReply(r.status, r.text);
      const sig = optOutSignal(r.status, r.text);
      if (sig) e.optOutSignal = sig;
      if (sig === "explicit") addOptOut(row.endpoint, 'explicit {"agentcoin":"opt-out"} reply');
      else if (sig === "ambiguous") appendFileSync(reviewFileFor(logFile), JSON.stringify({ at: e.at, ref: row.ref, endpoint: row.endpoint, status: r.status, signal: "ambiguous", blocked: false, excerpt: r.text.slice(0, 500) }) + "\n");
      if (row.arm[2] === "c" && r.status >= 200 && r.status < 300) {
        const j = jobByRef.get(row.ref); const provider = findAcceptance(r.text, j.jobRef);
        if (provider) { e.acceptance = { jobRef: j.jobRef, provider }; out.acceptances.push({ ref: row.ref, job: j, provider }); }
      }
    } else if (ch === "mc") {
      const r1 = await httpOnce(req[0], { fetchImpl });
      Object.assign(e, { request: req[0], status: r1.status, attempts: r1.attempts, ...(r1.error ? { error: r1.error } : {}), response: { status: r1.status, headers: r1.headers, text: r1.text } });
      if (r1.status >= 200 && r1.status < 300) {
        const sid = r1.headers["mcp-session-id"];
        const h = { ...req[1].headers }; if (sid) h["mcp-session-id"] = sid; else delete h["mcp-session-id"];
        const r2 = await httpOnce({ ...req[1], headers: h }, { fetchImpl });
        e.initialized = { status: r2.status, attempts: r2.attempts, ...(r2.error ? { error: r2.error } : {}), sessionId: sid ?? null, text: r2.text.slice(0, 2000) };
      }
      e.classification = "n/a (MCP initialize: protocol response, not a reply)";
    } else if (ch === "xt") {
      const r1 = await httpOnce(req[0], { fetchImpl });
      Object.assign(e, { request: redactReq(req), status: r1.status, attempts: r1.attempts, ...(r1.error ? { error: r1.error } : {}), response: { status: r1.status, headers: r1.headers, text: r1.text } });
      e.classification = "n/a (x402 resource response, not a reply)";
      const planned = BigInt(/(\d+) atomic test USDC/.exec(row.reachReason ?? "")?.[1] ?? "0"); // the approved price for this resource
      const capAtomic = [X402_MAX_EACH, planned, X402_MAX_TOTAL - out.x402Spent].reduce((a, b) => (b < a ? b : a));
      if (r1.status !== 402) e.x402 = { paid: false, reason: `first GET returned ${r1.status}, not 402` };
      else if (!payerKey) e.x402 = { paid: false, reason: "no payer key" };
      else {
        const pick = pickX402(r1, { capAtomic });
        if (pick.abort) e.x402 = { paid: false, aborted: pick.abort };
        else if (pick.x402Version !== 2) e.x402 = { paid: false, aborted: `x402Version ${pick.x402Version} (only v2 supported)` };
        else {
          const { header, authorization } = await signX402(pick, payerKey);
          out.x402Spent += pick.amount; // counted as spent once signed (it may settle even if the response is lost)
          const r2 = await httpOnce({ ...req[1], headers: { ...req[1].headers, "PAYMENT-SIGNATURE": header } }, { fetchImpl, retryOnNetworkError: false });
          let settle = null; const ph = r2.headers["payment-response"] ?? r2.headers["x-payment-response"];
          if (ph) { try { settle = unb64(ph); } catch { settle = { unparsed: ph.slice(0, 500) }; } }
          e.x402 = { signed: true, accept: { scheme: pick.accept.scheme, network: pick.accept.network, asset: pick.accept.asset, payTo: pick.accept.payTo, amount: pick.amount.toString() }, authorization, paidStatus: r2.status, ...(r2.error ? { paidError: r2.error } : {}), paymentResponse: settle, paidResponse: { headers: r2.headers, text: r2.text.slice(0, 4000) } };
        }
      }
    }
    if (e.classification === "engaged") out.followups.push({ ref: row.ref, endpoint: row.endpoint, reason: e.acceptance ? "accepted job" : "genuine reply", status: "PREPARED, NOT SENT (needs approval)" });
    out.sent.push(e);
    appendFileSync(logFile, JSON.stringify(e) + "\n");
  }
  if (out.followups.length) appendFileSync(path.join(path.dirname(logFile), "followups.pending.jsonl"), out.followups.map((f) => JSON.stringify({ at: now().toISOString(), ...f })).join("\n") + "\n");
  if (out.acceptances.length) appendFileSync(path.join(path.dirname(logFile), "acceptances.jsonl"), out.acceptances.map((a) => JSON.stringify({ at: now().toISOString(), ref: a.ref, jobRef: a.job.jobRef, provider: a.provider, amountAtomic: a.job.amountAtomic, specHash: a.job.specHash, state: "accepted; escrow to open via v2/jobs.mjs" })).join("\n") + "\n");
  return out;
}

/** Sum of x402 amounts already SIGNED in a log (signed counts as spent, settled or not). */
export const priorX402Spent = (log) => log.reduce((a, e) => (e?.x402?.signed && /^\d+$/.test(String(e.x402.accept?.amount ?? "")) ? a + BigInt(e.x402.accept.amount) : a), 0n);
export const sha256File = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = process.env.DOORKNOCK_TARGETS_FILE, want = process.env.DOORKNOCK_TARGETS_SHA256;
  if (!f || !want) throw new Error("set DOORKNOCK_TARGETS_FILE + DOORKNOCK_TARGETS_SHA256 (pinned approved list)");
  const got = sha256File(f); if (got !== want) throw new Error(`targets sha256 ${got} != pinned ${want}`);
  const jf = process.env.DOORKNOCK_JOBS_FILE, jwant = process.env.DOORKNOCK_JOBS_SHA256;
  if (!jf || sha256File(jf) !== jwant) throw new Error("set DOORKNOCK_JOBS_FILE + DOORKNOCK_JOBS_SHA256 (pinned approved jobs)");
  const { targets } = JSON.parse(readFileSync(f, "utf8")); const { jobs } = JSON.parse(readFileSync(jf, "utf8"));
  const { operatorKey } = await import("../../lib/keys.mjs");
  const m = mode();
  let payerKey = null;
  if (m.live) { process.env.AGENTCOIN_NETWORK ??= "base-sepolia"; const { roleKey } = await import("../../lib/config.mjs"); payerKey = roleKey("deployer"); }
  const logFile = path.join(OUT, m.live ? "knock-log.jsonl" : "knock-log.dry-run.jsonl");
  // x402 total cap is per cycle across runs: carry forward every authorization already signed in the live log
  const x402Spent = priorX402Spent(readLog(path.join(OUT, "knock-log.jsonl")));
  const res = await runV2({ targets, jobs, logFile, priorLogs: [path.join(HERE, "..", "out", "knock-log.jsonl")], privateKey: operatorKey().privateKey, payerKey, base: process.env.AGENTCOIN_BASE_URL, seedHex: got, x402Spent });
  const brief = res.sent.map((e) => ({ ref: e.ref, arm: e.arm, host: e.host, status: e.status, attempts: e.attempts, error: e.error ?? null, classification: e.classification, ...(e.initialized ? { initialized: e.initialized.status } : {}), ...(e.x402 ? { x402: { paid: e.x402.signed ?? false, paidStatus: e.x402.paidStatus ?? null, amount: e.x402.accept?.amount ?? null, abort: e.x402.aborted ?? e.x402.reason ?? null } } : {}), ...(e.acceptance ? { acceptance: e.acceptance } : {}) }));
  writeFileSync(path.join(OUT, m.live ? (process.env.DOORKNOCK_RESULT_NAME ?? "send-result.json") : "send-result.dry-run.json"), JSON.stringify({ mode: res.mode, guarded: res.guarded, sent: brief, skipped: res.skipped, acceptances: res.acceptances.map((a) => ({ ref: a.ref, provider: a.provider })), followups: res.followups, x402SpentAtomic: res.x402Spent.toString() }, null, 2) + "\n");
  console.log(JSON.stringify({ mode: res.mode, guarded: res.guarded, sent: res.sent.length, skipped: res.skipped.length, skippedReasons: res.skipped.reduce((m, s) => ((m[s.reason] = (m[s.reason] ?? 0) + 1), m), {}), acceptances: res.acceptances.length, x402SpentAtomic: res.x402Spent.toString() }, null, 2));
}
