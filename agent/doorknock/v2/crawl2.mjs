#!/usr/bin/env node
// Door-knocker v2 step 1: fresh READ-ONLY crawl (public catalog GETs, card GETs, Base Sepolia view calls). Sends nothing.
// Excludes the original 25 (by id, host and endpoint). Output: out/v2/candidates.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crawlErc8004 } from "../sources.mjs";
import { a2aReach, mcpReach, x402TestnetReach, freeContactSkill } from "./reach.mjs";
import { score } from "../crawl.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "out", "v2");
mkdirSync(OUT, { recursive: true });
const UA = "agentcoin-doorknock-crawler/0.5 (read-only; testnet)";
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\])/;
const host = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return null; } };

async function get(url, timeoutMs = 9000, maxChars = 300000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, redirect: "manual", signal: ctl.signal });
    const text = (await r.text()).slice(0, maxChars);
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body };
  } catch (e) { return { status: 0, error: e.name === "AbortError" ? "timeout" : String(e.message ?? e) }; }
  finally { clearTimeout(t); }
}
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }

async function bazaar(max) {
  const items = [];
  for (let off = 0; off < max; off += 100) {
    const r = await get(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100&offset=${off}`, 30000, 20_000_000);
    if (r.status !== 200) { console.error(`bazaar offset ${off}: ${r.status || r.error}`); break; }
    const page = r.body?.items ?? []; items.push(...page);
    if (page.length < 100) break;
  }
  return items.map((it) => {
    const url = it.resource ?? it.accepts?.[0]?.resource;
    const sep = (it.accepts ?? []).find((a) => a.network === "eip155:84532" || a.network === "base-sepolia");
    const evm = sep ?? (it.accepts ?? []).find((a) => String(a.network).startsWith("eip155:") || a.network === "base");
    return { source: "x402-bazaar", id: `x402:${url}`, name: it.metadata?.name ?? host(url) ?? "?", description: String(it.description ?? it.accepts?.[0]?.description ?? "").slice(0, 400), url, host: host(url),
      networks: [...new Set((it.accepts ?? []).map((a) => a.network))], priceAtomic: evm?.amount ?? evm?.maxAmountRequired ?? null, method: it.extensions?.bazaar?.info?.input?.method ?? it.metadata?.bazaar?.info?.input?.method ?? null, lastUpdated: it.lastUpdated ?? null };
  });
}
async function mcpRegistry(queries) {
  const seen = new Map();
  for (const q of queries) {
    let cursor = null;
    for (let page = 0; page < 3; page++) {
      const r = await get(`https://registry.modelcontextprotocol.io/v0/servers?limit=100&search=${encodeURIComponent(q)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, 30000, 20_000_000);
      for (const e of r.body?.servers ?? []) {
        const s = e.server, meta = e._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
        if (meta.status && meta.status !== "active") continue;
        if (meta.isLatest === false) continue;
        const rem = (s.remotes ?? []).find((x) => x.type === "streamable-http") ?? s.remotes?.[0];
        if (!rem?.url) continue;
        seen.set(s.name, { source: "mcp-registry", id: `mcp:${s.name}`, name: s.title ?? s.name, description: String(s.description ?? "").slice(0, 400), url: rem.url, host: host(rem.url), remote: rem.url, remoteType: rem.type, remoteHeaders: rem.headers ?? [], updatedAt: meta.updatedAt ?? null });
      }
      cursor = r.body?.metadata?.nextCursor; if (!cursor) break;
    }
  }
  return [...seen.values()];
}

