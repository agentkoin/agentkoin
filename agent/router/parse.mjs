// AgentCoin index: normalizers from public seller metadata to Service records.
// Shared by the seed builder (build/build-seed.mjs) and POST /v1/services (one-call listing).
// Seller-supplied text (names, descriptions, tags) is stored as data only: it is truncated, never
// interpreted, and listed under untrustedFields. Ranking uses structured fields and evidence.
import { TESTNET } from "../lib/network.mjs";
import { createHash } from "node:crypto";
import { keccak256, toBytes, getAddress, isAddress } from "viem";
import { jcs } from "../lib/canonical.mjs";
import { cardInterfaces } from "../doorknock/v2/reach.mjs";

export const UNTRUSTED_FIELDS = ["name", "description", "skills[].name", "skills[].description", "skills[].tags", "skills[].inputExample"];
export const PROTOCOLS = ["x402", "a2a", "mcp", "openapi", "erc8004"];
const SEPOLIA = TESTNET ? new Set(["eip155:84532", "base-sepolia"]) : new Set(["eip155:8453", "base"]); // configured network first (lib/network.mjs)
const NET_ALIASES = { base: "eip155:8453", "base-sepolia": "eip155:84532", ethereum: "eip155:1", polygon: "eip155:137", arbitrum: "eip155:42161", optimism: "eip155:10", avalanche: "eip155:43114" };

const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
export const hostOf = (u) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
};
export const serviceId = (protocol, host) => `svc_${sha16(`${protocol}:${host}`)}`;
export const operatorId = (host) => `op_${sha16(host)}`;
export const metadataHash = (o) => keccak256(toBytes(jcs(o)));

const str = (v, n = 300) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, n) : v == null ? null : String(v).slice(0, n));
const arr = (v) => (Array.isArray(v) ? v : []);
const normNet = (n) => (n == null ? null : NET_ALIASES[n] ?? String(n));
const addr = (a) => (typeof a === "string" && isAddress(a, { strict: false }) ? getAddress(a) : null);
const jsonCap = (o, n) => {
  if (o == null) return null;
  try {
    const s = JSON.stringify(o);
    return s.length <= n ? o : null;
  } catch {
    return null;
  }
};

/** Pick the accept entry a Base Sepolia buyer would use first: Base Sepolia, then Base, then any EVM, then first. */
export function preferredAccept(accepts) {
  const a = arr(accepts).filter((x) => x && typeof x === "object");
  const n = (x) => normNet(x.network);
  return a.find((x) => SEPOLIA.has(n(x))) ?? a.find((x) => n(x) === "eip155:8453") ?? a.find((x) => String(n(x)).startsWith("eip155:")) ?? a[0] ?? null;
}
const compactAccept = (x) => ({ scheme: str(x.scheme, 40), network: normNet(x.network), asset: str(x.asset, 80), amount: str(x.amount ?? x.maxAmountRequired, 40), payTo: str(x.payTo, 80), maxTimeoutSeconds: Number.isFinite(x.maxTimeoutSeconds) ? x.maxTimeoutSeconds : null, extra: jsonCap(x.extra, 300) });

/** x402 resources (Bazaar discovery items, a 402 body, or a /.well-known/x402 manifest) -> skills. */
export function x402Skills(items) {
  const out = [];
  const seen = new Set();
  for (const it of arr(items)) {
    if (!it || typeof it !== "object") continue;
    const url = it.resource?.url ?? it.resource ?? it.url ?? it.endpoint ?? it.accepts?.[0]?.resource ?? null;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) continue;
    const accepts = arr(it.accepts).slice(0, 6).map(compactAccept);
    const p = preferredAccept(arr(it.accepts));
    const info = it.extensions?.bazaar?.info ?? it.metadata?.bazaar?.info ?? null;
    const method = str(info?.input?.method ?? it.method ?? it.resource?.method ?? (p?.extra?.method) ?? null, 10)?.toUpperCase() ?? null;
    let u;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    const id = `${method ?? "ANY"} ${u.pathname}${u.search}`.slice(0, 300);
    if (seen.has(id)) continue;
    seen.add(id);
    const inputSchema = jsonCap(it.extensions?.bazaar?.schema?.properties?.input ?? it.inputSchema ?? null, 2500);
    const inputExample = jsonCap(info?.input ? { body: info.input.body, queryParams: info.input.queryParams, bodyType: info.input.bodyType } : null, 1500);
    out.push({
      id,
      name: str(it.serviceName ?? it.metadata?.name ?? it.name ?? u.pathname, 120),
      description: str(it.description ?? it.resource?.description ?? p?.description ?? null),
      tags: arr(it.tags).slice(0, 10).map((t) => str(t, 40)),
      url,
      method,
      type: str(it.type, 10) ?? "http",
      price: p ? str(p.amount ?? p.maxAmountRequired, 40) : null,
      asset: p ? str(p.asset, 80) : null,
      network: p ? normNet(p.network) : null,
      payTo: p ? str(p.payTo, 80) : null,
      scheme: p ? str(p.scheme, 40) : null,
      accepts,
      inputSchema,
      inputExample,
      sourceStats: it.quality ? { l30DaysTotalCalls: it.quality.l30DaysTotalCalls ?? null, l30DaysUniquePayers: it.quality.l30DaysUniquePayers ?? null, lastCalledAt: it.quality.lastCalledAt ?? null, statsFrom: "x402 Bazaar (CDP) quality field" } : null,
      lastUpdated: str(it.lastUpdated, 40),
    });
  }
  return out;
}

