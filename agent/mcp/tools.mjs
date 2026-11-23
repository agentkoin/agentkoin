// Tool definitions for the AgentCoin MCP server. Exactly 5 tools (SPEC-v0 §5).
// Descriptions are factual, <= 300 chars, no instructions to the calling model.
// Units: token amounts are USDC 6-decimal integer strings. Every output carries chainId + contract addresses.
import { z } from "zod";
import { keccak256, toBytes, getAddress, parseEventLogs, encodeFunctionData } from "viem";
import { contracts, wallet, send, read, publicClient } from "../lib/chain.mjs";
import { ANVIL_KEYS, DEMO_SIGN, CHAIN_ID, STATES } from "../lib/config.mjs";
import { quote, jobStatus, envelope } from "../lib/protocol.mjs";
import { evaluatorReputation } from "../lib/indexer.mjs";
import { verifyDocument } from "../lib/verify.mjs";

const uint = z.string().regex(/^[0-9]+$/).describe("unsigned integer, decimal string");
const usdc = z.string().regex(/^[0-9]+$/).describe("USDC base units (6 decimals), decimal string");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const evidence = z.array(z.looseObject({ event: z.string(), txHash: bytes32, blockNumber: uint }));
const env = {
  chainId: z.number().int(),
  network: z.string(),
  networkName: z.string().optional(),
  testnet: z.boolean().optional(),
  localDevnet: z.boolean().optional(),
  realValue: z.boolean().optional(),
  blockNumber: uint,
  contracts: z.object({ escrow: address, evaluatorRegistry: address, token: address, arbitrator: address, identityRegistry: address.nullable(), evaluatorAdapter: address, depositRouteFactory: address }),
};

