// Door-knocker v2: classify whether a target has a FREE, CLEAR machine message channel, from read-only data only
// (its own A2A card / MCP registry entry / x402 Bazaar listing). Learnings from runs 1-2 (2026-10-30):
//  - many cards point at a web root that only serves paid GET routes (405/404 on POST) -> root URLs are "uncertain"
//  - A2A v1.0 cards: JSON-RPC method SendMessage, HTTP+JSON POST {url}/message:send (no /v1 prefix)
//  - some cards REQUIRE an extension (e.g. a2a-x402) -> not free
//  - some cards say their A2A URL is a paid door / not a message endpoint -> excluded
const PAID_DOOR_RE = /not an a2a (message )?endpoint|paid door|(unauthenticated|unpaid) (post|call|request)[^.]{0,60}\b402\b|every (skill|call|message) (is )?paid|settle before serve/i;
const AUTH_RE = /^(oauth2|openIdConnect|apiKey|http|mutualTLS)$/i;

const arr = (v) => (Array.isArray(v) ? v : []);
export function cardInterfaces(card) {
  if (!card || typeof card !== "object") return [];
  const out = [];
  for (const x of arr(card.supportedInterfaces)) if (x?.url) out.push({ url: x.url, binding: String(x.protocolBinding ?? x.transport ?? "JSONRPC").toUpperCase(), version: String(x.protocolVersion ?? card.protocolVersion ?? "") });
  if (typeof card.url === "string") out.push({ url: card.url, binding: String(card.preferredTransport ?? "JSONRPC").toUpperCase(), version: String(card.protocolVersion ?? "") });
  for (const x of arr(card.additionalInterfaces)) if (x?.url) out.push({ url: x.url, binding: String(x.transport ?? "JSONRPC").toUpperCase(), version: String(card.protocolVersion ?? "") });
  return out.filter((x) => /^https:\/\//.test(x.url) && /^(JSONRPC|HTTP\+JSON|REST)$/.test(x.binding) && !/\/(mcp|sse)\/?$|\.well-known\//i.test(x.url));
}
export const majorOf = (v) => (String(v).startsWith("1.") || v === "1" ? "1.0" : "0.3");
const isRoot = (u) => { try { const x = new URL(u); return (x.pathname === "/" || x.pathname === "") && !x.search; } catch { return true; } };

/** A2A reachability from a card: { status: "clear"|"uncertain"|"excluded", reason, iface } */
export function a2aReach(card) {
  if (!card) return { status: "excluded", reason: "no A2A card" };
  const ifaces = cardInterfaces(card);
  if (!ifaces.length) return { status: "excluded", reason: "card declares no https JSONRPC/HTTP+JSON interface" };
  const req = arr(card.capabilities?.extensions).filter((e) => e?.required === true).map((e) => e.uri);
  if (req.length) return { status: "excluded", reason: `card requires extension(s): ${req.join(", ")}` };
  const sec = card.security ?? card.securityRequirements ?? [];
  const schemes = Object.values(card.securitySchemes ?? {}).map((s) => s?.type ?? Object.keys(s ?? {})[0]).filter(Boolean);
  if ((Array.isArray(sec) && sec.length) || schemes.some((t) => AUTH_RE.test(String(t).replace(/SecurityScheme$/, "")))) return { status: "excluded", reason: "card declares auth (security/securitySchemes)" };
  const text = JSON.stringify({ d: card.description, s: arr(card.skills).map((s) => s.description) }).slice(0, 40000);
  if (PAID_DOOR_RE.test(text)) return { status: "excluded", reason: `card text says the A2A URL is paid / not a message endpoint ("${PAID_DOOR_RE.exec(text)[0]}")` };
  // prefer v1.0 explicit interfaces, then non-root paths
  const ranked = [...ifaces].sort((a, b) => Number(isRoot(a.url)) - Number(isRoot(b.url)) || Number(majorOf(b.version) === "1.0") - Number(majorOf(a.version) === "1.0"));
  const iface = { ...ranked[0], version: majorOf(ranked[0].version) };
  if (/\.(json|ya?ml|md|txt)$/i.test(new URL(iface.url).pathname)) return { status: "excluded", reason: `declared interface URL is a document (${iface.url}), not a message endpoint`, iface };
  if (iface.version === "0.3" && iface.binding !== "JSONRPC" && /\/v1\/?$/.test(new URL(iface.url).pathname)) return { status: "uncertain", reason: "v0.3 HTTP+JSON base already ends in /v1 (ambiguous: /v1/v1/message:send vs /v1/message:send)", iface };
  if (iface.binding !== "JSONRPC" && !/a2a|agent|message|inbox|rpc/i.test(new URL(iface.url).pathname)) return { status: "uncertain", reason: `HTTP+JSON interface path looks like an API route, not an A2A base (${iface.url})`, iface };
  if (isRoot(iface.url)) return { status: "uncertain", reason: "A2A URL is the bare web root (in runs 1-2, 7 of 8 such roots rejected POST); not counted as reachable", iface };
  return { status: "clear", reason: `card declares A2A ${iface.version} ${iface.binding} at ${iface.url}; no required extension, no auth, no paid-door text`, iface };
}

/** Free, informational skill ids we may name in metadata.skillId (never a paid skill). */
export function freeContactSkill(card) {
  for (const s of arr(card?.skills)) {
    const blob = `${s.id} ${s.name} ${s.description}`.toLowerCase();
    if (/\b(contact|inbox|feedback|about|info|help|hello|intake|partnership|message)\b/.test(String(s.id).toLowerCase()) && !/\$\s?\d|\bprice\b|\bpaid\b|x402|usdc/.test(blob)) return s.id;
  }
  return null;
}

/** MCP registry remote: initialize-only presentation channel. */
export function mcpReach(entry) {
  const r = entry?.remote;
  if (!r || !/^https:\/\//.test(r)) return { status: "excluded", reason: "no https remote" };
  if (entry.remoteType && entry.remoteType !== "streamable-http") return { status: "excluded", reason: `remote type ${entry.remoteType} (only streamable-http)` };
  if ((entry.remoteHeaders ?? []).some((h) => h?.isRequired)) return { status: "excluded", reason: "remote requires headers (auth)" };
  return { status: "clear", reason: `streamable-http MCP remote ${r}, no required headers (initialize only: carries clientInfo + ref link; not a message inbox)` };
}

/** x402 testnet arm: only Base Sepolia listings, priced <= cap. */
export function x402TestnetReach(t, { maxAtomic = 50000 } = {}) {
  const nets = t?.networks ?? [];
  if (!nets.some((n) => n === "eip155:84532" || n === "base-sepolia")) return { status: "excluded", reason: "not on Base Sepolia" };
  if (t.priceAtomic != null && BigInt(t.priceAtomic) > BigInt(maxAtomic)) return { status: "excluded", reason: `price ${t.priceAtomic} > cap ${maxAtomic}` };
  if (t.method && t.method !== "GET") return { status: "excluded", reason: `method ${t.method} (only side-effect-free GET)` };
  return { status: "clear", reason: `x402 resource accepting Base Sepolia (we would pay only the eip155:84532 option), ${t.priceAtomic ?? "?"} atomic test USDC` };
}

// Public hosting suffixes where each subdomain is a different operator.
const SHARED = ["workers.dev", "onrender.com", "up.railway.app", "railway.app", "vercel.app", "netlify.app", "sslip.io", "nip.io", "fly.dev", "herokuapp.com", "pages.dev", "github.io", "replit.app", "web.app", "azurewebsites.net", "com.au", "co.uk", "co.jp", "com.br", "co.in", "ngrok-free.app", "ngrok.app", "trycloudflare.com", "deno.dev", "hf.space"];
/** Operator key (approximate registrable domain) so one operator gets at most one knock per cycle. */
export function operatorOf(host) {
  const h = String(host).toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
  for (const s of SHARED) if (h === s || h.endsWith("." + s)) { const rest = h.slice(0, -(s.length + 1)).split("."); return `${rest[rest.length - 1]}.${s}`; }
  return h.split(".").slice(-2).join(".");
}