/** A2A agent card -> skills + interface. */
export function a2aSkills(card) {
  return arr(card?.skills)
    .slice(0, 100)
    .filter((s) => s && typeof s === "object")
    .map((s) => ({ id: str(s.id ?? s.name, 120), name: str(s.name, 120), description: str(s.description), tags: arr(s.tags).slice(0, 10).map((t) => str(t, 40)), inputModes: arr(s.inputModes).slice(0, 6).map((m) => str(m, 60)), price: null, asset: null, network: null, payTo: null, inputExample: jsonCap(arr(s.examples).slice(0, 2).map((e) => str(e, 200)), 600) }))
    .filter((s) => s.id);
}
export function a2aInterface(card, cardUrl) {
  try {
    const ifs = cardInterfaces(card);
    if (ifs.length) return { url: ifs[0].url, binding: ifs[0].binding, version: ifs[0].version, all: ifs.slice(0, 4) };
  } catch {}
  const u = typeof card?.url === "string" ? card.url : null;
  return u ? { url: u, binding: card.preferredTransport ?? "JSONRPC", version: str(card.protocolVersion, 10) } : cardUrl ? { url: null, binding: null, version: null } : null;
}
const cardAuth = (card) => {
  const sec = card?.security ?? card?.securityRequirements ?? [];
  return (Array.isArray(sec) && sec.length > 0) || Object.keys(card?.securitySchemes ?? {}).length > 0;
};

