#!/usr/bin/env node
// Door-knocker step 2: machine-channel knocks (A2A only). DRY_RUN=1 by default: nothing is sent.
// Live sending requires ALL of: DRY_RUN=0, DOORKNOCK_LIVE_ACK=send-to-outside-agents, no KILL file, no DOORKNOCK_KILL=1.
// Limits: 1 knock per agent endpoint, 1 follow-up only if the agent replied (engaged), 50 sends per rolling 24h.
// Opt-outs: only an explicit {"agentcoin":"opt-out"} reply or a /v1/optout record blocks; ambiguous signals -> out/optout-review.jsonl (never block).
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOffer, signOffer, a2aRequest, offerBodyDiff, offerContentDiff } from "./offer.mjs";
import { loadOptOuts, isOptedOut, addOptOut } from "./optout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DAILY_LIMIT = 50;
export const KILL_FILE = process.env.DOORKNOCK_KILL_FILE ?? path.join(HERE, "KILL");

export function mode(env = process.env) {
  const killed = env.DOORKNOCK_KILL === "1" || existsSync(KILL_FILE);
  const dry = env.DRY_RUN !== "0";
  const ack = env.DOORKNOCK_LIVE_ACK === "send-to-outside-agents";
  return { killed, dryRun: dry || !ack || killed, live: !dry && ack && !killed };
}

export function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Opt-out policy (Carter, 2026-10-30 23:18 ET): NO automatic blocking from classifiers, errors, or reply wording.
// Only an EXPLICIT opt-out blocks: the agent itself sent {"agentcoin":"opt-out"} (a data part / top-level object, or a
// text part that is exactly that JSON), not inside an echo of our offer. Anything else that merely looks like an opt-out
// ("unsubscribe", "opt out", an echo of our instructions) is logged to out/optout-review.jsonl for a human and never blocks.
// Self-service opt-outs via the service's /v1/optout are honored separately (optout.mjs).
const AMBIGUOUS_OPT_OUT_RE = /"agentcoin"\s*:\s*"opt-out"|\bopt[- ]?out\b|\bunsubscribe\b|do not contact|stop contacting/i;
// strings that are echoes of our own offer (it contains the opt-out instructions itself)
const OWN_TEXT_RE = /AgentCoin testnet (job )?offer \((test USDC, )?no real value\)|agentcoin-offer\/0\.\d|No further contact after opt-out|\/v1\/optout/;
const isOptOutObj = (v) => v && typeof v === "object" && !Array.isArray(v) && v.agentcoin === "opt-out";
const isOptOutText = (s) => { try { return isOptOutObj(JSON.parse(String(s).trim())); } catch { return false; } };
/** Walk the reply's own content (echoes of our offer removed). Returns { explicit, text }. */
function replyOwn(bodyText) {
  let j;
  try { j = JSON.parse(bodyText); } catch { const t = bodyText ?? ""; return { explicit: isOptOutText(t), text: OWN_TEXT_RE.test(t) ? "" : t }; }
  const out = []; let explicit = false;
  const walk = (v) => {
    if (typeof v === "string") { if (isOptOutText(v)) explicit = true; else if (!OWN_TEXT_RE.test(v)) out.push(v); return; }
    if (!v || typeof v !== "object") return;
    if (typeof v.type === "string" && v.type.startsWith("agentcoin-offer/")) return; // our signed offer (v0.1 or v2) echoed back
    if (isOptOutObj(v)) { explicit = true; return; }
    if (Array.isArray(v)) return v.forEach(walk);
    Object.values(v).forEach(walk);
  };
  walk(j);
  return { explicit, text: out.join("\n") };
}
export const replyOwnText = (bodyText) => replyOwn(bodyText).text;
/** "explicit" (blocks), "ambiguous" (review only, never blocks), or null. */
export function optOutSignal(status, bodyText) {
  const own = replyOwn(bodyText);
  if (status && status < 400 && own.explicit) return "explicit";
  if (own.explicit || AMBIGUOUS_OPT_OUT_RE.test(own.text)) return "ambiguous";
  return null;
}
export function classifyReply(status, bodyText) {
  if (!status || status >= 400) return "no-engagement";
  if (optOutSignal(status, bodyText) === "explicit") return "opt-out";
  // a JSON-RPC error or empty ack is not engagement; an agent message/task with content is
  try {
    const j = JSON.parse(bodyText);
    if (j.error) return "no-engagement";
    const r = j.result ?? j;
    const parts = r?.parts ?? r?.status?.message?.parts ?? r?.message?.parts ?? [];
    return parts.length ? "engaged" : "no-engagement";
  } catch {
    return "no-engagement";
  }
}
export const reviewFileFor = (logFile) => path.join(path.dirname(logFile), "optout-review.jsonl");

