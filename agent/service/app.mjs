#!/usr/bin/env node
// AgentCoin public TESTNET service (one process). Base Sepolia only when AGENTCOIN_NETWORK=base-sepolia; test USDC,
// no real value. Binds 127.0.0.1 (put a tunnel / reverse proxy in front; set TRUST_PROXY=1 behind one).
//  - x402 paid endpoint POST /v1/notarize (0.01 test USDC): payment is routed into JobEscrow (EscrowDepositRoute).
//    The service returns an operator-signed timestamp receipt whose keccak256(RFC8785) is submitted on chain as the
//    escrow deliverableHash; a background evaluator checks the hash, issues the verdict and finalizes after the
//    challenge window.
//  - hosted facilitator /facilitator/{supported,verify,settle} (relayer pays gas; restricted to AgentCoin routes)
//  - remote MCP over streamable HTTP at /mcp (stateless), same tools as the stdio server
//  - discovery docs: /QUICKSTART-AGENTS.md, /llms.txt, /openapi.json, /.well-known/*, /discovery/resources
//  - /v1/faucets (pointers only), /v1/stats (anonymous), /v1/caps
// Every JSON object response carries the VALUE_LABEL fields (testnet/realValue) and an X-AgentCoin-Testnet header.
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { keccak256, toBytes, getAddress, parseEventLogs, isHex, erc20Abi as erc20AbiViem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { contracts, wallet, send, sendIdempotent, read, publicClient, assertChain, rawLogsChunked } from "../lib/chain.mjs";
import { loadStakeScanCache, saveStakeScanCache, freshness, DEFAULT_STAKE_SCAN_TTL_MS } from "../lib/stake-scan-cache.mjs";
import { knownEvaluators, evaluatorCandidates, evaluatorRow, SELECTION_TEXT, accumulateTrackRecords, shouldCacheEvaluatorList, shouldAwaitJobIndex, listNeedsFreshScan, evaluatorListCacheValid } from "../lib/evaluators.mjs";
import { ProfileStore, CanaryQueue, handleProfile, handleCanary, fullRow, onboardingBlock, stakeStatus, foldStakeEvents } from "../lib/evaluator-onboarding.mjs";
import { SITE_ROUTES, sitePageHtml, sitePageMachine, negotiate, linkHeader, liveTiles } from "./site.mjs";
import { wantsHtml, landingHtml, privacyHtml, privacyDraftHtml, risksHtml, SITE, readBrand, BRAND_FILES, readJob, JOB_FILES, readFont, FONT_FILES, receiptJob } from "./landing.mjs";
import { AGENT_DIR, ROOT, CHAIN_ID, STATES, TOKEN_EIP712, ABI, ARTIFACTS_DIR, NETWORK, PUBLIC_BASE_URL, VALUE_LABEL, roleKey } from "../lib/config.mjs";
import { quote, evaluatorSnapshot, jobStatus, refreshEscrowArbitrator } from "../lib/protocol.mjs";
import { evaluatorReputation } from "../lib/indexer.mjs";
import { verifyDocument } from "../lib/verify.mjs";
import { jcs } from "../lib/canonical.mjs";
import { parseCriteriaParams, parseDeliverableId, criteriaOffer, criteriaBytes, deliverableBytes, deliverableSha256, CRITERIA_VOCABULARY } from "../lib/criteria.mjs";
import { signEip191, verifyEip191 } from "../lib/sign.mjs";
import { withEscrowHint } from "../../integrations/x402-escrow-hint/index.mjs";
import { operatorKey } from "../lib/keys.mjs";
import { checkExactAuthorization } from "../x402/server.mjs";
import { payaiEnabled, payaiVerify } from "../x402/payai.mjs";
import { findUsdcTransferToRoute, jobCreatedFromReceipt, depositAttestedFromReceipt, attachedTxHashes } from "../x402/route-deposit.mjs";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { Caps } from "./caps.mjs";
import { NOTARY_RESPONSE_SCHEMA, NOTARY_RESPONSE_SCHEMA_JCS, NOTARY_RESPONSE_SCHEMA_HASH } from "../lib/notary-schema.mjs";
import { Stats, parseRef, classifyPayers, parseDemoBuyers } from "./stats.mjs";
import { EscrowJobIndex, DEFAULT_ESCROWS, knownInternalAddresses } from "./escrow-stats.mjs";
import { Router, RouterError, makeFetchDoc } from "../router/router.mjs";
import { routerTools } from "../router/tools.mjs";
import { Exchange, ExchangeError, exchangeFee } from "../exchange/exchange.mjs";
import { OpenJobs } from "../exchange/openjobs.mjs";
import { Beta } from "../exchange/beta.mjs";
import { OrderIntents } from "../exchange/orderintent.mjs";
import { makeExchangeHttp } from "../exchange/http.mjs";
import { seedListings, runSeed, deliverableBytesOf } from "../exchange/seeds.mjs";
import { buildService } from "../router/parse.mjs";
import { OUTCOMES, NET } from "../lib/config.mjs";
import { resolveExchangeFeeRecipient, TESTNET, netCopy, netHide, JUDGE_KIT_REF, EXPLORER, ESCROW_DEFAULT, ESCROW_FEE_BPS } from "../lib/network.mjs";
import { assertNotSanctioned, sdnMatch } from "../lib/ofac.mjs";
import { headerCopy } from "../lib/header402.mjs";
import { agcConfig, agcExactRequirements, isAgcExact, orderAccepts, agcSwapEntry, agcExactPaymentRecord, agcSwapPaymentRecord, agcReserve, agcQuoteParams, AGC_ABI } from "../lib/agc.mjs";
import { multiAssetConfig, parseQuoteParams, fxQuote, QuoteBook, QuoteError, swapRequirements, slimSwapForHeader, verifySwapPayload, settlementFromReceipt, paymentRecord, paymentFromReceipt, resolveAsset, SETTLER_ABI, BASE_SEPOLIA } from "../lib/multiasset.mjs";

import { VERSION, mcpServerName, mcpServerAlias } from "../lib/version.mjs";
import { createAnchorQueue, AnchorStore, makeSdkSender, makeProxySender } from "../lib/ccd-anchor-queue.mjs";
import { DEFAULT_CCD_GRPC } from "../lib/ccd-anchor.mjs";
import { freeOffer, freeHtml, readTrust, trustPageHtml } from "../lib/pages.mjs";
import { LEGACY_JOB_HINTS } from "../lib/legacy-job-hints.mjs";
import { collect as collectProof, proofBundle, canonicalProof, fetchBytesDefault, ESCROWS as PROOF_ESCROWS } from "../lib/job-proof.mjs";
export { VERSION };
export const BRAND_ALT = "AgentKoin: two corner brackets gripping a solid square (the payment held in escrow until a verdict)";
const env = process.env;
const num = (k, d) => (env[k] !== undefined ? Number(env[k]) : d);
const big = (k, d) => (env[k] !== undefined ? BigInt(env[k]) : d);

export const CONFIG = {
  port: num("SERVICE_PORT", Number(new URL(PUBLIC_BASE_URL).port || 8402)),
  publicUrl: PUBLIC_BASE_URL.replace(/\/$/, ""),
  trustProxy: env.TRUST_PROXY === "1",
  price: big("NOTARY_PRICE", 10_000n), // 0.01 test USDC
  deadlineSeconds: num("NOTARY_DEADLINE_SECONDS", 3600),
  facilitatorMaxAmount: big("FACILITATOR_MAX_AMOUNT", 5_000_000n), // 5 test USDC
  // measured on Base Sepolia v0.3 (settle 397k + submit 71k + verdict 64k + finalize 114k gas at 0.006 gwei) ~3.9e12 wei; 2x margin
  estLifecycleWei: big("EST_LIFECYCLE_WEI", 8_000_000_000_000n),
  estSettleWei: big("EST_SETTLE_WEI", 5_000_000_000_000n),
  caps: {
    perIpPerDay: num("CAP_PER_IP_PER_DAY", 10),
    perAddressPerDay: num("CAP_PER_ADDRESS_PER_DAY", 5),
    globalPaidPerDay: num("CAP_GLOBAL_PAID_PER_DAY", 100),
    globalGasWeiPerDay: big("CAP_GLOBAL_GAS_WEI_PER_DAY", 50_000_000_000_000n), // 0.00005 ETH/day
    freePerIpPerHour: num("CAP_FREE_PER_IP_PER_HOUR", 600),
  },
  stateDir: env.SERVICE_STATE_DIR ?? path.join(AGENT_DIR, ".state", NETWORK),
  loopMs: num("SERVICE_LOOP_MS", 20_000),
  probeMs: num("ROUTER_PROBE_MS", 600_000),
  routerSeed: env.ROUTER_SEED_FILE ?? path.join(AGENT_DIR, "router", "seed", "index-seed.json.gz"),
  doNotContact: env.DO_NOT_CONTACT_FILE ?? path.join(AGENT_DIR, "doorknock", "do-not-contact.json"),
  submitPerIpPerHour: num("ROUTER_SUBMIT_PER_IP_PER_HOUR", 20),
  maxBody: 16_384,
  // idempotent retry of the notary's job writes (submit, verdict): lib/txretry.mjs
  txRetry: {
    maxAttempts: num("TX_RETRY_MAX_ATTEMPTS", 5),
    baseDelayMs: num("TX_RETRY_BASE_MS", 1000),
    maxDelayMs: num("TX_RETRY_MAX_DELAY_MS", 15_000),
    maxTotalMs: num("TX_RETRY_MAX_TOTAL_MS", 90_000),
    receiptTimeoutMs: num("TX_RETRY_RECEIPT_TIMEOUT_MS", 30_000),
    deadlineMarginS: num("TX_RETRY_DEADLINE_MARGIN_S", 30),
  },
};

const SPEC_TEXT = "agentcoin-notary/v1: JSON receipt {v, digest, note, jobId, client, settleTx, notarizedAt, chainId}; deliverableHash = keccak256(RFC8785(receipt))";
const SPEC_HASH = keccak256(toBytes(SPEC_TEXT));
const FAUCETS = [
  { asset: "USDC (test)", network: "eip155:84532", url: "https://faucet.circle.com", note: "Circle testnet faucet; select Base Sepolia. The x402 exact scheme needs only test USDC: the relayer pays gas." },
  { asset: "ETH (test, gas)", network: "eip155:84532", url: "https://docs.base.org/base-chain/tools/network-faucets", note: "List of Base Sepolia ETH faucets; needed only for direct contract calls (agentcoin-escrow scheme, challenges)." },
];

// ---------------- wallets (serialized per signer) ----------------
const keyFor = (role) => env[`AGENTCOIN_${role.toUpperCase()}_KEY`] ?? roleKey(role);
let W = null;
function wallets() {
  if (W) return W;
  W = { relayer: wallet(keyFor("relayer")), provider: wallet(keyFor("provider")), evaluator: wallet(keyFor("evaluator")) };
  try {
    W.operatorKey = operatorKey().privateKey;
  } catch {
    W.operatorKey = null; // receipts are then unsigned (the on-chain deliverableHash still anchors them)
  }
  return W;
}
// job-lifecycle writes (submit, verdict) go through the idempotent retry in lib/txretry.mjs
const txWrite = (w, c, fn, args, opts) => sendIdempotent(w, c, fn, args, { ...opts, policy: CONFIG.txRetry });
const queues = new Map();
function serial(name, fn) {
  const prev = queues.get(name) ?? Promise.resolve();
  const p = prev.then(fn, fn);
  queues.set(name, p.catch(() => {}));
  return p;
}

// AD-011 Fix 1: the service's own `evaluator` key is only the labeled reference evaluator. Buyers pick any active
// EvaluatorRegistry evaluator per job (?evaluator=<address>); the choice is bound into the exact payTo route address
// (CREATE2 over the offer) and the escrow job, so the service cannot rewrite it. With no choice the default is
// AGENTCOIN_DEFAULT_EVALUATOR if set, else the reference evaluator (keeps the v0.5.15 USDC entries byte-identical).
export const REFERENCE_EVALUATOR_LABEL = "reference evaluator (operated by STOS Technologies, testnet demo)";
export const referenceEvaluator = () => wallets().evaluator.account.address;
export const defaultEvaluator = () => (/^0x[0-9a-fA-F]{40}$/.test(String(env.AGENTCOIN_DEFAULT_EVALUATOR ?? "").trim()) ? getAddress(env.AGENTCOIN_DEFAULT_EVALUATOR.trim()) : referenceEvaluator());
export const notaryOffer = (evaluator = null, specHash = SPEC_HASH) => ({ provider: wallets().provider.account.address, evaluator: evaluator ? getAddress(evaluator) : defaultEvaluator(), amount: CONFIG.price, deadlineSeconds: BigInt(CONFIG.deadlineSeconds), specHash });
const offerJson = (o) => ({ provider: o.provider, evaluator: o.evaluator, amount: o.amount.toString(), deadlineSeconds: Number(o.deadlineSeconds), specHash: o.specHash });

// ---------------- persistent state (jobs; no personal data) ----------------
class JobStore {
  constructor(file) {
    this.file = file;
    this.jobs = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }
  get(id) {
    return this.jobs[String(id)];
  }
  put(id, v) {
    this.jobs[String(id)] = { ...(this.jobs[String(id)] ?? {}), ...v };
    this.flush();
  }
  pending() {
    // a failed job whose submit tx was broadcast but unconfirmed stays watched: tick() re-adopts it if it landed
    return Object.entries(this.jobs).filter(([, j]) => !["settled", "failed"].includes(j.status) || (j.status === "failed" && j.submitTxInFlight));
  }
  flush() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(this.jobs, null, 2));
    renameSync(this.file + ".tmp", this.file);
  }
}

// ---------------- helpers ----------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const label = (o) => (o && typeof o === "object" && !Array.isArray(o) ? { ...o, ...VALUE_LABEL } : o);
const ser = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const LABEL_HEADER = { "X-AgentCoin-Testnet": String(VALUE_LABEL.testnet), "X-AgentCoin-Real-Value": String(VALUE_LABEL.realValue) };

function send_(res, status, body, type, headers = {}) {
  res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, EXTENSION-RESPONSES, X-AgentCoin-Testnet", ...LABEL_HEADER, ...headers });
  // Base mainnet wording for service-authored copy only (text pages, 402s, allowlisted discovery JSON);
  // data endpoints and signed artifacts pass through untouched. Identity on testnets (TESTNET short-circuits).
  res.end(!TESTNET && (String(type).startsWith("text/") || status === 402 || res.__copy) ? netCopy(body) : body);
}
const COPY_ROUTES = /^\/(openapi\.json|llms\.txt|healthz|status|\.well-known\/(mcp\/server-card\.json|mcp\.json|agents\.json|agentkoin-exchange\.json)|exchange\/?|exchange\/(llms\.txt|openapi\.json|server\.json|\.well-known\/agent-card\.json|v1\/earn|v1\/stats)|v1\/(caps|faucets|notarize|notarize\/schema\.json))$/;
function sendRaw_(res, status, body, type, headers = {}) {
  res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, EXTENSION-RESPONSES, X-AgentCoin-Testnet", ...LABEL_HEADER, ...headers });
  res.end(body);
}
const json = (res, status, body, headers = {}) => send_(res, status, ser(label(body)), "application/json", headers);
const rawJson = (res, status, body, headers = {}) => sendRaw_(res, status, ser(body), "application/json", headers); // signed artifacts: never mutate

function recordOptOut(dir, match) {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "optouts.json");
  const d = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { entries: [] };
  if (!d.entries.some((e) => e.match.toLowerCase() === match.toLowerCase())) d.entries.push({ match, reason: "self-service opt-out", at: new Date().toISOString() });
  writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
}

async function readBody(req, max) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readBodyBuf(req, max) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

