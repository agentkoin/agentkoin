#!/usr/bin/env node
// delivered = 2xx (x402: paid GET 2xx); replies = A2A agent content incl. status.message / artifacts (see isReply).
// Door-knocker v2 stats table: variant x (sends, delivered, replies, quickstart hits, MCP sessions, paid calls, jobs opened).
// Joins the local send log (out/v2/knock-log.jsonl, entries carry `ref`) with the service's /v1/stats `doorknock` section
// (server-side per-ref counters, no IPs). Read-only. Writes out/v2/stats-table.{json,md}.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMINGS, CHANNELS } from "./messages.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "out", "v2");
const COLS = ["targets", "sends", "delivered", "replies", "quickstart", "mcpSessions", "paidCalls", "jobsOpened", "optouts"];

const ok = (n) => typeof n === "number" && n >= 200 && n < 300;
/** Delivered: a 2xx on the knock request, or (x402 arm) a 2xx on the paid GET after the 402. */
export const isDelivered = (e) => ok(e.status) || ok(e.x402?.paidStatus);
/** Reply: agent content back on an A2A knock. Counts classifier "engaged", content in result.status.message.parts or
 *  result.artifacts[].parts (task replies), also when the stored body was truncated (not parseable JSON). Not MCP/x402. */
export function isReply(e) {
  if (e.engaged === true || e.classification === "engaged") return true;
  const ch = String(e.arm ?? e.ref ?? "").slice(0, 2);
  if ((ch !== "a3" && ch !== "a1") || !ok(e.status)) return false;
  const text = String(e.response?.text ?? "");
  let j; try { j = JSON.parse(text); } catch { j = undefined; }
  if (j !== undefined) {
    if (j?.error) return false;
    const r = j?.result ?? j;
    const has = (p) => Array.isArray(p) && p.length > 0;
    return has(r?.status?.message?.parts) || (Array.isArray(r?.artifacts) && r.artifacts.some((a) => has(a?.parts)));
  }
  return !/"error"\s*:\s*\{/.test(text.slice(0, 200)) && (/"status"\s*:\s*\{[^]*?"message"\s*:\s*\{[^]*?"parts"\s*:\s*\[\s*\{/.test(text) || /"artifacts"\s*:\s*\[\s*\{[^]*?"parts"\s*:\s*\[\s*\{/.test(text));
}

export function buildTable({ targets = [], log = [], doorknock = null }) {
  const rows = {};
  const row = (v) => (rows[v] ??= Object.fromEntries(COLS.map((c) => [c, 0])));
  const armOf = new Map(targets.map((t) => [t.ref, t.arm]));
  for (const t of targets) row(t.arm).targets++;
  for (const e of log) {
    const arm = e.arm ?? armOf.get(e.ref); if (!arm || e.sent !== true) continue;
    const r = row(arm); r.sends++;
    if (isDelivered(e)) r.delivered++;
    if (isReply(e)) r.replies++;
  }
  for (const [ref, c] of Object.entries(doorknock?.byRef ?? {})) {
    const arm = armOf.get(ref) ?? ref.split("-")[0]; const r = row(arm);
    r.quickstart += c.quickstart ?? 0; r.mcpSessions += c.mcpSessions ?? 0; r.paidCalls += c.paidCalls ?? 0; r.jobsOpened += c.jobsOpened ?? 0; r.optouts += c.optouts ?? 0;
  }
  const total = Object.fromEntries(COLS.map((c) => [c, Object.values(rows).reduce((s, r) => s + r[c], 0)]));
  return { columns: COLS, rows: Object.fromEntries(Object.entries(rows).sort()), total };
}
export function toMarkdown(t) {
  const label = (v) => `${v} (${CHANNELS[v.slice(0, 2)] ?? "?"} / ${FRAMINGS[v[2]] ?? "?"})`;
  let md = `| variant | ${t.columns.join(" | ")} |\n|---|${t.columns.map(() => "---:").join("|")}|\n`;
  for (const [v, r] of Object.entries(t.rows)) md += `| ${label(v)} | ${t.columns.map((c) => r[c]).join(" | ")} |\n`;
  md += `| **total** | ${t.columns.map((c) => `**${t.total[c]}**`).join(" | ")} |\n`;
  return md;
}
async function main() {
  mkdirSync(OUT, { recursive: true });
  const tf = existsSync(path.join(OUT, "targets.cycle1.approved.json")) ? path.join(OUT, "targets.cycle1.approved.json") : path.join(OUT, "targets.cycle1.json");
  const targets = existsSync(tf) ? JSON.parse(readFileSync(tf, "utf8")).targets : [];
  const lf = path.join(OUT, "knock-log.jsonl");
  const log = existsSync(lf) ? readFileSync(lf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const base = (process.env.AGENTCOIN_BASE_URL ?? "https://testnet.agentcoinhq.com").replace(/\/+$/, "");
  let doorknock = null, statsNote, statsSince = null;
  try { const r = await fetch(`${base}/v1/stats`, { headers: { "user-agent": "agentcoin-doorknock-stats/0.5" }, signal: AbortSignal.timeout(15000) }); const s = await r.json(); statsSince = s.since ?? null; doorknock = s.doorknock ?? null; statsNote = doorknock ? "live /v1/stats doorknock section" : "service has no doorknock section yet (pre-v2 build)"; }
  catch (e) { statsNote = `stats fetch failed: ${e.message}`; }
  const t = buildTable({ targets, log, doorknock });
  const firstSend = log.filter((e) => e.sent === true).map((e) => e.at).sort()[0] ?? null;
  const att = doorknock ? { refsWithHits: Object.keys(doorknock.byRef ?? {}).length, ...Object.fromEntries(["quickstart", "mcpSessions", "paidCalls", "jobsOpened", "optouts"].map((c) => [c, t.total[c]])) } : null;
  statsNote += `; attribution window: first send ${firstSend} to now (service stats since ${statsSince ?? "?"})`;
  const meta = { generatedAt: new Date().toISOString(), source: { log: lf, stats: `${base}/v1/stats`, statsNote }, firstSend, statsSince, attribution: att, sendsLogged: log.filter((e) => e.sent === true).length };
  writeFileSync(path.join(OUT, "stats-table.json"), JSON.stringify({ ...meta, ...t }, null, 2) + "\n");
  writeFileSync(path.join(OUT, "stats-table.md"), `# Door-knocker v2 stats (${meta.generatedAt})\n\n${statsNote}; sends logged: ${meta.sendsLogged}\n\n${toMarkdown(t)}`);
  console.log(toMarkdown(t)); console.error(statsNote);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => (console.error(e), process.exit(1)));
