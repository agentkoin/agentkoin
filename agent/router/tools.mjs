// MCP tools (also A2A skills): find_service, route_task, place_order, get_order (read-only), record_payment (write), claim_listing, verify, plus the
// AgentKoin Exchange tools (when ctx.exchange is set): create_listing, get_agent_profile, list_evaluators,
// find_earning_opportunities, post_job, list_open_jobs, claim_job.
// Descriptions are factual and <= 300 chars. Units: USDC base units (6 decimals) as decimal strings.
import { TESTNET } from "../lib/network.mjs";
import { z } from "zod";

const usdc = z.string().regex(/^[0-9]{1,18}$/).describe("USDC base units (6 decimals), decimal string");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const out = z.looseObject({});

/**
 * Every MCP tool carries all five annotations (title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint) for
 * directory review. Each tool is either read-only or a write; no tool mixes both. Read-only tools are idempotent and
 * non-destructive; no tool deletes or overwrites user data (writes are append-only or idempotent upserts).
 */
export function completeAnnotations(tools) {
  return tools.map((t) => {
    const a = t.config.annotations ?? {};
    if (typeof a.readOnlyHint !== "boolean") throw new Error(`tool ${t.name}: readOnlyHint required`);
    const ro = a.readOnlyHint;
    const annotations = { title: a.title ?? t.config.title, readOnlyHint: ro, destructiveHint: ro ? false : (a.destructiveHint ?? false), idempotentHint: ro ? true : (a.idempotentHint ?? false), openWorldHint: a.openWorldHint ?? false };
    return { ...t, config: { ...t.config, annotations } };
  });
}

/** ctx: { router, quote, openJob, jobStatus, verifyDocument, evaluatorReputation } */
export function routerTools(ctx) {
  return completeAnnotations(routerToolList(ctx));
}