/**
 * Plan (and, only when live, send) knocks. `send` is injected for tests; default uses fetch.
 * Returns { mode, planned, sent, skipped }.
 */
export async function run({ targets, logFile, privateKey, base, env = process.env, now = () => new Date(), send = defaultSend, kind = "knock", limit = DAILY_LIMIT, verify = null } = {}) {
  const m = mode(env);
  if (m.live && !/^https:\/\/[^/]+\.[^/]+/.test(base ?? "")) throw new Error("live knocks need a real public https AGENTCOIN_BASE_URL");
  if (m.live && /REPLACE/i.test(base)) throw new Error("live knocks refused: placeholder base URL");
  mkdirSync(path.dirname(logFile), { recursive: true });
  const log = readLog(logFile);
  const optouts = loadOptOuts();
  const dayAgo = now().getTime() - 86400_000;
  let sentToday = log.filter((e) => e.sent && Date.parse(e.at) > dayAgo).length;
  const knocked = new Set(log.filter((e) => e.kind === "knock" && e.sent).map((e) => e.endpoint));
  const resent = new Set(log.filter((e) => e.kind === "resend" && e.sent).map((e) => e.endpoint));
  const followed = new Set(log.filter((e) => e.kind === "follow-up" && e.sent).map((e) => e.endpoint));
  const engaged = new Set(log.filter((e) => e.reply === "engaged").map((e) => e.endpoint));
  const out = { mode: m, planned: [], sent: [], skipped: [] };
  const seen = new Set();
  for (const t of targets) {
    const ep = t.channel?.url;
    const skip = (reason) => out.skipped.push({ id: t.id, endpoint: ep ?? null, reason });
    if (!ep || t.channel.kind !== "a2a") { skip("no machine channel (A2A)"); continue; }
    if (seen.has(ep)) { skip("duplicate endpoint"); continue; }
    seen.add(ep);
    if (isOptedOut(optouts, t) || t.optedOut) { skip("opted out / do-not-contact"); continue; }
    if (kind === "knock" && knocked.has(ep)) { skip("already knocked"); continue; }
    // resend (Carter-approved, once): same offer in the protocol variant the target itself indicated; only to targets
    // already knocked, at most once, and never when the per-target format decision is "skip"
    if (kind === "resend") {
      const logSkip = (reason) => { skip(reason); appendFileSync(logFile, JSON.stringify({ at: now().toISOString(), kind, resend: true, id: t.id, name: t.name ?? null, endpoint: ep, sent: false, skipped: reason, format: t.resend ?? null }) + "\n"); };
      if (!t.resend || t.resend.decision !== "send") { logSkip(`format: ${t.resend?.reason ?? "no clear correct format"}`); continue; }
      if (!knocked.has(ep)) { logSkip("resend only to an already-knocked endpoint"); continue; }
      if (resent.has(ep)) { logSkip("already resent once"); continue; }
    }
    if (kind === "follow-up" && (!engaged.has(ep) || followed.has(ep))) { skip(engaged.has(ep) ? "follow-up already sent" : "not engaged; no follow-up"); continue; }
    if (sentToday + out.planned.length >= limit) { skip(`daily limit ${limit} reached`); continue; }
    const offer = await signOffer(buildOffer(t, { base, now: now() }), privateKey);
    const req = a2aRequest(kind === "resend" ? { ...t.channel, ...t.resend.channel } : t.channel, kind === "follow-up" ? { ...offer, summary: `Follow-up (only because you replied). ${offer.summary}` } : offer);
    // pre-send guard: throws (aborting the whole run before this send) if the body is not the approved message
    if (verify) verify(req, t);
    out.planned.push({ id: t.id, endpoint: ep, request: req });
    const entry = { at: now().toISOString(), kind, ...(kind === "resend" ? { resend: true, format: t.resend } : {}), id: t.id, name: t.name ?? null, endpoint: ep, dryRun: m.dryRun, sent: false, offerDigest: offer.signature.signedDigest };
    if (m.live) {
      entry.request = req;
      const r = await send(req);
      entry.sent = true;
      entry.status = r.status;
      entry.attempts = r.attempts ?? 1;
      if (r.error) entry.error = r.error;
      entry.response = { status: r.status, headers: r.headers ?? null, text: r.text ?? "" };
      entry.respondedAt = now().toISOString();
      // the reply is untrusted data: only recorded and classified, never acted on beyond an opt-out
      entry.reply = classifyReply(r.status, r.text);
      const sig = optOutSignal(r.status, r.text);
      if (sig) entry.optOutSignal = sig;
      if (sig === "explicit") addOptOut(ep, 'explicit {"agentcoin":"opt-out"} reply');
      else if (sig === "ambiguous") appendFileSync(reviewFileFor(logFile), JSON.stringify({ at: entry.respondedAt, id: t.id, name: t.name ?? null, endpoint: ep, kind, status: r.status, signal: "ambiguous", blocked: false, excerpt: (r.text ?? "").slice(0, 500) }) + "\n");
      out.sent.push(entry);
    }
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  }
  return out;
}

