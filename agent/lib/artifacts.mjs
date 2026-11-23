// Builders for the agent-facing artifacts. All content is derived from chain state or repo files;
// nothing is asserted that cannot be re-checked by lib/verify.mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAddress } from "viem";
import { publicClient, contracts, read } from "./chain.mjs";
import { ROOT, CHAIN_ID, PUBLIC_BASE_URL, NETWORK, NET, VALUE_LABEL } from "./config.mjs";
import { configToJson, evaluatorSnapshot, codeHashes, manifestContracts, NO_ARBITRATOR_TEXT } from "./protocol.mjs";
import { sha256Hex } from "./canonical.mjs";
import { signEip191, signAgentCard, jwksFor } from "./sign.mjs";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

export const URLS = {
  base: PUBLIC_BASE_URL,
  registration: `${PUBLIC_BASE_URL}/.well-known/agent-registration.json`,
  agentCard: `${PUBLIC_BASE_URL}/.well-known/agent-card.json`,
  jwks: `${PUBLIC_BASE_URL}/.well-known/jwks.json`,
  trustManifest: `${PUBLIC_BASE_URL}/.well-known/agentcoin-trust.json`,
  trustManifestSchema: `${PUBLIC_BASE_URL}/schemas/trust-manifest-0.1.json`,
  quote: `${PUBLIC_BASE_URL}/v1/quote`,
  demoResource: `${PUBLIC_BASE_URL}/v1/demo/resource`,
  discovery: `${PUBLIC_BASE_URL}/discovery/resources`,
  notarize: `${PUBLIC_BASE_URL}/v1/notarize`,
  quickstart: `${PUBLIC_BASE_URL}/QUICKSTART-AGENTS.md`,
  llms: `${PUBLIC_BASE_URL}/llms.txt`,
  stats: `${PUBLIC_BASE_URL}/v1/stats`,
  mcpHttp: `${PUBLIC_BASE_URL}/mcp`,
  mcpReadOnly: `${PUBLIC_BASE_URL}/mcp/readonly`,
  exchange: `${PUBLIC_BASE_URL}/.well-known/agentkoin-exchange.json`,
  exchangeCard: `${PUBLIC_BASE_URL}/exchange/.well-known/agent-card.json`,
  exchangeLlms: `${PUBLIC_BASE_URL}/exchange/llms.txt`,
  earn: `${PUBLIC_BASE_URL}/exchange/earn.md`,
  terms: `${PUBLIC_BASE_URL}/terms`,
  mcp: "stdio:node agent/mcp/server.mjs",
};

const LOCAL = NETWORK === "local";
const MAINNET = NETWORK === "base"; // Base mainnet wording; testnet/local strings below are unchanged
// AGENTCOIN_HOSTED=1: AGENTCOIN_BASE_URL is a live public URL of agent/service/app.mjs. Otherwise artifacts state
// that HTTP endpoints are not publicly hosted and list only what an outside agent can reach (contracts, Sourcify ABIs).
export const HOSTED = process.env.AGENTCOIN_HOSTED === "1" && !LOCAL;
const feeText = (cfg) => `Protocol fee ${Number(cfg.feeBps) / 100}% and evaluator fee ${Number(cfg.evaluatorFeeBps) / 100}% of provider payout (escrow config read on chain).`;
const fileHash = (rel) => ({ path: rel, sha256: sha256Hex(readFileSync(path.join(ROOT, rel))) });

/** Operator-signed, individually verifiable claim about on-chain state at a block. */
export async function attestation(claim, privateKey) {
  return signEip191({ v: "agentcoin-attestation/0.1", chainId: CHAIN_ID, ...claim }, privateKey);
}

// keccak256 of empty bytecode: the code hash an address with no code has (EIP-1052 semantics aside).
export const EMPTY_CODE_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