/** OpenAPI 3.x -> skills (one per operation). x-payment-info / x-x402 extensions are read when present. */
export function openapiSkills(doc, docUrl) {
  const out = [];
  const base = arr(doc?.servers)[0]?.url ?? (docUrl ? new URL(docUrl).origin : "");
  for (const [p, ops] of Object.entries(doc?.paths ?? {}).slice(0, 300)) {
    for (const [m, op] of Object.entries(ops ?? {})) {
      if (!["get", "post", "put", "patch", "delete"].includes(m) || !op || typeof op !== "object") continue;
      const pay = op["x-payment-info"] ?? op["x-x402"] ?? null;
      const p0 = preferredAccept(arr(pay?.accepts));
      let url = null;
      try {
        url = new URL(p.replace(/^\//, ""), base.endsWith("/") ? base : base + "/").href;
      } catch {}
      out.push({ id: str(op.operationId ?? `${m.toUpperCase()} ${p}`, 200), name: str(op.summary ?? op.operationId ?? p, 120), description: str(op.description ?? op.summary ?? null), tags: arr(op.tags).slice(0, 10).map((t) => str(t, 40)), url, method: m.toUpperCase(), price: str(p0?.amount ?? pay?.price ?? null, 40), asset: str(p0?.asset ?? null, 80), network: normNet(p0?.network ?? null), payTo: str(p0?.payTo ?? null, 80), inputSchema: jsonCap(op.requestBody?.content?.["application/json"]?.schema ?? null, 2500) });
    }
  }
  return out;
}

/** MCP tools (tools/list result or server card tools) -> skills. */
export function mcpSkills(tools) {
  return arr(tools)
    .slice(0, 200)
    .filter((t) => t && typeof t === "object" && t.name)
    .map((t) => ({ id: str(t.name, 120), name: str(t.title ?? t.name, 120), description: str(t.description), tags: [], price: null, asset: null, network: null, payTo: null, inputSchema: jsonCap(t.inputSchema ?? null, 2500) }));
}

/** Assemble a Service record. metadataHash covers the parsed metadata (not timestamps). */
export function buildService({ protocol, host, name, description = null, endpoints = {}, skills = [], erc8004AgentId = null, source, origin = "indexed", extra = {} }) {
  if (!PROTOCOLS.includes(protocol)) throw new Error(`protocol must be one of ${PROTOCOLS.join(", ")}`);
  const evmPayTo = [...new Set(skills.flatMap((s) => [s.payTo, ...arr(s.accepts).map((a) => a.payTo)]).map(addr).filter(Boolean))];
  const counts = new Map();
  for (const s of skills) {
    const a = addr(s.payTo);
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const payTo = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const meta = { protocol, host, name: str(name, 120) ?? host, description: str(description), endpoints, skills, erc8004AgentId: erc8004AgentId == null ? null : String(erc8004AgentId), payTo, wallets: evmPayTo.slice(0, 20), ...extra };
  return { id: serviceId(protocol, host), operatorId: operatorId(host), ...meta, source, origin, metadataHash: metadataHash(meta) };
}

/** Detect the kind of a fetched public document and build a Service from it. */
export function serviceFromDocument(doc, url, { status = 200, headers = {} } = {}) {
  const host = hostOf(url);
  if (!host) throw new Error("bad url");
  const src = (kind) => ({ kind, url, fetchedAt: new Date().toISOString() });
  // x402: a 402 body / PAYMENT-REQUIRED header, a discovery list, or a well-known manifest
  const pr = headers["payment-required"] ? safeB64(headers["payment-required"]) : null;
  const x = pr ?? doc;
  if (status === 402 || pr || (x && (Array.isArray(x.accepts) || Array.isArray(x.items) || Array.isArray(x.resources) || Array.isArray(x.endpoints)) && /x402/i.test(JSON.stringify(x).slice(0, 4000)))) {
    const items = Array.isArray(x.accepts) ? [{ ...x, resource: x.resource?.url ?? x.resource ?? url }] : arr(x.items ?? x.resources ?? x.endpoints).map((r) => (typeof r === "string" ? { resource: r } : r));
    const skills = x402Skills(items);
    if (!skills.length) throw new Error("x402 document has no parseable resources");
    return buildService({ protocol: "x402", host, name: x.name ?? x.serviceName ?? host, description: x.description ?? null, endpoints: { manifest: url }, skills, source: src("x402") });
  }
  if (doc && typeof doc === "object" && (doc.openapi || doc.swagger) && doc.paths) {
    const skills = openapiSkills(doc, url);
    return buildService({ protocol: "openapi", host, name: doc.info?.title ?? host, description: doc.info?.description ?? null, endpoints: { openapi: url }, skills, source: src("openapi") });
  }
  if (doc && typeof doc === "object" && doc.type && /eip-8004/i.test(String(doc.type)) && Array.isArray(doc.services ?? doc.endpoints)) {
    const svcs = arr(doc.services ?? doc.endpoints);
    const a2a = svcs.find((s) => /a2a/i.test(s.name))?.endpoint ?? null;
    const mcp = svcs.find((s) => /mcp/i.test(s.name))?.endpoint ?? null;
    const x402 = svcs.find((s) => /x402/i.test(s.name))?.endpoint ?? null;
    const reg = arr(doc.registrations)[0] ?? null;
    return buildService({ protocol: "erc8004", host, name: doc.name ?? host, description: doc.description ?? null, endpoints: { registration: url, a2aCard: a2a, mcp, x402 }, skills: [], erc8004AgentId: reg?.agentId ?? null, source: src("erc8004-registration"), extra: { identityRegistry: str(reg?.agentRegistry, 120) } });
  }
  if (doc && typeof doc === "object" && Array.isArray(doc.tools)) {
    return buildService({ protocol: "mcp", host, name: doc.serverInfo?.title ?? doc.serverInfo?.name ?? doc.name ?? host, description: doc.description ?? null, endpoints: { mcp: doc.transport?.url ?? null, serverCard: url }, skills: mcpSkills(doc.tools), source: src("mcp-server-card") });
  }
  if (doc && typeof doc === "object" && (Array.isArray(doc.skills) || doc.supportedInterfaces || doc.protocolVersion) && doc.name) {
    return buildService({ protocol: "a2a", host, name: doc.name, description: doc.description ?? null, endpoints: { card: url, a2a: a2aInterface(doc, url) }, skills: a2aSkills(doc), source: src("a2a-card"), extra: { authDeclared: cardAuth(doc) } });
  }
  throw new Error("unrecognized document: expected an A2A agent card, x402 402/manifest, OpenAPI 3, MCP server card, or ERC-8004 registration");
}
function safeB64(s) {
  try {
    return JSON.parse(Buffer.from(String(s), "base64").toString("utf8"));
  } catch {
    return null;
  }
}
export { cardAuth };