export function parseNotarizeInput(body) {
  let o;
  try {
    o = body ? JSON.parse(body) : {};
  } catch {
    return { error: "body must be JSON" };
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return { error: "body must be a JSON object" };
  const { sha256, data, note } = o;
  if ((sha256 === undefined) === (data === undefined)) return { error: "provide exactly one of sha256 (0x-prefixed 32-byte hex) or data (string, <= 4096 chars)" };
  if (sha256 !== undefined && !(typeof sha256 === "string" && /^0x[0-9a-fA-F]{64}$/.test(sha256))) return { error: "sha256 must be 0x + 64 hex chars" };
  if (data !== undefined && !(typeof data === "string" && data.length <= 4096)) return { error: "data must be a string of at most 4096 chars" };
  if (note !== undefined && !(typeof note === "string" && note.length <= 200)) return { error: "note must be a string of at most 200 chars" };
  const digest = sha256 !== undefined ? sha256.toLowerCase() : "0x" + Buffer.from(require_sha256(data)).toString("hex");
  return { digest, digestKind: sha256 !== undefined ? "sha256 (client-supplied)" : "sha256(utf8(data))", note: note ?? null };
}
import { createHash } from "node:crypto";
function require_sha256(s) {
  return createHash("sha256").update(s, "utf8").digest();
}

function endpointLabel(p) {
  if (p === "/v1/notarize/example" || p === "/v1/notarize/schema.json") return p;
  if (p.startsWith("/v1/notarize/")) return "/v1/notarize/{id}";
  if (p.startsWith("/v1/criteria/")) return "/v1/criteria/{hash}";
  if (p.startsWith("/v1/deliverables/")) return "/v1/deliverables/{id}";
  if (/^\/v1\/escrows\/0x[0-9a-fA-F]{40}\/jobs\/\d+\/proof$/.test(p)) return "/v1/escrows/{escrow}/jobs/{id}/proof";
  if (/^\/v1\/jobs\/\d+\/proof$/.test(p)) return "/v1/jobs/{id}/proof";
  if (p.startsWith("/v1/jobs/")) return "/v1/jobs/{id}";
  if (p.startsWith("/v1/services/")) return p.replace(/svc_[0-9a-f]+/, "{id}");
  if (p.startsWith("/v1/orders/")) return p.replace(/ord_[0-9a-f]+/, "{id}");
  if (p.startsWith("/v1/reputation/")) return "/v1/reputation/{id}";
  return p;
}
export const receiptHash = (receipt) => keccak256(toBytes(jcs(receipt)));

// ---------------- the app ----------------
export function createApp(opts = {}) {
  // Base mainnet: the Exchange fee recipient (fee Safe) is required and must not be the operator signer; refuse to start otherwise.
  const baseFeeRecipient = NETWORK === "base" ? resolveExchangeFeeRecipient({ network: NETWORK, option: opts.exchangeFeeRecipient, env, operatorAddress: wallets().operatorKey ? privateKeyToAccount(wallets().operatorKey).address : null }) : undefined;
  const cfg = { ...CONFIG, ...opts, caps: { ...CONFIG.caps, ...(opts.caps ?? {}) } };
  mkdirSync(cfg.stateDir, { recursive: true });
  refreshEscrowArbitrator().catch(() => {}); // envelope() reports the live JobEscrow.arbitrator()
  const caps = opts.capsInstance ?? new Caps(cfg.caps);
  const stats = opts.statsInstance ?? new Stats({ file: path.join(cfg.stateDir, "stats.json") });
  const jobs = new JobStore(path.join(cfg.stateDir, "jobs.json"));
  const reservations = new Map(); // jobId -> remaining reserved gas for that admitted paid call (in memory)
  const URL_ = (p) => cfg.publicUrl + p;
  const ma = opts.multiAsset ?? multiAssetConfig(env); // AD-009: swap entry only when MULTIASSET_SETTLER is set
  // AD-010: AGC entries, GET /v1/agc and AGC jobs only when AGC_ADDRESS/AGC_ESCROW/AGC_ROUTE_FACTORY/AGC_ADAPTER are set.
  const agc = opts.agc ?? agcConfig(env);
  const AGC_KEY = "agc-"; // job-store key prefix for AGC JobEscrow jobs (their ids restart at 1)
  const agcEscrowRef = () => ({ address: agc.escrow, abi: ABI.escrow });
  const isAgcEscrow = (a) => !!agc.enabled && !!a && getAddress(a) === agc.escrow;
  const jobKey = (escrowAddr, id) => (isAgcEscrow(escrowAddr) ? AGC_KEY + String(id) : String(id));
  const keyRef = (k) => (String(k).startsWith(AGC_KEY) ? { escrow: agcEscrowRef(), id: BigInt(String(k).slice(AGC_KEY.length)) } : { escrow: contracts().escrow, id: BigInt(k) });
  const escrowByAddress = (a) => (isAgcEscrow(a) ? agcEscrowRef() : contracts().escrow);
  const quoteBook = new QuoteBook();
  const chainCall = (a) => publicClient.readContract(a);
  const links = {
    quote: URL_("/v1/quote"),
    quickstart: URL_("/QUICKSTART-AGENTS.md"),
    llms: URL_("/llms.txt"),
    openapi: URL_("/openapi.json"),
    agentCard: URL_("/.well-known/agent-card.json"),
    trustManifest: URL_("/.well-known/agentcoin-trust.json"),
    registration: URL_("/.well-known/agent-registration.json"),
    mcp: URL_("/mcp"),
    mcpReadOnly: URL_("/mcp/readonly"),
    mcpServerCard: URL_("/.well-known/mcp/server-card.json"),
    optOut: URL_("/v1/optout"),
    notarize: URL_("/v1/notarize"),
    evaluators: URL_("/v1/evaluators"),
    evaluatorProfile: URL_("/v1/evaluators/profile"),
    evaluatorCanary: URL_("/v1/evaluators/canary"),
    evaluatorOnboarding: URL_("/v1/evaluators/onboarding"),
    evaluatorDocs: URL_("/EVALUATORS.md"),
    judgeKit: URL_("/EVALUATORS.md#3-run-the-judge-kit-watcher"),
    notarizeExample: URL_("/v1/notarize/example"),
    notarizeSchema: URL_("/v1/notarize/schema.json"),
    faucets: URL_("/v1/faucets"),
    stats: URL_("/v1/stats"),
    facilitator: URL_("/facilitator"),
    discovery: URL_("/discovery/resources"),
    services: URL_("/v1/services"),
    route: URL_("/v1/route"),
    orders: URL_("/v1/orders"),
    index: URL_("/.well-known/agentcoin-index.json"),
    repository: "https://github.com/agentkoin/agentkoin",
    privacy: URL_("/privacy"),
    terms: URL_("/terms"),
    trust: URL_("/trust"),
    free: URL_("/free"),
    exchange: URL_("/exchange"),
    exchangeIndex: URL_("/.well-known/agentcoin-exchange.json"),
    exchangeApi: URL_("/exchange/v1/listings"),
    exchangeLlms: URL_("/exchange/llms.txt"),
    exchangeOpenapi: URL_("/exchange/openapi.json"),
  };

  // ---- seller-side router (index + route + orders + claims + scores), SQLite in this process ----
  const internalAddrs = () => {
    const w = wallets();
    const a = [w.relayer.account.address, w.provider.account.address, w.evaluator.account.address];
    if (w.operatorKey) a.push(privateKeyToAccount(w.operatorKey).address);
    try {
      a.push(privateKeyToAccount(keyFor("deployer")).address);
    } catch {}
    for (const x of String(env.AGENTCOIN_INTERNAL_ADDRESSES ?? "").split(",")) if (/^0x[0-9a-fA-F]{40}$/.test(x.trim())) a.push(x.trim());
    for (const d of parseDemoBuyers(env.AGENTCOIN_DEMO_BUYERS)) a.push(d.address);
    return a;
  };
  const demoBuyers = () =>
    parseDemoBuyers(env.AGENTCOIN_DEMO_BUYERS).map((d) => {
      const address = getAddress(d.address);
      return { ...d, address, hasPaid: stats.payers.has(address.toLowerCase()) };
    });
  // Escrow-direct jobs (v0.5/v0.6 escrows) for /v1/stats: lazy, cached, bounded RPC reads (see escrow-stats.mjs).
  let escrowIdx = opts.escrowStatsIndex ?? null;
  const escrowStatsIndex = () => {
    if (escrowIdx) return escrowIdx;
    const primaryAddr = contracts().escrow.address;
    const defaults = DEFAULT_ESCROWS[CHAIN_ID] ?? [{ label: "escrow", address: primaryAddr, primary: true }];
    escrowIdx = new EscrowJobIndex({
      escrows: defaults.map((e) => ({ ...e, primary: e.address.toLowerCase() === primaryAddr.toLowerCase() })),
      reader: {
        jobCount: (e) => read({ address: e.address, abi: ABI.escrow }, "jobCount", []),
        getJob: async (e, id) => {
          const j = await read({ address: e.address, abi: ABI.escrow }, "getJob", [BigInt(id)]);
          return { client: j.client, evaluator: j.evaluator, state: STATES[j.state], slashBase: j.slashBase };
        },
      },
      file: path.join(cfg.stateDir, "escrow-stats-cache.json"),
      ttlMs: Number(env.AGENTCOIN_ESCROW_STATS_TTL_MS ?? 120_000),
    });
    return escrowIdx;
  };
  const escrowDirectStats = async () => {
    try {
      const idx = escrowStatsIndex();
      const p = idx.refresh();
      if (idx.source === "none") await Promise.race([p, new Promise((r) => setTimeout(r, 8000))]);
      const internal = knownInternalAddresses({ internalAddrs: [...internalAddrs(), referenceEvaluator()], knownEvaluators: knownEvaluators({ agentDir: AGENT_DIR, chainId: CHAIN_ID, env }), deploymentsDir: path.join(ROOT, "deployments") });
      const outsidePayers = [...stats.payers].filter((a) => !internal.has(a));
      return idx.snapshot({ internal, notarizeJobIds: Object.keys(jobs.jobs).filter((k) => /^\d+$/.test(k) && jobs.jobs[k].kind !== "exchange"), notarizePayers: outsidePayers });
    } catch (e) {
      return { error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160) };
    }
  };
  const chainCtx = {
    get usdc() {
      return contracts().usdc.address;
    },
    get escrow() {
      return contracts().escrow.address;
    },
    get escrowAbi() {
      return contracts().escrow.abi;
    },
    get evaluator() {
      return wallets().evaluator.account.address;
    },
    async readJob(jobId) {
      const c = contracts();
      const j = await read(c.escrow, "getJob", [BigInt(jobId)]).catch(() => null);
      if (!j || STATES[j.state] === "None") return null;
      return { state: STATES[j.state], outcome: OUTCOMES[j.outcome], client: j.client, provider: j.provider, evaluator: j.evaluator, amount: j.amount.toString(), specHash: j.specHash, deliverableHash: j.deliverableHash };
    },
    jobStatus: (id, o) => jobStatus(id, o),
    getReceipt: (hash) => publicClient.getTransactionReceipt({ hash }),
    ownerOf: async (agentId) => read(contracts().identity, "ownerOf", [BigInt(agentId)]),
    quoteFees: (amount) => quote({ amount: String(amount) }),
  };
  const router =
    opts.router ??
    new Router({
      dbFile: opts.routerDb ?? path.join(cfg.stateDir, "router.sqlite"),
      publicUrl: cfg.publicUrl,
      seedFile: cfg.routerSeed,
      optOutFiles: [cfg.doNotContact, path.join(cfg.stateDir, "optouts.json")],
      signerKey: wallets().operatorKey,
      chain: chainCtx,
      fetchDoc: opts.fetchDoc ?? makeFetchDoc(),
      agentcoinAddresses: internalAddrs(),
    });
  const submitHits = new Map(); // ip -> [timestamps] (in memory, hourly window)
  function admitSubmit(ip) {
    const t = Date.now();
    const a = (submitHits.get(ip) ?? []).filter((x) => t - x < 3600_000);
    if (a.length >= cfg.submitPerIpPerHour) return false;
    a.push(t);
    submitHits.set(ip, a);
    if (submitHits.size > 10_000) submitHits.clear();
    return true;
  }

  // ---- AgentKoin Exchange (spec agentkoin-exchange-v0.1): same SQLite file and JobEscrow as the router ----
  const readJobFull = async (id) => {
    const j = await read(contracts().escrow, "getJob", [BigInt(id)]).catch(() => null);
    if (!j || STATES[j.state] === "None") return null;
    return { state: STATES[j.state], outcome: OUTCOMES[j.outcome], client: j.client, provider: j.provider, evaluator: j.evaluator, amount: j.amount.toString(), payoutBps: Number(j.payoutBps), deadline: j.deadline.toString(), submittedAt: j.submittedAt.toString(), verdictAt: j.verdictAt.toString(), disputedAt: j.disputedAt.toString(), configVersion: Number(j.configVersion), specHash: j.specHash, deliverableHash: j.deliverableHash };
  };
  const readTrustJobs = () => {
    try {
      const b = readTrust(cfg.stateDir, "json");
      return b ? JSON.parse(b.toString("utf8")).jobs ?? [] : [];
    } catch {
      return [];
    }
  };
  // live figures for the landing page and /status: the same data the trust page and Exchange stats serve; 30 s memo; a failing source is left out
  let liveMemo = { at: 0, v: null };
  const liveSnapshot = () => {
    if (liveMemo.v && Date.now() - liveMemo.at < 30_000) return liveMemo.v;
    const v = { generatedAt: new Date().toISOString(), trustJobs: null, exchangeStats: null };
    try { v.trustJobs = readTrustJobs(); } catch { /* tile omitted */ }
    try { v.exchangeStats = exchange.stats(); } catch { /* tile omitted */ }
    liveMemo = { at: Date.now(), v };
    return v;
  };
  // landing page live parts: tiles, the receipt card (most recent settled job that passed our re-check) and the top Exchange listings; each is dropped on failure
  const landingLive = () => {
    const live = liveSnapshot();
    let listings = [];
    try { listings = exchange.search({ limit: 5 }).results ?? []; } catch { /* preview hidden */ }
    return { tiles: liveTiles(live), receipt: receiptJob(live.trustJobs), listings };
  };
  const exchangeProbeFetch = makeFetchDoc({ timeoutMs: 8000, maxBytes: 262_144, userAgent: "agentkoin-exchange/0.1 (listing endpoint probe; testnet)" });
  const exchange =
    opts.exchange ??
    new Exchange({
      db: router.db,
      chainId: CHAIN_ID,
      publicUrl: cfg.publicUrl,
      signerKey: wallets().operatorKey,
      internalAddresses: () => [...internalAddrs(), referenceEvaluator()],
      referenceEvaluator: referenceEvaluator(),
      tokenEip712: TOKEN_EIP712,
      // Exchange buyer fee terms (defaults 80 bps / 50000 = 0.8%, min 0.05 USDC): AGENTCOIN_EXCHANGE_FEE_BPS, AGENTCOIN_EXCHANGE_FEE_MIN
      feeBps: opts.exchangeFeeBps ?? (/^[0-9]{1,4}$/.test(String(env.AGENTCOIN_EXCHANGE_FEE_BPS ?? "")) ? env.AGENTCOIN_EXCHANGE_FEE_BPS : undefined),
      feeMin: opts.exchangeFeeMin ?? (/^[0-9]{1,12}$/.test(String(env.AGENTCOIN_EXCHANGE_FEE_MIN ?? "")) ? env.AGENTCOIN_EXCHANGE_FEE_MIN : undefined),
      // Escrow default (lib/network.mjs ESCROW_DEFAULT): "always" on testnets, "optin" on base; AGENTCOIN_ESCROW_DEFAULT overrides.
      escrowDefault: opts.escrowDefault ?? ESCROW_DEFAULT,
      escrowFeeBps: opts.escrowFeeBps ?? ESCROW_FEE_BPS,
      // Exchange buyer fee recipient (off-chain fee leg): AGENTCOIN_EXCHANGE_FEE_RECIPIENT, else the operator signer address
      feeRecipient: NETWORK === "base" ? baseFeeRecipient : opts.exchangeFeeRecipient ?? (/^0x[0-9a-fA-F]{40}$/.test(String(env.AGENTCOIN_EXCHANGE_FEE_RECIPIENT ?? "")) ? env.AGENTCOIN_EXCHANGE_FEE_RECIPIENT : wallets().operatorKey ? privateKeyToAccount(wallets().operatorKey).address : null),
      chain: {
        get usdc() {
          return contracts().usdc.address;
        },
        get escrow() {
          return contracts().escrow.address;
        },
        get escrowAbi() {
          return contracts().escrow.abi;
        },
        get routeFactory() {
          return contracts().routeFactory.address;
        },
        get registry() {
          return contracts().registry.address;
        },
        get identityRegistry() {
          return contracts().identity?.address ?? null;
        },
        readJob: readJobFull,
        routeFor: (o) => read(contracts().routeFactory, "routeFor", [o]),
        verifyFeeTransfer: async (hash, { from, to, min }) => {
          const rc = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
          if (!rc || rc.status !== "success") return false;
          const logs = parseEventLogs({ abi: erc20AbiViem, logs: rc.logs.filter((l) => getAddress(l.address) === getAddress(contracts().usdc.address)), eventName: "Transfer", strict: false });
          return logs.some((l) => getAddress(l.args.from) === getAddress(from) && getAddress(l.args.to) === getAddress(to) && BigInt(l.args.value) >= BigInt(min));
        },
        ...(opts.exchangeChain ?? {}),
      },
      evaluators: () => evaluatorList(),
      probe:
        opts.exchangeProbe ??
        (async (url) => {
          const t0 = performance.now();
          const r = await exchangeProbeFetch(url, { text: true });
          return { status: r.status, error: r.error ?? null, latencyMs: Math.round(performance.now() - t0) };
        }),
      erc8004Lookup:
        opts.exchangeErc8004 ??
        (async (id) => {
          const c = contracts();
          if (!c.identity?.address) return null;
          const [owner, agentWallet] = await Promise.all([read(c.identity, "ownerOf", [BigInt(id)]), read(c.identity, "getAgentWallet", [BigInt(id)]).catch(() => null)]);
          return { owner, agentWallet };
        }),
      fetchBytes: opts.exchangeFetchBytes ?? (async (url) => (await fetchBytesDefault(url)).bytes),
      trustJobs: readTrustJobs,
      isOptedOut: (endpoint, seller) => {
        try {
          return router._optedOutHost(new URL(endpoint).hostname.toLowerCase()) || router._isOptedOut({ host: new URL(endpoint).hostname.toLowerCase(), payTo: seller, wallets: [seller], endpoints: { url: endpoint } });
        } catch {
          return false;
        }
      },
      limits: { maxJobAmount: cfg.facilitatorMaxAmount, ...(opts.exchangeLimits ?? {}) },
    });
  const openJobs = (exchange.jobs ??= new OpenJobs(exchange, { evaluatorOnboarding: () => onboarding(), limits: opts.openJobLimits }));
  // beta window/credit config: AGENTCOIN_EXCHANGE_BETA_START / _END (ISO), AGENTCOIN_EXCHANGE_BETA_CREDIT (base units)
  if (!exchange.beta)
    new Beta(exchange, {
      start: opts.betaStart ?? env.AGENTCOIN_EXCHANGE_BETA_START ?? null,
      end: opts.betaEnd ?? env.AGENTCOIN_EXCHANGE_BETA_END ?? null,
      creditPerJob: opts.betaCreditPerJob ?? (/^[0-9]{1,12}$/.test(String(env.AGENTCOIN_EXCHANGE_BETA_CREDIT ?? "")) ? env.AGENTCOIN_EXCHANGE_BETA_CREDIT : null),
    });
  // EIP-712 OrderIntent for POST /exchange/v1/orders + MCP place_order (0.5.39). Unsigned orders stay accepted (deprecated) unless AGENTCOIN_EXCHANGE_REQUIRE_ORDER_INTENT=1.
  if (!exchange.intents) new OrderIntents(exchange, { require: opts.requireOrderIntent ?? env.AGENTCOIN_EXCHANGE_REQUIRE_ORDER_INTENT === "1" });
  let exchangeSeeded = false;
  async function registerExchangeSeeds() {
    if (exchangeSeeded) return;
    exchangeSeeded = true;
    const seller = wallets().provider.account.address;
    for (const l of seedListings(cfg.publicUrl)) {
      try {
        await exchange.createListing({ listing: l, seller }, { skipAuth: true });
      } catch (e) {
        console.log(JSON.stringify({ t: new Date().toISOString(), evt: "exchange-seed-failed", title: l.title, error: String(e.message).slice(0, 160) }));
      }
    }
  }
  const seedInFlight = new Set();
  /** AgentKoin seed orders: do the work, publish the deliverable bytes, submit sha256 on chain (provider wallet). */
  async function runExchangeSeed(orderId) {
    if (seedInFlight.has(orderId)) return;
    seedInFlight.add(orderId);
    try {
      const o = await exchange.refresh(orderId);
      if (o.listing_id.startsWith("oj_")) return; // open-jobs board: the claimer delivers
      const l = exchange._row(o.listing_id);
      if (l.origin !== "agentcoin" || getAddress(exchange.provider(l)) !== wallets().provider.account.address || !o.job_id || o.job?.state !== "Funded") return;
      const c = contracts();
      const blk = await publicClient.getBlock();
      const prev = exchange.deliverableBytes(orderId);
      const bytes = prev
        ? Buffer.from(prev)
        : deliverableBytesOf(
            await runSeed(o.skill_id, o.input, { jobId: o.job_id, client: o.buyer, blockTimestamp: blk.timestamp, escrow: c.escrow.address, verifyJob: async (escrow, jobId) => {
              // same evidence collection + checks as the judge-kit verifier (lib/job-proof.mjs is byte-identical to judge-kit/src/verify/job-proof.mjs)
              const { evaluateChecks } = await import("../lib/job-proof.mjs");
              const ev = await collectProof({ client: publicClient, escrow: getAddress(escrow), jobId: String(jobId), hints: {}, window: NET.maxLogRange || 50000, maxCalls: 40, sourcify: false });
              if (!ev.exists) return { ok: false, passed: 0, failed: 1, skipped: 0, results: [{ id: "job-exists", status: "fail" }] };
              const results = evaluateChecks(ev);
              const failed = results.filter((r) => r.status === "fail").length;
              return { ok: failed === 0, failed, passed: results.filter((r) => r.status === "pass").length, skipped: results.filter((r) => r.status === "skip").length, results };
            } }),
          );
      const h = prev ? (await import("../exchange/exchange.mjs")).sha256Hex(bytes) : exchange.storeDeliverable(orderId, bytes);
      const jobId = BigInt(o.job_id);
      const sub = await serial("provider", () =>
        txWrite(wallets().provider, c.escrow, "submit", [jobId, h], {
          label: `exchange submit job ${o.job_id}`,
          deadline: Number(o.job.deadline),
          isDone: async () => {
            const j = await read(c.escrow, "getJob", [jobId]);
            const st = STATES[j.state];
            return { done: st !== "Funded", state: st, ours: st !== "Funded" && String(j.deliverableHash).toLowerCase() === h };
          },
        }),
      );
      exchange.setTx(orderId, "submit", sub.hash ?? null);
      stats.inc("exchangeSeedSubmits");
      afterDeliverable(orderId, { submitTx: sub.hash ?? null });
      await exchange.refresh(orderId).catch(() => {});
    } catch (e) {
      console.log(JSON.stringify({ t: new Date().toISOString(), evt: "exchange-seed-error", orderId, error: String(e.shortMessage ?? e.message).slice(0, 200) }));
    } finally {
      seedInFlight.delete(orderId);
    }
  }
  function afterFunding(orderId) {
    runExchangeSeed(orderId).catch(() => {});
  }
  /** Reference-evaluator jobs enter the background loop (verdict by machine checks, then finalize). */
  function afterDeliverable(orderId, { submitTx = null } = {}) {
    try {
      const o = exchange._order(orderId);
      if (!o.job_id || getAddress(o.evaluator) !== referenceEvaluator() || getAddress(o.escrow) !== contracts().escrow.address) return;
      if (jobs.get(o.job_id) && jobs.get(o.job_id).kind !== "exchange") return;
      jobs.put(o.job_id, { kind: "exchange", exchange: { orderId, listingId: o.listing_id }, status: "submitted", payer: o.buyer, settleTx: o.txs.fund ?? null, ...(submitTx ? { submitTx } : {}), deliverableHash: o.deliverable_hash, createdAt: Date.now() });
    } catch {}
  }
  /** x402 hire: no PAYMENT-SIGNATURE -> 402; valid EIP-3009 for the listing route -> relayer settle -> funded order. */
  async function exchangeHireX402({ listingId = null, skillId = null, evaluator = null, input = null, paymentSignature = null, orderId = null, ip = null, buyer = null }) {
    const buyerHint = buyer && /^0x[0-9a-fA-F]{40}$/.test(String(buyer)) ? getAddress(buyer) : null;
    let order = null;
    if (orderId) {
      order = exchange._order(orderId);
      if (order.job_id) throw new ExchangeError(409, "order already funded", { jobId: order.job_id });
      ({ listing_id: listingId, skill_id: skillId, evaluator, input } = order);
    }
    let offer, reqs, resource, provider, evAddr;
    if (order && listingId.startsWith("oj_")) {
      // open-jobs board order: provider = claimer, evaluator/amount/spec fixed at claim time
      const jr = openJobs._sync(openJobs._row(listingId));
      if (jr.status !== "claimed" || jr.order_id !== order.id) throw new ExchangeError(409, `claim for this order is no longer active (open job ${jr.status})`);
      offer = exchange.orderOffer(order);
      reqs = await exchange.requirementsFor(offer, { openJobId: listingId, orderId: order.id, skillId: "task", buyer: order.buyer });
      resource = { url: URL_(`/exchange/v1/orders/${order.id}/pay`), description: `AgentKoin Exchange open job ${listingId}: USDC escrow job judged by ${offer.evaluator} (testnet)`, mimeType: "application/json" };
    } else {
      const r = exchange._row(listingId);
      if (r.status !== "active") throw new ExchangeError(409, `listing is ${r.status}`);
      const skill = exchange._skill(r, skillId);
      exchange._input(input, skill);
      skillId = skill.skill_id;
      const ev = await exchange.selectEvaluator(r, skill, { evaluator });
      offer = exchange.offer(r, skill, ev.address);
      reqs = await exchange.exactRequirements(r, skill, ev.address, order?.buyer ?? buyerHint);
      resource = { url: URL_(`/exchange/v1/listings/${r.id}/hire?skill=${encodeURIComponent(skill.skill_id)}`), description: `AgentKoin Exchange hire ${r.id}/${skill.skill_id}: USDC escrow job judged by ${ev.address} (testnet)`, mimeType: "application/json" };
    }
    provider = getAddress(offer.provider);
    evAddr = getAddress(offer.evaluator);
    // 402 shows the fee for the known buyer (order buyer or ?buyer=), else the list fee; re-quoted for the actual payer below
    const feeReq = order?.buyer || buyerHint ? exchange.feeRequirement(offer.amount, order?.buyer ?? buyerHint) : exchange.feeRequirement(offer.amount);
    const pr = (reason) => ({ x402Version: 2, error: reason, resource, accepts: [reqs], ...(feeReq ? { extensions: { "agentkoin-exchange-fee": { info: { ...reqs.extra.agentcoin.exchangeFee, rule: exchange.fees().exchangeFee.rule }, schema: "PAYMENT-SIGNATURE payload.feeAuthorization = {signature, authorization} for the fee requirement (EIP-3009 to the fee recipient), next to payload.authorization for accepts[0]" } } } : {}) });
    if (!paymentSignature) {
      stats.inc("exchange402");
      return { status: 402, body: pr("PAYMENT-SIGNATURE header is required") };
    }
    let pp;
    try {
      pp = typeof paymentSignature === "string" ? unb64(paymentSignature) : paymentSignature;
    } catch {
      throw new ExchangeError(400, "PAYMENT-SIGNATURE is not base64 JSON");
    }
    if (pp?.accepted?.scheme && pp.accepted.scheme !== "exact") throw new ExchangeError(400, "Exchange hire supports accepted.scheme exact");
    const v = await verifyExactFull(pp, reqs);
    if (!v.isValid) return { status: 402, body: pr(v.invalidReason) };
    // fee leg: a second EIP-3009 authorization from the same payer to the fee recipient (checked before anything is submitted)
    // The fee is re-quoted for the actual payer: the beta waiver (opted-in, window active) and fee credits can lower it or make it 0.
    let feePP = null;
    const payerFeeReq = exchange.feeRequirement(offer.amount, getAddress(v.payer));
    if (payerFeeReq) {
      const feeReq = payerFeeReq;
      const fa = pp?.payload?.feeAuthorization;
      if (!fa?.authorization || !fa?.signature) return { status: 402, body: pr(`exchange fee authorization missing: sign EIP-3009 for ${feeReq.amount} to ${feeReq.payTo} as payload.feeAuthorization`) };
      feePP = { x402Version: 2, accepted: feeReq, payload: { signature: fa.signature, authorization: fa.authorization } };
      const fv = await verifyExactFull(feePP, feeReq);
      if (!fv.isValid) return { status: 402, body: pr(`fee authorization: ${fv.invalidReason}`) };
      if (getAddress(fv.payer) !== getAddress(v.payer)) return { status: 402, body: pr("fee authorization must be from the same payer") };
      if (fa.authorization.nonce === pp.payload.authorization.nonce) return { status: 402, body: pr("fee authorization needs its own nonce") };
      const bal = await read(contracts().usdc, "balanceOf", [getAddress(v.payer)]);
      if (bal < BigInt(reqs.amount) + BigInt(feeReq.amount)) return { status: 402, body: pr("insufficient_funds for price + fee") };
    }
    if (getAddress(v.payer) === provider) throw new ExchangeError(422, "buyer cannot be the provider");
    if (getAddress(v.payer) === evAddr) throw new ExchangeError(422, "buyer cannot be the evaluator");
    if (order && listingId.startsWith("oj_") && getAddress(v.payer) !== getAddress(order.buyer)) throw new ExchangeError(422, "open jobs are funded by the posting buyer");
    const adm = caps.admitPaid(ip, v.payer, cfg.estLifecycleWei);
    if (!adm.ok) {
      stats.inc("capRejections");
      return { status: 429, body: { error: adm.reason, caps: caps.snapshot() } };
    }
    let st;
    try {
      st = await relayedSettle(offer, pp, adm.reservation);
    } catch (e) {
      caps.release(adm.reservation, { ip, payer: v.payer });
      return { status: 502, body: { error: "settle failed (authorization not consumed if the tx reverted)", detail: String(e.shortMessage ?? e.message).slice(0, 300) } };
    }
    // escrow first (the job value), then the fee leg; a failed fee leg is recorded (txs.fee null) and logged, not retried silently
    let feeTx = null;
    if (feePP) {
      try {
        const au = feePP.payload.authorization;
        const c = contracts();
        const t = await serial("relayer", () => send(wallets().relayer, c.usdc, "transferWithAuthorization", [getAddress(au.from), getAddress(au.to), BigInt(au.value), BigInt(au.validAfter), BigInt(au.validBefore), au.nonce, feePP.payload.signature]));
        caps.spend(t.costWei, adm.reservation);
        feeTx = t.hash;
        stats.inc("exchangeFeeLegs");
      } catch (e) {
        stats.inc("exchangeFeeLegFailures");
        console.log(JSON.stringify({ t: new Date().toISOString(), evt: "exchange-fee-leg-failed", jobId: String(st.jobId), payer: st.payer, error: String(e.shortMessage ?? e.message).slice(0, 200) }));
      }
    }
    stats.payer(st.payer);
    stats.inc("exchangeHires");
    reservations.set(String(st.jobId), adm.reservation);
    const fund = { jobId: st.jobId.toString(), paymentTx: st.transaction, feeTx, feeVerified: true, feePaid: feePP ? feePP.payload.authorization.value : "0" };
    const view = order ? await exchange.recordFunding(order.id, { ...fund, payer: st.payer }) : await exchange.createFunded({ listing_id: listingId, skill_id: skillId, evaluator: evAddr, buyer: st.payer, input, ...fund, channel: "x402" });
    if (feePP && !feeTx) exchange.setTx(view.order_id, "feeLegFailed", true);
    if (order && listingId.startsWith("oj_")) openJobs._sync(openJobs._row(listingId));
    afterFunding(view.order_id);
    return { status: 201, body: view, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: st.transaction, network: `eip155:${CHAIN_ID}`, payer: st.payer, jobId: st.jobId.toString(), ...(feePP ? { feeTransaction: feeTx, fee: feePP.payload.authorization.value } : {}), ...VALUE_LABEL }) } };
  }

  // criteria mode (opt-in): the default entries above, re-bound to the sha256 criteria specHash (payTo is offer-bound)
  async function exactRequirementsCrit(ev, crit) {
    const base = await exactRequirements(ev);
    const o = notaryOffer(ev, crit.specHash);
    const payTo = await read(contracts().routeFactory, "routeFor", [o]);
    return { ...base, payTo, extra: { ...base.extra, agentcoin: { ...base.extra.agentcoin, offer: offerJson(o), criteria: crit.metadata } } };
  }
  async function escrowRequirementsCrit(ev, crit) {
    const base = await escrowRequirements(ev);
    return { ...base, extra: { ...base.extra, specHash: crit.specHash, criteria: crit.metadata } };
  }
  async function exactRequirements(chosen = null) {
    const c = contracts();
    const o = notaryOffer(chosen);
    const [payTo, cfgOnchain, ev] = await Promise.all([read(c.routeFactory, "routeFor", [o]), read(c.escrow, "currentConfig"), evaluatorSnapshot(c, o.evaluator)]);
    return {
      scheme: "exact",
      network: `eip155:${CHAIN_ID}`,
      amount: cfg.price.toString(),
      asset: c.usdc.address,
      payTo,
      maxTimeoutSeconds: 300,
      extra: {
        name: TOKEN_EIP712.name,
        version: TOKEN_EIP712.version,
        assetTransferMethod: "eip3009",
        responseSchemaHash: NOTARY_RESPONSE_SCHEMA_HASH,
        responseSchemaUrl: links.notarizeSchema,
        agentcoin: {
          payToKind: "EscrowDepositRoute (CREATE2, offer-bound); settle opens an escrow job with client = authorization.from",
          depositRouteFactory: c.routeFactory.address,
          escrowContract: c.escrow.address,
          offer: offerJson(o),
          evaluatorStake: ev.stake,
          evaluatorActive: ev.active,
          feeBps: Number(cfgOnchain.feeBps),
          evaluatorFeeBps: Number(cfgOnchain.evaluatorFeeBps),
          spec: SPEC_TEXT,
          relayerPaysGas: true,
          trustManifestUrl: links.trustManifest,
        },
      },
    };
  }
  async function escrowRequirements(ev = null) {
    const c = contracts();
    const o = notaryOffer(ev);
    return {
      scheme: "agentcoin-escrow",
      network: `eip155:${CHAIN_ID}`,
      amount: cfg.price.toString(),
      asset: c.usdc.address,
      payTo: o.provider,
      maxTimeoutSeconds: 300,
      extra: { responseSchemaHash: NOTARY_RESPONSE_SCHEMA_HASH, responseSchemaUrl: links.notarizeSchema, escrowContract: c.escrow.address, evaluator: o.evaluator, specHash: SPEC_HASH, spec: SPEC_TEXT, deadlineSeconds: cfg.deadlineSeconds, schemeSpec: "payer calls escrowContract.createAndFund(provider=payTo, evaluator, amount>=price, deadline, specHash) itself (pays own gas); PAYMENT-SIGNATURE payload = {jobId, txHash}" },
    };
  }
  // ---- AD-011 Fix 1: evaluator listing (buyer's choice per job) ----
  let evList = null;
  const stakers = new Set();
  const stakeEvents = new Map(); // evaluator -> latest Staked { tx, block, timestamp, count }
  let stakerCursor = null;
  let evIndexAt = 0;
  // Track record = counts over JobEscrow.getJob(1..jobCount) (eth_call per job; terminal jobs cached), no log scans.
  const jobIndex = new Map(); // jobId -> { evaluator, state, outcome, submittedAt, verdictAt }
  const repCache = new Map(); // evaluator -> counts
  const TERMINAL = ["Settled", "Expired", "Cancelled"];
  const evCandidates = () => evaluatorCandidates({ known: knownEvaluators({ agentDir: AGENT_DIR, chainId: CHAIN_ID, env }), reference: referenceEvaluator(), referenceLabel: REFERENCE_EVALUATOR_LABEL, stakers: [...stakers] }).filter((k) => k.address !== wallets().provider.account.address);
  let fullCache = null;
  let evIndexReady = false;
  let evIndexInFlight = null;
  let evGeneration = 0; // bumped whenever a refresh completes; a list built under an older generation is never cached
  // Cold-start fix: the last completed scan is persisted in stateDir and served at boot while a single-flight
  // background refresh runs. No cache file => old behaviour (the first request awaits the live scan).
  const scanCacheFile = path.join(cfg.stateDir, "stake-scan-cache.json");
  const scanTtlMs = Number(opts.stakeScanTtlMs ?? env.AGENTCOIN_STAKE_SCAN_TTL_MS ?? DEFAULT_STAKE_SCAN_TTL_MS);
  const nowMs = () => (opts.stakeScanNowMs ?? Date.now)();
  let scanAtMs = 0; // completion time of the scan the served data comes from
  let scanSource = "live"; // "cache" until a live scan completes in this process
  let scanFailed = false; // most recent refresh attempt failed (serving older data)
  const persistScan = () => saveStakeScanCache(scanCacheFile, { scannedAtMs: scanAtMs, cursor: stakerCursor, stakers, events: stakeEvents, rep: repCache });
  {
    const cached = loadStakeScanCache(scanCacheFile);
    if (cached) {
      for (const a of cached.stakers) stakers.add(a);
      for (const [a, e] of cached.events) stakeEvents.set(a, e);
      for (const [a, r] of cached.rep) repCache.set(a, r);
      stakerCursor = cached.cursor != null ? BigInt(cached.cursor) : null;
      scanAtMs = cached.scannedAtMs;
      scanSource = "cache";
      evIndexReady = true;
      evIndexAt = 0; // force the first refresh to run
    }
  }
  const scanFreshness = () => freshness({ scannedAtMs: scanAtMs, ttlMs: scanTtlMs, now: nowMs(), lastRefreshFailed: scanFailed, source: scanSource });
  /** Single-flight refresh; resolves when done, never rejects. */
  async function refreshEvaluatorIndex(force = false) {
    if (evIndexInFlight) return evIndexInFlight;
    // Throttle only after a successful pass. A failed first pass must retry on the next tick
    // (previously evIndexAt was set up front, which could stall retries for 10 min).
    if (!force && evIndexReady && Date.now() - evIndexAt < 600_000 && nowMs() - scanAtMs < scanTtlMs) return;
    evIndexInFlight = (async () => {
      let ok = true;
      try {
        if (opts.stakeScanner) {
          await opts.stakeScanner({ stakers, stakeEvents, repCache });
        } else {
          const c = contracts();
          try {
            // permissionless stakers: Staked events from AGENTCOIN_EVALUATOR_INDEX_FROM (Base Sepolia default: AD-011 start
            // block; earlier stakers = the reference evaluator, always listed) to head, incrementally
            const head = await publicClient.getBlockNumber();
            const from = stakerCursor ?? BigInt(env.AGENTCOIN_EVALUATOR_INDEX_FROM ?? (CHAIN_ID === 84532 ? 59182000 : (c.d.deployBlock ?? 0)));
            if (head >= from) {
              const logs = parseEventLogs({ abi: c.registry.abi, logs: await rawLogsChunked(c.registry.address, from, head), eventName: "Staked", strict: false });
              for (const l of logs) if (l.args?.evaluator) stakers.add(getAddress(l.args.evaluator));
              foldStakeEvents(stakeEvents, logs.filter((l) => l.args?.evaluator).map((l) => ({ evaluator: l.args.evaluator, txHash: l.transactionHash, blockNumber: l.blockNumber })));
              stakerCursor = head + 1n;
            }
          } catch { ok = false; }
          try {
            const n = await read(c.escrow, "jobCount", []);
            for (let i = 1n; i <= n; i++) {
              const k = String(i);
              if (TERMINAL.includes(jobIndex.get(k)?.state)) continue;
              const j = await read(c.escrow, "getJob", [i]);
              jobIndex.set(k, { evaluator: getAddress(j.evaluator), state: STATES[j.state], outcome: OUTCOMES[j.outcome], submittedAt: Number(j.submittedAt), verdictAt: Number(j.verdictAt), instant: j.instant });
            }
            const next = accumulateTrackRecords([...jobIndex.values()], n);
            repCache.clear();
            for (const [addr, r] of next) repCache.set(addr, r);
            evIndexReady = true; // as before: track records ready even if the log scan failed
            evIndexAt = Date.now();
            evList = null;
          } catch { ok = false; }
        }
      } catch { ok = false; }
      if (ok) {
        evIndexReady = true;
        evIndexAt = Date.now();
        scanAtMs = nowMs();
        scanSource = "live";
        scanFailed = false;
        evGeneration++;
        evList = null; // drop any pre-index snapshot so the next list includes track records
        fullCache = null;
        persistScan();
      } else {
        scanFailed = true; // keep serving the cache (stale: true)
      }
    })().finally(() => { evIndexInFlight = null; });
    return evIndexInFlight;
  }
  if (evIndexReady) refreshEvaluatorIndex().catch(() => {}); // cache loaded: serve it now, refresh in the background
  async function evaluatorList() {
    if (opts.activeEvaluators) return opts.activeEvaluators(); // tests: offline selectable list (no RPC)
    if (shouldAwaitJobIndex(evIndexReady, evIndexInFlight)) await evIndexInFlight.catch(() => {});
    if (listNeedsFreshScan({ indexReady: evIndexReady, scanAtMs, ttlMs: scanTtlMs, now: nowMs() })) {
      // single-flight, TTL-gated; wait (bounded) so a newly staked evaluator is in `list`, not only in `all`
      await Promise.race([refreshEvaluatorIndex().catch(() => {}), new Promise((r) => setTimeout(r, 8000).unref?.())]);
    }
    if (evaluatorListCacheValid({ indexReady: evIndexReady, cached: evList, now: Date.now(), generation: evGeneration })) return evList.v;
    const gen = evGeneration;
    const c = contracts();
    const def = defaultEvaluator();
    const rows = await Promise.all(
      evCandidates().map(async (k) => {
        const [snapshot, exactPayTo] = await Promise.all([evaluatorSnapshot(c, k.address), read(c.routeFactory, "routeFor", [notaryOffer(k.address)])]);
        return evaluatorRow(k, { snapshot, exactPayTo, trackRecord: repCache.get(k.address), links, isDefault: k.address === def });
      }),
    );
    const v = rows.filter((r) => r.active);
    if (shouldCacheEvaluatorList(evIndexReady) && gen === evGeneration) evList = { at: Date.now(), v, generation: gen };
    return v;
  }
  async function evaluatorsBlock(ev = null) {
    const c = contracts();
    return { registry: c.registry.address, selected: ev ?? defaultEvaluator(), default: defaultEvaluator(), selection: SELECTION_TEXT, url: links.evaluators, list: await evaluatorList().catch(() => []) };
  }
  // ---- Evaluator onboarding v1 (daily spec 2026-11-19): complete listing, signed profiles, queue-only canary ----
  const profiles = new ProfileStore(path.join(cfg.stateDir, "evaluator-profiles.json"));
  const canaryQueue = new CanaryQueue(path.join(cfg.stateDir, "canary-queue.jsonl"));
  const registryReader = {
    minStake: () => read(contracts().registry, "minStake", []),
    snapshot: (a) => evaluatorSnapshot(contracts(), a),
    stakeEvents: async () => {
      if (!evIndexReady) await refreshEvaluatorIndex().catch(() => {});
      else refreshEvaluatorIndex().catch(() => {}); // TTL-gated, single-flight, not awaited
      let filled = false;
      for (const e of stakeEvents.values()) {
        if (e.timestamp != null) continue;
        try {
          e.timestamp = Number((await publicClient.getBlock({ blockNumber: BigInt(e.block) })).timestamp);
          filled = true;
        } catch {}
      }
      if (filled && scanAtMs) persistScan();
      return stakeEvents;
    },
    ...(opts.registryReader ?? {}), // tests may override any method
  };
  async function evaluatorFullData() {
    if (fullCache && Date.now() - fullCache.at < 60_000) return fullCache;
    const [minStake, events] = await Promise.all([registryReader.minStake(), registryReader.stakeEvents()]);
    let provider = null;
    try {
      provider = wallets().provider.account.address;
    } catch {}
    const cands = evaluatorCandidates({ known: knownEvaluators({ agentDir: AGENT_DIR, chainId: CHAIN_ID, env }), reference: referenceEvaluator(), referenceLabel: REFERENCE_EVALUATOR_LABEL, stakers: [...events.keys()] }).filter((k) => k.address !== provider);
    const snaps = new Map(await Promise.all(cands.map(async (k) => [k.address, await registryReader.snapshot(k.address)])));
    fullCache = { at: Date.now(), minStake: String(minStake), events, cands, snaps };
    return fullCache;
  }
  async function evaluatorFullList() {
    const d = await evaluatorFullData();
    const c = contracts();
    // profiles are attached at render time, so a new profile shows without waiting for the 60 s snapshot cache
    const rows = d.cands.map((k) => fullRow({ candidate: k, snapshot: d.snaps.get(k.address), minStake: d.minStake, stakeEvent: d.events.get(k.address), profile: profiles.get(k.address), links, registry: c.registry.address, token: c.usdc.address }));
    const statusCounts = { active: 0, below_min_stake: 0, unstaked: 0 };
    for (const r of rows) statusCounts[r.status]++;
    return { minStake: d.minStake, statusCounts, all: rows };
  }
  async function evaluatorStatus(address) {
    const [minStake, events, snapshot] = await Promise.all([registryReader.minStake(), registryReader.stakeEvents(), registryReader.snapshot(address)]);
    const st = stakeStatus(snapshot, minStake);
    return { everStaked: events.has(getAddress(address)), stake: String(snapshot.stake), minStake: String(minStake), ...st };
  }
  const onboardingDeps = () => ({ chainId: CHAIN_ID, registry: contracts().registry.address, now: opts.now ?? (() => Math.floor(Date.now() / 1000)), status: evaluatorStatus, profiles, queue: canaryQueue });
  const onboarding = async () => onboardingBlock({ links, registry: contracts().registry.address, token: contracts().usdc.address, minStake: String(await registryReader.minStake().catch(() => "unknown")), chainId: CHAIN_ID });
  /** Buyer's evaluator choice: null = default. Rejects addresses that are not active registry evaluators. */
  async function resolveEvaluator(raw) {
    if (raw == null || raw === "") return { ev: null };
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(raw))) return { error: "evaluator must be a 0x address" };
    const ev = getAddress(raw);
    if (ev === defaultEvaluator()) return { ev: null };
    if (ev === wallets().provider.account.address) return { error: "evaluator cannot be the provider" };
    const active = await read(contracts().registry, "isActive", [ev]).catch(() => false);
    if (!active) return { error: "evaluator is not an active EvaluatorRegistry evaluator" };
    return { ev };
  }
  const chosenFrom = (u, pp) => u.searchParams.get("evaluator") ?? pp?.accepted?.extra?.agentcoin?.offer?.evaluator ?? pp?.accepted?.extra?.settlement?.evaluator ?? null;

  // ---- opt-in gvp-criteria-checks/1 mode (?spec=gvp-criteria-checks/1&digest=0x..[&nonce=..]); default mode is untouched ----
  const criteriaCache = new Map(); // specHash hex (no 0x) -> criteria offer; bounded, for unpaid GET /v1/criteria/<sha256>
  const rememberCriteria = (co) => {
    criteriaCache.delete(co.specHash.slice(2));
    criteriaCache.set(co.specHash.slice(2), co);
    if (criteriaCache.size > 1000) criteriaCache.delete(criteriaCache.keys().next().value);
    return co;
  };
  const critBuild = (params) => rememberCriteria(criteriaOffer({ baseUrl: cfg.publicUrl, params, chainId: CHAIN_ID, escrow: contracts().escrow.address }));
  // query wins; otherwise the criteria the payer echoes in PAYMENT-SIGNATURE accepted.extra[.agentcoin].criteria
  function critFrom(u, pp = null) {
    let params = parseCriteriaParams((k) => u.searchParams.get(k));
    if (!params && pp) {
      const m = pp?.accepted?.extra?.agentcoin?.criteria ?? pp?.accepted?.extra?.criteria;
      const dl = m?.deliverableUrl ? String(m.deliverableUrl).split("/v1/deliverables/")[1] : null;
      const pd = dl ? parseDeliverableId(dl) : null;
      if (pd) params = { digest: pd.digest, nonce: pd.nonce, id: pd.id };
    }
    if (!params) return { crit: null };
    if (params.error) return { error: params.error };
    return { crit: critBuild(params) };
  }
  const criteriaJob = (id) => Object.entries(jobs.jobs).find(([, j]) => j.criteria?.id === id && j.status !== "failed");
  const criteriaJobBySpec = (specHash) => Object.entries(jobs.jobs).find(([, j]) => j.criteria?.specHash === specHash);
  const criteriaRefs = (c) => ({ vocabulary: CRITERIA_VOCABULARY, specHash: c.specHash, criteriaUrl: URL_("/v1/criteria/" + c.specHash.slice(2)), deliverableUrl: URL_("/v1/deliverables/" + c.id) });

  // ---- self-verifying job proofs: GET /v1/jobs/{id}/proof, GET /v1/escrows/{escrow}/jobs/{id}/proof ----
  const proofCache = new Map(); // "<escrow>:<id>" -> signed proof, kept only for terminal jobs (immutable)
  // ---- Concordium anchor (feature flag CCD_ANCHOR=1, default OFF; opts.ccdAnchor = { sender, storeFile?, noTimer? } for tests) ----
  // Settled jobs get their proof core frozen (byte-identical forever) and queued for one RegisterData tx on Concordium testnet.
  const ccdOn = opts.ccdAnchor ?? (process.env.CCD_ANCHOR === "1" ? {} : null);
  let ccd = null, ccdTimer = null;
  if (ccdOn) {
    const host = process.env.CCD_GRPC_HOST ?? DEFAULT_CCD_GRPC.host, port = Number(process.env.CCD_GRPC_PORT ?? DEFAULT_CCD_GRPC.port);
    let real = null; // created lazily so a missing key/SDK only delays anchoring, never the service
    const sender = ccdOn.sender ?? {
      send: async (h) => (real ??= await (process.env.CCD_GRPC_HOST ? makeSdkSender({ keyFile: process.env.CCD_ANCHOR_KEY_FILE, host, port }) : makeProxySender({ keyFile: process.env.CCD_ANCHOR_KEY_FILE, base: process.env.CCD_PROXY_URL ?? undefined }))).send(h),
      status: async (t) => (real ??= await (process.env.CCD_GRPC_HOST ? makeSdkSender({ keyFile: process.env.CCD_ANCHOR_KEY_FILE, host, port }) : makeProxySender({ keyFile: process.env.CCD_ANCHOR_KEY_FILE, base: process.env.CCD_PROXY_URL ?? undefined }))).status(t),
    };
    ccd = createAnchorQueue({ store: new AnchorStore(ccdOn.storeFile === undefined ? path.join(cfg.stateDir, "ccd-anchors.json") : ccdOn.storeFile), sender, network: "testnet", genesis: process.env.CCD_TESTNET_GENESIS ?? null, log: (m) => console.error(m) });
    if (!ccdOn.noTimer) { ccdTimer = setInterval(() => ccd.tick().catch(() => {}), 15000); ccdTimer.unref?.(); }
  }
  const evaluatorBadges = (() => { try { return JSON.parse(process.env.CCD_EVALUATOR_BADGES ?? "{}"); } catch { return {}; } })(); // {"0xEvaluator": "<badge token address>"}
  const ccdSign = async (b) => (wallets().operatorKey ? await (async () => { const signed = await signEip191(b, wallets().operatorKey); return { ...signed, signature: { ...signed.signature, kid: `did:pkh:eip155:${CHAIN_ID}:${signed.signature.signer}#secp256k1` } }; })() : { ...b, signature: null });
  const proofLinks = (jobId, escrowAddr = null) => {
    const isDefault = !escrowAddr || getAddress(escrowAddr) === contracts().escrow.address;
    const proof = isDefault ? URL_(`/v1/jobs/${jobId}/proof`) : URL_(`/v1/escrows/${getAddress(escrowAddr)}/jobs/${jobId}/proof`);
    return { proofUrl: proof, verifyCommand: `npx ${JUDGE_KIT_REF} verify ${jobId}${isDefault ? "" : ` --escrow ${getAddress(escrowAddr)}`}` };
  };
  // Badges live OUTSIDE the anchored core (like `anchors`): proofCore() drops `badges`, so adding one never changes a frozen core or its hash.
  const badgesFor = (addr) => { const b = addr && (evaluatorBadges[addr] ?? evaluatorBadges[String(addr).toLowerCase()] ?? Object.entries(evaluatorBadges).find(([k]) => k.toLowerCase() === String(addr).toLowerCase())?.[1]); return b ? { badges: { concordium: { [addr]: b } } } : {}; };
  async function buildJobProof(escrowAddr, jobId) {
    const escrow = getAddress(escrowAddr);
    const key = `${escrow}:${jobId}`;
    if (proofCache.has(key)) return proofCache.get(key);
    if (ccd) { // frozen core: serve it byte-identical plus the current anchors, re-signed (the signature covers core + anchors)
      const fc = ccd.frozenCore(escrow, jobId);
      if (fc) return ccdSign({ ...fc, anchors: ccd.anchorsFor(escrow, jobId), ...badgesFor(fc.evaluator?.address) });
    }
    const isDefault = escrow === contracts().escrow.address;
    const st = isDefault ? jobs.get(String(jobId)) : null;
    const hints = { deliverableUrls: [], criteriaUrls: [] };
    const xh = exchange.proofHints(escrow, jobId);
    if (xh) {
      hints.criteriaUrls.push(...xh.criteriaUrls);
      hints.deliverableUrls.push(...xh.deliverableUrls);
      for (const k of ["fundTx", "submitTx", "verdictTx", "settleTx"]) if (xh[k]) hints[k] = xh[k];
    }
    if (st?.kind === "exchange") {
      for (const [k, v] of [["fundTx", st.settleTx], ["submitTx", st.submitTx], ["verdictTx", st.verdictTx], ["settleTx", st.finalizeTx]]) if (v && !hints[k]) hints[k] = v;
    } else if (xh) {
      // Exchange job with an outside evaluator: hints come from the order only
    } else if (st) {
      Object.assign(hints, { fundTx: st.settleTx, submitTx: st.submitTx, verdictTx: st.verdictTx, settleTx: st.finalizeTx });
      if (st.criteria) {
        hints.deliverableUrls.push(URL_("/v1/deliverables/" + st.criteria.id));
        hints.criteriaUrls.push(URL_("/v1/criteria/" + st.criteria.specHash.slice(2)));
      } else hints.deliverableUrls.push(URL_("/v1/notarize/" + jobId));
    } else if (isDefault) { hints.deliverableUrls.push(URL_("/v1/notarize/" + jobId)); // default-mode notarize jobs: receipt at the status URL
      if (NETWORK === "base-sepolia") Object.assign(hints, LEGACY_JOB_HINTS[escrow]?.[String(jobId)] ?? {}); // jobs 1-4 predate local job state: chain tx hashes found by an event scan
    }
    // our own URLs are answered from local state (no self-HTTP); everything else is fetched
    const fetchBytes = async (url) => {
      const xb = exchange.localBytes(url);
      if (xb) return { bytes: Buffer.from(xb) };
      const cm = url.startsWith(URL_("/v1/criteria/")) ? url.slice(URL_("/v1/criteria/").length).match(/^[0-9a-f]{64}$/) : null;
      if (cm) {
        const jb = criteriaJobBySpec("0x" + cm[0]);
        const doc = criteriaCache.get(cm[0])?.document ?? (jb && criteriaOffer({ baseUrl: cfg.publicUrl, params: { digest: jb[1].criteria.digest, nonce: jb[1].criteria.nonce, id: jb[1].criteria.id }, chainId: CHAIN_ID, escrow: contracts().escrow.address }).document);
        if (doc) return { bytes: criteriaBytes(doc) };
      }
      const dm = url.startsWith(URL_("/v1/deliverables/")) ? parseDeliverableId(url.slice(URL_("/v1/deliverables/").length)) : null;
      if (dm) {
        const jb = criteriaJob(dm.id);
        if (jb?.[1].receipt) return { bytes: deliverableBytes(jb[1].receipt) };
      }
      const nm = url.startsWith(URL_("/v1/notarize/")) ? url.slice(URL_("/v1/notarize/").length).match(/^\d+$/) : null;
      if (nm && jobs.get(nm[0])?.receipt) return { bytes: Buffer.from(JSON.stringify({ receipt: jobs.get(nm[0]).receipt })) };
      return fetchBytesDefault(url);
    };
    const ev = await collectProof({ client: publicClient, escrow, jobId, hints, window: NET.maxLogRange || 50000, maxCalls: 40, fetchBytes });
    if (!ev.exists) return null;
    const stos = new Set(internalAddrs().map((a) => a.toLowerCase()));
    const evaluatorAddr = getAddress(ev.job.evaluator);
    const bundle = proofBundle(ev, { links: { job: URL_(`/v1/jobs/${jobId}`), ...proofLinks(jobId, escrow), agentCard: links.agentCard, jwks: URL_("/.well-known/jwks.json") }, generatedAt: new Date().toISOString(), ...VALUE_LABEL });
    bundle.deliverable.candidateUrls = hints.deliverableUrls;
    bundle.criteria.candidateUrls = hints.criteriaUrls;
    bundle.evaluator = { ...(bundle.evaluator ?? { address: evaluatorAddr }), stosOperated: stos.has(evaluatorAddr.toLowerCase()) || evaluatorAddr === referenceEvaluator(), operator: stos.has(evaluatorAddr.toLowerCase()) || evaluatorAddr === referenceEvaluator() ? "STOS Technologies LLC" : null, trackRecordUrl: URL_("/v1/evaluators/" + evaluatorAddr) };
    if (ccd && ev.job.state === "Settled") {
      ccd.freeze({ escrow, jobId, chainId: CHAIN_ID, bundle });
      { const fc2 = ccd.frozenCore(escrow, jobId); return ccdSign({ ...fc2, anchors: ccd.anchorsFor(escrow, jobId), ...badgesFor(fc2.evaluator?.address) }); }
    }
    const bundleB = { ...bundle, ...badgesFor(evaluatorAddr) };
    let out = bundleB;
    if (wallets().operatorKey) {
      const signed = await signEip191(bundleB, wallets().operatorKey);
      out = { ...signed, signature: { ...signed.signature, kid: `did:pkh:eip155:${CHAIN_ID}:${signed.signature.signer}#secp256k1` } };
    } else out = { ...bundleB, signature: null };
    if (["Settled", "Expired", "Cancelled"].includes(ev.job.state)) proofCache.set(key, out);
    return out;
  }

  let notarySeedId = null;
  let lq = null;
  async function registerNotarySeed() {
    const ex = await exactRequirements();
    const es = await escrowRequirements();
    const o = notaryOffer();
    const host = new URL(cfg.publicUrl).host;
    const strip = (r) => ({ scheme: r.scheme, network: r.network, asset: r.asset, amount: r.amount, payTo: r.payTo });
    const svc = buildService({
      protocol: "x402",
      host,
      name: `AgentCoin notary (${NETWORK} testnet)`,
      description: resourceInfo().description,
      endpoints: { x402: links.notarize, mcp: links.mcp, a2a: { url: URL_("/a2a/v1"), binding: "HTTP+JSON", version: "1.0" }, status: URL_("/v1/notarize/{jobId}") },
      skills: [{ id: "POST /v1/notarize", name: "Timestamp notary", description: resourceInfo().description, method: "POST", url: links.notarize, price: ex.amount, asset: ex.asset, network: ex.network, payTo: ex.payTo, scheme: "exact", accepts: [strip(ex), strip(es)], inputSchema: { type: "object", properties: { sha256: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, data: { type: "string", maxLength: 4096 }, note: { type: "string", maxLength: 200 } } }, inputExample: { body: { sha256: "0x" + "ab".repeat(32), note: "optional" } }, tags: ["notary", "timestamp", "escrow", "testnet"] }],
      source: { kind: "agentcoin-operated", url: links.discovery },
      origin: "agentcoin",
      extra: { escrowOffer: offerJson(o) },
    });
    notarySeedId = router.registerSeed(svc, {
      liveQuote: async () => {
        // live from chain (route address, fee config, evaluator stake); cached 30 s to keep route_task latency flat
        if (!lq || Date.now() - lq.at > 30_000) {
          const r = await exactRequirements();
          lq = { at: Date.now(), v: { ...r, accepts: [r, await escrowRequirements()] } };
        }
        return lq.v;
      },
      escrow: {
        provider: o.provider,
        evaluator: o.evaluator,
        specHash: SPEC_HASH,
        sellerCall: { method: "POST", url: links.notarize, headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": 'base64(JSON {"x402Version":2,"accepted":{"scheme":"agentcoin-escrow","network":"eip155:84532"},"payload":{"jobId":"<jobId>","txHash":"<createAndFundFor tx hash>"}})' }, body: { sha256: "0x<64 hex>" }, note: "after the funding tx; the notary submits the receipt hash on chain and the evaluator issues the verdict" },
      },
    });
    return notarySeedId;
  }
  async function probeSeeds() {
    if (!notarySeedId) await registerNotarySeed().catch(() => null);
    if (!notarySeedId) return null;
    const out = [];
    for (const [kind, init, url] of [
      ["reach", { method: "GET" }, URL_("/healthz")],
      ["402", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha256: "0x" + "00".repeat(32) }) }, links.notarize],
    ]) {
      const t0 = performance.now();
      let status = 0, bodySha256 = null;
      try {
        const r = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), "user-agent": "agentcoin-probe/0.1", "x-agentcoin-probe": "1" }, signal: AbortSignal.timeout(10_000) });
        status = r.status;
        bodySha256 = "0x" + createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex");
      } catch {}
      out.push(await router.addProbe(notarySeedId, { kind, status, latencyMs: Math.round(performance.now() - t0), url, bodySha256 }));
    }
    await router.recomputeScore(notarySeedId);
    return out;
  }

  // Bazaar resource metadata (CDP rules: description <= 500 chars and describes the endpoint only; iconUrl PNG/JPG/WebP/GIF, not SVG;
  // serviceName <= 32 printable ASCII; <= 5 tags). Text from plans/partner-listings-drafts.md 2C.
  const NOTARY_DESCRIPTION = netCopy(`Timestamp notary on Base Sepolia testnet (test USDC, no real value). Returns a signed notarization record for the submitted content hash. Payment is held in AgentKoin escrow until a staked outside evaluator issues a verdict, then released to the provider or refunded to the buyer. Free example response: GET ${links.notarizeExample}. Schema: /v1/notarize/schema.json.`);
  const resourceInfo = (ev = null) => ({ url: ev ? `${links.notarize}?evaluator=${ev}` : links.notarize, description: NOTARY_DESCRIPTION, mimeType: "application/json", serviceName: "AgentKoin", tags: ["escrow", "notary", "timestamp", "usdc", "testnet"], iconUrl: URL_("/brand/symbol-1024.png") });
  // ---- free example of the paid response (GET /v1/notarize/example) ----
  // Source: a real job record from this service's job store; the bundled snapshot of the same public record is used when the store lacks it.
  const EXAMPLE_JOB_ID = String(opts.exampleJobId ?? process.env.NOTARIZE_EXAMPLE_JOB_ID ?? "19");
  function exampleRecord() {
    const live = jobs.get(EXAMPLE_JOB_ID);
    if (live?.receipt) return { jobId: EXAMPLE_JOB_ID, ...live, source: "job store" };
    const snap = JSON.parse(readFileSync(path.join(AGENT_DIR, "static", "notarize-example-job.json"), "utf8"));
    return { ...snap, source: "bundled snapshot of GET /v1/notarize/" + snap.jobId, ...(TESTNET ? {} : { illustrative: "Base Sepolia testnet job shown for its shape only; not a Base mainnet job" }) };
  }
  // agentcoin.payment (non-USDC payments only) sits in the footer, outside the receipt, so responseSchemaHash is unchanged.
  const statusBody = async (jobId, j) => {
    const footer = await notaryFooter(jobId, j.receipt);
    // Re-derived (ECDSA signing here is deterministic): lets anyone recover the signer from the status URL, incl. jobs paid before 0.5.27.
    const receiptSignature = wallets().operatorKey && j.receipt ? (await signEip191(j.receipt, wallets().operatorKey).catch(() => null))?.signature ?? null : null;
    return { jobId, status: j.status, receipt: j.receipt, ...(receiptSignature ? { receiptSignature } : {}), deliverableHash: j.deliverableHash, settleTx: j.settleTx, submitTx: j.submitTx, verdictTx: j.verdictTx ?? null, finalizeTx: j.finalizeTx ?? null, ...(j.criteria ? { criteria: criteriaRefs(j.criteria) } : {}), agentcoin: j.payment ? { ...footer, payment: j.payment } : footer };
  };
  // Jobs settled through the CrossCurrencySettler before v0.5.15 have no stored payment record: rebuild it once from the
  // settle tx's CrossCurrencySettled event and store it. Checked at most once per job per process for other jobs.
  const paymentChecked = new Set();
  async function backfillPayment(id, j) {
    if (j.payment || !ma.enabled || !j.settleTx || paymentChecked.has(id)) return j;
    paymentChecked.add(id);
    try {
      const rcpt = await publicClient.getTransactionReceipt({ hash: j.settleTx });
      if (rcpt?.to?.toLowerCase() !== ma.settler.toLowerCase()) return j;
      const payment = paymentFromReceipt(rcpt, ma.settler, id);
      if (!payment) return j;
      jobs.put(id, { payment });
      return jobs.get(id);
    } catch {
      paymentChecked.delete(id); // RPC error: retry on a later request
      return j;
    }
  }
  const VERIFY_TEXT_CRITERIA = "sha256(RFC8785(receipt)) == JobEscrow.getJob(jobId).deliverableHash; the receipt is served byte-exact at criteria.deliverableUrl; sha256(RFC8785(criteria document)) == getJob(jobId).specHash; receiptSignature is EIP-191 by the operator over RFC8785(receipt)";
  const VERIFY_TEXT = "keccak256(RFC8785(receipt)) == JobEscrow.getJob(jobId).deliverableHash; receiptSignature is EIP-191 by the operator over RFC8785(receipt)";
  let paidExampleCache = null;
  async function paidExampleCore() {
    // Same keys as the POST /v1/notarize 200 body (without the footer), built from the example job.
    if (paidExampleCache) return paidExampleCache;
    const j = exampleRecord();
    const sig = wallets().operatorKey ? (await signEip191(j.receipt, wallets().operatorKey).catch(() => null))?.signature ?? null : null;
    paidExampleCache = { receipt: j.receipt, receiptSignature: sig, deliverableHash: j.deliverableHash, jobId: String(j.jobId), settleTx: j.settleTx, submitTx: j.submitTx ?? null, verify: VERIFY_TEXT, status: links.notarize + "/" + String(j.jobId) };
    return paidExampleCache;
  }
  async function exampleBody(shape) {
    const j = exampleRecord();
    const meta = { example: true, sampleOf: links.notarize + "/" + String(j.jobId), sampleSource: j.source, ...(j.illustrative ? { illustrative: j.illustrative } : {}), schema: links.notarizeSchema, responseSchemaHash: NOTARY_RESPONSE_SCHEMA_HASH };
    if (shape === "post") {
      const core = await paidExampleCore();
      return { ...meta, shape: "POST /v1/notarize 200", ...core, agentcoin: await notaryFooter(core.jobId, core.receipt, core.receiptSignature) };
    }
    return { ...meta, shape: "GET /v1/notarize/{jobId} 200", ...(await statusBody(String(j.jobId), j)) };
  }
  // Bazaar declaration: input = a real request body (the example job's digest; its note is left out to fit the header
  // budget); input schema = the sha256 form parseNotarizeInput accepts; output = the POST 200 example plus the published response schema (/v1/notarize/schema.json,
  // without its $schema/$id/title so it nests as a subschema). The PAYMENT-REQUIRED header copy slims output (lib/header402.mjs).
  const { $schema: _s, $id: _i, title: _t, ...NOTARY_OUTPUT_SCHEMA } = NOTARY_RESPONSE_SCHEMA;
  const bazaar = async () => {
    const r = exampleRecord().receipt ?? {};
    return declareDiscoveryExtension({
      method: "POST",
      bodyType: "json",
      input: { sha256: r.digest ?? "0x" + "ab".repeat(32) },
      inputSchema: { properties: { sha256: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, note: { type: "string", maxLength: 200 } } }, // unchanged (header budget); `data` alternative: OpenAPI
      output: { example: await paidExampleCore(), schema: NOTARY_OUTPUT_SCHEMA },
    }).bazaar;
  };
  // The notary is the reference seller for @agentcoin/x402-escrow-hint: its own 402 carries extensions["agentcoin-escrow"].
  // Only this service's own 402 is extended; router/proxied/third-party responses are never modified.
  const escrowHintOpts = () => {
    const c = contracts();
    const o = notaryOffer();
    return { provider: o.provider, evaluator: o.evaluator, specHash: SPEC_HASH, deadlineSeconds: cfg.deadlineSeconds, ...(notarySeedId ? { serviceId: notarySeedId } : {}), deployment: { routerUrl: cfg.publicUrl, escrowContract: c.escrow.address, token: c.usdc.address } };
  };
  // AD-010: AGC exact entry, derived from the unchanged USDC exact entry; payTo = AGC factory.routeFor(same offer).
  async function agcExactEntry() {
    if (!agc.enabled) return null;
    const o = notaryOffer();
    const factory = { address: agc.routeFactory, abi: ABI.routeFactory };
    const [usdcExact, payTo, cfgOnchain, registry] = await Promise.all([exactRequirements(), read(factory, "routeFor", [o]), read(agcEscrowRef(), "currentConfig"), read(agcEscrowRef(), "registry")]);
    const ev = await evaluatorSnapshot({ registry: { address: registry, abi: ABI.registry } }, o.evaluator);
    return agcExactRequirements(usdcExact, { cfg: agc, payTo, feeBps: Number(cfgOnchain.feeBps), evaluatorFeeBps: Number(cfgOnchain.evaluatorFeeBps), evaluatorStake: ev.stake, evaluatorActive: ev.active, reserveUrl: URL_("/v1/agc") });
  }
  // PAYMENT-REQUIRED header copy (agent/lib/header402.mjs): no inline bazaar output.example, no agentcoin-escrow extension,
  // no agentcoin-swap entry (all listed in bodyOnly). The JSON body keeps the full challenge.
  // criteria mode (opt-in): the 402 header stays inside the 6,144 B budget. The criteria document and the agentcoin-escrow
  // entry are body-only (the document is also served at criteriaUrl); the exact entry keeps specHash and the URLs.
  const slimCriteria = (a) => {
    const slim = (o) => (o?.criteria ? { ...o, criteria: { vocabulary: o.criteria.vocabulary, specHash: o.criteria.specHash, criteriaUrl: o.criteria.criteriaUrl, deliverableUrl: o.criteria.deliverableUrl } } : o);
    const ag = a.extra?.agentcoin ? slim(a.extra.agentcoin) : null;
    return ag ? { ...a, extra: { ...a.extra, agentcoin: ag } } : a;
  };
  const headerPR = (pr) => {
    const h = headerCopy(pr, agc);
    if (!pr.accepts.some((a) => a.extra?.criteria?.document || a.extra?.agentcoin?.criteria?.document)) return h;
    return { ...h, accepts: h.accepts.filter((a) => a.scheme !== "agentcoin-escrow").map(slimCriteria), bodyOnly: [...h.bodyOnly, "accepts.agentcoin-escrow", "accepts[].extra.agentcoin.criteria.document"] };
  };
  // AD-009: EURC-in / USDC-out entry, appended after the unchanged USDC entries. Quote cached briefly (one eth_call per window).
  let swapCache = null;
  const swapOffer = (ev = null) => {
    const o = notaryOffer(ev);
    return { escrow: agc.swapOut ? agc.adapter : contracts().escrow.address, provider: o.provider, evaluator: o.evaluator, deadlineSeconds: cfg.deadlineSeconds, specHash: SPEC_HASH };
  };
  async function swapAccepts(ev = null) {
    if (!ma.enabled || CHAIN_ID !== BASE_SEPOLIA.chainId) return [];
    const now = Math.floor(Date.now() / 1000);
    try {
      if (!swapCache || now - swapCache.at >= ma.quoteCacheSeconds || swapCache.q.expiry - now < 60) {
        const q = await fxQuote({ from: BASE_SEPOLIA.assets.EURC, to: resolveAsset(contracts().usdc.address), amount: cfg.price, side: "exactOut" }, { call: chainCall, cfg: ma, nowSec: now });
        swapCache = { at: now, q: quoteBook.put(q) };
      }
      const e = swapRequirements(swapCache.q, { cfg: ma, offer: swapOffer(ev), links, responseSchemaHash: NOTARY_RESPONSE_SCHEMA_HASH });
      return [agc.swapOut ? agcSwapEntry(e, agc) : e];
    } catch {
      return []; // no quote (e.g. no liquidity): the USDC entries are served alone
    }
  }
  async function relayedSwapSettle(v, reservation) {
    const { hash, receipt, costWei } = await serial("relayer", () => send(wallets().relayer, { address: ma.settler, abi: SETTLER_ABI }, "settle", [v.struct, v.auth]));
    caps.spend(costWei, reservation);
    const r = settlementFromReceipt(receipt, ma.settler);
    if (!r) throw new Error(`settle produced no settlement event (${hash})`);
    if (!r.swapped) return { refunded: true, transaction: hash, payer: v.payer, reason: r.reason };
    stats.inc("jobsOpened");
    const payment = paymentRecord(v.quote, r, { transaction: hash, settler: ma.settler });
    const toAgc = agc.swapOut && getAddress(v.struct.escrow) === agc.adapter;
    return { transaction: hash, jobId: r.jobId, blockNumber: receipt.blockNumber, payer: v.payer, ...(toAgc ? { escrow: agc.escrow } : {}), payment: toAgc ? agcSwapPaymentRecord(payment, agc) : payment };
  }
  const paymentRequired = async (error, ev = null, crit = null) => {
    // AGC exact (AD-010, local only) keeps the default evaluator: the AGC registry is separate from the USDC registry
    const pr = { x402Version: 2, error, resource: resourceInfo(ev), accepts: orderAccepts({ usdcExact: crit ? await exactRequirementsCrit(ev, crit) : await exactRequirements(ev), agcExact: ev || crit ? null : await agcExactEntry(), escrow: crit ? await escrowRequirementsCrit(ev, crit) : await escrowRequirements(ev), swap: crit ? [] : await swapAccepts(ev) }, agc), extensions: { bazaar: await bazaar() }, exampleUrl: links.notarizeExample, responseSchemaUrl: links.notarizeSchema, evaluators: await evaluatorsBlock(ev) };
    return CHAIN_ID === 84532 ? withEscrowHint(pr, escrowHintOpts()) : pr;
  };
  async function alongPayaiVerify(paymentPayload, paymentRequirements) {
    if (!payaiEnabled() || paymentPayload?.accepted?.scheme !== "exact") return {};
    try {
      const pa = await payaiVerify({ paymentPayload, paymentRequirements });
      return pa.extensionResponsesHeader ? { "EXTENSION-RESPONSES": pa.extensionResponsesHeader } : {};
    } catch {
      return {};
    }
  }
  /** Base mainnet: generated from network config (the live 402 accepts); testnets: the static file, byte-for-byte. */
  async function wellKnownX402Buf() {
    if (TESTNET) return readFileSync(path.join(AGENT_DIR, "static", "well-known-x402.json"));
    const pr = await paymentRequired("");
    const doc = { version: 1, resources: [{ url: links.notarize, type: "http", description: pr.resource.description, accepts: pr.accepts, metadata: { provider: "AgentKoin (STOS Technologies LLC)", category: "infrastructure", tags: ["escrow", "notary", "timestamp", "usdc"] } }] };
    return Buffer.from(ser(doc) + "\n");
  }
  async function sendWellKnownX402(res) {
    // Byte-for-byte: do not run the body through json()/label().
    const buf = await wellKnownX402Buf();
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, EXTENSION-RESPONSES, X-AgentCoin-Testnet", ...LABEL_HEADER, "content-length": String(buf.length) });
    res.end(buf);
  }
  function sendIcon(res) {
    const buf = readFileSync(path.join(AGENT_DIR, "static", "icon.png"));
    res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400", "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, EXTENSION-RESPONSES, X-AgentCoin-Testnet", ...LABEL_HEADER, "content-length": String(buf.length) });
    res.end(buf);
  }
  // Receipt footer for notary receipts: verified = keccak256(RFC8785(receipt)) equals JobEscrow.getJob(jobId).deliverableHash
  // read in this call (and, when a signature is present, it recovers to the operator signer).
  async function notaryFooter(jobId, receipt, signature = null) {
    const checks = { onchainSource: "JobEscrow.getJob read in this response" };
    let chainOk = false;
    try {
      const j = await read(escrowByAddress(receipt?.escrow), "getJob", [BigInt(receipt?.jobId ?? jobId)]);
      chainOk = !!receipt && [receiptHash(receipt), deliverableSha256(receipt)].includes(String(j.deliverableHash).toLowerCase());
    } catch {}
    checks.onchainDeliverableHashMatches = chainOk;
    let sigOk = null;
    if (signature && receipt) {
      const op = wallets().operatorKey ? privateKeyToAccount(wallets().operatorKey).address : null;
      const v = await verifyEip191({ ...receipt, signature }).catch(() => null);
      sigOk = !!v?.valid && (!op || getAddress(v.signer) === op);
      checks.receiptSignatureValid = sigOk;
    }
    return router.footer({ serviceId: notarySeedId, verified: chainOk && sigOk !== false, checks });
  }

  // ---- settle (exact): verify + caps + factory.settle by the relayer ----
  async function verifyExactFull(paymentPayload, requirements, token = contracts().usdc) {
    const c = { usdc: token };
    const now = (await publicClient.getBlock()).timestamp;
    const r = await checkExactAuthorization(paymentPayload, requirements, now);
    if (!r.ok) return { isValid: false, invalidReason: r.reason, payer: r.msg?.from };
    // OFAC SDN screen before any job is created from this payment (payer and payTo)
    if (sdnMatch([r.msg.from, r.msg.to])) return { isValid: false, invalidReason: "sanctioned_address", errorCode: "OFAC_SDN_MATCH", payer: r.msg.from };
    if (await read(c.usdc, "authorizationState", [r.msg.from, r.msg.nonce])) return { isValid: false, invalidReason: "authorization nonce already used", payer: r.msg.from };
    if ((await read(c.usdc, "balanceOf", [r.msg.from])) < r.msg.value) return { isValid: false, invalidReason: "insufficient_funds", payer: r.msg.from };
    return { isValid: true, payer: r.msg.from };
  }
  async function relayedSettle(o, paymentPayload, reservation, c = contracts()) {
    const au = paymentPayload.payload.authorization;
    const { hash, receipt, costWei } = await serial("relayer", () => send(wallets().relayer, c.routeFactory, "settle", [o, getAddress(au.from), BigInt(au.value), BigInt(au.validAfter), BigInt(au.validBefore), au.nonce, paymentPayload.payload.signature]));
    caps.spend(costWei, reservation);
    const created = parseEventLogs({ abi: ABI.escrow, logs: receipt.logs, eventName: "JobCreated" })[0];
    if (!created) throw new Error(`settle produced no escrow job (${hash})`);
    stats.inc("jobsOpened");
    return { transaction: hash, jobId: created.args.jobId, blockNumber: receipt.blockNumber, payer: getAddress(au.from), ...(c.escrow.address !== contracts().escrow.address ? { escrow: c.escrow.address } : {}) };
  }

  // After a third-party facilitator (e.g. Dexter) has already submitted the EIP-3009
  // transfer to the EscrowDepositRoute, factory.settle cannot consume the nonce again.
  // Recover the escrow job from Transfer / JobCreated / DepositAttested logs on the
  // attached tx hashes (settle and/or keeper attest). Does not change the unused-nonce path.
  async function findJobFromExactTransfer(paymentPayload, requirements) {
    const c = contracts();
    const au = paymentPayload?.payload?.authorization;
    if (!au?.from || !au?.value || !requirements?.payTo) return null;
    const hashes = attachedTxHashes(paymentPayload);
    if (!hashes.length) return null;
    for (const hash of hashes) {
      const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
      if (!receipt || receipt.status !== "success") continue;
      const transfer = findUsdcTransferToRoute(receipt, { token: c.usdc.address, route: requirements.payTo, from: au.from, value: au.value });
      const created = jobCreatedFromReceipt(receipt, ABI.escrow);
      const attested = depositAttestedFromReceipt(receipt, ABI.routeFactory);
      let jobId = created?.args?.jobId ?? attested?.args?.jobId;
      if (jobId == null) continue;
      const j = await read(c.escrow, "getJob", [BigInt(jobId)]).catch(() => null);
      if (!j) continue;
      if (getAddress(j.client) !== getAddress(au.from)) continue;
      if (BigInt(j.amount) < BigInt(au.value)) continue;
      return { transaction: hash, jobId: BigInt(jobId), blockNumber: receipt.blockNumber, payer: getAddress(au.from), recoveredFromRoute: true, transfer: transfer ? { txHash: transfer.txHash, logIndex: transfer.logIndex } : null };
    }
    // A Dexter settle tx may only contain the USDC Transfer; the job is in a later attest tx.
    // If we saw a matching Transfer but no job, report that so the caller can wait/attest.
    for (const hash of hashes) {
      const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
      if (!receipt) continue;
      const transfer = findUsdcTransferToRoute(receipt, { token: c.usdc.address, route: requirements.payTo, from: au.from, value: au.value });
      if (transfer) return { pendingAttestation: true, transaction: hash, payer: getAddress(au.from), transfer };
    }
    return null;
  }

  async function verifyEscrowJob(paymentPayload, crit = null) {
    const c = contracts();
    const o = notaryOffer();
    const { jobId, txHash } = paymentPayload.payload ?? {};
    if (!jobId || !txHash) return { isValid: false, invalidReason: "payload.jobId and payload.txHash required" };
    const rcpt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!rcpt || rcpt.status !== "success") return { isValid: false, invalidReason: "txHash is not a successful tx" };
    // AD-011 Fix 2 self-submit: any tx that opened this job on the escrow counts (escrow.createAndFund, the payer's own
    // routeFactory.settle, or the payer's own CrossCurrencySettler.settle); the relayer is not needed.
    const escrowLogs = rcpt.logs.filter((l) => l.address?.toLowerCase() === c.escrow.address.toLowerCase());
    const created = parseEventLogs({ abi: ABI.escrow, logs: escrowLogs, eventName: "JobCreated" }).find((l) => String(l.args.jobId) === String(jobId));
    if (!created) return { isValid: false, invalidReason: "txHash did not create this job on the escrow" };
    const j = await read(c.escrow, "getJob", [BigInt(jobId)]).catch(() => null);
    if (!j) return { isValid: false, invalidReason: "job not found" };
    if (STATES[j.state] !== "Funded") return { isValid: false, invalidReason: `job state ${STATES[j.state]} != Funded` };
    // AD-011 Fix 1: the buyer's evaluator choice stands (the escrow already required an active registry evaluator)
    if (getAddress(j.provider) !== o.provider) return { isValid: false, invalidReason: "job provider mismatch" };
    if (j.amount < cfg.price) return { isValid: false, invalidReason: "job amount < price" };
    if (j.specHash !== (crit?.specHash ?? SPEC_HASH)) return { isValid: false, invalidReason: "specHash mismatch" };
    if (crit && criteriaJob(crit.id)) return { isValid: false, invalidReason: "criteria id already used; choose a new nonce" };
    if (jobs.get(jobId)) return { isValid: false, invalidReason: "job already redeemed" };
    return { isValid: true, payer: getAddress(j.client), jobId: BigInt(jobId), blockNumber: rcpt.blockNumber, transaction: txHash, deadline: Number(j.deadline) };
  }

  async function deliver(input, s, reservation, crit = null) {
    const key = jobKey(s.escrow, s.jobId);
    const c = { escrow: keyRef(key).escrow };
    const blk = await publicClient.getBlock({ blockNumber: s.blockNumber });
    const receipt = { v: "agentcoin-notary/v1", chainId: CHAIN_ID, escrow: c.escrow.address, jobId: s.jobId.toString(), client: s.payer, digest: input.digest, digestKind: input.digestKind, note: input.note, settleTx: s.transaction, settleBlock: s.blockNumber.toString(), notarizedAt: Number(blk.timestamp), notarizedAtIso: new Date(Number(blk.timestamp) * 1000).toISOString(), ...VALUE_LABEL };
    const deliverableHash = crit ? deliverableSha256(receipt) : receiptHash(receipt);
    const sig = wallets().operatorKey ? (await signEip191(receipt, wallets().operatorKey)).signature : null;
    jobs.put(key, { status: "paid", payer: s.payer, settleTx: s.transaction, receipt, deliverableHash, createdAt: Date.now(), ...(crit ? { criteria: { id: crit.id, digest: crit.digest, nonce: crit.nonce, specHash: crit.specHash, hashAlg: "sha256" } } : {}), ...(s.payment ? { payment: s.payment } : {}) });
    const deadline = s.deadline ?? Number(blk.timestamp) + CONFIG.deadlineSeconds;
    let sub;
    try {
      sub = await serial("provider", () =>
        txWrite(wallets().provider, c.escrow, "submit", [s.jobId, deliverableHash], {
          label: `submit job ${s.jobId}`,
          deadline,
          isDone: async () => {
            const j = await read(c.escrow, "getJob", [s.jobId]);
            const st = STATES[j.state];
            return { done: st !== "Funded", state: st, ours: st !== "Funded" && j.deliverableHash === deliverableHash };
          },
        }),
      );
    } catch (e) {
      if (e?.hash) e.submitTxInFlight = e.hash;
      throw e;
    }
    if (sub.skipped && !sub.ours) throw new Error(`submit skipped: job is ${sub.state} on chain with a different deliverable`);
    caps.spend(sub.costWei, reservation);
    stats.inc("jobsSubmitted");
    if (reservation) reservations.set(key, reservation);
    jobs.put(key, { status: "submitted", submitTx: sub.hash });
    return { receipt, receiptSignature: sig, deliverableHash, jobId: s.jobId.toString(), settleTx: s.transaction, submitTx: sub.hash, verify: crit ? VERIFY_TEXT_CRITERIA : VERIFY_TEXT, status: links.notarize + "/" + key, ...proofLinks(s.jobId.toString()), ...(crit ? { criteria: criteriaRefs(crit) } : {}) };
  }

  // ---- background evaluator + finalizer ----
  let loopBusy = false;
  let lastTickError = null;
  async function tick() {
    if (loopBusy) return;
    refreshEvaluatorIndex().catch(() => {}); // AD-011 listing: stakers + track records, every 15 min, not awaited
    loopBusy = true;
    try {
      const now = Number((await publicClient.getBlock()).timestamp);
      for (const o of exchange.db.prepare("SELECT id FROM ex_orders WHERE status = 'funded' AND job_id IS NOT NULL AND updated_at < ?").all(Date.now() - 60_000)) await runExchangeSeed(o.id).catch(() => {});
      for (const [id, j] of jobs.pending()) {
        const { escrow: jobEscrow, id: onchainId } = keyRef(id);
        const c = { escrow: jobEscrow };
        const onchain = await read(c.escrow, "getJob", [onchainId]).catch(() => null);
        if (!onchain) continue;
        const st = STATES[onchain.state];
        if (st === "Settled" || st === "Disputed") {
          caps.finish(reservations.get(String(id)));
          reservations.delete(String(id));
        }
        if (st === "Settled") {
          if (j.status !== "settled") {
            jobs.put(id, { status: "settled", settledSeen: Date.now() });
            stats.inc("jobsSettled");
            if (ccd) buildJobProof(jobEscrow, onchainId).catch(() => {}); // freeze the proof core + queue the anchor
          }
          continue;
        }
        if (st === "Disputed") {
          if (j.status !== "disputed") {
            jobs.put(id, { status: "disputed" });
            stats.inc("jobsDisputed");
          }
          continue;
        }
        if (j.status === "failed") {
          if (st === "Submitted" && onchain.deliverableHash === j.deliverableHash) {
            console.log(JSON.stringify({ t: new Date().toISOString(), evt: "submit-landed-after-failure", jobId: String(id), submitTx: j.submitTxInFlight }));
            jobs.put(id, { status: "submitted", submitTx: j.submitTxInFlight, submitTxInFlight: null, error: null });
          } else if (st !== "Funded" || now >= Number(onchain.deadline)) jobs.put(id, { submitTxInFlight: null });
          continue;
        }
        if (st === "Submitted" && j.status === "submitted") {
          if (onchain.deliverableHash !== j.deliverableHash) {
            jobs.put(id, { status: "failed", error: "on-chain deliverableHash differs from stored receipt hash" });
            continue;
          }
          const ecfgV = await read(c.escrow, "config", [onchain.configVersion]).catch(() => null);
          if (getAddress(onchain.evaluator) !== referenceEvaluator()) {
            // AD-011 Fix 1: the buyer chose another evaluator; the service never decides this job. After evalWindow
            // with no verdict, anyone may call timeoutRelease (client refunded by contract rule); the relayer does it.
            if (!ecfgV || now <= Number(onchain.submittedAt) + Number(ecfgV.evalWindow)) continue;
            if (!caps.canSpendBackground(cfg.estSettleWei)) continue;
            try {
              const t = await serial("relayer", () => send(wallets().relayer, c.escrow, "timeoutRelease", [onchainId]));
              caps.spend(t.costWei, reservations.get(String(id)));
              jobs.put(id, { status: "settled", terminal: "Expired", timeoutTx: t.hash });
            } catch (e) {
              jobs.put(id, { lastError: String(e.shortMessage ?? e.message).slice(0, 200) });
            }
            continue;
          }
          if (!caps.canSpendBackground(cfg.estSettleWei)) {
            lastTickError = "background gas budget (2x daily cap) exhausted; verdict deferred";
            continue;
          }
          let plan = { outcome: 1, payoutBps: 10000, reason: `notary receipt hash verified: ${j.deliverableHash}` };
          if (j.kind === "exchange") {
            const ev = await exchange.evaluate(j.exchange.orderId).catch((e) => ({ judgeable: false, reason: String(e.message) }));
            if (!ev.judgeable) {
              jobs.put(id, { lastError: `exchange: not judgeable (${ev.reason})` });
              continue;
            }
            plan = { outcome: ev.outcome, payoutBps: ev.payoutBps, reason: ev.reason };
          }
          const v = await serial("evaluator", () =>
            txWrite(wallets().evaluator, c.escrow, "verdict", [onchainId, plan.outcome, plan.payoutBps, keccak256(toBytes(plan.reason))], {
              label: `verdict job ${id}`,
              deadline: ecfgV ? Number(onchain.submittedAt) + Number(ecfgV.evalWindow) : undefined,
              isDone: async () => {
                const st = STATES[(await read(c.escrow, "getJob", [onchainId])).state];
                return { done: st !== "Submitted", state: st, ours: ["Completed", "Rejected", "Partial", "Settled", "Disputed"].includes(st) };
              },
            }),
          );
          caps.spend(v.costWei, reservations.get(String(id)));
          if (!v.skipped) stats.inc("verdicts");
          jobs.put(id, { status: "verdict", verdictTx: v.hash, ...(j.kind === "exchange" ? { verdictReason: plan.reason } : {}) });
          if (j.kind === "exchange" && v.hash) exchange.setTx(j.exchange.orderId, "verdict", v.hash);
          continue;
        }
        if (["Completed", "Rejected", "Partial"].includes(st)) {
          const ecfg = await read(c.escrow, "config", [onchain.configVersion]).catch(() => null);
          if (!ecfg) continue;
          if (now <= Number(onchain.verdictAt) + Number(ecfg.challengeWindow)) continue;
          if (!caps.canSpendBackground(cfg.estSettleWei)) {
            lastTickError = "background gas budget (2x daily cap) exhausted; finalize deferred";
            continue;
          }
          try {
            const f = await serial("relayer", () => send(wallets().relayer, c.escrow, "finalize", [onchainId]));
            caps.spend(f.costWei, reservations.get(String(id)));
            caps.finish(reservations.get(String(id)));
            reservations.delete(String(id));
            jobs.put(id, { status: "settled", finalizeTx: f.hash });
            if (j.kind === "exchange") {
              exchange.setTx(j.exchange.orderId, "settle", f.hash);
              await exchange.refresh(j.exchange.orderId).catch(() => {});
            }
            stats.inc("jobsSettled");
            if (ccd) buildJobProof(jobEscrow, onchainId).catch(() => {});
          } catch (e) {
            jobs.put(id, { lastError: String(e.shortMessage ?? e.message).slice(0, 200) });
          }
          continue;
        }
        if (["Expired", "Cancelled"].includes(st)) {
          caps.finish(reservations.get(String(id)));
          reservations.delete(String(id));
          jobs.put(id, { status: "settled", terminal: st });
        }
      }
    } catch (e) {
      // RPC hiccup or a failed write: recorded, retried next tick
      lastTickError = String(e.shortMessage ?? e.message).slice(0, 300);
    } finally {
      loopBusy = false;
      stats.flush();
    }
  }

  // ---- static docs ----
  const artifact = (f) => {
    const file = path.join(ARTIFACTS_DIR, f);
    // unsigned network (e.g. base before scripts/sign-base-artifacts.mjs): clean 503 with a machine-readable reason
    if (!existsSync(file)) throw Object.assign(new Error("artifacts_not_signed"), { status: 503, reason: { code: "ARTIFACTS_NOT_SIGNED", network: NETWORK, file: f, retry: "after the operator signs this network's artifacts" } });
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const fileText = (p) => readFileSync(path.join(ROOT, p), "utf8");
  // Base mainnet docs: docs/base/<name> with {{PLACEHOLDER}}s filled from the deployment record; testnets: docs/<name>.
  const docText = (name) => {
    const v = path.join(ROOT, "docs", "base", name);
    if (TESTNET || !existsSync(v)) return fileText(`docs/${name}`);
    const c = contracts();
    const d = c.d ?? {};
    const u6 = (x) => (x == null ? null : String(Number(x) / 1e6));
    const vals = { CHAIN_ID: CHAIN_ID, BASE: URL_("").replace(/\/$/, ""), RPC: "https://mainnet.base.org", EXPLORER, USDC: c.usdc?.address, ESCROW: c.escrow?.address, REGISTRY: c.registry?.address, ROUTE_FACTORY: c.routeFactory?.address, RECOVERY_VAULT: d.recoveryVault, DEPLOY_BLOCK: d.deployBlock, MAX_PER_JOB: d.maxPerJob, MAX_TOTAL_LOCKED: d.maxTotalLocked, MAX_PER_JOB_USDC: u6(d.maxPerJob), MAX_TOTAL_LOCKED_USDC: u6(d.maxTotalLocked), MIN_STAKE: d.minStake, MIN_STAKE_USDC: u6(d.minStake), JUDGE_KIT: JUDGE_KIT_REF, ESCROW_FEE_BPS: ESCROW_FEE_BPS, LIST_FEE_BPS: exchange.fees().exchangeFeeBps };
    return readFileSync(v, "utf8").replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => (vals[k] == null || vals[k] === "" ? `<unset: ${k}>` : String(vals[k])));
  };
  const PRIVACY_DRAFT = process.env.AGENTCOIN_PRIVACY_DRAFT ?? path.join(ROOT, "legal", "privacy-policy-mainnet-draft.md");
  const privacyPage = () => (!TESTNET && existsSync(PRIVACY_DRAFT) ? privacyDraftHtml({ md: readFileSync(PRIVACY_DRAFT, "utf8"), version: VERSION, alt: BRAND_ALT }) : privacyHtml({ version: VERSION, alt: BRAND_ALT }));
  const RISK_DRAFT = process.env.AGENTCOIN_RISK_DRAFT ?? path.join(ROOT, "legal", "risk-disclosure-draft.md");
  const risksPage = () => risksHtml({ md: existsSync(RISK_DRAFT) ? readFileSync(RISK_DRAFT, "utf8") : null, version: VERSION, alt: BRAND_ALT, ...(TESTNET ? {} : { caps: { maxPerJob: contracts().d?.maxPerJob ?? 50_000_000, maxTotalLocked: contracts().d?.maxTotalLocked ?? 500_000_000 } }) });
  const securityTxt = () => {
    const exp = new Date(Date.now() + 180 * 86400e3);
    exp.setUTCHours(0, 0, 0, 0);
    return `Contact: mailto:${SITE.contact}\nExpires: ${exp.toISOString()}\nPolicy: https://agentcoinhq.com/security\nCanonical: ${URL_("/.well-known/security.txt")}\nPreferred-Languages: en\n`;
  };
  const llms = () => netHide(`# AgentKoin (Base Sepolia testnet)

> Formerly AgentCoin. Escrow + staked-evaluator settlement for agent-to-agent payments in test USDC. testnet: ${TESTNET}. No real value.

- Network: Base Sepolia (eip155:${CHAIN_ID}); token: Circle test USDC ${contracts().usdc.address}
- Protocol fee: read live from /v1/quote (on-chain JobEscrow.currentConfig)
- Paid endpoint (x402 v2): POST ${links.notarize} - timestamp notary, ${Number(cfg.price) / 1e6} test USDC, payment held in escrow until the evaluator verdict
- Opt-in criteria mode (outside evaluators, ${CRITERIA_VOCABULARY}): GET ${links.notarize}?spec=${CRITERIA_VOCABULARY}&digest=0x<sha256>[&nonce=<id>] -> 402 whose accepts[].extra criteria carries specHash = sha256(RFC8785(document)), criteriaUrl (GET /v1/criteria/<sha256>) and deliverableUrl (GET /v1/deliverables/<id>); default mode unchanged
- Verify any job without trusting this service: GET ${URL_("/v1/jobs/{id}/proof")} (signed bundle: txs, payment path, criteria and receipt hashes, checks[]) and run: npx ${JUDGE_KIT_REF} verify <jobId> [--escrow <addr>] (it re-runs every check against a Base Sepolia RPC; docs/VERIFY-A-JOB.md)
- Free example of the paid response (no payment): GET ${links.notarizeExample} (GET /v1/notarize/{jobId} shape; ?shape=post for the POST 200 shape)
- Response JSON Schema (free; RFC 8785 bytes, sha256 = accepts[].extra.responseSchemaHash ${NOTARY_RESPONSE_SCHEMA_HASH}): GET ${links.notarizeSchema}
- FX quote (free): GET ${links.quote}?from=EURC&to=USDC&amount=10000[&side=exactIn|exactOut] (Uniswap v3 QuoterV2 on Base Sepolia; expiry, minOut, rate, rateSource)${ma.enabled ? `\n- Pay in EURC, seller receives USDC: 402 accepts[] entry scheme agentcoin-swap (settler ${ma.settler}); swap failure returns the EURC in the same transaction` : ""}
- Remote MCP (streamable HTTP, stateless): ${links.mcp}
- AgentKoin Exchange (testnet agent marketplace; every hire is an escrow job judged by a staked evaluator; fees 0): ${links.exchangeIndex}; llms: ${links.exchangeLlms}; OpenAPI: ${links.exchangeOpenapi}
- Hosted x402 facilitator (this service's escrow routes only): ${links.facilitator}/supported
- Quickstart for agents: ${links.quickstart}
- OpenAPI: ${links.openapi}
- A2A agent card: ${links.agentCard}
- Trust manifest (signed): ${links.trustManifest}
- Test USDC faucet pointers: ${links.faucets}
- Anonymous usage stats: ${links.stats}
- MCP server card: ${links.mcpServerCard}
- MCP endpoints: ${links.mcp} (all tools); ${links.mcpReadOnly} (read-only tools only, write tools refused)
- Terms of use (draft, not lawyer-reviewed): ${links.terms}
- Source repository (MIT): ${links.repository}
- Stripe x402 demo: ${SITE.stripeDemo}
- Packages: npm @agentkoin/x402-escrow-hint ${SITE.npm}; PyPI agentkoin-core ${SITE.pypi}
- Base Builder Code (ERC-8021 data suffix): ${SITE.builderCode}
- Website: ${cfg.publicUrl}; privacy policy: ${links.privacy}; terms of use (draft, not lawyer-reviewed): ${links.terms}; contact: ${SITE.contact}
- Do-not-contact and index delisting: POST ${links.optOut} {"match": "<host | URL | service id | erc8004:84532:<agentId> | payTo address>"}

## Arbiter for Base AuthCaptureEscrow (Base Sepolia)
- AgentKoinAuthCaptureArbiterV03: ${SITE.arbiterV03} (Sourcify exact match: ${SITE.arbiterV03Sourcify})
- Operator for Base commerce-payments AuthCaptureEscrow ${SITE.authCaptureEscrow}; token collector ERC3009PaymentCollector ${SITE.erc3009Collector}
- Flow: the buyer authorizes payment into AuthCaptureEscrow; a staked evaluator posts a verdict; the arbiter captures to the provider, splits, or refunds the buyer. Funds are held by AuthCaptureEscrow, not by AgentKoin.
- Evaluator slashing by this arbiter becomes active after its EvaluatorRegistry's 48 h slasher timelock (eligible from 2026-11-22 04:02 UTC).
- Example and source: ${SITE.stripeDemo}

## Become an evaluator (judge)
- Steps (JSON): GET ${links.evaluatorOnboarding}; guide: ${links.evaluatorDocs}
- 1 stake: USDC.approve(${contracts().registry.address}, minStake) then EvaluatorRegistry.stake(minStake) at ${contracts().registry.address}; minStake = registry.minStake()
- 2 profile: POST ${links.evaluatorProfile} {"type":"agentkoin-evaluator-profile/v1","chainId":${CHAIN_ID},"registry","address","name","url?","contact?","verdictEndpoint?","criteriaKinds?","issuedAt":<unix s>,"signature"}; signature = EIP-191 over raw keccak256(JCS(body without signature)); issuedAt within 600 s; status active or below_min_stake
- 3 watcher: judge-kit src/watch.ts --evaluator <address> (evalWindow deadlines, stake health)
- 4 canary: POST ${links.evaluatorCanary} {"type":"agentkoin-canary-request/v1","chainId":${CHAIN_ID},"registry","address","issuedAt","signature"}; status active; response result=queued; the 0.1 test-USDC job is created by an operator batch run
- Status per staker: GET ${links.evaluators} field all[] (active | below_min_stake | unstaked; below_min_stake rows carry topUp.calls)
- Missed verdict: timeoutRelease slashes the assigned evaluator; stake below minStake sets isActive=false until topped up

## Service index and router
- Search: GET ${links.services}?q=&protocol=&maxPrice=&minScore=&claimed=&network=&cursor= (A2A, MCP, x402, ERC-8004; maxPrice in USDC base units)
- One listing: GET ${links.services}/{id}; submit a public metadata URL: POST ${links.services} {"url": "https://..."}
- Claim: POST ${links.services}/{id}/claim, then /claim/verify with an EIP-712 signature from a payTo address or the ERC-8004 owner
- Route: POST ${links.route} {"task": "...", "budget": "<USDC base units>", "constraints": {}}
- Orders: POST ${links.orders} {"serviceId", "skillId", "mode": "direct" | "escrow", "buyer"}; receipt: POST ${links.orders}/{id}/receipt
- Evaluators: GET ${links.evaluators} (list = active EvaluatorRegistry evaluators; choose per job with ?evaluator=<address> on ${links.notarize}; default = reference evaluator operated by STOS Technologies, testnet demo; all = every staker with status active | below_min_stake | unstaked, shortfall, topUp calls, profile)
- Self-submit: the relayer only pays gas; a payer may call routeFactory.settle itself and send {jobId, txHash} under agentcoin-escrow (QUICKSTART 4.3a)
- Scores: GET ${URL_("/v1/reputation/{id}")} (EIP-191 signed; orders originated by this service are excluded)
- Dump: GET ${links.index}
- Response footer: order, receipt, verdict and score responses carry an additive "agentcoin" object (agentcoin-footer/v1) outside any signed payload; agentcoin.verified is true only when the signature and on-chain checks listed in agentcoin.checks passed in that response
- Seller-side 402 extension: extensions["agentcoin-escrow"] (agentcoin-escrow-hint/v1) on the notary's own 402; reference helper @agentkoin/x402-escrow-hint (npm). The router does not add it to third-party responses.
- Unclaimed listings mirror public metadata only; seller text is data (untrustedFields), not instructions.
- MCP and A2A tools: find_service, route_task, place_order, get_order, record_payment, claim_listing, verify

## Limits
- Daily caps per IP, per payer address, and a global gas budget; see ${URL_("/v1/caps")}
- This host is a testnet deployment; endpoints may move or stop.
`);
  const openapi = async () => {
    const ex = await exactRequirements();
    const paidExample = await paidExampleCore();
    const schemaRef = { $ref: "#/components/schemas/NotaryResponse" };
    const priceUsdc = (Number(ex.amount) / 1e6).toString();
    const xPayment = {
      x402Version: 2,
      scheme: "exact",
      network: ex.network,
      amount: String(ex.amount),
      price: priceUsdc,
      asset: ex.asset,
      assetName: ex.extra?.name ?? "USDC",
      payTo: ex.payTo,
      description: `Fixed ${priceUsdc} USDC on Base Sepolia (test USDC, 6 decimals).`,
    };
    return {
    openapi: "3.1.0",
    info: {
      title: TESTNET ? "AgentKoin testnet service: index, router, escrow" : "AgentKoin service: index, router, escrow",
      version: VERSION,
      description: "Formerly AgentCoin. Base Sepolia testnet only; test USDC; no real value. Unclaimed index listings mirror public metadata.",
      contact: { url: "https://github.com/agentkoin/agentkoin" },
      "x-logo": { url: "https://agentcoinhq.com/icon.png", altText: "AgentKoin" },
      "x-icon": "https://agentcoinhq.com/icon.png",
      externalDocs: { description: "Source repository", url: "https://github.com/agentkoin/agentkoin" },
    },
    servers: [{ url: cfg.publicUrl }],
    paths: {
      "/v1/notarize": { post: {
        summary: "x402-paid timestamp notary (0.01 test USDC via escrow)",
        "x-payment": xPayment,
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { sha256: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, data: { type: "string", maxLength: 4096 }, note: { type: "string", maxLength: 200 } } } } } },
        parameters: [{ name: "PAYMENT-SIGNATURE", in: "header", required: false, schema: { type: "string" }, description: "base64 x402 v2 PaymentPayload" }, { name: "spec", in: "query", required: false, schema: { type: "string", enum: [CRITERIA_VOCABULARY] }, description: "opt-in: specHash = sha256 of an RFC 8785 criteria document (gvp-criteria-checks/1); needs digest" }, { name: "digest", in: "query", required: false, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, description: "with spec: the sha256 the receipt will carry; must equal the body digest" }, { name: "nonce", in: "query", required: false, schema: { type: "string", pattern: "^[0-9a-z]{1,32}$" }, description: "with spec: distinguishes repeat notarizations of one digest" }],
        responses: {
          200: { description: `receipt + on-chain anchoring. Free sample: GET ${links.notarizeExample}?shape=post; JSON Schema: ${links.notarizeSchema} (responseSchemaHash ${NOTARY_RESPONSE_SCHEMA_HASH})`, content: { "application/json": { schema: schemaRef, ...(TESTNET ? { example: paidExample } : {}) } } },
          400: { description: "invalid input" },
          402: {
            description: "Payment required. The JSON body and the PAYMENT-REQUIRED header carry the same x402 v2 challenge (exact 0.01 USDC on Base Sepolia plus agentcoin-escrow).",
            headers: { "PAYMENT-REQUIRED": { schema: { type: "string" }, description: "base64-encoded x402 v2 PaymentRequired JSON" } },
            content: { "application/json": { schema: { type: "object", required: ["x402Version", "resource", "accepts"], properties: {
              x402Version: { type: "integer", const: 2 },
              error: { type: "string" },
              resource: { type: "object", properties: { url: { type: "string", format: "uri" }, serviceName: { type: "string" }, iconUrl: { type: "string", format: "uri" } } },
              accepts: { type: "array", items: { type: "object", properties: { scheme: { type: "string" }, network: { type: "string" }, amount: { type: "string" }, asset: { type: "string" }, payTo: { type: "string" } } } },
              extensions: { type: "object" },
            } } } },
          },
          429: { description: "cap reached" },
        },
      } },
      "/v1/criteria/{sha256}": { get: { summary: "criteria document (gvp-criteria-checks/1) whose sha256 over its RFC 8785 bytes is the path value; immutable", parameters: [{ name: "sha256", in: "path", required: true, schema: { type: "string", pattern: "^[0-9a-f]{64}$" } }], responses: { 200: { description: "exact document bytes", content: { "application/json": { schema: { type: "object" } } } }, 404: { description: "unknown hash" } } } },
      "/v1/deliverables/{id}": { get: { summary: "byte-exact notary receipt (RFC 8785) for a criteria-mode job; sha256(body) is the on-chain deliverableHash; id = digest hex without 0x, plus -nonce when one was used", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "exact receipt bytes", content: { "application/json": { schema: { type: "object" } } } }, 404: { description: "no paid job" } } } },
      "/v1/notarize/example": { get: {
        summary: "free example of the paid notary response (no payment, never 402); built from a real job record",
        parameters: [{ name: "shape", in: "query", required: false, schema: { type: "string", enum: ["get", "post"] }, description: "get (default): GET /v1/notarize/{jobId} 200 shape; post: POST /v1/notarize 200 shape" }],
        responses: { 200: { description: "example: true; sampleOf names the source job; other keys as in the paid response", content: { "application/json": { schema: schemaRef } } } },
      } },
      "/v1/notarize/schema.json": { get: { summary: `JSON Schema of the paid notary response, served as RFC 8785 bytes; sha256 = ${NOTARY_RESPONSE_SCHEMA_HASH}`, responses: { 200: { description: "ok", content: { "application/schema+json": { schema: { type: "object" } } } } } } },
      "/v1/notarize/{jobId}": { get: { summary: "receipt and lifecycle status", parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok", content: { "application/json": { schema: schemaRef } } }, 404: { description: "unknown" } } } },
      "/v1/quote": { get: { summary: "free. Without from/to: on-chain escrow fee quote for amount (unchanged). With from/to: FX quote (Uniswap v3 QuoterV2, Base Sepolia) with expiry, minOut/maxIn, rate, rateSource, quoteId", parameters: [{ name: "amount", in: "query", schema: { type: "string" }, description: "atomic units (6 decimals)" }, { name: "from", in: "query", required: false, schema: { type: "string", enum: ["USDC", "EURC"] }, description: "symbol or Base Sepolia token address" }, { name: "to", in: "query", required: false, schema: { type: "string", enum: ["USDC", "EURC"] } }, { name: "side", in: "query", required: false, schema: { type: "string", enum: ["exactIn", "exactOut"], default: "exactIn" } }], responses: { 200: { description: "ok" }, 400: { description: "bad parameters" }, 422: { description: "no quote (e.g. no liquidity)" } } } },
      "/v1/jobs/{jobId}": { get: { summary: "on-chain job status", parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" } } } },
      "/v1/faucets": { get: { summary: "test token faucet pointers", responses: { 200: { description: "ok" } } } },
      "/v1/services": {
        get: { summary: "search the service index", parameters: ["q", "protocol", "maxPrice", "minScore", "claimed", "network", "cursor", "limit"].map((name) => ({ name, in: "query", schema: { type: "string" } })), responses: { 200: { description: "ok" }, 400: { description: "invalid filter" } } },
        post: { summary: "index a public metadata URL (GET only; idempotent by metadata hash)", requestBody: { content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } } } } }, responses: { 200: { description: "unchanged or updated" }, 201: { description: "created" }, 409: { description: "opted out" }, 422: { description: "unparseable" }, 429: { description: "cap" } } },
      },
      "/v1/services/{id}": { get: { summary: "one listing", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" }, 404: { description: "unknown or delisted" } } } },
      "/v1/services/{id}/claim": { post: { summary: "EIP-712 claim challenge + well-known token", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" } } } },
      "/v1/services/{id}/claim/verify": { post: { summary: "verify a claim (EIP-712 signature by payTo or ERC-8004 owner, or method well-known)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { claimant: { type: "string" }, expiresAt: { type: "string" }, signature: { type: "string" }, method: { type: "string", enum: ["eip712", "well-known"] } } } } } }, responses: { 200: { description: "claimed" }, 403: { description: "signer not allowed" } } } },
      "/v1/route": { post: { summary: "ranked candidate sellers for a task", requestBody: { content: { "application/json": { schema: { type: "object", required: ["task"], properties: { task: { type: "string", maxLength: 2000 }, budget: { type: "string", pattern: "^[0-9]+$" }, constraints: { type: "object" } } } } } }, responses: { 200: { description: "ok" }, 400: { description: "invalid" } } } },
      "/v1/orders": { post: { summary: "place an order (direct: seller's x402 requirements; escrow: unsigned approve + createAndFundFor)", requestBody: { content: { "application/json": { schema: { type: "object", required: ["serviceId"], properties: { serviceId: { type: "string" }, skillId: { type: "string" }, mode: { type: "string", enum: ["direct", "escrow"] }, buyer: { type: "string" } } } } } }, responses: { 201: { description: "created" }, 422: { description: "not orderable on eip155:84532" } } } },
      "/v1/orders/{id}": { get: { summary: "order status", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" } } } },
      "/v1/orders/{id}/receipt": { post: { summary: "record payment tx + deliverable (direct) or jobId (escrow)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" }, 409: { description: "tx/job already used" }, 422: { description: "job mismatch" } } } },
      "/v1/evaluators": { get: { summary: "list: active EvaluatorRegistry evaluators (stake, exposure, labels, exact payTo per evaluator), choose one with ?evaluator=<address> on /v1/notarize; all: every staker with status active | below_min_stake | unstaked, stake, minStake, shortfall, stakeTx, stakedAt, profile, topUp, nextSteps", responses: { 200: { description: "ok" } } } },
      "/v1/evaluators/onboarding": { get: { summary: "become-an-evaluator steps (stake, signed profile, judge-kit watcher, canary request), signing rule, minStake", responses: { 200: { description: "ok" } } } },
      "/v1/evaluators/profile": { post: { summary: "store a signed evaluator profile (agentkoin-evaluator-profile/v1; EIP-191 over keccak256(JCS(body without signature)); issuedAt within 600 s; signer = address; status active or below_min_stake; overwrite by the same signer with newer issuedAt)", requestBody: { content: { "application/json": { schema: { type: "object", required: ["type", "chainId", "registry", "address", "name", "issuedAt", "signature"], properties: { type: { type: "string", const: "agentkoin-evaluator-profile/v1" }, chainId: { type: "integer" }, registry: { type: "string" }, address: { type: "string" }, name: { type: "string", maxLength: 64 }, url: { type: "string" }, contact: { type: "string", maxLength: 200 }, verdictEndpoint: { type: "string" }, criteriaKinds: { type: "array", items: { type: "string" }, maxItems: 16 }, issuedAt: { type: "integer" }, signature: { type: "string" } } } } } }, responses: { 201: { description: "stored" }, 200: { description: "replaced" }, 400: { description: "invalid" }, 401: { description: "bad signature or stale issuedAt" }, 403: { description: "never staked, unstaked, or different signer" }, 409: { description: "issuedAt not newer than stored" } } } },
      "/v1/evaluators/canary": { post: { summary: "queue a 0.1 test-USDC canary job request for an active evaluator (agentkoin-canary-request/v1, signed like /v1/evaluators/profile); writes a queue entry only, no transaction", requestBody: { content: { "application/json": { schema: { type: "object", required: ["type", "chainId", "registry", "address", "issuedAt", "signature"] } } } }, responses: { 202: { description: "queued" }, 200: { description: "already_queued" }, 409: { description: "not active" } } } },
      "/v1/evaluators/{address}": { get: { summary: "evaluator track record counts from on-chain escrow and registry events", parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" } } } },
      "/v1/reputation/{id}": { get: { summary: "signed delivery score + evidence", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" } } } },
      "/.well-known/agentcoin-index.json": { get: { summary: "paged index dump", parameters: [{ name: "cursor", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "string" } }], responses: { 200: { description: "ok" } } } },
      "/v1/optout": { post: { summary: "do-not-contact + index delisting: AgentCoin's door-knocker will never message the match, and matching listings are removed", requestBody: { content: { "application/json": { schema: { type: "object", required: ["match"], properties: { match: { type: "string", maxLength: 300 } } } } } }, responses: { 200: { description: "recorded" } } } },
      "/.well-known/mcp/server-card.json": { get: { summary: "MCP server card (tools list without a session)", responses: { 200: { description: "ok" } } } },
      "/v1/stats": { get: { summary: "anonymous usage stats", responses: { 200: { description: "ok" } } } },
      "/v1/caps": { get: { summary: "current cap limits and usage", responses: { 200: { description: "ok" } } } },
      "/facilitator/supported": { get: { summary: "x402 facilitator supported kinds", responses: { 200: { description: "ok" } } } },
      "/facilitator/verify": { post: { summary: "x402 facilitator verify", responses: { 200: { description: "ok" } } } },
      "/facilitator/settle": { post: { summary: "x402 facilitator settle (relayer pays gas; AgentCoin routes only; capped)", responses: { 200: { description: "ok" } } } },
      "/mcp": { post: { summary: "MCP streamable HTTP endpoint (stateless, JSON responses)", responses: { 200: { description: "ok" } } } },
      "/mcp/readonly": { post: { summary: "Read-only MCP endpoint (same transport): only tools annotated readOnlyHint true; write-tool calls are refused", responses: { 200: { description: "ok" } } } },
      "/a2a/v1/message:send": { post: { summary: "A2A HTTP+JSON message:send with a data part {skill, arguments} (find_service, route_task, place_order, get_order, record_payment, claim_listing, verify) or a text part (route_task)", responses: { 200: { description: "ok" } } } },
    },
    components: { schemas: { NotaryResponse: NOTARY_RESPONSE_SCHEMA } },
  };
  };

  // ---- facilitator (hosted) ----
  async function factoryRouteCheck(requirements) {
    const c = contracts();
    const o = requirements?.extra?.agentcoin?.offer;
    if (!o) return { ok: false, reason: "requirements.extra.agentcoin.offer required (AgentCoin EscrowDepositRoute payments only)" };
    let offer;
    try {
      offer = { provider: getAddress(o.provider), evaluator: getAddress(o.evaluator), amount: BigInt(o.amount), deadlineSeconds: BigInt(o.deadlineSeconds), specHash: o.specHash };
    } catch {
      return { ok: false, reason: "malformed offer" };
    }
    if (!isHex(offer.specHash) || offer.specHash.length !== 66) return { ok: false, reason: "malformed specHash" };
    if (offer.amount > cfg.facilitatorMaxAmount) return { ok: false, reason: `amount above facilitator max ${cfg.facilitatorMaxAmount}` };
    if (BigInt(requirements.amount) !== offer.amount) return { ok: false, reason: "requirements.amount != offer.amount" };
    if (getAddress(requirements.asset) !== getAddress(c.usdc.address)) return { ok: false, reason: "asset must be test USDC" };
    if (requirements.network !== `eip155:${CHAIN_ID}`) return { ok: false, reason: "network mismatch" };
    const route = await read(c.routeFactory, "routeFor", [offer]);
    if (getAddress(route) !== getAddress(requirements.payTo)) return { ok: false, reason: "payTo is not the AgentCoin route for this offer" };
    const ev = await evaluatorSnapshot(c, offer.evaluator);
    if (!ev.active) return { ok: false, reason: "offer evaluator is not an active staked evaluator" };
    return { ok: true, offer };
  }

  // ---- MCP over streamable HTTP ----
  // /mcp/readonly: the same stateless streamable HTTP transport, serving only tools annotated readOnlyHint true.
  // Calls to write tools are answered with a clear isError result naming /mcp instead of the SDK's generic "not found".
  const MCP_READONLY_TOOLS = ["find_service", "route_task", "get_agent_profile", "list_evaluators", "verify", "get_order", "find_earning_opportunities", "list_open_jobs", "get_fee_credits"];
  const readOnlyTools = () => RTOOLS.filter((t) => t.config.annotations.readOnlyHint === true && MCP_READONLY_TOOLS.includes(t.name));
  async function handleMcp(req, res, body, ref = null, { readOnly = false } = {}) {
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { buildServer } = await import("../mcp/server.mjs");
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null });
    }
    const msgs = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    if (readOnly) {
      const ro = new Set(readOnlyTools().map((t) => t.name));
      const refused = msgs.filter((m) => m?.method === "tools/call" && !ro.has(m?.params?.name));
      if (refused.length) {
        for (const [k, v] of Object.entries(LABEL_HEADER)) res.setHeader(k, v);
        res.setHeader("access-control-allow-origin", "*");
        const reply = (m) => ({ jsonrpc: "2.0", id: m.id ?? null, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "read_only_endpoint", message: `tool ${String(m.params?.name ?? "")} is not available on the read-only endpoint /mcp/readonly (it writes or is unknown); use ${links.mcp} for write tools`, readOnlyTools: [...ro] }) }] } });
        if (!Array.isArray(parsed)) return json(res, 200, reply(parsed));
        return json(res, 200, msgs.map((m) => (refused.includes(m) ? reply(m) : { jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32600, message: "batch contains a refused write-tool call; resend the other messages separately" } })));
      }
    }
    if (msgs.some((m) => m?.method === "initialize")) stats.inc("mcpSessions"), stats.ref(ref, "mcpSessions");
    stats.inc("mcpRequests");
    stats.ref(ref, "mcpRequests");
    const server = buildServer({ tools: readOnly ? readOnlyTools() : RTOOLS, version: VERSION, readOnly });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    for (const [k, v] of Object.entries(LABEL_HEADER)) res.setHeader(k, v);
    res.setHeader("access-control-allow-origin", "*");
    await server.connect(transport);
    if (!TESTNET) {
      // Base mainnet: reword the authored catalog (initialize / *list), never tool-call results.
      const ms = Array.isArray(parsed) ? parsed : [parsed];
      if (ms.every((m) => /^(initialize|tools\/list|prompts\/list|resources\/list)$/.test(m?.method ?? ""))) {
        const end = res.end.bind(res);
        const tx = (c) => (typeof c === "string" ? netCopy(c) : c instanceof Uint8Array ? Buffer.from(netCopy(Buffer.from(c).toString("utf8"))) : c);
        const writeHead = res.writeHead.bind(res);
        // reworded body length differs: drop content-length so node frames the response itself
        res.writeHead = (st, ...a) => {
          res.removeHeader("content-length");
          for (const h of a) if (h && typeof h === "object" && !Array.isArray(h)) for (const k of Object.keys(h)) if (k.toLowerCase() === "content-length") delete h[k];
          return writeHead(st, ...a);
        };
        const write = res.write.bind(res);
        res.write = (c, ...a) => write(tx(c), ...a);
        res.end = (c, ...a) => end(tx(c), ...a);
      }
    }
    await transport.handleRequest(req, res, parsed);
  }

  const toolCtx = {
    exchange,
    exchangeHireX402: async (a) => {
      const r = await exchangeHireX402(a);
      if (r.status !== 201 && r.status !== 402) throw new ExchangeError(r.status, r.body?.error ?? "hire failed", r.body);
      return r.status === 402 ? { status: "payment-required", ...r.body } : r.body;
    },
    router, quote, openJob: (a) => import("../mcp/tools.mjs").then((m) => m.openJob(a)), jobStatus, verifyDocument, evaluatorReputation };
  const RTOOLS = routerTools(toolCtx);
  const A2A_ADVERTISED = RTOOLS.map((t) => t.name);
  const exchangeHttp = makeExchangeHttp({
    exchange, json, send: send_, stats, version: VERSION, links, mcpTools: () => RTOOLS,
    readBody: readBodyBuf, hireX402: exchangeHireX402, afterFunding, afterDeliverable: (id) => afterDeliverable(id),
  });
  const A2A_SKILLS = {
    ...Object.fromEntries(RTOOLS.map((t) => [t.name, (i) => t.handler(i ?? {})])),
    // legacy (unadvertised) aliases kept for v0.4 clients
    quote: (i) => quote(i),
    get_job_status: async (i) => {
      const st = await jobStatus(i.jobId);
      return st?.exists === false ? st : { ...st, ...proofLinks(String(i.jobId)) };
    },
    get_evaluator_reputation: (i) => evaluatorReputation(i.evaluator),
    verify_attestation: (i) => verifyDocument(typeof i.document === "string" ? JSON.parse(i.document) : i.document, { expectedSigner: i.expectedSigner }),
  };

  // ---- router ----
  async function handle(req, res) {
    const u = new URL(req.url, "http://x");
    const p = u.pathname.replace(/\/+$/, "") || "/";
    const ip = clientIp(req, cfg.trustProxy);
    const ref = parseRef(u.searchParams.get("ref") ?? req.headers["x-agentcoin-ref"]);
    if (ref) {
      stats.ref(ref, "requests");
      const hit = { "/QUICKSTART-AGENTS.md": "quickstart", "/llms.txt": "llms", "/.well-known/agent-card.json": "agentCard", "/openapi.json": "openapi" }[p];
      if (hit && req.method === "GET") stats.ref(ref, hit);
    }
    stats.request({ userAgent: req.headers["user-agent"], referer: req.headers["referer"], endpoint: `${req.method} ${endpointLabel(p)}`.slice(0, 80) });
    if (!TESTNET && (req.method === "GET" || req.method === "HEAD") && COPY_ROUTES.test(p)) res.__copy = true;
    if (req.method === "OPTIONS") return send_(res, 204, "", "text/plain", { "access-control-allow-methods": "GET, HEAD, POST, OPTIONS", "access-control-allow-headers": "content-type, payment-signature, mcp-protocol-version, accept, x-agentcoin-ref" });
    if (req.method === "HEAD" && p === "/v1/notarize") {
      const ch = await resolveEvaluator(u.searchParams.get("evaluator"));
      if (ch.error) return json(res, 400, { error: ch.error, evaluators: links.evaluators });
      const cr = critFrom(u);
      if (cr.error) return json(res, 400, { error: cr.error });
      stats.inc("paymentRequired402");
      stats.ref(ref, "paymentRequired402");
      const pr = await paymentRequired("PAYMENT-SIGNATURE header is required", ch.ev, cr.crit);
      return json(res, 402, pr, { "PAYMENT-REQUIRED": b64(label(headerPR(pr))) });
    }
    if ((req.method === "GET" || req.method === "HEAD") && p === "/icon.png") return sendIcon(res);
    if ((req.method === "GET" || req.method === "HEAD") && SITE_ROUTES[p.replace(/\/+$/, "")]) {
      // informational human site (static HTML; fee numbers come from exchange.fees())
      const sctx = { base: URL_("").replace(/\/$/, ""), fees: exchange.fees(), links, version: VERSION, alt: BRAND_ALT, live: liveSnapshot(), ...(TESTNET ? {} : { caps: { maxPerJob: contracts().d?.maxPerJob ?? 50_000_000, maxTotalLocked: contracts().d?.maxTotalLocked ?? 500_000_000 } }) };
      const kind = negotiate(req.headers.accept, u.searchParams.get("format"));
      const hdr = { "cache-control": p === "/status" ? "public, max-age=30" : "public, max-age=300", vary: "Accept", link: linkHeader(sctx.base) };
      if (kind !== "html") { const m = sitePageMachine(p, sctx, kind); if (!TESTNET) res.__copy = true; return send_(res, 200, m.body, m.type, hdr); }
      return send_(res, 200, sitePageHtml(p, sctx), "text/html; charset=utf-8", hdr);
    }
    if ((req.method === "GET" || req.method === "HEAD") && p === "/privacy") return send_(res, 200, privacyPage(), "text/html; charset=utf-8", { "cache-control": "public, max-age=3600" });
    if ((req.method === "GET" || req.method === "HEAD") && FONT_FILES[p]) {
      // self-hosted site fonts (static whitelist; hashed names are immutable)
      const b = readFont(AGENT_DIR, p);
      res.writeHead(200, { "content-type": b.type, "cache-control": b.immutable ? "public, max-age=31536000, immutable" : "public, max-age=86400", "access-control-allow-origin": "*", ...LABEL_HEADER, "content-length": String(b.buf.length) });
      return res.end(req.method === "HEAD" ? undefined : b.buf);
    }
    if ((req.method === "GET" || req.method === "HEAD") && BRAND_FILES[p]) {
      // AD-012 brand assets (static whitelist)
      const b = readBrand(AGENT_DIR, p);
      res.writeHead(200, { "content-type": b.type, "cache-control": "public, max-age=3600", "access-control-allow-origin": "*", ...LABEL_HEADER, "content-length": String(b.buf.length) });
      return res.end(b.buf);
    }
    if ((req.method === "GET" || req.method === "HEAD") && JOB_FILES[p]) {
      // bbv-job1 deliverable (static whitelist, before the free-request cap)
      const b = readJob(AGENT_DIR, p);
      res.writeHead(200, { "content-type": b.type, "cache-control": "public, max-age=3600", "access-control-allow-origin": "*", ...LABEL_HEADER, "content-length": String(b.buf.length) });
      return res.end(b.buf);
    }
    if ((req.method === "GET" || req.method === "HEAD") && (p === "/specs/criteria/notarize-binding-v1.json" || p === "/specs/criteria/notarize-binding-v1.sha256")) {
      // pinned criteria spec: immutable bytes from agent/criteria/; the .sha256 alias is computed from those exact bytes
      const buf = readFileSync(path.join(AGENT_DIR, "criteria", "notarize-binding-v1.json"));
      const isDigest = p.endsWith(".sha256");
      const out = isDigest ? Buffer.from("0x" + createHash("sha256").update(buf).digest("hex") + "\n") : buf;
      res.writeHead(200, { "content-type": isDigest ? "text/plain; charset=utf-8" : "application/json", "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*", "content-length": String(out.length) });
      return res.end(req.method === "HEAD" ? undefined : out);
    }
    if (!TESTNET && (req.method === "GET" || req.method === "HEAD") && p === "/risks") return send_(res, 200, risksPage(), "text/html; charset=utf-8", { "cache-control": "public, max-age=600" });
    if ((req.method === "GET" || req.method === "HEAD") && (p === "/.well-known/security.txt" || p === "/security.txt")) return send_(res, 200, securityTxt(), "text/plain; charset=utf-8", { "cache-control": "public, max-age=86400" });
    if ((req.method === "GET" || req.method === "HEAD") && p === "/robots.txt") return send_(res, 200, "User-agent: *\nAllow: /\n", "text/plain; charset=utf-8", { "cache-control": "public, max-age=3600" });
    if ((req.method === "GET" || req.method === "HEAD") && p === "/.well-known/agents.json") {
      // factual index of discovery URLs; optional state-dir files are listed only when they exist
      const d = { v: "agentkoin-discovery-index/v1", name: "AgentKoin", testnet: TESTNET, discovery: { agentCard: URL_("/.well-known/agent-card.json"), mcpServerCard: URL_("/.well-known/mcp/server-card.json"), openapi: URL_("/openapi.json"), x402: URL_("/.well-known/x402"), jwks: URL_("/.well-known/jwks.json"), trustManifest: URL_("/.well-known/agentcoin-trust.json"), llms: URL_("/llms.txt"), exchange: URL_("/.well-known/agentcoin-exchange.json"), exchangeLlms: URL_("/exchange/llms.txt"), exchangeOpenapi: URL_("/exchange/openapi.json"), exchangeAgentCard: URL_("/exchange/.well-known/agent-card.json") } };
      if (existsSync(path.join(cfg.stateDir, "concordium-agent-card.json"))) d.discovery.concordiumAgentCard = URL_("/.well-known/concordium-agent-card.json");
      d.criteria = { notarizeBindingV1: { specId: "agentkoin-notarize-binding-criteria/v1", url: URL_("/specs/criteria/notarize-binding-v1.json"), sha256: "0x" + createHash("sha256").update(readFileSync(path.join(AGENT_DIR, "criteria", "notarize-binding-v1.json"))).digest("hex"), digestUrl: URL_("/specs/criteria/notarize-binding-v1.sha256") } };
      if (readTrust(cfg.stateDir, "json")) d.discovery.trustJobs = URL_("/trust/jobs.json");
      return json(res, 200, d, { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
    }
    if ((req.method === "GET" || req.method === "HEAD") && p === "/.well-known/concordium-agent-card.json") {
      // Agent Card for the Concordium Agent Registry badge. The exact bytes live in the state dir (the registry commits to their sha256),
      // so the card can be updated (e.g. after the badge token id is known) without a redeploy. 404 until the file exists.
      const f = path.join(cfg.stateDir, "concordium-agent-card.json");
      if (!existsSync(f)) return json(res, 404, { error: "no Concordium agent card published" });
      const buf = readFileSync(f);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", "access-control-allow-origin": "*", "content-length": String(buf.length), ...LABEL_HEADER });
      return res.end(req.method === "HEAD" ? undefined : buf);
    }
    if ((req.method === "GET" || req.method === "HEAD") && (p === "/trust" || p === "/trust/" || p === "/trust/jobs.json" || p === "/trust.json")) {
      // job table + machine-readable twin; files in the state dir (trust/index.html, trust/jobs.json)
      const asJson = p.endsWith(".json") || !wantsHtml(req.headers.accept, u.searchParams.get("format"));
      let buf = readTrust(cfg.stateDir, asJson ? "json" : "html");
      if (asJson && exchange.trustRows().length) {
        // Exchange hook (spec section 8): annotate jobs with exchange_listing_id + agent_ids; live Exchange jobs not yet in the generated table are appended
        let doc = null;
        try {
          doc = buf ? JSON.parse(buf.toString("utf8")) : null;
        } catch {}
        buf = Buffer.from(JSON.stringify(exchange.mergeTrust(doc), null, 2) + "\n");
      }
      if (!asJson) {
        // v3 site template: render the table from the same document /trust/jobs.json serves (Exchange rows merged); the
        // generated trust/index.html stays the fallback when there is no usable jobs.json
        let doc = null;
        try {
          const jb = readTrust(cfg.stateDir, "json");
          doc = jb ? JSON.parse(jb.toString("utf8")) : null;
          if (doc && exchange.trustRows().length) doc = exchange.mergeTrust(doc);
        } catch { doc = null; }
        if (doc && Array.isArray(doc.jobs) && doc.jobs.length) buf = Buffer.from(trustPageHtml(doc, { version: VERSION, alt: BRAND_ALT, page: u.searchParams.get("page") ?? 1 }));
      }
      if (!buf) return json(res, 404, { error: "no trust page published" });
      res.writeHead(200, { "content-type": asJson ? "application/json" : "text/html; charset=utf-8", "cache-control": "public, max-age=300", vary: "Accept", "access-control-allow-origin": "*", "content-length": String(buf.length), ...LABEL_HEADER });
      return res.end(req.method === "HEAD" ? undefined : buf);
    }
    if ((req.method === "GET" || req.method === "HEAD") && (p === "/free" || p === "/free/" || p === "/free.json")) {
      if (!TESTNET) return json(res, 404, { error: "not_found", reason: { code: "NO_FREE_OFFER", detail: "no free USDC offer on Base mainnet" } });
      const o = freeOffer({ baseUrl: cfg.publicUrl });
      if (p === "/free.json" || !wantsHtml(req.headers.accept, u.searchParams.get("format"))) return json(res, 200, o, { "cache-control": "public, max-age=300", vary: "Accept" });
      return send_(res, 200, freeHtml(o), "text/html; charset=utf-8", { "cache-control": "public, max-age=300", vary: "Accept" });
    }
    if ((req.method === "GET" || req.method === "HEAD") && p === "/.well-known/x402") {
      if (req.method === "HEAD") {
        const buf = await wellKnownX402Buf();
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "content-length": String(buf.length), ...LABEL_HEADER });
        return res.end();
      }
      return sendWellKnownX402(res);
    }
    const fr = caps.checkFree(ip);
    if (!fr.ok) {
      stats.inc("capRejections");
      return json(res, 429, { error: fr.reason }, { "retry-after": String(fr.retryAfterSeconds) });
    }
    try {
      if (/^\/exchange(\/|$)|^\/\.well-known\/agent(coin|koin)-exchange\.json$/.test(p)) {
        await registerExchangeSeeds();
        if (await exchangeHttp(req, res, { u, p, ip, ref })) return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && p === "/") {
        // AD-012: browsers (Accept prefers text/html) get the landing page; everything else the unchanged JSON index.
        // HEAD gets the same headers as GET (Node drops the body on HEAD).
        if (negotiate(req.headers.accept, u.searchParams.get("format")) === "md" && !u.searchParams.get("format")?.includes("json")) { const m = sitePageMachine("/agents", { base: URL_("").replace(/\/$/, ""), fees: exchange.fees(), links, version: VERSION, alt: BRAND_ALT }, "md"); return send_(res, 200, m.body, m.type, { vary: "Accept", link: linkHeader(URL_("").replace(/\/$/, "")) }); }
        if (wantsHtml(req.headers.accept, u.searchParams.get("format"))) return send_(res, 200, landingHtml({ links, version: VERSION, alt: BRAND_ALT, ...landingLive() }), "text/html; charset=utf-8", { vary: "Accept", link: linkHeader(URL_("").replace(/\/$/, "")) });
        return json(res, 200, { service: TESTNET ? "AgentKoin testnet service" : "AgentKoin service", version: VERSION, network: NETWORK, chainId: CHAIN_ID, links, index: router.stats(), paidEndpoints: [{ url: links.notarize, method: "POST", price: cfg.price.toString(), asset: TESTNET ? "test USDC (6 decimals)" : "USDC (6 decimals)" }], formerly: "AgentCoin" }, { vary: "Accept", link: linkHeader(URL_("").replace(/\/$/, "")) });
      }
      if (req.method === "GET") {
        if (p === "/healthz") return json(res, 200, { ok: true });
        if (p === "/v1/notarize") {
          const ch = await resolveEvaluator(u.searchParams.get("evaluator"));
          if (ch.error) return json(res, 400, { error: ch.error, evaluators: links.evaluators });
          const cr = critFrom(u);
          if (cr.error) return json(res, 400, { error: cr.error });
          stats.inc("paymentRequired402");
          stats.ref(ref, "paymentRequired402");
          const pr = await paymentRequired("PAYMENT-SIGNATURE header is required", ch.ev, cr.crit);
          return json(res, 402, pr, { "PAYMENT-REQUIRED": b64(label(headerPR(pr))) });
        }
        if (p === "/v1/evaluators") {
          const [block, full, ob] = await Promise.all([evaluatorsBlock(), evaluatorFullList().catch((e) => ({ minStake: null, statusCounts: null, all: null, allError: String(e.shortMessage ?? e.message).slice(0, 200) })), onboarding()]);
          return json(res, 200, { ...block, reference: { address: referenceEvaluator(), label: REFERENCE_EVALUATOR_LABEL }, listSemantics: "list = active evaluators selectable per job; all = every address that staked since the index start block plus labeled evaluators, with status", ...full, onboarding: ob, ...scanFreshness() });
        }
        if (p === "/v1/evaluators/onboarding") return json(res, 200, await onboarding());
        const evm = p.match(/^\/v1\/evaluators\/(0x[0-9a-fA-F]{40})$/);
        if (evm) {
          const a = getAddress(evm[1]);
          const snapshot = await evaluatorSnapshot(contracts(), a);
          return json(res, 200, { evaluator: a, escrow: contracts().escrow.address, registry: contracts().registry.address, snapshot, counts: repCache.get(a) ?? null, source: "JobEscrow.getJob(1..jobCount) read in the background every 10 min (null until indexed or no jobs); event-level evidence: MCP tool get_evaluator_reputation" });
        }
        if (p === "/llms.txt") return send_(res, 200, llms(), "text/plain; charset=utf-8");
        if (p === "/EVALUATORS.md") return send_(res, 200, docText("EVALUATORS.md"), "text/markdown; charset=utf-8");
        if (p === "/QUICKSTART-AGENTS.md") return send_(res, 200, docText("QUICKSTART-AGENTS.md"), "text/markdown; charset=utf-8");
        if (p === "/openapi.json") return json(res, 200, await openapi());
        if (p === "/.well-known/agent-card.json" || p === "/.well-known/agent.json") return rawJson(res, 200, artifact("agent-card.json"));
        if (p === "/.well-known/jwks.json") return rawJson(res, 200, artifact("jwks.json"));
        // signed artifact body is served unchanged; the onboarding pointer rides in a Link header (RFC 8288)
        if (p === "/.well-known/agentcoin-trust.json" || p === "/.well-known/agentkoin-trust.json") return rawJson(res, 200, artifact("trust-manifest.json"), { link: `<${links.evaluatorOnboarding}>; rel="https://agentcoinhq.com/rel/evaluator-onboarding"; type="application/json"` });
        if (p === "/.well-known/agent-registration.json") return rawJson(res, 200, artifact("agent-registration.json"));
        if (p === "/.well-known/agent-registration.json.sig") return rawJson(res, 200, artifact("agent-registration.sig.json"));
        if (p === "/.well-known/mcp/server-card.json" || p === "/.well-known/mcp") {
          const TOOLS = RTOOLS;
          const { LATEST_PROTOCOL_VERSION } = await import("@modelcontextprotocol/sdk/types.js");
          return json(res, 200, { serverInfo: { name: mcpServerName(NETWORK), title: "AgentKoin router + escrow (Base Sepolia testnet)", formerly: "AgentCoin", aliases: [mcpServerAlias(NETWORK)], version: VERSION, icons: [{ src: URL_("/brand/symbol-1024.png"), mimeType: "image/png", sizes: ["1024x1024"] }, { src: URL_("/brand/symbol.svg"), mimeType: "image/svg+xml", sizes: ["any"], theme: "light" }, { src: URL_("/brand/symbol-on-dark.svg"), mimeType: "image/svg+xml", sizes: ["any"], theme: "dark" }, { src: URL_("/icon-512.png"), mimeType: "image/png", sizes: ["512x512"] }] }, protocolVersion: LATEST_PROTOCOL_VERSION, transport: { type: "streamable-http", url: links.mcp }, capabilities: { tools: {} }, tools: TOOLS.map((t) => ({ name: t.name, description: t.config.description })), documentation: links.quickstart, repository: { url: links.repository, source: "github" } });
        }
        if (p === "/v1/faucets") return json(res, 200, TESTNET ? { faucets: FAUCETS, note: "pointers only; this service does not dispense tokens" } : { faucets: [], note: "Base mainnet: no faucets (real USDC)" });
        if (p === "/v1/stats") return json(res, 200, { ...stats.snapshot(), ...classifyPayers(stats.payers, internalAddrs()), demoBuyers: demoBuyers(), escrowDirect: await escrowDirectStats(), caps: caps.snapshot() });
        if (p === "/v1/caps") return json(res, 200, caps.snapshot());
        if (p === "/v1/agc" && agc.enabled) {
          // AD-010 reserve proof (free): reserve and supply read at one block
          const blockNumber = await publicClient.getBlockNumber();
          const readAt = (address, functionName, args, bn) => publicClient.readContract({ address, abi: AGC_ABI, functionName, args, blockNumber: bn });
          return json(res, 200, await agcReserve({ cfg: agc, usdc: contracts().usdc.address, readAt, blockNumber }));
        }
        if (p === "/v1/quote" && (u.searchParams.has("from") || u.searchParams.has("to"))) {
          // AD-009 FX quote (free). Without from/to the existing escrow fee quote below is served unchanged.
          const toAgc = agcQuoteParams(u.searchParams, agc, contracts().usdc.address); // AD-010: to=AGC quotes to USDC, then wrap 1:1
          const qp = parseQuoteParams(toAgc ? toAgc.params : u.searchParams, ma);
          if (qp.error) return json(res, 400, { error: qp.error });
          try {
            const q = await fxQuote(qp, { call: chainCall, cfg: ma });
            return json(res, 200, toAgc ? toAgc.decorate(quoteBook.put(q)) : quoteBook.put(q));
          } catch (e) {
            return json(res, e instanceof QuoteError ? 422 : 502, { error: "no quote", detail: String(e.shortMessage ?? e.message).slice(0, 200) });
          }
        }
        if (p === "/v1/quote") return json(res, 200, await quote({ amount: u.searchParams.get("amount") ?? cfg.price.toString() }));
        {
          const pm = p.match(/^\/v1\/jobs\/(\d+)\/proof$/) ?? null;
          const em = p.match(/^\/v1\/escrows\/(0x[0-9a-fA-F]{40})\/jobs\/(\d+)\/proof$/);
          if (pm || em) {
            const escrowAddr = em ? getAddress(em[1]) : contracts().escrow.address;
            if (!PROOF_ESCROWS[escrowAddr.toLowerCase()] && escrowAddr !== contracts().escrow.address) return json(res, 404, { error: "escrow is not a known AgentKoin JobEscrow deployment", known: Object.keys(PROOF_ESCROWS).map(getAddress) });
            const proof = await buildJobProof(escrowAddr, (em ?? pm)[em ? 2 : 1]);
            if (!proof) return json(res, 404, { error: "job does not exist on this escrow" });
            return json(res, 200, proof, { "cache-control": ["Settled", "Expired", "Cancelled"].includes(proof.job.state) ? "public, max-age=3600" : "no-store" });
          }
        }
        if (p.startsWith("/v1/jobs/")) {
          const jid = p.split("/")[3];
          const st = await jobStatus(jid);
          return json(res, 200, st?.exists === false ? st : { ...st, ...proofLinks(jid) });
        }
        // opt-in criteria mode: criteria documents (immutable, exact bytes) and byte-exact receipts (deliverables)
        const crm = p.match(/^\/v1\/criteria\/([0-9a-f]{64})$/);
        if (crm) {
          const hit = criteriaCache.get(crm[1]);
          let doc = hit?.document;
          if (!doc) {
            const jb = criteriaJobBySpec("0x" + crm[1]);
            if (jb) doc = criteriaOffer({ baseUrl: cfg.publicUrl, params: { digest: jb[1].criteria.digest, nonce: jb[1].criteria.nonce, id: jb[1].criteria.id }, chainId: CHAIN_ID, escrow: contracts().escrow.address }).document;
          }
          if (!doc) return json(res, 404, { error: "unknown criteria hash (offers are built from GET /v1/notarize?spec=" + CRITERIA_VOCABULARY + "&digest=0x..)" });
          return send_(res, 200, criteriaBytes(doc), "application/json", { "cache-control": "public, max-age=31536000, immutable", "x-criteria-sha256": crm[1] });
        }
        const dvm = p.match(/^\/v1\/deliverables\/([0-9a-z-]+)$/);
        if (dvm) {
          const pd = parseDeliverableId(dvm[1]);
          const jb = pd ? criteriaJob(pd.id) : null;
          if (!jb || !jb[1].receipt) return json(res, 404, { error: "no paid job for this deliverable id" });
          const body = deliverableBytes(jb[1].receipt);
          return send_(res, 200, body, "application/json", { "cache-control": "public, max-age=31536000, immutable", "content-length": String(body.length) });
        }
        // free, unpaid: must precede the /v1/notarize/{id} match
        if (p === "/v1/notarize/example") return json(res, 200, await exampleBody(u.searchParams.get("shape") === "post" ? "post" : "get"));
        if (p === "/v1/notarize/schema.json") return send_(res, 200, NOTARY_RESPONSE_SCHEMA_JCS, "application/schema+json", { "x-response-schema-hash": NOTARY_RESPONSE_SCHEMA_HASH }); // JCS bytes: sha256(body) == responseSchemaHash
        if (p.startsWith("/v1/notarize/")) {
          const id = p.split("/")[3];
          const j = jobs.get(id);
          if (!j) return json(res, 404, { error: "unknown jobId (only jobs opened through this service)" });
          if (j.kind === "exchange") return json(res, 404, { error: "this job is an AgentKoin Exchange order, not a notarize job", order: URL_(`/exchange/v1/orders/${j.exchange.orderId}`) });
          return json(res, 200, await statusBody(id, await backfillPayment(id, j)));
        }
        if (p === "/discovery/resources") return json(res, 200, { x402Version: 2, items: [{ resource: links.notarize, type: "http", x402Version: 2, accepts: [await exactRequirements()], lastUpdated: new Date().toISOString(), metadata: { ...resourceInfo(), bazaar: await bazaar() } }] });
        if (p === "/facilitator/supported") return json(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: `eip155:${CHAIN_ID}`, extra: { restriction: "AgentCoin EscrowDepositRoute payTo only; settle opens an escrow job", maxAmount: cfg.facilitatorMaxAmount.toString() } }], extensions: ["bazaar"], signers: { [`eip155:${CHAIN_ID}`]: [wallets().relayer.account.address] } });
        if (p === "/mcp" || p === "/mcp/readonly") return json(res, 405, { error: "use POST (stateless streamable HTTP, JSON responses)" }, { allow: "POST" });
        if (p === "/v1/services") {
          stats.inc("servicesSearch");
          const g = (k) => u.searchParams.get(k) ?? undefined;
          return json(res, 200, { ...router.search({ q: g("q"), protocol: g("protocol"), maxPrice: g("maxPrice"), minScore: g("minScore"), claimed: g("claimed"), network: g("network"), cursor: g("cursor"), limit: g("limit") }), agentcoin: router.footer({ verified: false, checks: {} }) });
        }
        let m;
        if ((m = p.match(/^\/v1\/services\/(svc_[0-9a-f]{16})$/))) return json(res, 200, { ...router.get(m[1], { skillsOffset: u.searchParams.get("skillsOffset"), skillsLimit: u.searchParams.get("skillsLimit") }), agentcoin: router.footer({ serviceId: m[1], verified: false, checks: {} }) });
        if ((m = p.match(/^\/v1\/reputation\/(svc_[0-9a-f]{16})$/))) return json(res, 200, await router.reputationWithFooter(m[1]));
        if ((m = p.match(/^\/v1\/orders\/(ord_[0-9a-f]{16})$/))) return json(res, 200, await router.getOrder(m[1]));
        if (p === "/.well-known/agentcoin-index.json" || p === "/.well-known/agentkoin-index.json") return json(res, 200, router.dump({ cursor: u.searchParams.get("cursor"), limit: u.searchParams.get("limit") }));
        return json(res, 404, { error: "not found", links });
      }
      if (req.method === "POST") {
        const body = await readBody(req, cfg.maxBody);
        if (p === "/mcp") return await handleMcp(req, res, body, ref);
        if (p === "/mcp/readonly") return await handleMcp(req, res, body, ref, { readOnly: true });
        if (p === "/v1/evaluators/profile" || p === "/v1/evaluators/canary") {
          if (!admitSubmit(ip)) return json(res, 429, { error: "submission cap per IP per hour reached" });
          let b;
          try {
            b = body ? JSON.parse(body) : {};
          } catch {
            return json(res, 400, { error: "body must be JSON" });
          }
          const r = await (p === "/v1/evaluators/profile" ? handleProfile : handleCanary)(b, onboardingDeps());
          stats.inc(p === "/v1/evaluators/profile" ? "evaluatorProfiles" : "canaryRequests");
          if (!r.ok) {
            const { ok, status, ...rest } = r;
            return json(res, status, { ...rest, docs: links.evaluatorDocs });
          }
          return json(res, r.status, r.body);
        }
        if (["/v1/route", "/v1/services", "/v1/orders"].includes(p) || /^\/v1\/(services|orders)\/(svc|ord)_[0-9a-f]{16}\/(claim|claim\/verify|receipt)$/.test(p)) {
          let b;
          try {
            b = body ? JSON.parse(body) : {};
          } catch {
            return json(res, 400, { error: "body must be JSON" });
          }
          if (typeof b !== "object" || b === null || Array.isArray(b)) return json(res, 400, { error: "body must be a JSON object" });
          if (p === "/v1/route") {
            stats.inc("routeCalls");
            stats.ref(ref, "routeCalls");
            return json(res, 200, await router.route(b));
          }
          if (p === "/v1/services") {
            if (!admitSubmit(ip)) return json(res, 429, { error: "submission cap per IP per hour reached" });
            stats.inc("servicesSubmitted");
            const r = await router.submit(b);
            return json(res, r.status === "created" ? 201 : 200, r);
          }
          if (p === "/v1/orders") {
            stats.inc("orders");
            stats.ref(ref, "orders");
            assertNotSanctioned([b?.buyer]); // OFAC SDN screen at order intake (403 OFAC_SDN_MATCH)
            return json(res, 201, await router.placeOrder(b));
          }
          const [, , kind, id, ...rest] = p.split("/");
          const tail = rest.join("/");
          if (kind === "services" && tail === "claim") return json(res, 200, await router.claimChallenge(id, b));
          if (kind === "services" && tail === "claim/verify") {
            const r = await router.claimVerify(id, b);
            stats.inc("claims");
            return json(res, 200, r);
          }
          if (kind === "orders" && tail === "receipt") {
            stats.inc("orderReceipts");
            return json(res, 200, await router.receipt(id, b));
          }
        }
        if (p === "/v1/notarize") {
          const hdr = req.headers["payment-signature"];
          if (!hdr) {
            const ch = await resolveEvaluator(u.searchParams.get("evaluator"));
            if (ch.error) return json(res, 400, { error: ch.error, evaluators: links.evaluators });
            const cr = critFrom(u);
            if (cr.error) return json(res, 400, { error: cr.error });
            stats.inc("paymentRequired402");
            stats.ref(ref, "paymentRequired402");
            const pr = await paymentRequired("PAYMENT-SIGNATURE header is required", ch.ev, cr.crit);
            return json(res, 402, pr, { "PAYMENT-REQUIRED": b64(label(headerPR(pr))) });
          }
          const input = parseNotarizeInput(body);
          if (input.error) return json(res, 400, { error: input.error });
          let pp;
          try {
            pp = unb64(String(hdr));
          } catch {
            return json(res, 400, { error: "PAYMENT-SIGNATURE is not base64 JSON" });
          }
          const scheme = pp?.accepted?.scheme;
          const choice = scheme === "agentcoin-escrow" ? { ev: null } : await resolveEvaluator(chosenFrom(u, pp));
          if (choice.error) return json(res, 400, { error: choice.error, evaluators: links.evaluators });
          const cr = critFrom(u, pp);
          if (cr.error) return json(res, 400, { error: cr.error });
          const crit = cr.crit;
          if (crit && crit.digest !== input.digest) return json(res, 400, { error: "request digest differs from the digest the criteria were built for (criteria.digest)", expectedDigest: crit.digest, requestDigest: input.digest });
          if (crit && !["exact", "agentcoin-escrow"].includes(scheme)) return json(res, 400, { error: "criteria mode supports accepted.scheme exact or agentcoin-escrow" });
          if (crit && scheme === "exact" && agc.enabled && pp?.accepted?.asset && getAddress(pp.accepted.asset) === agc.address) return json(res, 400, { error: "criteria mode does not support the AGC asset" });
          let settled, reservation;
          let payaiHdr = {};
          if (scheme === "exact" && agc.enabled && pp?.accepted?.asset && getAddress(pp.accepted.asset) === agc.address) {
            // AD-010 AGC exact: same verify/settle path, AGC token, AGC route factory and AGC JobEscrow
            const reqs = await agcExactEntry();
            const v = await verifyExactFull(pp, reqs, { address: agc.address, abi: AGC_ABI });
            if (!v.isValid) {
              stats.inc("paidCallsRejected");
              stats.inc("paymentRequired402");
              const pr = await paymentRequired(v.invalidReason);
              return json(res, 402, pr, { "PAYMENT-REQUIRED": b64(label(headerPR(pr))) });
            }
            const adm = caps.admitPaid(ip, v.payer, cfg.estLifecycleWei);
            if (!adm.ok) {
              stats.inc("capRejections");
              return json(res, 429, { error: adm.reason, caps: caps.snapshot() });
            }
            reservation = adm.reservation;
            try {
              settled = await relayedSettle(notaryOffer(), pp, reservation, { routeFactory: { address: agc.routeFactory, abi: ABI.routeFactory }, escrow: agcEscrowRef() });
              settled.payment = agcExactPaymentRecord({ cfg: agc, amount: reqs.amount, transaction: settled.transaction, jobId: settled.jobId });
            } catch (e) {
              caps.release(reservation, { ip, payer: v.payer });
              return json(res, 502, { error: "settle failed", detail: String(e.shortMessage ?? e.message).slice(0, 300) });
            }
          } else if (scheme === "exact") {
            const reqs = crit ? await exactRequirementsCrit(choice.ev, crit) : await exactRequirements(choice.ev);
            const v = crit && criteriaJob(crit.id) ? { isValid: false, invalidReason: "criteria id already used; choose a new nonce" } : await verifyExactFull(pp, reqs);
            if (!v.isValid && v.invalidReason === "authorization nonce already used") {
              const found = await findJobFromExactTransfer(pp, reqs);
              if (found?.jobId != null) {
                const adm = caps.admitPaid(ip, found.payer, cfg.estLifecycleWei - cfg.estSettleWei);
                if (!adm.ok) {
                  stats.inc("capRejections");
                  return json(res, 429, { error: adm.reason, caps: caps.snapshot() });
                }
                reservation = adm.reservation;
                settled = found;
              } else if (found?.pendingAttestation) {
                return json(res, 502, { error: "payment transferred to the deposit route but the escrow job is not open yet", settleTx: found.transaction });
              } else {
                stats.inc("paidCallsRejected");
                stats.inc("paymentRequired402");
                const pr = await paymentRequired(v.invalidReason, choice.ev, crit);
                return json(res, 402, pr, { "PAYMENT-REQUIRED": b64(label(headerPR(pr))) });
              }
            } else if (!v.isValid) {
              stats.inc("paidCallsRejected");
              stats.inc("paymentRequired402");
              const pr = await paymentRequired(v.invalidReason, choice.ev, crit);
              return json(res, 402, pr, { "PAYMENT-REQUIRED": b64(label(headerPR(pr))) });
            } else {
            payaiHdr = await alongPayaiVerify(pp, reqs);
            const adm = caps.admitPaid(ip, v.payer, cfg.estLifecycleWei);
            if (!adm.ok) {
              stats.inc("capRejections");
              return json(res, 429, { error: adm.reason, caps: caps.snapshot() });
            }
            reservation = adm.reservation;
            try {
              settled = await relayedSettle(notaryOffer(choice.ev, crit?.specHash), pp, reservation);
            } catch (e) {
              caps.release(reservation, { ip, payer: v.payer });
              return json(res, 502, { error: "settle failed", detail: String(e.shortMessage ?? e.message).slice(0, 300) });
            }
            }
          } else if (scheme === "agentcoin-escrow") {
            const v = await verifyEscrowJob(pp, crit);
            if (!v.isValid) {
              stats.inc("paidCallsRejected");
              const pr = await paymentRequired(v.invalidReason, null, crit);
              return json(res, 402, pr, { "PAYMENT-REQUIRED": b64(label(headerPR(pr))) });
            }
            const adm = caps.admitPaid(ip, v.payer, cfg.estLifecycleWei - cfg.estSettleWei);
            if (!adm.ok) {
              stats.inc("capRejections");
              return json(res, 429, { error: adm.reason, caps: caps.snapshot() });
            }
            reservation = adm.reservation;
            settled = v;
            stats.inc("jobsOpened");
          } else if (scheme === "agentcoin-swap" && ma.enabled) {
            const v = await verifySwapPayload(pp, { book: quoteBook, cfg: ma, offer: swapOffer(choice.ev), chainId: CHAIN_ID });
            if (!v.isValid || !quoteBook.markUsed(v.hash)) {
              stats.inc("paidCallsRejected");
              const pr = await paymentRequired(v.isValid ? "quote already used by this buyer" : v.invalidReason);
              return json(res, 402, pr, { "PAYMENT-REQUIRED": b64(label(headerPR(pr))) });
            }
            const adm = caps.admitPaid(ip, v.payer, cfg.estLifecycleWei);
            if (!adm.ok) {
              stats.inc("capRejections");
              return json(res, 429, { error: adm.reason, caps: caps.snapshot() });
            }
            reservation = adm.reservation;
            try {
              settled = await relayedSwapSettle(v, reservation);
            } catch (e) {
              caps.release(reservation, { ip, payer: v.payer });
              return json(res, 502, { error: "settle failed (authorization not consumed if the tx reverted)", detail: String(e.shortMessage ?? e.message).slice(0, 300) });
            }
            if (settled.refunded) {
              caps.release(reservation, { ip, payer: v.payer });
              stats.inc("paidCallsRejected");
              const pr = await paymentRequired("swap failed; tokenIn returned to buyer in the same transaction");
              return json(res, 402, { ...pr, refund: { transaction: settled.transaction, payer: settled.payer, asset: v.quote.from.asset, amount: v.quote.maxIn } }, { "PAYMENT-REQUIRED": b64(label(headerPR(pr))) });
            }
          } else {
            return json(res, 400, { error: `accepted.scheme must be exact or agentcoin-escrow${ma.enabled ? " or agentcoin-swap" : ""}` });
          }
          stats.payer(settled.payer);
          stats.inc("paidCalls");
          stats.ref(ref, "paidCalls");
          stats.ref(ref, "jobsOpened"); // every paid call opens exactly one escrow job
          try {
            const out = await deliver(input, settled, reservation, crit);
            const pr = { success: true, transaction: settled.transaction, network: `eip155:${CHAIN_ID}`, payer: settled.payer, jobId: settled.jobId.toString(), ...(settled.payment ? { payment: settled.payment } : {}), ...VALUE_LABEL };
            const footer = await notaryFooter(out.jobId, out.receipt, out.receiptSignature);
            return json(res, 200, { ...out, agentcoin: settled.payment ? { ...footer, payment: settled.payment } : footer }, { "PAYMENT-RESPONSE": b64(pr), ...payaiHdr });
          } catch (e) {
            jobs.put(settled.jobId, { status: "failed", error: String(e.shortMessage ?? e.message).slice(0, 200), ...(e?.submitTxInFlight ? { submitTxInFlight: e.submitTxInFlight } : {}) });
            return json(res, 502, { error: "delivery failed after payment; the escrow job stays Funded and the client can claim a refund after the deadline", jobId: settled.jobId.toString(), settleTx: settled.transaction });
          } finally {
            stats.flush();
          }
        }
        if (p === "/facilitator/verify" || p === "/facilitator/settle") {
          let b;
          try {
            b = JSON.parse(body);
          } catch {
            return json(res, 400, { error: "body must be JSON {x402Version, paymentPayload, paymentRequirements}" });
          }
          const { paymentPayload, paymentRequirements } = b ?? {};
          stats.inc(p.endsWith("verify") ? "facilitatorVerify" : "facilitatorSettle");
          const rc = await factoryRouteCheck(paymentRequirements).catch((e) => ({ ok: false, reason: String(e.shortMessage ?? e.message).slice(0, 200) }));
          if (!rc.ok) return json(res, 200, p.endsWith("verify") ? { isValid: false, invalidReason: rc.reason } : { success: false, errorReason: rc.reason, transaction: "", network: paymentRequirements?.network ?? null });
          const v = await verifyExactFull(paymentPayload, paymentRequirements);
          if (p.endsWith("verify")) {
            const hdr = v.isValid ? await alongPayaiVerify(paymentPayload, paymentRequirements) : {};
            return json(res, 200, v, hdr);
          }
          if (!v.isValid) return json(res, 200, { success: false, errorReason: v.invalidReason, transaction: "", network: paymentRequirements.network, payer: v.payer });
          const adm = caps.admitPaid(ip, v.payer, cfg.estSettleWei);
          if (!adm.ok) {
            stats.inc("capRejections");
            return json(res, 429, { success: false, errorReason: adm.reason, transaction: "", network: paymentRequirements.network });
          }
          try {
            const s = await relayedSettle(rc.offer, paymentPayload, adm.reservation);
            stats.payer(s.payer);
            return json(res, 200, { success: true, transaction: s.transaction, network: paymentRequirements.network, payer: s.payer, jobId: s.jobId.toString() });
          } catch (e) {
            caps.release(adm.reservation, { ip, payer: v.payer });
            return json(res, 200, { success: false, errorReason: String(e.shortMessage ?? e.message).slice(0, 200), transaction: "", network: paymentRequirements.network });
          }
        }
        if (p === "/v1/optout") {
          // do-not-contact for the door-knocker: {"match": "<your A2A endpoint URL | host | erc8004:84532:<agentId>>"}
          let b;
          try {
            b = JSON.parse(body);
          } catch {
            return json(res, 400, { error: 'body must be JSON {"match": "<A2A endpoint URL, host, or erc8004:84532:<agentId>>"}' });
          }
          const match = typeof b?.match === "string" ? b.match.trim() : "";
          if (!match || match.length > 300) return json(res, 400, { error: "match must be a non-empty string (<=300 chars)" });
          recordOptOut(cfg.stateDir, match);
          const del = router.optOut(match);
          const exRemoved = exchange.optOut(match);
          if (exRemoved) del.delisted.push(`exchange:${exRemoved}`);
          stats.ref(ref, "optouts");
          if (del.delisted.length) stats.inc("optoutDelists");
          return json(res, 200, { ok: true, match, matchKind: del.kind, delisted: del.delisted, effect: "no AgentCoin door-knocker messages will be sent to this match; matching index listings are removed now and excluded from future imports" });
        }
        if (p === "/a2a/v1/message:send") {
          let b;
          try {
            b = JSON.parse(body);
          } catch {
            return json(res, 400, { error: "body must be JSON" });
          }
          const optPart = (b?.message?.parts ?? []).find((x) => x?.data?.agentcoin === "opt-out");
          if (optPart) {
            const m = String(optPart.data.match ?? "").trim();
            let delisted = [];
            if (m && m.length <= 300) {
              recordOptOut(cfg.stateDir, m);
              delisted = router.optOut(m).delisted;
            }
            return json(res, 200, { message: { role: "agent", messageId: `ac-${Date.now()}`, parts: [{ data: label({ ok: true, optedOut: m || null, delisted, note: m ? "recorded; matching index listings removed" : "include data.match (your A2A endpoint URL) so it can be honored" }), mediaType: "application/json" }] } });
          }
          const parts = b?.message?.parts ?? [];
          const part = parts.find((x) => x?.data ?? x?.kind === "data");
          let skill = part?.data?.skill ?? part?.data?.skillId;
          let input = part?.data?.arguments ?? part?.data?.input ?? {};
          if (!part) {
            const text = parts.map((x) => x?.text).filter((x) => typeof x === "string").join("\n").trim();
            if (!text) return json(res, 400, { error: `message needs a data part {skill, arguments} (skills: ${A2A_ADVERTISED.join(", ")}) or a text part (routed as route_task)` });
            skill = "route_task";
            input = { task: text.slice(0, 2000) };
          }
          const fn = A2A_SKILLS[skill];
          if (!fn) return json(res, 400, { error: `unknown skill; one of ${A2A_ADVERTISED.join(", ")}` });
          stats.inc(`a2a_${skill}`);
          const out = label(await fn(input ?? {}));
          return json(res, 200, { message: { role: "agent", messageId: `ac-${Date.now()}`, parts: [{ data: out, mediaType: "application/json" }] } });
        }
        return json(res, 404, { error: "not found" });
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (e) {
      if (e instanceof RouterError || e instanceof ExchangeError) return json(res, e.status, { error: e.message, ...e.extra });
      return json(res, e.status ?? 500, { error: e.status ? e.message : "internal error", detail: e.status ? undefined : String(e.shortMessage ?? e.message).slice(0, 200), ...(e.reason ? { reason: e.reason } : {}) });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      try {
        json(res, 500, { error: "internal error" });
      } catch {}
    });
  });
  let timer = null, probeTimer = null;
  return {
    server,
    caps,
    stats,
    jobs,
    tick,
    links,
    router,
    tools: RTOOLS,
    registerNotarySeed,
    probeSeeds,
    exchange,
    registerExchangeSeeds,
    exchangeHireX402,
    runExchangeSeed,
    get notarySeedId() {
      return notarySeedId;
    },
    get lastTickError() {
      return lastTickError;
    },
    startLoop() {
      // Kick the job index immediately. setInterval alone waits loopMs (20s), and a 402 in that
      // window (or one cached for 60s) served trackRecord: null for every evaluator after a deploy.
      refreshEvaluatorIndex().catch(() => {});
      timer = setInterval(tick, cfg.loopMs);
      timer.unref?.();
      probeSeeds().catch(() => {});
      probeTimer = setInterval(() => probeSeeds().catch(() => {}), cfg.probeMs);
      probeTimer.unref?.();
    },
    ccd, buildJobProof, // Concordium anchor queue (null when the flag is off); exposed for tests and the backfill script
    stop() {
      if (ccdTimer) clearInterval(ccdTimer);
      if (timer) clearInterval(timer);
      if (probeTimer) clearInterval(probeTimer);
      stats.flush();
      return new Promise((r) => server.close(() => r())).finally(() => {
        if (!opts.router) router.close();
      });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await assertChain();
  const app = createApp();
  const seed = app.router.importSeed();
  console.log(`router: ${JSON.stringify(seed)}; ${JSON.stringify(app.router.stats()).slice(0, 300)}`);
  const host = process.env.SERVICE_HOST ?? "127.0.0.1"; // containers: SERVICE_HOST=0.0.0.0 behind the platform proxy
  app.server.listen(CONFIG.port, host, () => {
    console.log(`AgentKoin ${NETWORK} service v${VERSION} on http://${host}:${CONFIG.port} (public URL ${CONFIG.publicUrl}); relayer ${wallets().relayer.account.address}`);
  });
  app.startLoop();
  const bye = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
