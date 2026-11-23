#!/usr/bin/env node
// Door-knocker step 1: read-only crawl of public registries -> ranked targets (agent/doorknock/out/).
// Sends nothing to anyone. Only GETs public catalogs/cards and reads Base Sepolia contract state.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crawlBazaar, crawlMcpRegistry, crawlErc8004, probeA2A, crawlVirtualsAcp } from "./sources.mjs";
import { loadOptOuts, isOptedOut } from "./optout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
mkdirSync(OUT, { recursive: true });
const dep = JSON.parse(readFileSync(path.join(HERE, "..", "..", "deployments", "base-sepolia.json"), "utf8"));
const SELF = dep.erc8004?.agentId;

const KW = [
  ["x402", 4], ["escrow", 5], ["payment", 3], ["pay", 1], ["usdc", 3], ["agent", 2], ["a2a", 3], ["erc-8004", 3], ["8004", 2],
  ["task", 1], ["job", 2], ["marketplace", 3], ["service", 1], ["verify", 2], ["evaluat", 3], ["oracle", 2], ["commerce", 3], ["base", 1],
];
const kwHits = (s) => KW.filter(([k]) => s.toLowerCase().includes(k));

export function score(t) {
  const reasons = [];
  let s = 0;
  if (t.channel) {
    s += 40;
    reasons.push(`publishes an A2A card (${t.card.cardUrl}, fetched HTTP 200) with endpoint ${t.channel.url}`);
  }
  if (t.source === "erc8004-base-sepolia") {
    s += 15;
    reasons.push(`ERC-8004 agent #${t.agentId} on Base Sepolia (same chain as AgentCoin testnet)`);
    if (t.x402Support) (s += 8), reasons.push("registration declares x402Support: true");
  }
  if (t.source === "x402-bazaar") {
    const nets = t.networks ?? [];
    if (nets.some((n) => n === "eip155:84532" || n === "base-sepolia")) (s += 15), reasons.push("x402 seller accepting Base Sepolia (testnet)");
    else if (nets.some((n) => n === "eip155:8453" || n === "base")) (s += 8), reasons.push("x402 seller on Base mainnet (USDC)");
    else reasons.push(`x402 seller on ${nets.join(",") || "unknown network"}`);
  }
  if (t.source === "virtuals-acp") {
    s += Math.min(12, Math.round(Math.log10(1 + (t.successfulJobCount ?? 0)) * 3));
    reasons.push(`Virtuals ACP agent with ${t.successfulJobCount} successful ACP jobs${t.successRate != null ? ` (${t.successRate}% success)` : ""}, chains ${t.acpChains.join(",")}; ACP channel is Base mainnet (out of scope)`);
  }
  if (t.source === "mcp-registry" && t.remote) (s += 6), reasons.push(`remote MCP server ${t.remote} in the official MCP Registry`);
  const hits = kwHits(`${t.name} ${t.description}`);
  if (hits.length) {
    s += Math.min(15, hits.reduce((a, [, w]) => a + w, 0));
    reasons.push(`description mentions: ${hits.map(([k]) => k).join(", ")}`);
  }
  if (t.sameHostEntries > 1) reasons.push(`${t.sameHostEntries} registry entries share host ${t.host} (counted once)`);
  if (t.mcp) (s += 3), reasons.push("also lists an MCP endpoint");
  return { score: s, reason: reasons.join("; ") };
}

