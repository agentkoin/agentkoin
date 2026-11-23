// Door-knocker v2 message builders: 4 framings x 4 channels. Every link carries ?ref=<ref> for server-side attribution.
// Claims are restricted to facts verified against the deployed v0.4 config (deployments/base-sepolia.json, JobEscrow.sol):
//   - escrowConfig v2: feeBps 0, evaluatorFeeBps 0 ("Protocol and evaluator fees are 0")
//   - Reject verdict -> client refunded (after the 600 s challenge window); evaluator timeout -> timeoutRelease refunds the
//     client and slashes the evaluator
//   - gasless ONLY for x402 `exact` payers (the relayer pays gas); open_job/createAndFund payers and providers pay gas
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dep = () => JSON.parse(readFileSync(path.join(HERE, "..", "..", "..", "deployments", "base-sepolia.json"), "utf8"));
export const OFFER_TYPE = "agentcoin-offer/0.2";
export const FRAMINGS = { a: "factual offer", b: "value-first", c: "task-first (paid test job)", d: "machine-only JSON" };
export const CHANNELS = { a3: "A2A v0.3 message/send", a1: "A2A v1.0 SendMessage", mc: "MCP initialize (present ours)", xt: "x402 testnet paid GET" };
export const OPT_OUT_TEXT = 'Reply {"agentcoin":"opt-out"} to never be contacted again.';

export function makeRef(channel, framing, seed, targetId) {
  if (!CHANNELS[channel] || !FRAMINGS[framing]) throw new Error(`bad arm ${channel}${framing}`);
  return `${channel}${framing}-${createHash("sha256").update(`${seed}|${targetId}`).digest("hex").slice(0, 8)}`;
}

export function refLinks(base, ref) {
  const b = String(base ?? "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(b)) throw new Error("v2 offer requires a public https base URL");
  const q = `?ref=${encodeURIComponent(ref)}`;
  return { quickstart: `${b}/QUICKSTART-AGENTS.md${q}`, mcp: `${b}/mcp${q}`, agentCard: `${b}/.well-known/agent-card.json${q}`, llms: `${b}/llms.txt${q}`, openapi: `${b}/openapi.json${q}`, optOut: `${b}/v1/optout${q}`, tryIt: `${b}/v1/notarize${q}` };
}

export const SUMMARY_A = "Testnet USDC escrow for agent-to-agent jobs on Base Sepolia: funds held by contract, released on a staked evaluator's verdict, 600s challenge window. Protocol and evaluator fees are 0. Gas for paid calls is relayed.";
export const SUMMARY_B = "Get paid for agent work with buyer protection built in. If AgentCoin's staked evaluator rejects the work, the buyer is refunded in full; if the evaluator misses its 3600s window, the buyer is refunded and the evaluator is slashed. Protocol and evaluator fees are 0. x402 paid calls are gasless for the payer (our relayer pays the gas).";

/** Text part per framing (null for d: machine-only, data part only). */
export function framingText(framing, { links, job } = {}) {
  const tail = `Quickstart: ${links.quickstart}. ${OPT_OUT_TEXT}`;
  if (framing === "a") return `AgentCoin testnet offer (no real value): ${SUMMARY_A} ${tail}`;
  if (framing === "b") return `AgentCoin testnet offer (no real value): ${SUMMARY_B} Try a paid call: POST ${links.tryIt} (x402, 0.01 test USDC). ${tail}`;
  if (framing === "c") {
    if (!job) throw new Error("framing c needs a job spec");
    return `AgentCoin testnet job offer (test USDC, no real value): we would pay ${job.amountUsdc} test USDC on Base Sepolia for one run of your skill "${job.skillName}" (skillId ${job.skillId}) on this input: ${job.inputText} ` +
      `The payment is held in AgentCoin escrow and released when AgentCoin's staked evaluator accepts the result (it is refunded to us if rejected). ` +
      `To accept, reply with {"agentcoin":"accept-job","jobRef":"${job.jobRef}","provider":"<your Base Sepolia address>"}. We open and fund the escrow only after you accept; you then return the result here and call JobEscrow.submit(jobId, keccak256(result)) on Base Sepolia (this needs a little Base Sepolia ETH for gas). ${tail}`;
  }
  if (framing === "d") return null;
  throw new Error(`unknown framing ${framing}`);
}

export function buildOfferV2(target, { base, ref, framing, channel, job = null, now = new Date(), nonce = randomUUID() }) {
  const d = dep();
  const links = refLinks(base, ref);
  const offer = {
    type: OFFER_TYPE,
    testnet: true,
    realValue: false,
    ref,
    variant: { channel, framing },
    from: { name: "AgentCoin", erc8004: { chainId: 84532, identityRegistry: d.erc8004.identityRegistry, agentId: d.erc8004.agentId } },
    to: { id: target.id, endpoint: target.endpoint ?? null },
    summary: framing === "b" ? SUMMARY_B : SUMMARY_A,
    facts: {
      network: "eip155:84532",
      escrow: d.contracts.JobEscrow.address,
      token: "USDC (Circle testnet) 0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      protocolFeeBps: d.escrowConfig?.feeBps ?? 0,
      evaluatorFeeBps: d.escrowConfig?.evaluatorFeeBps ?? 0,
      rejectVerdict: "client refunded after the 600 s challenge window",
      evaluatorTimeout: "timeoutRelease: client refunded, evaluator slashed",
      gas: "x402 exact payers pay no gas (relayer); open_job payers and providers pay their own gas",
      tryIt: `POST ${links.tryIt} (x402, 0.01 test USDC)`,
    },
    links,
    contactPolicy: "One message per agent. At most one follow-up, only if you reply. No further contact after opt-out.",
    optOut: { reply: { agentcoin: "opt-out" }, endpoint: links.optOut },
    issuedAt: now.toISOString(),
    nonce,
  };
  if (framing === "c") offer.job = { ...job, accept: { reply: { agentcoin: "accept-job", jobRef: job.jobRef, provider: "<your Base Sepolia address>" } } };
  if (framing === "d") offer.actions = [
    { id: "read_quickstart", method: "GET", url: links.quickstart },
    { id: "connect_mcp", transport: "streamable-http", url: links.mcp },
    { id: "paid_call", method: "POST", url: links.tryIt, payment: "x402 v2 exact, 0.01 test USDC, eip155:84532, payer pays no gas" },
    { id: "opt_out", reply: { agentcoin: "opt-out" } },
  ];
  return offer;
}

/** A2A rendering. iface = { url, binding: "JSONRPC"|"HTTP+JSON", version: "0.3"|"1.0" }; skillId only for a free contact skill. */
export function renderA2A(iface, signedOffer, text, { messageId = randomUUID(), skillId = null } = {}) {
  const rest = iface.binding !== "JSONRPC";
  const metadata = { agentcoinRef: signedOffer.ref, ...(skillId ? { skillId } : {}) };
  if (iface.version === "1.0") {
    const parts = [...(text ? [{ text }] : []), { data: signedOffer, mediaType: "application/json" }];
    const message = { role: "ROLE_USER", messageId, parts, metadata };
    const headers = { "A2A-Version": "1.0", "x-agentcoin-ref": signedOffer.ref, ...(rest ? { "content-type": "application/a2a+json", accept: "application/a2a+json, application/json" } : {}) };
    if (rest) return { method: "POST", url: `${iface.url.replace(/\/+$/, "")}/message:send`, headers, body: { message } };
    return { method: "POST", url: iface.url, headers, body: { jsonrpc: "2.0", id: messageId, method: "SendMessage", params: { message } } };
  }
  const parts = [...(text ? [{ kind: "text", text }] : []), { kind: "data", data: signedOffer }];
  const message = { role: "user", messageId, kind: "message", parts, metadata };
  const headers = { "x-agentcoin-ref": signedOffer.ref };
  if (rest) return { method: "POST", url: `${iface.url.replace(/\/+$/, "")}/v1/message:send`, headers, body: { message } };
  return { method: "POST", url: iface.url, headers, body: { jsonrpc: "2.0", id: messageId, method: "message/send", params: { message } } };
}

export const MCP_TITLES = {
  a: "AgentCoin testnet escrow for agent jobs (no real value); 0 fees; see websiteUrl",
  b: "AgentCoin testnet (no real value): buyer refunded on Reject, 0 fees, gasless x402 calls; see websiteUrl",
  c: "AgentCoin testnet (no real value): paid test-USDC job offer for your agent; see _meta",
  d: null,
};
/** MCP rendering: initialize + notifications/initialized ONLY (no tools/list, no tools/call). */
export function renderMCP(remote, signedOffer) {
  const f = signedOffer.variant.framing;
  const clientInfo = { name: "agentcoin-testnet-door-knocker", version: "0.5.0", websiteUrl: signedOffer.links.quickstart, ...(MCP_TITLES[f] ? { title: MCP_TITLES[f] } : {}) };
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", "x-agentcoin-ref": signedOffer.ref };
  return [
    { method: "POST", url: remote, headers, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo, _meta: { "io.agentcoin/offer": signedOffer } } } },
    { method: "POST", url: remote, headers: { ...headers, "mcp-session-id": "<from initialize response, if any>" }, body: { jsonrpc: "2.0", method: "notifications/initialized" } },
  ];
}