export const TOOLS = [
  {
    name: "quote",
    config: {
      title: "Quote escrow terms",
      description:
        "Returns protocol fee, evaluator fee, provider net, challenge bond, arbitration fee, instant-release eligibility, windows and config version for an escrow amount, plus ERC-8183 adapter bond, arbitration cost and minimum kernel expiry; optionally evaluator stake and capacity. Read-only.",
      inputSchema: { amount: usdc, providerBond: usdc.optional(), evaluator: address.optional() },
      outputSchema: {
        ...env,
        unit: z.string(),
        amount: usdc,
        providerBond: usdc,
        feeBps: z.number().int(),
        feeChargedOn: z.string(),
        instantBondCoverBps: z.number().int(),
        exposureMultiplier: z.number().int(),
        feeAtFullPayout: usdc,
        providerNetAtFullPayout: usdc,
        evaluatorFeeBps: z.number().int(),
        evaluatorFeeAtFullPayout: usdc,
        evaluatorFeeChargedOn: z.string(),
        challengeBond: usdc,
        arbitrationFee: usdc,
        challengeUpfrontTotal: usdc.describe("challengeBond + arbitrationFee, pulled from the challenger"),
        arbitrationFeeModel: z.string(),
        instantThreshold: usdc,
        instantEligible: z.boolean(),
        requiredProviderBondForInstant: usdc.nullable().describe("null when amount > instantThreshold"),
        evalWindowSeconds: z.number().int(),
        challengeWindowSeconds: z.number().int(),
        configVersion: z.number().int(),
        evaluatorMinStake: usdc,
        erc8183Adapter: z.object({
          challengeBond: usdc,
          arbitrationFee: usdc,
          requiredExpiryDurationSeconds: usdc.describe("evalWindow + challengeWindow + arbitrationTimeout + expiryMargin"),
          minKernelExpiry: usdc.describe("unix seconds; a kernel job must expire at or after this to be assignable now"),
          minKernelExpiryRule: z.string(),
          configVersion: z.number().int(),
        }),
        evaluator: z.looseObject({ address, active: z.boolean(), stake: usdc, availableExposure: usdc }).optional(),
        evaluatorCanTakeAmount: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (a) => quote(a),
  },
  {
    name: "open_job",
    config: {
      title: "Build escrow job transactions",
      description:
        "Builds unsigned EIP-1559 transactions (USDC approve, then escrow createAndFund) for the given client, provider, evaluator, amount, deadline and spec. Nothing is signed or sent; the client signs and broadcasts. Returns calldata, nonces and the absolute deadline.",
      inputSchema: {
        client: address.optional().describe("address that signs and pays; required unless demoSign"),
        provider: address,
        evaluator: address,
        amount: usdc,
        deadlineSeconds: z.number().int().positive().describe("seconds from the latest block until the submission deadline"),
        specHash: bytes32.optional().describe("keccak256 of the job spec; required unless spec is given"),
        spec: z.string().max(10000).optional().describe("job spec text; hashed with keccak256 if specHash is absent"),
        demoSign: z.boolean().optional().describe("sign and send with the server key; accepted only when the server runs with AGENTCOIN_DEMO_SIGN=1 (local demo)"),
      },
      outputSchema: {
        ...env,
        mode: z.enum(["unsigned", "demo-signed"]),
        client: address,
        provider: address,
        evaluator: address,
        amount: usdc,
        specHash: bytes32,
        deadline: uint.describe("absolute unix time encoded in the createAndFund calldata"),
        transactions: z.array(
          z.object({
            step: z.number().int(),
            label: z.string(),
            type: z.literal("eip1559"),
            chainId: z.number().int(),
            from: address,
            to: address,
            data: z.string().regex(/^0x[0-9a-fA-F]*$/),
            value: uint,
            nonce: z.number().int(),
            gas: uint.nullable().describe("estimate; null when it depends on a prior step"),
            maxFeePerGas: uint,
            maxPriorityFeePerGas: uint,
          }),
        ),
        expectedJobId: uint.describe("jobCount+1 at build time; differs if another job is created first"),
        jobId: uint.optional(),
        state: z.string().optional(),
        txHashes: z.object({ approve: bytes32, createAndFund: bytes32 }).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler: async (a) => openJob(a),
  },
  {
    name: "get_job_status",
    config: {
      title: "Get escrow job status",
      description:
        "Returns state, outcome, payoutBps, parties, amounts, bonds, deadlines (verdict and challenge), dispute record and the tx hash of every event for a jobId. Read-only.",
      inputSchema: { jobId: uint },
      outputSchema: {
        ...env,
        jobId: uint,
        exists: z.boolean(),
        state: z.string().optional(),
        outcome: z.string().optional(),
        client: address.optional(),
        provider: address.optional(),
        evaluator: address.optional(),
        amount: usdc.optional(),
        providerBond: usdc.optional(),
        payoutBps: z.number().int().optional(),
        instant: z.boolean().optional(),
        accepted: z.boolean().optional(),
        configVersion: z.number().int().optional(),
        deadline: uint.optional(),
        submittedAt: uint.optional(),
        verdictAt: uint.optional(),
        disputedAt: uint.optional(),
        specHash: bytes32.optional(),
        deliverableHash: bytes32.optional(),
        reasonHash: bytes32.optional(),
        verdictDeadline: uint.nullable().optional(),
        challengeDeadline: uint.nullable().optional(),
        slashBase: usdc.optional().describe("registry minStake pinned at fund; slash amounts are bps of this"),
        dispute: z.looseObject({ challenger: address, arbitrator: address, bond: usdc, arbitrationFee: usdc }).nullable().optional(),
        evidence: evidence.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (a) => jobStatus(a.jobId),
  },
  {
    name: "get_evaluator_reputation",
    config: {
      title: "Get evaluator reputation",
      description:
        "Raw counts derived from escrow and registry events for an evaluator: jobs assigned, verdicts by outcome, disputes, verdicts overturned, missed verdicts, slashes; plus stake, volume, avg time to verdict and tx-hash evidence. No score. Read-only.",
      inputSchema: { evaluator: address },
      outputSchema: {
        ...env,
        evaluator: address,
        indexedFromBlock: uint,
        indexedToBlock: uint,
        unit: z.string(),
        counts: z.object({
          jobsAssigned: z.number().int(),
          verdicts: z.number().int(),
          verdictsByOutcome: z.object({ Complete: z.number().int(), Reject: z.number().int(), Partial: z.number().int() }),
          jobsCompleted: z.number().int(),
          jobsDisputed: z.number().int(),
          disputesLost: z.number().int(),
          verdictsOverturned: z.number().int(),
          missedVerdicts: z.number().int(),
          adapter: z.object({ jobsAccepted: z.number().int(), verdicts: z.number().int(), verdictsOverturned: z.number().int(), missedVerdicts: z.number().int() }),
        }),
        totalVolume: usdc,
        currentStake: usdc,
        active: z.boolean(),
        slashedTotal: usdc,
        avgTimeToVerdictSeconds: uint.nullable(),
        evidence: z.record(z.string(), z.union([evidence, z.record(z.string(), evidence)])),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (a) => evaluatorReputation(a.evaluator),
  },
  {
    name: "verify_attestation",
    config: {
      title: "Verify attestation or signed artifact",
      description:
        "Verifies a trust manifest, single attestation, A2A agent card (JWS ES256K) or {document, signature} ERC-8004 registration: signature, signer, and on-chain claims (code hashes, config, stakes at block, agent owner). Returns each check. Read-only.",
      inputSchema: { document: z.union([z.record(z.string(), z.unknown()), z.string()]).describe("JSON object or JSON string"), expectedSigner: address.optional() },
      outputSchema: {
        ...env,
        kind: z.string(),
        valid: z.boolean(),
        signer: address.nullable(),
        checks: z.array(z.object({ check: z.string(), pass: z.boolean(), detail: z.string() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (a) => {
      const doc = typeof a.document === "string" ? JSON.parse(a.document) : a.document;
      const r = await verifyDocument(doc, { expectedSigner: a.expectedSigner });
      const c = contracts();
      return { ...envelope(c, await publicClient.getBlockNumber()), ...r, checks: r.checks.map((x) => ({ ...x, detail: String(x.detail) })) };
    },
  },
];

/** A-6: build unsigned approve + createAndFund txs. Server-side signing only behind AGENTCOIN_DEMO_SIGN=1. */
export async function openJob(a) {
  const c = contracts();
  const specHash = a.specHash ?? (a.spec ? keccak256(toBytes(a.spec)) : null);
  if (!specHash) throw new Error("specHash or spec required");
  if (a.demoSign && !DEMO_SIGN) throw new Error("demoSign requires the server to run with AGENTCOIN_DEMO_SIGN=1");
  const w = a.demoSign ? wallet(process.env.AGENTCOIN_CLIENT_KEY ?? ANVIL_KEYS.client) : null;
  const client = getAddress(w ? w.account.address : a.client ?? "");
  if (a.client && w && getAddress(a.client) !== client) throw new Error("client != server demo key address");
  const provider = getAddress(a.provider);
  const evaluator = getAddress(a.evaluator);
  const amount = BigInt(a.amount);
  const block = await publicClient.getBlock();
  const deadline = block.timestamp + BigInt(a.deadlineSeconds);
  const [nonce, fees, jobCount] = await Promise.all([
    publicClient.getTransactionCount({ address: client, blockTag: "pending" }),
    publicClient.estimateFeesPerGas(),
    read(c.escrow, "jobCount"),
  ]);
  const approveData = encodeFunctionData({ abi: c.usdc.abi, functionName: "approve", args: [c.escrow.address, amount] });
  const createData = encodeFunctionData({ abi: c.escrow.abi, functionName: "createAndFund", args: [provider, evaluator, amount, deadline, specHash] });
  const approveGas = await publicClient.estimateGas({ account: client, to: c.usdc.address, data: approveData }).catch(() => null);
  const tx = (step, label, to, data, gas) => ({
    step, label, type: "eip1559", chainId: CHAIN_ID, from: client, to, data, value: "0", nonce: nonce + step - 1,
    gas: gas === null ? null : gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
  });
  const out = {
    ...envelope(c, block.number),
    mode: "unsigned",
    client, provider, evaluator,
    amount: amount.toString(),
    specHash,
    deadline: deadline.toString(),
    transactions: [tx(1, "USDC.approve(escrow, amount)", c.usdc.address, approveData, approveGas), tx(2, "JobEscrow.createAndFund(provider, evaluator, amount, deadline, specHash)", c.escrow.address, createData, null)],
    expectedJobId: (jobCount + 1n).toString(),
  };
  if (!w) return out;
  const approve = await send(w, c.usdc, "approve", [c.escrow.address, amount]);
  const created = await send(w, c.escrow, "createAndFund", [provider, evaluator, amount, deadline, specHash]);
  const jobId = parseEventLogs({ abi: c.escrow.abi, logs: created.receipt.logs, eventName: "JobCreated" })[0].args.jobId;
  const st = await read(c.escrow, "getJob", [jobId]);
  return { ...out, ...envelope(c, created.receipt.blockNumber), mode: "demo-signed", jobId: jobId.toString(), state: STATES[st.state], txHashes: { approve: approve.hash, createAndFund: created.hash } };
}