/** evaluators: [address] or [{ address, label, operator, role, default }]. Labels go to limitations (the 0.1 schema has no label fields). */
export async function buildTrustManifest({ operator, agentId, evaluators }) {
  const c = contracts();
  const blockNumber = await publicClient.getBlockNumber();
  // Base mainnet deploys no ERC8183EvaluatorAdapter (c.adapter.address null): adapter fields are omitted there.
  const hasAdapter = !!c.adapter?.address;
  const [adapterCfgVersion, adapterCfg, slasherTimelock] = await Promise.all([
    hasAdapter ? read(c.adapter, "currentConfigVersion") : null,
    hasAdapter ? read(c.adapter, "currentConfig") : null,
    read(c.registry, "slasherTimelock"),
  ]);
  const adapterRequired = hasAdapter ? await read(c.adapter, "requiredExpiryDuration", [adapterCfgVersion]) : null;
  const [cfgVersion, escrowCfg, regCfg, treasury, arbitrator] = await Promise.all([
    read(c.escrow, "currentConfigVersion"),
    read(c.escrow, "currentConfig"),
    read(c.registry, "config"),
    read(c.escrow, "treasury"),
    read(c.escrow, "arbitrator"),
  ]);
  const noArb = BigInt(arbitrator) === 0n;
  // the arbitrator listed is the escrow's live arbitrator(), not the deployment record
  const arbFee = noArb ? null : await publicClient.readContract({ ...c.arbitrator, address: arbitrator, functionName: "arbitrationCost", args: [0n, 0n] });
  const hashes = await codeHashes({ ...c, arbitrator: { ...c.arbitrator, address: noArb ? null : arbitrator } });
  const evs = [];
  const atts = [];
  const labeled = evaluators.map((e) => (typeof e === "string" ? { address: e } : e));
  for (const { address: e } of labeled) {
    const snap = await evaluatorSnapshot(c, e);
    evs.push({ ...snap, snapshotBlock: blockNumber.toString() });
    atts.push(
      await attestation({ type: "evaluator-stake", subject: snap.address, contract: c.registry.address, blockNumber: blockNumber.toString(), claim: { stake: snap.stake, active: snap.active, slashedTotal: snap.slashedTotal } }, operator.privateKey),
    );
  }
  for (const [name, codeHash] of Object.entries(hashes)) {
    if (codeHash === undefined) continue;
    const address = manifestContracts(c)[name].address;
    atts.push(await attestation({ type: "contract-code", subject: address, blockNumber: blockNumber.toString(), claim: { name, codeHash } }, operator.privateKey));
  }
  const manifest = {
    $schema: URLS.trustManifestSchema,
    v: "agentcoin-trust/0.1",
    issuer: getAddress(operator.address),
    agent: c.identity.address && agentId != null ? { agentRegistry: `eip155:${CHAIN_ID}:${c.identity.address}`, agentId: String(agentId) } : null,
    chainId: CHAIN_ID,
    network: `eip155:${CHAIN_ID}`,
    issuedAt: new Date().toISOString(),
    snapshotBlock: blockNumber.toString(),
    contracts: {
      escrow: { address: c.escrow.address, codeHash: hashes.escrow },
      evaluatorRegistry: { address: c.registry.address, codeHash: hashes.evaluatorRegistry },
      token: LOCAL
        ? { address: c.usdc.address, codeHash: hashes.token, symbol: "mUSDC", decimals: 6, note: "MockUSDC test token, not Circle USDC" }
        : { address: c.usdc.address, codeHash: hashes.token, symbol: "USDC", decimals: 6, note: MAINNET ? "Circle USDC on Base; proxy contract, codeHash is of the proxy" : "Circle test USDC on Base Sepolia (testnet, no value); proxy contract, codeHash is of the proxy" },
      arbitrator: noArb
        ? { address: arbitrator, codeHash: EMPTY_CODE_HASH, kind: NO_ARBITRATOR_TEXT }
        : { address: arbitrator, codeHash: hashes.arbitrator, kind: "MockArbitrator (owner-ruled stub for Kleros/UMA)" },
      ...(c.identity.address ? { identityRegistry: { address: c.identity.address, codeHash: hashes.identityRegistry, kind: LOCAL ? "MockIdentityRegistry (ERC-8004 subset, local)" : "ERC-8004 IdentityRegistry (official erc-8004-contracts deployment; upgradeable proxy, codeHash is of the proxy)" } } : {}),
      ...(hasAdapter ? { evaluatorAdapter: { address: c.adapter.address, codeHash: hashes.evaluatorAdapter, kind: "ERC8183EvaluatorAdapter (staked evaluator for external ERC-8183 kernels)" } } : {}),
      depositRouteFactory: { address: c.routeFactory.address, codeHash: hashes.depositRouteFactory, kind: "EscrowDepositRouteFactory (x402 exact payTo routes)" },
      treasury,
    },
    fees: {
      feeBps: Number(escrowCfg.feeBps),
      chargedOn: "provider payout (settlement or instant release); 0 on reject or refund",
      evaluatorFeeBps: Number(escrowCfg.evaluatorFeeBps),
      evaluatorFeeChargedOn: "provider gross on settled Complete/Partial when the verdict stands",
      ...(noArb
        ? { arbitrationFeeModel: NO_ARBITRATOR_TEXT }
        : {
            arbitrationFee: arbFee.toString(),
            arbitrationFeeModel: "challenger pays bond + quoted arbitration cost; both held by the contract until the ruling; on a ruling the cost goes to the arbitrator and the losing side reimburses it if the ruling is material; on a stale dispute both are refunded to the challenger",
          }),
      buyerBond: "none",
    },
    escrowConfig: { version: Number(cfgVersion), ...configToJson(escrowCfg) },
    ...(hasAdapter ? { adapterConfig: { version: Number(adapterCfgVersion), ...configToJson(adapterCfg), requiredExpiryDuration: adapterRequired.toString() } } : {}),
    registryConfig: { ...configToJson(regCfg), slasherTimelockSeconds: slasherTimelock.toString() },
    evaluators: evs,
    sla: { quoteP95Ms: null, note: "not measured" },
    disputeRules: [fileHash("specs/SPEC-v0.md"), fileHash("docs/ASSUMPTIONS.md")],
    audits: [],
    attestations: atts,
    ...VALUE_LABEL,
    endpoints: HOSTED
      ? { agentRegistration: URLS.registration, agentCard: URLS.agentCard, quote: URLS.quote, mcp: URLS.mcpHttp, mcpStdio: URLS.mcp, notarize: URLS.notarize, quickstart: URLS.quickstart, llms: URLS.llms, stats: URLS.stats, evaluators: `${URLS.base}/v1/evaluators`, evaluatorOnboarding: `${URLS.base}/v1/evaluators/onboarding`, evaluatorProfile: `${URLS.base}/v1/evaluators/profile`, evaluatorCanary: `${URLS.base}/v1/evaluators/canary`, repository: "https://github.com/agentkoin/agentkoin" }
      : { agentRegistration: URLS.registration, agentCard: URLS.agentCard, quote: URLS.quote, mcp: URLS.mcp },
    limitations: [
      MAINNET ? `Base mainnet (chainId ${CHAIN_ID}); Circle USDC (real value); per-job and total-locked caps enforced on chain (escrow maxPerJob / maxTotalLocked)` : LOCAL ? "local Anvil prototype (chainId 31337); not deployed to any public network" : `${NET.name} (chainId ${CHAIN_ID}) TESTNET deployment only; no mainnet deployment; test USDC has no value`,
      ...(MAINNET ? [HOSTED ? `HTTP endpoints hosted at ${URLS.base}` : `HTTP endpoints (x402, A2A, MCP over HTTP) are not publicly hosted; URLs above are the service's local default (${URLS.base})`, "deposit-route keepers k=2 (deployer holds no role)"] : LOCAL ? [] : [HOSTED ? `HTTP endpoints hosted at ${URLS.base} (testnet service; may move or stop)` : `HTTP endpoints (x402, A2A, MCP over HTTP) are not publicly hosted; URLs above are the service's local default (${URLS.base})`, "single keeper (k=1, deployer)"]),
      "contracts unaudited",
      noArb ? `escrow arbitrator: ${NO_ARBITRATOR_TEXT}` : "arbitrator is an owner-controlled mock",
      ...(BigInt(treasury) === 0xdeadn ? ["escrow treasury is 0x000000000000000000000000000000000000dEaD (no fee or bond recipient; fees are 0)"] : []),
      ...labeled.filter((e) => e.label).map((e) => `evaluator ${getAddress(e.address)}: ${e.label}; operator ${e.operator ?? "unknown"}${e.default ? "; default evaluator of this service" : ""}`),
      MAINNET ? "operator key held in the service secret store" : "throwaway operator key",
    ],
  };
  return signEip191(manifest, operator.privateKey);
}