async function main() {
  const startedAt = new Date().toISOString();
  const latestId = Number(process.env.ERC8004_LATEST_ID ?? Number(SELF) + 50);
  const [bazaar, mcp, erc, acp] = await Promise.all([
    crawlBazaar({ max: Number(process.env.BAZAAR_MAX ?? 1000) }).catch((e) => ({ error: String(e.message ?? e) })),
    crawlMcpRegistry().catch((e) => ({ error: String(e.message ?? e) })),
    crawlErc8004({ latestId, count: Number(process.env.ERC8004_COUNT ?? 400), selfAgentId: SELF }).catch((e) => ({ error: String(e.message ?? e) })),
    crawlVirtualsAcp().catch((e) => ({ error: String(e.message ?? e) })),
  ]);
  const ok = (x) => (Array.isArray(x) ? x : []);
  const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\])/;
  let all = [...ok(erc), ...ok(bazaar), ...ok(mcp), ...ok(acp)].filter((t) => t.source === "virtuals-acp" || ((t.host || t.a2a) && !PRIVATE.test(t.host ?? "")));
  // dedupe x402 resources by host (one agent/operator per host)
  const byKey = new Map();
  for (const t of all) {
    const k = t.host ? `host:${t.host}` : t.id;
    if (!byKey.has(k)) byKey.set(k, { ...t, sameHostEntries: 1, alsoListedIn: [] });
    else {
      const e = byKey.get(k);
      e.sameHostEntries++;
      if (!e.alsoListedIn.includes(t.source) && t.source !== e.source) e.alsoListedIn.push(t.source);
      if (!e.a2a && t.a2a) e.a2a = t.a2a;
    }
  }
  all = [...byKey.values()];
  // prefilter before probing cards: everything from ERC-8004 + MCP + the most relevant x402 hosts
  const pre = all.map((t) => ({ t, s: score(t).score })).sort((a, b) => b.s - a.s);
  const toProbe = pre.filter(({ t }) => t.host).slice(0, Number(process.env.PROBE_MAX ?? 150)).map(({ t }) => t);
  const cards = await probeA2A(toProbe, { max: Number(process.env.PROBE_MAX ?? 150) });
  const optouts = loadOptOuts();
  let targets = all
    .map((t) => {
      const cardUrl = t.a2a && /agent(-card)?\.json/.test(t.a2a) ? t.a2a : t.host ? `https://${t.host}/.well-known/agent-card.json` : null;
      const card = cards.get(cardUrl);
      const a2aLike = card?.endpoint && !/\/(mcp|sse)\/?$|\.well-known\//i.test(card.endpoint) && /^(JSONRPC|HTTP\+JSON|REST|)$/i.test(String(card.transport ?? ""));
      const channel = a2aLike ? { kind: "a2a", url: card.endpoint, transport: card.transport ?? "JSONRPC", protocolVersion: card.protocolVersion } : null;
      const tt = { ...t, card: card?.name ? card : undefined, channel };
      const { score: sc, reason } = score(tt);
      const optedOut = isOptedOut(optouts, tt) || card?.noContact === true;
      return { ...tt, score: sc, reason, optedOut, knockable: Boolean(channel) && !optedOut };
    })
    .sort((a, b) => Number(b.knockable) - Number(a.knockable) || b.score - a.score);
  // one knock per agent endpoint: later duplicates of the same A2A endpoint are not knockable
  const seenCh = new Set();
  for (const t of targets) {
    if (!t.channel) continue;
    const k = t.channel.url.replace(/\/+$/, "").toLowerCase();
    if (seenCh.has(k)) (t.knockable = false), (t.duplicateOf = k);
    seenCh.add(k);
  }
  targets.sort((a, b) => Number(b.knockable) - Number(a.knockable) || b.score - a.score);
  const summary = {
    testnet: true,
    realValue: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    sources: {
      "x402-bazaar": Array.isArray(bazaar) ? { url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources", resources: bazaar.length } : bazaar,
      "mcp-registry": Array.isArray(mcp) ? { url: "https://registry.modelcontextprotocol.io/v0/servers", servers: mcp.length } : mcp,
      "erc8004-base-sepolia": Array.isArray(erc) ? { registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", idsScanned: `${latestId} down, ${process.env.ERC8004_COUNT ?? 400} ids`, withRegistrationJson: erc.length } : erc,
      "a2a-cards": { probed: cards.size, found: [...cards.values()].filter((c) => c?.name).length },
      "virtuals-acp": Array.isArray(acp) ? { url: "https://acpx.virtuals.io/api/agents", agents: acp.length, note: "ACP channel = Base mainnet jobs; not knockable in scope" } : acp,
    },
    targets: targets.length,
    knockable: targets.filter((t) => t.knockable).length,
  };
  writeFileSync(path.join(OUT, "targets.json"), JSON.stringify({ summary, targets }, null, 2) + "\n");
  const top = targets.slice(0, 25).map((t, i) => ({ rank: i + 1, id: t.id, name: t.name, source: t.source, url: t.url, channel: t.channel, knockable: t.knockable, optedOut: t.optedOut, score: t.score, reason: t.reason }));
  writeFileSync(path.join(OUT, "top25.json"), JSON.stringify({ testnet: true, realValue: false, generatedAt: summary.finishedAt, summary, top25: top }, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => (console.error(e), process.exit(1)));
