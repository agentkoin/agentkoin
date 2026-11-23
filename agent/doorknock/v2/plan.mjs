#!/usr/bin/env node
// Door-knocker v2 step 2: rank -> filter (free, clear channel) -> seeded random arm assignment -> render. DRY RUN ONLY.
// Writes out/v2/{plan.json, targets.cycle1.json, jobs.cycle1.json, examples.md}. Sends nothing, signs nothing.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { a2aReach, operatorOf } from "./reach.mjs";
import { makeRef, buildOfferV2, framingText, renderA2A, renderMCP, renderX402, v2ContentKey, FRAMINGS, CHANNELS } from "./messages.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "out", "v2");
export const CYCLE_LIMIT = 50, JOB_AMOUNT_USDC = "0.05", JOB_MAX_USDC = 0.10, JOBS_PER_DAY = 20, MCP_ARM_MAX = 12, X402_ARM_MAX = 4, X402_MAX_ATOMIC = 10000;

/** Deterministic PRNG (mulberry32) seeded from a hex string. */
export function rng(seedHex) { let a = parseInt(seedHex.slice(0, 8), 16) >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function shuffle(arr, rand) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// side effects judged on the skill id/name (descriptions of x402 sellers all mention "pay"); descriptions only for hard actions
const SIDE_EFFECT_ID_RE = /(transfer|swap|send|pay|trade|execute|deploy|mint|withdraw|deposit|order|book|purchase|buy|sell|bridge|stake|sign|post|publish|delete|register|wallet|subscribe|email|sms|escrow|settle|transact)/i;
const SIDE_EFFECT_DESC_RE = /\b(transfers?|swaps?|withdraws?|deposits?|bridges?|mints?|deploys?|stakes?|places? (an? )?orders?|executes? (a )?trades?|sends? (an? )?(email|sms|message|transaction)s?|broadcasts?)\b/i;
/** (c) job: a skill from the target's own list with no side effects; prefer ones with an example input. */
export function pickJobSkill(skills) {
  const ok = (skills ?? []).filter((s) => s?.id && !SIDE_EFFECT_ID_RE.test(`${s.id} ${s.name ?? ""}`) && !SIDE_EFFECT_DESC_RE.test(String(s.description ?? "")));
  return ok.find((s) => (s.examples ?? []).length) ?? ok[0] ?? null;
}
export function jobSpec(target, ref) {
  const s = pickJobSkill(target.skills);
  if (!s) return null;
  const ex = (s.examples ?? []).find((e) => typeof e === "string" && e.trim());
  const inputText = ex ? `"${ex.trim().slice(0, 240)}"` : `"Produce one example result of this skill for a small sample input of your choice, and state the input you used."`;
  const spec = { kind: "agentcoin-test-job/0.1", testnet: true, skillId: s.id, skillName: String(s.name ?? s.id).slice(0, 80), input: inputText,
    acceptance: "Result returned in this thread, non-empty, answers the stated input, and keccak256(result bytes) equals the deliverableHash submitted on chain.",
    deadlineSeconds: 86400, evaluator: "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a (AgentCoin's staked evaluator, operated by AgentCoin; disclosed)" };
  const specHash = "0x" + createHash("sha256").update(JSON.stringify(spec)).digest("hex");
  return { jobRef: `job-${ref}`, skillId: s.id, skillName: spec.skillName, inputText, amountUsdc: JOB_AMOUNT_USDC, amountAtomic: String(Math.round(Number(JOB_AMOUNT_USDC) * 1e6)), client: "deployer 0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e", evaluator: "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a", deadlineSeconds: 86400, acceptance: spec.acceptance, specHash, openedOnlyAfterAccept: true };
}

/**
 * Select + assign. Channel: A2A version is fixed by the target's card (a3/a1); a random subset of targets that ALSO expose a
 * clear MCP remote is moved to the MCP arm (mc); x402-testnet-only targets form the xt arm. Framing: balanced round-robin over a
 * seeded shuffle within each channel; (c) only where the card lists a side-effect-free skill; (c) is not offered over MCP/x402.
 */
export function assign(candidates, seedHex, { limit = CYCLE_LIMIT, excludeOps = new Set() } = {}) {
  const rand = rng(seedHex);
  const seenOps = new Set([...excludeOps]); const pick = [];
  const a2a = candidates.filter((c) => c.reach.a2a.status === "clear" && c.sellsPaid).sort((x, y) => y.fit - x.fit);
  const xt = candidates.filter((c) => c.reach.x402Testnet.status === "clear" && c.reach.a2a.status !== "clear" && !/demo|poc|weather/i.test(c.reach.x402Testnet.url + c.host)).sort((x, y) => y.fit - x.fit);
  const xtPick = [];
  for (const c of xt) { const op = operatorOf(c.host); if (seenOps.has(op) || xtPick.length >= X402_ARM_MAX) continue; seenOps.add(op); xtPick.push(c); }
  const aPick = [];
  for (const c of a2a) { const op = operatorOf(c.host); if (seenOps.has(op) || aPick.length >= limit - xtPick.length) continue; seenOps.add(op); aPick.push(c); }
  const mcIds = new Set(shuffle(aPick.filter((c) => c.reach.mcp.status === "clear"), rand).slice(0, MCP_ARM_MAX).map((c) => c.id));
  for (const c of aPick) pick.push({ c, channel: mcIds.has(c.id) ? "mc" : c.reach.a2a.iface.version === "1.0" ? "a1" : "a3" });
  for (const c of xtPick) pick.push({ c, channel: "xt" });
  const out = [];
  for (const ch of Object.keys(CHANNELS)) {
    const group = shuffle(pick.filter((p) => p.channel === ch), rand);
    if (ch === "a1" || ch === "a3") {
      // (c) first, to ~1/4 of the group among targets with a side-effect-free skill; the rest round-robin a, b, d
      const nC = Math.round(group.length / 4); const cSet = new Set(group.filter((p) => pickJobSkill(p.c.skills)).slice(0, nC).map((p) => p.c.id));
      const rest = ["a", "b", "d"]; let k = Math.floor(rand() * 3);
      for (const p of group) out.push({ ...p, framing: cSet.has(p.c.id) ? "c" : rest[k++ % 3] });
    } else {
      const fr = ["a", "b", "d"]; let k = Math.floor(rand() * 3);
      for (const p of group) out.push({ ...p, framing: fr[k++ % 3] });
    }
  }
  return out;
}

async function main() {
  const candFile = path.join(OUT, "candidates.json");
  const raw = readFileSync(candFile);
  const seedHex = createHash("sha256").update(raw).digest("hex");
  const { summary, candidates } = JSON.parse(raw);
  const cache = new Map(JSON.parse(readFileSync(path.join(OUT, "probe-cache.json"), "utf8")).map((e) => [e.host, e]));
  for (const c of candidates) { const e = cache.get(c.host); if (e) c.reach.a2a = a2aReach(e.card); }
  const top25 = JSON.parse(readFileSync(path.join(HERE, "..", "out", "top25.approved.json"), "utf8")).top25;
  const excludeOps = new Set(top25.flatMap((t) => [t.channel?.url, t.url]).filter(Boolean).map((u) => { try { return operatorOf(new URL(u).host); } catch { return null; } }).filter(Boolean));
  const base = process.env.AGENTCOIN_BASE_URL ?? "https://testnet.agentcoinhq.com";

  // reachability counts (unique operators, original 25 excluded)
  const byOp = new Map();
  for (const c of candidates) { const op = operatorOf(c.host); if (excludeOps.has(op)) continue; const p = byOp.get(op); const rank = (x) => (x.reach.a2a.status === "clear" ? 3 : x.reach.mcp.status === "clear" ? 2 : x.reach.x402Testnet.status === "clear" ? 1 : 0); if (!p || rank(c) > rank(p) || (rank(c) === rank(p) && c.fit > p.fit)) byOp.set(op, c); }
  const ops = [...byOp.values()];
  const cnt = (f) => ops.filter(f).length;
  const reach = {
    operators: ops.length,
    a2aClear: cnt((c) => c.reach.a2a.status === "clear"),
    a2aClearSellers: cnt((c) => c.reach.a2a.status === "clear" && c.sellsPaid),
    a2aUncertain: cnt((c) => c.reach.a2a.status === "uncertain"),
    mcpClearOnly: cnt((c) => c.reach.a2a.status !== "clear" && c.reach.mcp.status === "clear"),
    mcpClearOnlySellers: cnt((c) => c.reach.a2a.status !== "clear" && c.reach.mcp.status === "clear" && c.sellsPaid),
    x402TestnetClear: cnt((c) => c.reach.x402Testnet.status === "clear"),
  };

  const assigned = assign(candidates, seedHex, { excludeOps });
  const now = new Date();
  const rows = [], jobs = [], examples = {};
  for (const { c, channel, framing } of assigned) {
    const ref = makeRef(channel, framing, seedHex, c.id);
    const job = framing === "c" ? jobSpec(c, ref) : null;
    const endpoint = channel === "mc" ? c.reach.mcp.remote : channel === "xt" ? c.reach.x402Testnet.url : c.reach.a2a.iface.url;
    const offer = buildOfferV2({ id: c.id, endpoint }, { base, ref, framing, channel, job, now, nonce: "<per-send uuid>" });
    offer.signature = "<EIP-191 signature by the AgentCoin operator key, added at send time>";
    const text = framingText(framing, { links: offer.links, job });
    const req = channel === "mc" ? renderMCP(endpoint, offer) : channel === "xt" ? renderX402({ url: endpoint }, offer, text, { maxAtomic: X402_MAX_ATOMIC }) : renderA2A(c.reach.a2a.iface, offer, text, { messageId: "<per-send uuid>", skillId: c.freeContactSkill });
    const row = { ref, arm: `${channel}${framing}`, channel: CHANNELS[channel], framing: FRAMINGS[framing], id: c.id, name: c.name, host: c.host, operator: operatorOf(c.host), endpoint,
      a2a: c.reach.a2a.iface ?? null, mcpRemote: c.reach.mcp.remote ?? null, fit: c.fit, fitReason: c.fitReason, reachReason: channel === "mc" ? c.reach.mcp.reason : channel === "xt" ? c.reach.x402Testnet.reason : c.reach.a2a.reason,
      skillId: c.freeContactSkill ?? null, contentKey: v2ContentKey(offer, text), request: req };
    rows.push(row);
    if (job) jobs.push({ ref, target: c.name, host: c.host, ...job });
    examples[`${channel}${framing}`] ??= row;
  }
  const sum = (a) => a.reduce((s, j) => s + Number(j.amountUsdc), 0);
  const plan = {
    testnet: true, dryRun: true, sent: 0, generatedAt: now.toISOString(), seed: { sha256OfCandidatesJson: seedHex, prng: "mulberry32(first 32 bits)" },
    crawl: summary, reachability: reach, enoughFor50: reach.a2aClearSellers + Math.min(reach.x402TestnetClear, X402_ARM_MAX) >= CYCLE_LIMIT,
    cycle1: { targets: rows.length, byArm: rows.reduce((m, r) => ((m[r.arm] = (m[r.arm] ?? 0) + 1), m), {}), byChannel: rows.reduce((m, r) => ((m[r.channel] = (m[r.channel] ?? 0) + 1), m), {}), byFraming: rows.reduce((m, r) => ((m[r.framing] = (m[r.framing] ?? 0) + 1), m), {}) },
    jobs: { count: jobs.length, amountEachUsdc: JOB_AMOUNT_USDC, maxEachUsdc: JOB_MAX_USDC, maxPerDay: JOBS_PER_DAY, totalUsdcIfAllAccept: sum(jobs).toFixed(2) },
    x402: { count: rows.filter((r) => r.arm.startsWith("xt")).length, maxEachAtomic: X402_MAX_ATOMIC, totalUsdcMax: (rows.filter((r) => r.arm.startsWith("xt")).reduce((s, r) => s + Number(candidates.find((c) => c.id === r.id).reach.x402Testnet.priceAtomic), 0) / 1e6).toFixed(3) },
    limits: { perAgentPerCycle: 1, followUp: "only on a genuine reply", perDay: 50, autoBlock: false, optOuts: "explicit only" },
  };
  if (jobs.length > JOBS_PER_DAY) throw new Error(`(c) jobs ${jobs.length} > ${JOBS_PER_DAY}/day`);
  writeFileSync(path.join(OUT, "targets.cycle1.json"), JSON.stringify({ plan, targets: rows }, null, 2) + "\n");
  writeFileSync(path.join(OUT, "jobs.cycle1.json"), JSON.stringify({ jobs }, null, 2) + "\n");
  writeFileSync(path.join(OUT, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  let md = `# Door-knocker v2: rendered example per arm (DRY RUN, nothing sent)\n\nOne real rendered request per channel x framing present in cycle 1. Signature and per-send ids are placeholders.\n`;
  for (const k of Object.keys(examples).sort()) { const r = examples[k]; md += `\n## ${k}: ${r.channel} / ${r.framing}\n\nTarget: ${r.name} (${r.host}), ref \`${r.ref}\`\n\n\`\`\`json\n${JSON.stringify(r.request, null, 2)}\n\`\`\`\n`; }
  writeFileSync(path.join(OUT, "examples.md"), md);
  console.log(JSON.stringify(plan, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => (console.error(e), process.exit(1)));
