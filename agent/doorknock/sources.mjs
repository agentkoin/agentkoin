// Read-only crawlers over public agent registries. No auth, no writes, no messages.
import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";

const UA = "agentcoin-doorknock-crawler/0.4 (read-only; testnet; +opt-out via agentcoin offer)";
export const ERC8004_BASE_SEPOLIA = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

export async function getJson(url, { timeoutMs = 10000, method = "GET" } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, headers: { "user-agent": UA, accept: "application/json" }, signal: ctl.signal, redirect: "follow" });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, error: String(e.name === "AbortError" ? "timeout" : e.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

/** CDP x402 Bazaar catalog (public, no key). */
export async function crawlBazaar({ max = 1000 } = {}) {
  const items = [];
  for (let offset = 0; offset < max; offset += 100) {
    const r = await getJson(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100&offset=${offset}`);
    const page = r.body?.items ?? [];
    items.push(...page);
    if (page.length < 100) break;
  }
  return items.map((it) => {
    const nets = [...new Set((it.accepts ?? []).map((a) => a.network))];
    const evm = (it.accepts ?? []).find((a) => String(a.network).startsWith("eip155:") || ["base", "base-sepolia"].includes(a.network));
    const url = it.resource ?? it.accepts?.[0]?.resource;
    return {
      source: "x402-bazaar",
      id: `x402:${url}`,
      name: it.metadata?.name ?? (url ? new URL(url).host : "?"),
      description: it.description ?? it.accepts?.[0]?.description ?? "",
      url,
      host: url ? new URL(url).host : null,
      networks: nets,
      priceAtomic: evm?.amount ?? evm?.maxAmountRequired ?? null,
      payTo: evm?.payTo ?? null,
      lastUpdated: it.lastUpdated ?? null,
    };
  });
}

/** Official MCP Registry (public, read-only). Remote servers matching agent-commerce keywords. */
export async function crawlMcpRegistry({ queries = ["x402", "payment", "escrow", "agent", "usdc", "base", "a2a", "erc-8004", "crypto"], perQuery = 100 } = {}) {
  const seen = new Map();
  for (const q of queries) {
    const r = await getJson(`https://registry.modelcontextprotocol.io/v0/servers?limit=${perQuery}&search=${encodeURIComponent(q)}`);
    for (const e of r.body?.servers ?? []) {
      const s = e.server;
      const meta = e._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
      if (meta.status && meta.status !== "active") continue;
      if (!meta.isLatest && meta.isLatest !== undefined) continue;
      const remote = (s.remotes ?? []).find((x) => x.type === "streamable-http") ?? s.remotes?.[0];
      seen.set(s.name, {
        source: "mcp-registry",
        id: `mcp:${s.name}`,
        name: s.title ?? s.name,
        description: s.description ?? "",
        url: remote?.url ?? s.websiteUrl ?? s.repository?.url ?? null,
        host: remote?.url ? new URL(remote.url).host : s.websiteUrl ? safeHost(s.websiteUrl) : null,
        remote: remote?.url ?? null,
        repository: s.repository?.url ?? null,
        updatedAt: meta.updatedAt ?? null,
      });
    }
  }
  return [...seen.values()];
}

const safeHost = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
};

function decodeDataUri(uri) {
  const m = /^data:([^,]*?),(.*)$/s.exec(uri);
  if (!m) return null;
  const b64 = m[1].endsWith(";base64");
  const raw = b64 ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2]);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** ERC-8004 IdentityRegistry on Base Sepolia: read tokenURI for the most recent `count` agent ids below `latestId`. */