function routerToolList(ctx) {
  const { router } = ctx;
  return [
    {
      name: "find_service",
      offline: true,
      config: {
        title: "Find services in the index",
        description: "Searches the AgentCoin index (A2A, MCP, x402, ERC-8004) or, with exchange/badge/evaluator/skill, AgentKoin Exchange listings (escrowed, evaluator-judged). With id (svc_ or lst_): one listing with skills, prices, hire formats, score. Read-only.",
        inputSchema: { id: z.string().max(40).optional(), q: z.string().max(300).optional(), exchange: z.boolean().optional().describe("search AgentKoin Exchange listings"), skill: z.string().max(120).optional(), badge: z.enum(["verified-track-record", "beta-tester"]).optional(), evaluator: address.optional().describe("listings that accept this evaluator"), sort: z.enum(["default", "price", "score", "jobs", "new"]).optional(), protocol: z.enum(["x402", "a2a", "mcp", "openapi", "erc8004", "http"]).optional(), maxPrice: usdc.optional(), minScore: z.number().min(0).max(1).optional(), claimed: z.boolean().optional(), network: z.string().max(80).optional(), cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional(), skillsOffset: z.number().int().min(0).optional() },
        outputSchema: out.shape,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      handler: async (a) => {
        const ex = ctx.exchange;
        if (ex && (a.exchange || a.badge || a.evaluator || a.skill || (a.id && a.id.startsWith("lst_")))) return a.id ? ex.getListing(a.id) : ex.search({ q: a.q, skill: a.skill, maxPrice: a.maxPrice, minScore: a.minScore, badge: a.badge, evaluator: a.evaluator, protocol: ["x402", "mcp", "a2a", "http"].includes(a.protocol) ? a.protocol : undefined, sort: a.sort, cursor: a.cursor, limit: a.limit });
        return a.id ? router.get(a.id, { skillsOffset: a.skillsOffset }) : router.search(a);
      },
    },
    {
      name: "route_task",
      offline: true,
      config: {
        title: "Route a task to ranked sellers",
        description: "Takes a task and budget; returns ranked candidate sellers with a quote (indexed or live), the exact request each seller expects, delivery score and available order modes. No payment. Read-only.",
        inputSchema: { task: z.string().min(2).max(2000), budget: usdc.optional(), constraints: z.object({ protocol: z.enum(["x402", "a2a", "mcp", "openapi", "erc8004"]).optional(), network: z.string().max(80).optional(), claimed: z.boolean().optional(), minScore: z.number().min(0).max(1).optional(), includeUnpriced: z.boolean().optional(), limit: z.number().int().min(1).max(20).optional() }).optional() },
        outputSchema: out.shape,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      handler: async (a) => router.route(a),
    },
    {
      name: "place_order",
      config: {
        title: "Place an order (Exchange hire, direct or escrow)",
        description: "listingId: Exchange hire (escrow), returns x402 requirements + unsigned txs; add paymentSignature (base64 x402 payload) to fund in the same call. serviceId: direct (seller's own x402) or escrow (unsigned txs). Neither: raw escrow job txs.",
        inputSchema: {
          listingId: z.string().max(40).optional(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional().describe("Exchange hire: EIP-712 OrderIntent signature by the buyer (typed data is returned by an unsigned call)"), expiresAt: z.union([z.string(), z.number()]).optional().describe("OrderIntent expiry, unix seconds, at most 1 h ahead"), nonce: z.union([z.string(), z.number()]).optional().describe("OrderIntent nonce, unique decimal per buyer"), erc8004Id: z.string().regex(/^[0-9]{1,30}$/).optional().describe("optional ERC-8004 agent id; if the signer is its owner or agentWallet the Verified agent badge is recorded"), input: z.record(z.string(), z.unknown()).optional().describe("job input (listing input_schema)"), paymentSignature: z.string().max(8000).optional().describe("base64 x402 PAYMENT-SIGNATURE for the listing's accepts"),
          serviceId: z.string().max(40).optional(), skillId: z.string().max(300).optional(), mode: z.enum(["direct", "escrow"]).optional(), buyer: address.optional(), deadlineSeconds: z.number().int().min(600).max(2592000).optional(),
          provider: address.optional().describe("raw escrow job (no serviceId)"), evaluator: address.optional(), amount: usdc.optional(), specHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), spec: z.string().max(10000).optional(),
        },
        outputSchema: out.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      handler: async (a) => {
        if (a.listingId) {
          if (!ctx.exchange) throw new Error("Exchange not enabled");
          if (a.paymentSignature) return ctx.exchangeHireX402({ listingId: a.listingId, skillId: a.skillId, evaluator: a.evaluator, input: a.input, paymentSignature: a.paymentSignature });
          return (ctx.exchange.intents ?? { hire: (x) => ctx.exchange.hire(x) }).hire({ listing_id: a.listingId, skill_id: a.skillId, buyer: a.buyer, evaluator: a.evaluator, input: a.input, channel: "mcp", signature: a.signature, expiresAt: a.expiresAt, nonce: a.nonce, erc8004_id: a.erc8004Id });
        }
        if (a.serviceId) return router.placeOrder({ serviceId: a.serviceId, skillId: a.skillId, mode: a.mode ?? "direct", buyer: a.buyer, deadlineSeconds: a.deadlineSeconds });
        if (!a.provider || !a.evaluator || !a.amount || !a.buyer) throw new Error("serviceId, or provider + evaluator + amount + buyer for a raw escrow job");
        const [q, txs] = await Promise.all([ctx.quote({ amount: a.amount, evaluator: a.evaluator }), ctx.openJob({ client: a.buyer, provider: a.provider, evaluator: a.evaluator, amount: a.amount, deadlineSeconds: a.deadlineSeconds ?? 3600, specHash: a.specHash, spec: a.spec })]);
        return { mode: "raw-escrow-job", quote: q, ...txs, agentcoin: router.footer({ verified: false, checks: { paymentRecorded: false } }) };
      },
    },
    {
      name: "get_order",
      config: {
        title: "Get an order",
        description: "Returns an order's status, payment tx, escrow job state, deliverable hash, verdict and signed delivery record. With jobId only: on-chain escrow job status. Read-only; to record a payment or delivery use record_payment.",
        inputSchema: { orderId: z.string().max(40).optional(), jobId: z.string().regex(/^[0-9]+$/).optional() },
        outputSchema: out.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      handler: async (a) => {
        if (a.orderId?.startsWith("xo_") && ctx.exchange) return ctx.exchange.getOrder(a.orderId);
        if (a.orderId) return router.getOrder(a.orderId);
        if (a.jobId) return ctx.jobStatus(a.jobId);
        throw new Error("orderId or jobId required");
      },
    },
    {
      name: "record_payment",
      config: {
        title: "Record a payment or delivery for an order",
        description: "Write. Records an order's payment: Exchange orders (xo_) take receipt.jobId (+ paymentTx, feeTx on the unsigned path), verified on chain; index orders take paymentTx and the deliverable or its sha256. Idempotent per order.",
        inputSchema: { orderId: z.string().max(40), receipt: z.object({ paymentTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), feeTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe("Exchange orders, unsigned path: USDC.transfer(fee recipient, fee) tx"), jobId: z.string().regex(/^[0-9]+$/).optional(), deliverable: z.union([z.string().max(100000), z.record(z.string(), z.unknown())]).optional(), deliverableSha256: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), latencyMs: z.number().int().min(0).optional() }) },
        outputSchema: out.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      handler: async (a) => {
        if (a.orderId.startsWith("xo_") && ctx.exchange) {
          if (!a.receipt?.jobId) throw new Error("receipt.jobId required for Exchange orders");
          return ctx.exchange.recordFunding(a.orderId, { jobId: a.receipt.jobId, paymentTx: a.receipt.paymentTx, feeTx: a.receipt.feeTx });
        }
        return router.receipt(a.orderId, a.receipt);
      },
    },
    {
      name: "claim_listing",
      config: {
        title: "Claim a listing",
        description: "Without signature: returns the EIP-712 typed data and a well-known token for a listing. With claimant + expiresAt + signature (payTo or ERC-8004 owner), or method well-known: verifies and marks the listing claimed.",
        inputSchema: { serviceId: z.string().max(40), claimant: address.optional(), expiresAt: z.string().regex(/^[0-9]{1,12}$/).optional(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional(), method: z.enum(["eip712", "well-known"]).optional() },
        outputSchema: out.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      handler: async (a) => (a.signature || a.method === "well-known" ? router.claimVerify(a.serviceId, a) : router.claimChallenge(a.serviceId, a)),
    },
    {
      name: "verify",
      config: {
        title: "Verify a document, evaluator or service",
        description: "document: signature and on-chain checks of a trust manifest, attestation, agent card or registration. evaluator: raw reputation counts with tx evidence. serviceId: delivery score, signature and evidence-root check. Read-only.",
        inputSchema: { document: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(), expectedSigner: address.optional(), evaluator: address.optional(), serviceId: z.string().max(40).optional() },
        outputSchema: out.shape,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      handler: async (a) => {
        const res = {};
        if (a.document !== undefined) {
          const doc = typeof a.document === "string" ? JSON.parse(a.document) : a.document;
          const r = await ctx.verifyDocument(doc, { expectedSigner: a.expectedSigner });
          res.document = { ...r, checks: (r.checks ?? []).map((x) => ({ ...x, detail: String(x.detail) })) };
        }
        if (a.evaluator) res.evaluator = await ctx.evaluatorReputation(a.evaluator);
        if (a.serviceId) res.service = { ...(await router.verifyScore(a.serviceId)), reputation: router.reputation(a.serviceId) };
        if (!Object.keys(res).length) throw new Error("document, evaluator or serviceId required");
        // footer: verified only if every requested signature/score check passed (evaluator counts are raw data, not a check)
        const parts = [];
        if (res.document) parts.push(res.document.valid === true);
        if (res.service) parts.push(router._scoreFooter(a.serviceId, res.service).verified);
        const checks = { ...(res.document ? { documentValid: res.document.valid === true } : {}), ...(res.service ? router._scoreFooter(a.serviceId, res.service).checks : {}) };
        res.agentcoin = router.footer({ serviceId: a.serviceId ?? null, verified: parts.length > 0 && parts.every(Boolean), checks });
        return res;
      },
    },
    ...(ctx.exchange ? exchangeTools(ctx) : []),
  ];
}

/** AgentKoin Exchange tools (spec section 7). Amounts as strings; results carry chainId, contracts, testnet:true. */
function exchangeTools(ctx) {
  const ex = ctx.exchange;
  const skill = z.object({
    skill_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), name: z.string().max(120), description: z.string().max(1000).optional(), price: usdc, sla_seconds: z.number().int().min(600).max(2592000).optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(), deliverable_schema: z.record(z.string(), z.unknown()).optional(), criteria: z.string().max(4000).optional(),
    criteria_url: z.string().max(500).optional(), criteria_hash: z.string().regex(/^0x[0-9a-f]{64}$/).optional(),
  });
  return [
    {
      name: "create_listing",
      config: {
        title: "Create or update an Exchange listing",
        description: "Open listing (no bond): seller signs EIP-712 Listing; the endpoint must answer a GET probe. Without signature: returns the typed data to sign. Criteria are pinned (sha256 = escrow specHash). Max 10 listings per seller.",
        inputSchema: {
          listing: z.object({ title: z.string().max(120), description: z.string().max(2000).optional(), endpoint: z.string().max(500), protocols: z.array(z.enum(["x402", "mcp", "a2a", "http"])).optional(), payTo: address.optional(), erc8004_id: z.string().regex(/^[0-9]{1,12}$/).optional(), acceptable_evaluators: z.array(address).max(20).optional(), labels: z.array(z.string().max(80)).max(10).optional(), display_name: z.string().max(80).optional(), skills: z.array(skill).min(1).max(20) }),
          seller: address, expiresAt: z.string().regex(/^[0-9]{1,12}$/).optional(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional(),
        },
        outputSchema: out.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      handler: async (a) => {
        try {
          return await ex.createListing(a);
        } catch (e) {
          if (e.status === 400 && e.extra?.eip712) return { status: "signature-required", ...e.extra, testnet: TESTNET, realValue: !TESTNET };
          throw e;
        }
      },
    },
    {
      name: "get_agent_profile",
      offline: true,
      config: {
        title: "Get an agent's Exchange profile",
        description: "AgentProfile for an EVM address: roles, listings, evaluator stake, track record (jobs, outcomes, volume, judge-kit verified share), score (needs >= 3 outside jobs) and badges, signed by the operator key with an evidence root. Read-only.",
        inputSchema: { agent_id: address },
        outputSchema: out.shape,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      handler: async (a) => ex.agentProfile(a.agent_id),
    },
    {
      name: "find_earning_opportunities",
      offline: true,
      config: {
        title: "Find ways to earn on AgentKoin Exchange",
        description: "For an agent told to make money: open jobs to claim, service categories where demand exceeds supply (from real board/order data), and evaluator openings, each with a one-call next step. Testnet, test USDC only; no earnings promised. Read-only.",
        inputSchema: { category: z.string().max(64).optional(), address: address.optional().describe("your address (marks evaluator status)"), limit: z.number().int().min(1).max(50).optional() },
        outputSchema: out.shape,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      handler: async (a) => ex.jobs.earn(a),
    },
    {
      name: "post_job",
      offline: true,
      config: {
        title: "Post a job to the open-jobs board",
        description: "Buyer posts a task: title, category, budget (USDC base units), sla_seconds, deliverable_schema (machine-checked), input. Signs EIP-712 OpenJob; without signature returns the typed data. Funded via escrow after an agent claims it. Buyer fee 0.8%, min 0.05 USDC.",
        inputSchema: {
          job: z.object({ title: z.string().max(120), description: z.string().max(2000).optional(), category: z.string().max(64).optional(), budget: usdc, sla_seconds: z.number().int().min(600).max(2592000).optional(), open_seconds: z.number().int().min(600).max(2592000).optional(), deliverable_schema: z.record(z.string(), z.unknown()).optional(), criteria: z.string().max(4000).optional(), input: z.unknown().optional(), evaluator: address.optional(), labels: z.array(z.string().max(80)).max(10).optional(), nonce: z.string().max(64).optional() }),
          buyer: address, expiresAt: z.string().regex(/^[0-9]{1,12}$/).optional(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional(),
        },
        outputSchema: out.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      handler: async (a) => {
        try {
          return await ex.jobs.post(a);
        } catch (e) {
          if (e.status === 400 && e.extra?.eip712) return { status: "signature-required", ...e.extra, testnet: TESTNET, realValue: !TESTNET };
          throw e;
        }
      },
    },
    {
      name: "list_open_jobs",
      offline: true,
      config: {
        title: "List open jobs on the board",
        description: "Open-jobs board: tasks posted by buyers with budget, category, SLA, criteria hash and a claim_job next step. Filter by category, minBudget, maxBudget; with jobId returns one job with its order. Read-only.",
        inputSchema: { jobId: z.string().regex(/^oj_[0-9a-f]{16}$/).optional(), category: z.string().max(64).optional(), minBudget: usdc.optional(), maxBudget: usdc.optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(10).optional() },
        outputSchema: out.shape,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      handler: async (a) => (a.jobId ? ex.jobs.get(a.jobId) : ex.jobs.list(a)),
    },
    {
      name: "claim_job",
      config: {
        title: "Claim an open job",
        description: "Claimer signs EIP-712 Claim (without signature: returns typed data). Exclusive for 2 h; the buyer then funds a JobEscrow job with provider = claimer. You deliver per the criteria and are paid 100% of the budget on a complete verdict.",
        inputSchema: { jobId: z.string().regex(/^oj_[0-9a-f]{16}$/), claimer: address, expiresAt: z.string().regex(/^[0-9]{1,12}$/).optional(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional() },
        outputSchema: out.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      handler: async (a) => {
        try {
          return await ex.jobs.claim(a.jobId, a);
        } catch (e) {
          if (e.status === 400 && e.extra?.eip712) return { status: "signature-required", ...e.extra, testnet: TESTNET, realValue: !TESTNET };
          throw e;
        }
      },
    },
    {
      name: "join_beta",
      offline: true,
      config: {
        title: "Join or leave the Exchange beta",
        description: "Opt an agent wallet in or out of the testnet beta: EIP-712 BetaOptIn(agent, optIn, issuedAt); without signature returns typed data. Beta: 0% Exchange buyer fee in the window, fee credits per completed judged job (fees only; not cash, not withdrawable), badge.",
        inputSchema: { agent: address, optIn: z.boolean().optional(), issuedAt: z.string().regex(/^[0-9]{1,12}$/).optional(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional() },
        outputSchema: out.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      handler: async (a) => {
        try {
          return await ex.beta.optIn(a);
        } catch (e) {
          if (e.status === 400 && e.extra?.eip712) return { status: "signature-required", ...e.extra, testnet: TESTNET, realValue: !TESTNET };
          throw e;
        }
      },
    },
    {
      name: "get_fee_credits",
      offline: true,
      config: {
        title: "Get beta status and fee credits",
        description: "Beta status, badge and the off-chain fee-credit balance and history for an address. Credits only reduce future Exchange buyer fees; they are not cash, not withdrawable and not transferable. Read-only.",
        inputSchema: { agent: address },
        outputSchema: out.shape,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      handler: async (a) => ex.beta.view(a.agent),
    },
    {
      name: "list_evaluators",
      offline: true,
      config: {
        title: "List active staked evaluators",
        description: "Active EvaluatorRegistry evaluators with stake, available exposure, operator label and Exchange verdict counts, plus the selection rule hire uses. Judging is free (evaluator fee 0) through 2026-12-31. Read-only.",
        inputSchema: { minAvailableExposure: usdc.optional() },
        outputSchema: out.shape,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      handler: async (a) => {
        const v = await ex.evaluatorsView();
        if (a.minAvailableExposure) v.evaluators = v.evaluators.filter((e) => e.availableExposure != null && BigInt(e.availableExposure) >= BigInt(a.minAvailableExposure));
        return v;
      },
    },
  ];
}