export async function buildRegistration({ agentId }) {
  const c = contracts();
  const cfg = await read(c.escrow, "currentConfig");
  const label = MAINNET ? "Base mainnet" : LOCAL ? "local prototype" : `${NETWORK} testnet`;
  const where = MAINNET ? `Base mainnet, chainId ${CHAIN_ID}: Circle USDC (real value), per-job and total caps on chain; ${HOSTED ? `HTTP endpoints hosted at ${URLS.base}` : "HTTP endpoints not publicly hosted yet"}` : LOCAL ? "Local Anvil (31337) prototype" : HOSTED ? `${NET.name}, chainId ${CHAIN_ID}: testnet only, test USDC, no real value; HTTP endpoints hosted at ${URLS.base}` : `${NET.name}, chainId ${CHAIN_ID}: testnet only, test USDC, no real value; HTTP endpoints not publicly hosted yet, contracts callable directly (ABIs on Sourcify)`;
  const onchain = LOCAL
    ? []
    : [
        { name: "escrow-contract", endpoint: `eip155:${CHAIN_ID}:${c.escrow.address}`, version: "agentcoin/0.4" },
        { name: "escrow-abi", endpoint: `https://sourcify.dev/server/v2/contract/${CHAIN_ID}/${c.escrow.address}?fields=abi`, version: "sourcify-v2" },
        { name: "x402-deposit-route-factory", endpoint: `eip155:${CHAIN_ID}:${c.routeFactory.address}`, version: "agentcoin/0.4" },
        { name: "evaluator-registry", endpoint: `eip155:${CHAIN_ID}:${c.registry.address}`, version: "agentcoin/0.4" },
      ];
  const http = LOCAL || HOSTED
    ? [
        { name: "A2A", endpoint: URLS.agentCard, version: "1.0" },
        { name: "MCP", endpoint: HOSTED ? URLS.mcpHttp : URLS.mcp, version: LATEST_PROTOCOL_VERSION },
        { name: "x402", endpoint: HOSTED ? URLS.notarize : URLS.quote, version: "2" },
        { name: "trust-manifest", endpoint: URLS.trustManifest, version: "agentcoin-trust/0.1" },
        ...(HOSTED ? [
          { name: "MCP-readonly", endpoint: URLS.mcpReadOnly, version: LATEST_PROTOCOL_VERSION },
          { name: "agentkoin-exchange", endpoint: URLS.exchange, version: "agentkoin-exchange/0.1" },
          { name: "A2A-exchange", endpoint: URLS.exchangeCard, version: "1.0" },
          { name: "exchange-llms.txt", endpoint: URLS.exchangeLlms },
          { name: "earn-guide", endpoint: URLS.earn },
          { name: "terms", endpoint: URLS.terms },
        ] : []),
        ...(HOSTED ? [{ name: "web", endpoint: URLS.base }, { name: "llms.txt", endpoint: URLS.llms }, { name: "agentcoin-index", endpoint: `${URLS.base}/.well-known/agentcoin-index.json`, version: "agentcoin-index/0.1" }, { name: "router", endpoint: `${URLS.base}/v1/route`, version: "agentcoin-router/0.1" }] : []),
      ]
    : [];
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: `AgentKoin service index, router and escrow (${label})`,
    description: `Index and router for agent services (A2A, MCP, x402, ERC-8004); USDC escrow for agent jobs with a staked evaluator. Verdicts: complete, reject, partial. Challengeable within a window; wrong or missed verdicts slash evaluator stake. ${feeText(cfg)}${HOSTED ? ` AgentKoin Exchange: escrowed, evaluator-judged service listings and an open-jobs board; MCP tools to find and hire (find_service, place_order), list services (create_listing) and earn (find_earning_opportunities, list_open_jobs, claim_job, post_job); all tools at ${URLS.mcpHttp}, read-only tools at ${URLS.mcpReadOnly}. Exchange buyer fee and beta terms: fees in ${URLS.exchange}.` : ""} ${where}, unaudited.`,
    ...VALUE_LABEL,
    services: [...http, ...onchain],
    x402Support: LOCAL || HOSTED,
    active: true,
    registrations: c.identity.address && agentId != null ? [{ agentId: Number(agentId), agentRegistry: `eip155:${CHAIN_ID}:${c.identity.address}` }] : [],
    supportedTrust: ["crypto-economic", "reputation"],
  };
}

