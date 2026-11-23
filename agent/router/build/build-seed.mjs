#!/usr/bin/env node
// Builds the unclaimed-listing seed from public metadata already on disk. Sends nothing, fetches nothing.
// Inputs: data/bazaar-raw.json (public x402 Bazaar catalog pages, fetch-bazaar.mjs),
//         doorknock/out/v2/probe-cache.json (public A2A cards fetched by the Oct 31 read-only crawl),
//         doorknock/out/v2/candidates.json + doorknock/out/targets.json (MCP registry remotes, ERC-8004 ids).
// Output: seed/index-seed.json.gz. Opt-outs (do-not-contact.json + service optouts.json) are excluded here and again at import.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildService, x402Skills, a2aSkills, a2aInterface, cardAuth, hostOf } from "../parse.mjs";
import { loadOptOutMatches, isOptedOut } from "../optout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = (...p) => path.join(HERE, "..", ...p);
const DK = (...p) => path.join(HERE, "..", "..", "doorknock", "out", ...p);
const SELF = new Set(["testnet.agentcoinhq.com"]);
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[)/;
const okHost = (h) => h && !SELF.has(h) && !PRIVATE.test(h) && h.includes(".");

const bz = JSON.parse(readFileSync(R("data", "bazaar-raw.json"), "utf8"));
const probe = JSON.parse(readFileSync(DK("v2", "probe-cache.json"), "utf8"));
const cands = JSON.parse(readFileSync(DK("v2", "candidates.json"), "utf8")).candidates;
const prev = JSON.parse(readFileSync(DK("targets.json"), "utf8")).targets;
const crawledAt = JSON.parse(readFileSync(DK("v2", "candidates.json"), "utf8")).summary.finished;
const optouts = loadOptOutMatches([path.join(HERE, "..", "..", "doorknock", "do-not-contact.json"), path.join(HERE, "..", "..", ".state", "base-sepolia", "optouts.json")]);

const services = new Map();
const put = (s) => {
  if (!okHost(s.host)) return;
  if (isOptedOut(optouts, s)) return void stats.optedOut++;
  services.set(s.id, s);
};
const stats = { optedOut: 0 };
// erc8004 ids by host
const ercByHost = new Map();
for (const c of cands) if (c.erc8004AgentId) ercByHost.set(c.host, String(c.erc8004AgentId));
for (const t of prev) if (t.agentId && t.host) ercByHost.set(t.host, String(t.agentId));

// 1. x402 (Bazaar catalog): one service per host, one skill per resource
const byHost = new Map();
for (const it of bz.items) {
  const h = hostOf(it.resource ?? it.accepts?.[0]?.resource);
  if (!h) continue;
  (byHost.get(h) ?? byHost.set(h, []).get(h)).push(it);
}
for (const [h, items] of byHost) {
  const skills = x402Skills(items);
  if (!skills.length) continue;
  const names = new Map();
  for (const it of items) if (it.serviceName) names.set(it.serviceName, (names.get(it.serviceName) ?? 0) + 1);
  const name = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? h;
  put(buildService({ protocol: "x402", host: h, name, endpoints: { origin: `https://${h}` }, skills, erc8004AgentId: ercByHost.get(h) ?? null, source: { kind: "x402-bazaar", url: bz.source, fetchedAt: bz.fetchedAt, resources: items.length } }));
}
// 2. A2A cards
for (const e of probe) {
  if (!e.card || typeof e.card !== "object" || !e.cardUrl) continue;
  const h = e.host;
  put(buildService({ protocol: "a2a", host: h, name: e.card.name ?? h, description: e.card.description ?? null, endpoints: { card: e.cardUrl, a2a: a2aInterface(e.card, e.cardUrl) }, skills: a2aSkills(e.card), erc8004AgentId: ercByHost.get(h) ?? null, source: { kind: "a2a-card", url: e.cardUrl, fetchedAt: crawledAt }, extra: { authDeclared: cardAuth(e.card) } }));
}
// 3. MCP registry remotes (metadata only; tools are not listed in the registry)
const mcp = new Map();
for (const t of prev) if (t.source === "mcp-registry" && t.remote) mcp.set(hostOf(t.remote), { name: t.name, description: t.description, remote: t.remote, transport: t.channel?.transport ?? null, id: t.id });
for (const c of cands) if (c.reach?.mcp?.remote) mcp.set(hostOf(c.reach.mcp.remote), { name: c.name, description: null, remote: c.reach.mcp.remote, transport: null, id: c.id.startsWith("mcp:") ? c.id : null });
for (const [h, m] of mcp) {
  if (!h) continue;
  put(buildService({ protocol: "mcp", host: h, name: m.name ?? h, description: m.description, endpoints: { mcp: m.remote, transport: m.transport ?? "streamable-http" }, skills: [], erc8004AgentId: ercByHost.get(h) ?? null, source: { kind: "mcp-registry", url: "https://registry.modelcontextprotocol.io/v0/servers", entry: m.id ? m.id.replace(/^mcp:/, "") : null, fetchedAt: crawledAt } }));
}
// 4. ERC-8004 registrations on Base Sepolia whose host has no other listing
for (const [h, id] of ercByHost) {
  if ([...services.values()].some((s) => s.host === h)) continue;
  const t = prev.find((x) => x.host === h && x.agentId) ?? {};
  put(buildService({ protocol: "erc8004", host: h, name: t.name ?? h, description: t.description ?? null, endpoints: { a2aCard: t.a2a ?? null, mcp: t.mcp ?? null }, skills: [], erc8004AgentId: id, source: { kind: "erc8004-base-sepolia", url: `eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e#${id}`, fetchedAt: crawledAt } }));
}

const list = [...services.values()].sort((a, b) => a.id.localeCompare(b.id));
const summary = {
  v: "agentcoin-index-seed/0.1",
  builtAt: new Date().toISOString(),
  testnet: true,
  realValue: false,
  inputs: { x402Bazaar: { url: bz.source, fetchedAt: bz.fetchedAt, resources: bz.count }, a2aCards: { file: "doorknock/out/v2/probe-cache.json", fetchedAt: crawledAt, cards: probe.filter((e) => e.card).length }, mcpRegistry: { files: ["doorknock/out/targets.json", "doorknock/out/v2/candidates.json"], remotes: mcp.size }, erc8004: { hosts: ercByHost.size } },
  counts: { services: list.length, withSkills: list.filter((s) => s.skills.length).length, byProtocol: list.reduce((m, s) => ((m[s.protocol] = (m[s.protocol] ?? 0) + 1), m), {}), skills: list.reduce((n, s) => n + s.skills.length, 0), operators: new Set(list.map((s) => s.host)).size, excludedOptedOut: stats.optedOut },
};
writeFileSync(R("seed", "index-seed.json.gz"), gzipSync(JSON.stringify({ ...summary, services: list }), { level: 9 }));
writeFileSync(R("seed", "index-seed.summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