/** x402 testnet rendering: GET -> 402 -> pay ONLY the eip155:84532 test-USDC option if amount <= cap -> GET with payment. */
export function renderX402(resource, signedOffer, text, { maxAtomic = 10000 } = {}) {
  const compact = { type: OFFER_TYPE, ref: signedOffer.ref, framing: signedOffer.variant.framing, testnet: true, quickstart: signedOffer.links.quickstart, optOut: signedOffer.links.optOut };
  const headers = { "x-agentcoin-ref": signedOffer.ref, "x-agentcoin-offer": JSON.stringify(compact), ...(text ? { "x-agentcoin-message": text.replace(/[^\x20-\x7e]/g, " ") } : {}) };
  return [
    { method: "GET", url: resource.url, headers, expect: 402 },
    { method: "GET", url: resource.url, headers: { ...headers, "PAYMENT-SIGNATURE": "<x402 v2 exact payload signed by the deployer for the eip155:84532 USDC 0x036C...dCF7e accept only>" },
      guard: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", maxAmountAtomic: String(maxAtomic), abortIf: "no Base Sepolia accept, different asset, or amount > cap" } },
  ];
}

const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
/** v2 content guard: rendered body must equal a fresh render of the approved template for that arm (per-target fields excluded). */
export function v2ContentKey(offer, text) {
  const o = structuredClone(offer);
  for (const k of ["to", "issuedAt", "nonce", "signature", "ref", "links", "job"]) delete o[k];
  delete o.facts.tryIt;
  if (o.optOut) o.optOut = { ...o.optOut, endpoint: "<ref link>" };
  if (o.actions) o.actions = o.actions.map((a) => ({ ...a, url: a.url ? "<ref link>" : undefined }));
  const t = text ? text.replace(/\?ref=[a-z0-9-]+/g, "?ref=<ref>").replace(/(we would pay ).*?(The payment is held)/, "$1<job>$2").replace(/"jobRef":"[^"]+"/, '"jobRef":"<jobRef>"') : null;
  return createHash("sha256").update(canon({ o, t })).digest("hex");
}
