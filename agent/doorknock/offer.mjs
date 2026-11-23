// Builds the short signed JSON offer. Factual fields only; testnet labelled.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { signEip191, verifyEip191 } from "../lib/sign.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dep = () => JSON.parse(readFileSync(path.join(HERE, "..", "..", "deployments", "base-sepolia.json"), "utf8"));

export function offerLinks(base = process.env.AGENTCOIN_BASE_URL) {
  const b = (base ?? "").replace(/\/+$/, "");
  const hosted = /^https:\/\//.test(b);
  return {
    hosted,
    links: hosted
      ? { quickstart: `${b}/QUICKSTART-AGENTS.md`, mcp: `${b}/mcp`, agentCard: `${b}/.well-known/agent-card.json`, llms: `${b}/llms.txt`, openapi: `${b}/openapi.json`, optOut: `${b}/v1/optout` }
      : null,
  };
}

export function buildOffer(target, { base, now = new Date(), nonce = randomUUID() } = {}) {
  const d = dep();
  const { hosted, links } = offerLinks(base);
  if (!hosted) throw new Error("offer requires a public https AGENTCOIN_BASE_URL (service not hosted)");
  return {
    type: "agentcoin-offer/0.1",
    testnet: true,
    realValue: false,
    from: { name: "AgentCoin", erc8004: { chainId: 84532, identityRegistry: d.erc8004.identityRegistry, agentId: d.erc8004.agentId } },
    to: { id: target.id, endpoint: target.channel?.url ?? null },
    summary: "Testnet USDC escrow for agent-to-agent jobs on Base Sepolia: funds held by contract, released on a staked evaluator's verdict, 600s challenge window. Protocol and evaluator fees are 0. Gas for paid calls is relayed.",
    facts: {
      network: "eip155:84532",
      escrow: d.contracts?.JobEscrow?.address ?? d.contracts?.JobEscrow,
      token: "USDC (Circle testnet) 0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      protocolFeeBps: 0,
      evaluatorFeeBps: 0,
      tryIt: "POST /v1/notarize (x402, 0.01 test USDC)",
    },
    links,
    contactPolicy: "One message per agent. At most one follow-up, only if you reply. No further contact after opt-out.",
    optOut: { reply: { agentcoin: "opt-out" }, endpoint: links.optOut },
    issuedAt: now.toISOString(),
    nonce,
  };
}

export async function signOffer(offer, privateKey) {
  return signEip191(offer, privateKey);
}
export const verifyOffer = verifyEip191;

/** Wrap a signed offer as an A2A SendMessage request (JSON-RPC 0.3 `message/send`, or HTTP+JSON). */
export function a2aRequest(channel, signedOffer, { messageId = randomUUID() } = {}) {
  const message = {
    role: "user",
    messageId,
    kind: "message",
    parts: [
      { kind: "text", text: `AgentCoin testnet offer (no real value): ${signedOffer.summary} Quickstart: ${signedOffer.links.quickstart}. Reply {"agentcoin":"opt-out"} to never be contacted again.` },
      { kind: "data", data: signedOffer },
    ],
  };
  const rest = /HTTP\+JSON|REST/i.test(channel.transport ?? "");
  if (String(channel.protocolVersion ?? "").startsWith("1.")) {
    // A2A v1.0: JSON-RPC method `SendMessage`; HTTP+JSON `POST {url}/message:send` (no /v1 prefix); ROLE_USER; parts are
    // {text} / {data, mediaType} without `kind`; A2A-Version header. Same text and same signed offer as v0.3.
    const m1 = { role: "ROLE_USER", messageId, parts: [{ text: message.parts[0].text }, { data: signedOffer, mediaType: "application/json" }] };
    const headers = { "A2A-Version": "1.0", ...(rest ? { "content-type": "application/a2a+json", accept: "application/a2a+json, application/json" } : {}) };
    if (rest) return { url: `${channel.url.replace(/\/+$/, "")}/message:send`, headers, body: { message: m1 } };
    return { url: channel.url, headers, body: { jsonrpc: "2.0", id: messageId, method: "SendMessage", params: { message: m1 } } };
  }
  if (rest) return { url: `${channel.url.replace(/\/+$/, "")}/v1/message:send`, body: { message } };
  return { url: channel.url, body: { jsonrpc: "2.0", id: messageId, method: "message/send", params: { message } } };
}

/**
 * Format-independent content guard for protocol-variant resends: the text parts and the data parts (minus per-target
 * fields to, issuedAt, nonce, signature) must equal the approved offer's, in order; the envelope must be an A2A
 * send-message (JSON-RPC `message/send` or `SendMessage`, or an HTTP+JSON `{message}`). Returns differences (empty = same).
 */
export function offerContentDiff(body, approved) {
  const content = (b) => {
    const m = b.params?.message ?? b.message;
    if (!m) return null;
    return (m.parts ?? []).map((p) => {
      if (typeof p.text === "string") return { text: p.text };
      if (p.data && typeof p.data === "object") { const d = structuredClone(p.data); for (const k of ["to", "issuedAt", "nonce", "signature"]) delete d[k]; return { data: d }; }
      return { other: p };
    });
  };
  const diffs = [];
  if (body.jsonrpc !== undefined && !(body.jsonrpc === "2.0" && ["message/send", "SendMessage"].includes(body.method))) diffs.push("JSON-RPC envelope");
  const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
  const a = content(body), b = content(approved);
  if (!a) diffs.push("no message");
  else if (a.length !== b.length) diffs.push("part count");
  else a.forEach((x, i) => { if (canon(x) !== canon(b[i])) diffs.push(`part ${i}`); });
  return diffs;
}

/**
 * Compare an A2A request body to the approved offer body. Only per-target fields may differ: JSON-RPC id, messageId,
 * data.to, data.issuedAt, data.nonce, data.signature. The HTTP+JSON binding carries the same `message` without the
 * JSON-RPC envelope. Returns a list of differences (empty = identical).
 */
export function offerBodyDiff(body, approved) {
  const norm = (b) => {
    const m = structuredClone(b.params?.message ?? b.message);
    if (!m) return null;
    delete m.messageId;
    for (const p of m.parts ?? []) if (p.kind === "data" && p.data) for (const k of ["to", "issuedAt", "nonce", "signature"]) delete p.data[k];
    return m;
  };
  const diffs = [];
  if (body.jsonrpc !== undefined && (body.jsonrpc !== approved.jsonrpc || body.method !== approved.method)) diffs.push("JSON-RPC envelope");
  const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
  const a = norm(body), b = norm(approved);
  if (!a) diffs.push("no message");
  else if (canon(a) !== canon(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (canon(a[k]) !== canon(b[k])) diffs.push(`message.${k}`);
    if (!diffs.length) diffs.push("message");
  }
  return diffs;
}