async function main() {
  const started = new Date().toISOString();
  const top25 = JSON.parse(readFileSync(path.join(HERE, "..", "out", "top25.approved.json"), "utf8")).top25;
  const exIds = new Set(top25.map((t) => t.id)), exHosts = new Set(top25.flatMap((t) => [host(t.url), host(t.channel?.url)]).filter(Boolean)), exEps = new Set(top25.map((t) => t.channel?.url).filter(Boolean));
  const prev = JSON.parse(readFileSync(path.join(HERE, "..", "out", "targets.json"), "utf8")).targets;
  const dep = JSON.parse(readFileSync(path.join(HERE, "..", "..", "..", "deployments", "base-sepolia.json"), "utf8"));
  const [bz, mcp, erc] = await Promise.all([
    bazaar(Number(process.env.BAZAAR_MAX ?? 5000)),
    mcpRegistry(["x402", "payment", "pay", "escrow", "agent", "usdc", "base", "a2a", "erc-8004", "crypto", "wallet", "onchain", "defi", "trading", "data", "api", "commerce", "marketplace", "oracle", "stablecoin"]),
    crawlErc8004({ latestId: Number(process.env.ERC8004_LATEST_ID ?? 10800), count: Number(process.env.ERC8004_COUNT ?? 1500), selfAgentId: dep.erc8004.agentId }).catch((e) => (console.error("erc8004", e.message), [])),
  ]);
  // merge by host (one operator per host); keep all listings' facts
  const all = [...erc, ...bz, ...mcp, ...prev.filter((t) => t.source !== "virtuals-acp")];
  const byHost = new Map();
  for (const t of all) {
    const h = t.host ?? host(t.a2a ?? t.url);
    if (!h || PRIVATE.test(h)) continue;
    const e = byHost.get(h) ?? { host: h, listings: [], ids: new Set() };
    if (!e.ids.has(t.id)) { e.ids.add(t.id); e.listings.push(t); }
    byHost.set(h, e);
  }
  const hosts = [...byHost.values()].filter((e) => !exHosts.has(e.host) && !e.listings.some((t) => exIds.has(t.id)));
  console.error(`hosts to probe: ${hosts.length} (excluded ${byHost.size - hosts.length} overlapping the original 25)`);
  let done = 0;
  const probed = await pool(hosts, Number(process.env.CONC ?? 16), async (e) => {
    const erc = e.listings.find((t) => t.source === "erc8004-base-sepolia");
    const cands = [erc?.a2a && /agent(-card)?\.json/.test(erc.a2a) ? erc.a2a : null, `https://${e.host}/.well-known/agent-card.json`, `https://${e.host}/.well-known/agent.json`].filter(Boolean);
    let card = null, cardUrl = null, tries = [];
    for (const u of cands) {
      const r = await get(u); tries.push([u, r.status || r.error]);
      if (r.status === 200 && r.body && typeof r.body === "object" && (r.body.name || r.body.skills)) { card = r.body; cardUrl = u; break; }
    }
    if (++done % 100 === 0) console.error(`probed ${done}/${hosts.length}`);
    return { ...e, card, cardUrl, tries };
  });
  writeFileSync(path.join(OUT, "probe-cache.json"), JSON.stringify(probed.map((e) => ({ host: e.host, ids: [...e.ids], cardUrl: e.cardUrl, card: e.card, tries: e.tries }))) + "\n");
  const cands = probed.map((e) => {
    const a2a = a2aReach(e.card);
    const mcpL = e.listings.find((t) => t.source === "mcp-registry" && t.remoteType);
    const mcp = mcpL ? mcpReach(mcpL) : { status: "excluded", reason: "no MCP registry remote" };
    const xL = e.listings.filter((t) => t.source === "x402-bazaar").map((t) => ({ t, r: x402TestnetReach(t) }));
    const xt = xL.find((x) => x.r.status === "clear");
    const best = e.listings.map((t) => ({ t, s: score({ ...t, channel: a2a.status === "clear" ? a2a.iface : null, card: e.cardUrl ? { cardUrl: e.cardUrl } : undefined }) })).sort((a, b) => b.s.score - a.s.score)[0];
    const sellsPaid = e.listings.some((t) => t.source === "x402-bazaar") || /x402|pay per call|per call|usdc|paid/i.test(JSON.stringify(e.card ?? {}).slice(0, 20000) + e.listings.map((t) => t.description).join(" "));
    const fit = best.s.score + (sellsPaid ? 10 : 0);
    const skills = (Array.isArray(e.card?.skills) ? e.card.skills : []).slice(0, 40).map((s) => ({ id: s.id, name: s.name, description: String(s.description ?? "").slice(0, 300), inputModes: s.inputModes, examples: (s.examples ?? []).slice(0, 2) }));
    const erc = e.listings.find((t) => t.source === "erc8004-base-sepolia");
    return {
      id: best.t.id, name: e.card?.name ?? best.t.name, host: e.host, sources: [...new Set(e.listings.map((t) => t.source))], listingCount: e.listings.length,
      erc8004AgentId: erc?.agentId ?? null, cardUrl: e.cardUrl, cardProtocolVersion: e.card?.protocolVersion ?? null,
      reach: { a2a, mcp: mcpL ? { ...mcp, remote: mcpL.remote } : mcp, x402Testnet: xt ? { ...xt.r, url: xt.t.url, priceAtomic: xt.t.priceAtomic, method: xt.t.method } : { status: "excluded", reason: xL.length ? xL[0].r.reason : "no x402 listing" } },
      freeContactSkill: freeContactSkill(e.card), skills, sellsPaid, fit, fitReason: best.s.reason + (sellsPaid ? "; sells a paid service" : ""),
    };
  }).sort((a, b) => b.fit - a.fit);
  const n = (k, s) => cands.filter((c) => c.reach[k].status === s).length;
  const summary = { testnet: true, realValue: false, started, finished: new Date().toISOString(), sources: { bazaarResources: bz.length, bazaarBaseSepolia: bz.filter((t) => t.networks.some((x) => x === "eip155:84532" || x === "base-sepolia")).length, mcpRemotes: mcp.length, erc8004WithRegistration: erc.length, previousTargets: prev.length }, hostsProbed: hosts.length, cardsFound: probed.filter((e) => e.card).length,
    reachable: { a2aClear: n("a2a", "clear"), a2aUncertainRoot: n("a2a", "uncertain"), mcpClear: n("mcp", "clear"), x402TestnetClear: n("x402Testnet", "clear") },
    a2aExcludedReasons: Object.entries(cands.filter((c) => c.reach.a2a.status === "excluded" && c.cardUrl).reduce((m, c) => ((m[c.reach.a2a.reason.split(":")[0].split("(")[0].trim()] = (m[c.reach.a2a.reason.split(":")[0].split("(")[0].trim()] ?? 0) + 1), m), {})) };
  writeFileSync(path.join(OUT, "candidates.json"), JSON.stringify({ summary, candidates: cands }, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => (console.error(e), process.exit(1)));