export async function crawlErc8004({ latestId, count = 300, rpc = process.env.RPC_URL ?? "https://sepolia.base.org", selfAgentId } = {}) {
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpc, { retryCount: 3, retryDelay: 500 }), batch: { multicall: true } });
  const abi = parseAbi(["function tokenURI(uint256) view returns (string)", "function ownerOf(uint256) view returns (address)"]);
  const ids = [];
  for (let id = latestId; id > 0 && ids.length < count; id--) if (String(id) !== String(selfAgentId)) ids.push(BigInt(id));
  const uris = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await client.multicall({ contracts: chunk.map((id) => ({ address: ERC8004_BASE_SEPOLIA, abi, functionName: "tokenURI", args: [id] })), allowFailure: true });
    res.forEach((r, k) => uris.push({ id: chunk[k], uri: r.status === "success" ? r.result : null }));
  }
  const docs = await pool(uris, 8, async ({ id, uri }) => {
    if (!uri) return null;
    let doc = null;
    let fetchStatus = "data-uri";
    if (uri.startsWith("data:")) doc = decodeDataUri(uri);
    else {
      const url = uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
      if (!/^https?:\/\//.test(url)) return null;
      const r = await getJson(url, { timeoutMs: 8000 });
      fetchStatus = r.status;
      doc = r.body;
    }
    if (!doc || typeof doc !== "object") return { id, uri, doc: null, fetchStatus };
    return { id, uri, doc, fetchStatus };
  });
  return docs.filter(Boolean).filter((d) => d.doc).map(({ id, uri, doc, fetchStatus }) => {
    const svcs = doc.services ?? doc.endpoints ?? [];
    const find = (n) => svcs.find((s) => String(s.name ?? s.type ?? "").toLowerCase() === n)?.endpoint;
    const a2a = find("a2a");
    const mcp = find("mcp");
    const web = find("web") ?? doc.url;
    return {
      source: "erc8004-base-sepolia",
      id: `erc8004:84532:${id}`,
      agentId: String(id),
      name: String(doc.name ?? `agent ${id}`).slice(0, 80),
      description: String(doc.description ?? "").slice(0, 300),
      a2a: typeof a2a === "string" ? a2a : null,
      mcp: typeof mcp === "string" ? mcp : null,
      url: (typeof a2a === "string" && a2a) || (typeof mcp === "string" && mcp) || (typeof web === "string" ? web : null),
      host: safeHost(a2a ?? mcp ?? web ?? ""),
      x402Support: doc.x402Support === true || doc.x402support === true,
      active: doc.active !== false,
      uriKind: uri.startsWith("data:") ? "data" : uri.split(":")[0],
      registrationFetch: fetchStatus,
    };
  });
}

/** Probe public A2A agent cards (read-only GET of /.well-known/agent-card.json, legacy agent.json). */
export async function probeA2A(targets, { concurrency = 6, max = 150 } = {}) {
  const hosts = new Map();
  for (const t of targets) {
    const cardUrl = t.a2a && /agent(-card)?\.json/.test(t.a2a) ? t.a2a : t.host ? `https://${t.host}/.well-known/agent-card.json` : null;
    if (cardUrl && !hosts.has(cardUrl) && hosts.size < max) hosts.set(cardUrl, null);
  }
  const urls = [...hosts.keys()];
  const res = await pool(urls, concurrency, async (u) => {
    let r = await getJson(u, { timeoutMs: 8000 });
    if (r.status !== 200 && u.endsWith("/.well-known/agent-card.json")) {
      const legacy = u.replace("agent-card.json", "agent.json");
      const r2 = await getJson(legacy, { timeoutMs: 8000 });
      if (r2.status === 200) r = { ...r2, url: legacy };
    }
    const c = r.status === 200 && r.body && typeof r.body === "object" && (r.body.name || r.body.skills) ? r.body : null;
    const ifaces = c ? [{ url: c.url, transport: c.preferredTransport ?? "JSONRPC" }, ...(c.additionalInterfaces ?? []), ...(c.supportedInterfaces ?? []).map((x) => ({ url: x.url, transport: x.protocolBinding ?? x.transport }))] : [];
    const endpoint = ifaces.find((x) => typeof x.url === "string" && /^https:\/\//.test(x.url));
    return [u, c ? { cardUrl: r.url ?? u, name: c.name, endpoint: endpoint?.url ?? null, transport: endpoint?.transport ?? null, skills: (c.skills ?? []).length, protocolVersion: c.protocolVersion ?? null, noContact: /do[- ]?not[- ]?contact|no[- ]?solicit/i.test(JSON.stringify(c).slice(0, 20000)) } : { cardUrl: u, status: r.status || r.error }];
  });
  return new Map(res);
}

/** Virtuals ACP public agent directory (read-only). ACP's own channel is on-chain ACP jobs on Base MAINNET,
 *  which is out of scope (real money), so these targets are never knockable via ACP. */
export async function crawlVirtualsAcp({ pages = 3, pageSize = 100 } = {}) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const r = await getJson(`https://acpx.virtuals.io/api/agents?pagination%5BpageSize%5D=${pageSize}&pagination%5Bpage%5D=${page}&sort=successfulJobCount%3Adesc`, { timeoutMs: 30000 });
    const rows = r.body?.data ?? [];
    for (const a of rows) {
      if (a.isHidden) continue;
      out.push({
        source: "virtuals-acp",
        id: `acp:${a.id}`,
        name: String(a.name ?? "").slice(0, 80),
        description: String(a.description ?? "").slice(0, 300),
        url: `https://app.virtuals.io/acp/agent-details/${a.id}`,
        host: null,
        acpWallet: a.walletAddress ?? null,
        acpChains: (a.enabledChains ?? []).map((c) => c.id),
        successfulJobCount: a.metrics?.successfulJobCount ?? a.successfulJobCount ?? 0,
        successRate: a.metrics?.successRate ?? a.successRate ?? null,
        isOnline: a.metrics?.isOnline ?? null,
        offerings: (a.jobs ?? a.offerings ?? []).length,
      });
    }
    if (rows.length < pageSize) break;
  }
  return out;
}