export const SEND_TIMEOUT_MS = 15000;
/** POST once to the target's own endpoint. Redirects are not followed. At most 1 retry, only on a network error
 * (no HTTP response); never on any HTTP status. */
export async function defaultSend({ url, body, headers: extraHeaders }, { fetchImpl = fetch, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", accept: "application/json", "user-agent": "agentcoin-doorknock/0.4 (testnet)", ...(extraHeaders ?? {}) }, body: JSON.stringify(body), signal: ctl.signal });
      const headers = { "content-type": r.headers?.get?.("content-type") ?? null, location: r.headers?.get?.("location") ?? null };
      return { status: r.status, headers, text: (await r.text()).slice(0, 20000), attempts: attempt };
    } catch (e) {
      last = { status: 0, text: "", error: String(e?.cause?.code ?? e?.name ?? "") + ": " + String(e?.message ?? e), attempts: attempt };
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}

export const sha256File = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const kind = process.argv.includes("--follow-up") ? "follow-up" : process.argv.includes("--resend") ? "resend" : "knock";
  const { operatorKey } = await import("../lib/keys.mjs");
  // DOORKNOCK_TARGETS_FILE (+ required DOORKNOCK_TARGETS_SHA256) pins an exact approved list; otherwise top N of targets.json
  let targets;
  if (process.env.DOORKNOCK_TARGETS_FILE) {
    const f = process.env.DOORKNOCK_TARGETS_FILE;
    const got = sha256File(f);
    if (got !== process.env.DOORKNOCK_TARGETS_SHA256) throw new Error(`targets file sha256 ${got} != DOORKNOCK_TARGETS_SHA256`);
    const j = JSON.parse(readFileSync(f, "utf8"));
    targets = j.top25 ?? j.targets;
    if (kind === "resend" && process.env.DOORKNOCK_CONTENT_DIFF !== "1") throw new Error("resend requires DOORKNOCK_CONTENT_DIFF=1 + DOORKNOCK_OFFER_TEMPLATE");
  } else {
    targets = JSON.parse(readFileSync(path.join(HERE, "out", "targets.json"), "utf8")).targets.filter((t) => t.knockable).slice(0, Number(process.env.DOORKNOCK_TOP ?? 25));
  }
  // DOORKNOCK_OFFER_TEMPLATE: every body must equal this approved offer outside the per-target fields
  let verify = null;
  if (process.env.DOORKNOCK_OFFER_TEMPLATE) {
    const tpl = JSON.parse(readFileSync(process.env.DOORKNOCK_OFFER_TEMPLATE, "utf8"));
    verify = (req, t) => {
      const d = (process.env.DOORKNOCK_CONTENT_DIFF === "1" ? offerContentDiff : offerBodyDiff)(req.body, tpl);
      if (d.length) throw new Error(`body for ${t.id} differs from the approved offer: ${d.join("; ")}`);
    };
  }
  const base = process.env.AGENTCOIN_BASE_URL ?? "https://REPLACE-WITH-PUBLIC-HOST";
  const m = mode();
  const logFile = path.join(HERE, "out", m.live ? "knock-log.jsonl" : "knock-log.dry-run.jsonl");
  const res = await run({ targets, logFile, privateKey: operatorKey().privateKey, base, kind, verify });
  if (!m.live) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(HERE, "out", "dry-run-plan.json"), JSON.stringify({ testnet: true, realValue: false, dryRun: true, base, planned: res.planned, skipped: res.skipped }, null, 2) + "\n");
    if (res.planned[0]) writeFileSync(path.join(HERE, "out", "offer.json"), JSON.stringify(res.planned[0].request.body, null, 2) + "\n");
  }
  console.log(JSON.stringify({ mode: res.mode, planned: res.planned.length, sent: res.sent.length, skipped: res.skipped.length, log: path.relative(process.cwd(), logFile) }, null, 2));
}