export async function buildAgentCard() {
  const skill = (id, name, description, tags, extra = {}) => ({ id, name, description, tags, inputModes: ["application/json"], outputModes: ["application/json"], ...extra });
  const label = MAINNET ? "Base mainnet" : LOCAL ? "local prototype" : `${NETWORK} testnet`;
  const where = MAINNET ? `Base mainnet (${CHAIN_ID}), Circle USDC (real value), capped; ${HOSTED ? `hosted at ${URLS.base}` : "HTTP endpoints not publicly hosted yet"}` : LOCAL ? "Local Anvil (31337) prototype" : `${NET.name} (${CHAIN_ID}) TESTNET only, test USDC, no real value; ${HOSTED ? `hosted at ${URLS.base}` : "HTTP endpoints not publicly hosted yet"}`;
  return {
    ...VALUE_LABEL,
    name: `AgentKoin service index, router and escrow (${label})`,
    ...(MAINNET ? { risksUrl: `${URLS.base}/risks`, escrow: { default: "direct", optIn: "escrow: true", risks: `${URLS.base}/risks` } } : {}),
    description: `Index of agent services across A2A, MCP, x402 and ERC-8004 with routing, direct x402 orders and USDC escrow with a staked evaluator. Unclaimed listings mirror public metadata. Outputs are JSON with chainId, contract addresses and tx hashes. ${where}, unaudited.`,
    supportedInterfaces: [{ url: `${URLS.base}/a2a/v1`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
    provider: { organization: "STOS Technologies LLC", url: URLS.base },
    version: "0.5.0",
    documentationUrl: `${URLS.base}/docs/interface.json`,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      skill("find_service", "Find service", "Search the cross-protocol index (A2A, MCP, x402, ERC-8004) by text, protocol, max price (USDC base units), min delivery score, claimed status, network; or read one listing by id.", ["index", "discovery", "search"]),
      skill("route_task", "Route task", "Task + budget -> ranked candidate sellers with quote (indexed or live), the exact request each seller expects, delivery score and order modes. No payment.", ["router", "discovery", "quote"]),
      skill("place_order", "Place order", `direct: the seller's own x402 requirements (buyer pays seller, no custody). escrow: fee quote + unsigned approve and JobEscrow.createAndFundFor txs on ${MAINNET ? "Base" : "Base Sepolia"}.`, ["order", "x402", "escrow", "usdc"]),
      skill("get_order", "Get order", "Order status, payment tx, escrow job state, deliverable hash, verdict, signed delivery record; with receipt it records the payment tx and delivery hash; jobId alone returns on-chain job status.", ["order", "status", "escrow"]),
      skill("claim_listing", "Claim listing", "EIP-712 challenge for a listing, then verification by a payTo address or the ERC-8004 owner (or a well-known token); marks the listing claimed.", ["index", "claim", "eip712"]),
      skill("verify", "Verify", "Signature and on-chain checks of a trust manifest, attestation, card or registration; evaluator reputation counts; service delivery score with signature and evidence root.", ["verification", "reputation", "attestation"]),
    ],
  };
}

export const cardKid = (operator) => `did:pkh:eip155:${CHAIN_ID}:${getAddress(operator.address)}#secp256k1`;
export const signCard = (card, operator) => signAgentCard(card, operator.privateKey, cardKid(operator), { jku: URLS.jwks });
export const buildJwks = (operator) => jwksFor(operator.privateKey, cardKid(operator));
