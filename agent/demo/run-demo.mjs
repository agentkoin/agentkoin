// End-to-end LOCAL demo (Anvil 31337). Requires: anvil, deployed contracts, seeded actors, signed artifacts,
// x402 server on 127.0.0.1:4020. demo/run.sh sets all of that up. Exits non-zero if any expectation fails.
//  A.  x402 `exact` (EIP-3009): 402 -> client signs TransferWithAuthorization to the offer's deposit route ->
//      mock facilitator verifies + settles (escrow job opened, client = payer) -> delivery -> provider submits
//      -> evaluator verdict Complete -> challenge window -> finalize -> provider net, protocol fee, evaluator fee
//  A2. MCP open_job returns unsigned txs (A-6); the client wallet signs; paid via the `agentcoin-escrow` scheme
//  B.  slash (missed verdict): timeoutRelease -> evaluator slashed (pinned slash base), client refunded
//  C.  slash (overturned verdict): wrong Reject -> provider challenges (bond + arbitration fee) -> arbitrator
//      rules 100% -> evaluator slashed, arbitration fee reimbursed to the challenger from evaluator stake
//  D.  ERC-8183 adapter: an external kernel mock names the adapter as evaluator -> staked evaluator assigned and
//      accepts -> provider submits on the kernel -> verdict held through the challenge window -> finalize ->
//      adapter calls kernel.complete -> kernel job Completed, provider paid by the kernel
//  D1. E-1a min-expiry refusal: a kernel job expiring before the quoted minKernelExpiry -> assign reverts ExpiryTooSoon
//  D2. E-1c late-submission refusal: accepted kernel job, provider submits when less than requiredExpiryDuration
//      is left -> noteSubmission refuses (ExpiryRefused + ExpiryRisk), exposure released, no slash ->
//      after kernel expiry the client takes the kernel's own refund path (claimRefund)
//  D3. E-1d: a Proposed (never accepted) assignment on a kernel job that ended -> anyone closes it (KernelEnded)
//  F.  A-1b/A-1e v0.1.2 k-of-n keepers (3 local keepers, Anvil #7/#8/#9, threshold 2): the buyer's EIP-3009
//      authorization is submitted straight to the token -> settle refuses it -> keeper #7 waits for the
//      confirmation depth (pending-finality), then votes: 1-of-3 does NOT credit -> keeper #8 votes the same
//      values: 2-of-3 credits (escrow job opens, client = payer) -> keeper #9 / duplicates / non-keepers rejected
//  F2. conflicting attestation: a plain offer-amount transfer -> keeper #8 votes honestly, keeper #9 attests a
//      wrong value -> DepositFrozen, nothing moves, keepers skip it -> owner proposes a timelocked resolution
//      (executed in G after 48h+)
//  G.  A-1a/A-1d RecoveryVault: a wrong-amount transfer + an unattributable mint; keeper #7 starts the sweep
//      before the transfer is attested (lagging keepers) -> (30d) -> the F2 resolution credits the frozen
//      deposit -> sweep moves the rest into the RecoveryVault (not the treasury) -> keepers #7 + #8 attest the
//      swept transfer: paid back from the vault (2-of-3) -> double claim reverts, horizon release refused
//  E.  E-17a stale dispute: client challenges, arbitrator never rules, arbitrationTimeout passes ->
//      resolveStaleDispute -> verdict executes, bond + held arbitration fee refunded to the challenger
import { keccak256, toBytes, parseEventLogs, toHex, decodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { connectMcp, call } from "../mcp/client-smoke.mjs";
import { contracts, wallet, send, read, increaseTime, fmt6, publicClient, mine } from "../lib/chain.mjs";
import { ANVIL_KEYS, KEEPER_KEYS, PUBLIC_BASE_URL, ADAPTER_STATES, KERNEL_STATES, LOCAL_CHAIN_ID, ABI } from "../lib/config.mjs";
import { jcs, omit } from "../lib/canonical.mjs";
import { readFileSync } from "node:fs";
import { keeperPass, claimView, DEFAULT_CONFIRMATIONS } from "../lib/keeper.mjs";
import { offer as x402Offer } from "../x402/server.mjs";

const c = contracts();
const W = { client: wallet(ANVIL_KEYS.client), provider: wallet(ANVIL_KEYS.provider), evaluator: wallet(ANVIL_KEYS.evaluator), deployer: wallet(ANVIL_KEYS.deployer) };
const A = Object.fromEntries(Object.entries(ANVIL_KEYS).map(([k, v]) => [k, privateKeyToAccount(v).address]));
const treasury = c.d.treasury;
const K = KEEPER_KEYS.map((k) => wallet(k)); // 3 local keepers, Anvil #7, #8, #9
const errName = (e) => e.cause?.data?.errorName ?? e.walk?.((x) => x?.data?.errorName)?.data?.errorName ?? e.shortMessage ?? e.message;
const kinds = (kp) => kp.actions.map((a) => a.kind).join(",");
let failures = 0;
const log = (...a) => console.log(...a);
const expect = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  log(`  ${ok ? "PASS" : "FAIL"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
};
const bal = (a) => read(c.usdc, "balanceOf", [a]);
const stakeOf = async (a) => (await read(c.registry, "evaluatorInfo", [a])).stake;
const cfg = await read(c.escrow, "currentConfig");
const minStake = (await read(c.registry, "config")).minStake;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString());

const mcp = await connectMcp();
const { tools } = await mcp.listTools();
log(`MCP tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);
expect("MCP tool count", tools.length, 5);

/** A-6: ask MCP for unsigned txs, sign + broadcast with the client's own wallet. */
async function openJobAsClient(args) {
  const built = await call(mcp, "open_job", { client: A.client, ...args });
  let last;
  for (const t of built.transactions) {
    const hash = await W.client.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value), nonce: t.nonce, ...(t.gas ? { gas: BigInt(t.gas) } : {}), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) });
    last = await publicClient.waitForTransactionReceipt({ hash });
    if (last.status !== "success") throw new Error(`${t.label} reverted`);
  }
  const jobId = parseEventLogs({ abi: c.escrow.abi, logs: last.logs, eventName: "JobCreated" })[0].args.jobId.toString();
  return { built, jobId, txHash: last.transactionHash };
}

// ---------------- A. x402 exact ----------------
log("\nA. x402 `exact` (EIP-3009) -> escrow deposit route -> evaluator verdict -> release");
const q = await call(mcp, "quote", { amount: "2000000", evaluator: A.evaluator });
log(`  quote: amount ${q.amount} fee ${q.feeAtFullPayout} evaluatorFee ${q.evaluatorFeeAtFullPayout} providerNet ${q.providerNetAtFullPayout} challengeBond ${q.challengeBond} arbitrationFee ${q.arbitrationFee} instantEligible ${q.instantEligible}`);

const r402 = await fetch(`${PUBLIC_BASE_URL}/v1/demo/resource`);
const pr = await r402.json();
expect("GET /v1/demo/resource without payment -> HTTP", r402.status, 402);
expect("PAYMENT-REQUIRED header decodes to body", JSON.stringify(unb64(r402.headers.get("payment-required"))) === JSON.stringify(pr), true);
expect("accepts[] schemes", pr.accepts.map((x) => x.scheme).join(","), "exact,agentcoin-escrow");
const ex = pr.accepts[0];
log(`  accepts[0]: scheme ${ex.scheme} network ${ex.network} amount ${ex.amount} asset ${ex.asset} payTo ${ex.payTo} extra.name "${ex.extra.name}" version ${ex.extra.version} assetTransferMethod ${ex.extra.assetTransferMethod}`);
const routeCheck = await read(c.routeFactory, "routeFor", [{ ...ex.extra.agentcoin.offer, amount: BigInt(ex.extra.agentcoin.offer.amount), deadlineSeconds: BigInt(ex.extra.agentcoin.offer.deadlineSeconds) }]);
expect("payTo == routeFactory.routeFor(offer) (recomputed by buyer)", routeCheck, ex.payTo);
expect("bazaar extension present", !!pr.extensions?.bazaar?.info, true);

const now = (await publicClient.getBlock()).timestamp;
const authorization = { from: A.client, to: ex.payTo, value: ex.amount, validAfter: "0", validBefore: String(now + BigInt(ex.maxTimeoutSeconds)), nonce: toHex(randomBytes(32)) };
const clientAcct = privateKeyToAccount(ANVIL_KEYS.client);
const signature = await clientAcct.signTypedData({
  domain: { name: ex.extra.name, version: ex.extra.version, chainId: LOCAL_CHAIN_ID, verifyingContract: ex.asset },
  types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization",
  message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
});
const exactPayload = { x402Version: 2, resource: pr.resource, accepted: ex, payload: { signature, authorization } };

const bad = await fetch(`${PUBLIC_BASE_URL}/v1/demo/resource`, { headers: { "PAYMENT-SIGNATURE": b64({ ...exactPayload, payload: { signature, authorization: { ...authorization, value: "1" } } }) } });
expect("exact payment with altered value -> HTTP", bad.status, 402);
log(`  rejection reason: ${(await bad.json()).error}`);

const cA0 = await bal(A.client), pA0 = await bal(A.provider), tA0 = await bal(treasury), eA0 = await bal(A.evaluator);
const r200 = await fetch(`${PUBLIC_BASE_URL}/v1/demo/resource`, { headers: { "PAYMENT-SIGNATURE": b64(exactPayload) } });
const delivered = await r200.json();
expect("exact paid GET -> HTTP", r200.status, 200);
const settle = unb64(r200.headers.get("payment-response"));
log(`  PAYMENT-RESPONSE: success ${settle.success} settleTx ${settle.transaction} payer ${settle.payer} jobId ${settle.extensions.agentcoin.jobId} submitTx ${settle.extensions.agentcoin.submitTx}`);
expect("client debited by price (USDC)", fmt6(cA0 - (await bal(A.client))), fmt6(BigInt(ex.amount)));
const jobAId = settle.extensions.agentcoin.jobId;
const jA = await call(mcp, "get_job_status", { jobId: jobAId });
expect("escrow job client == x402 payer", jA.client, A.client);
expect("escrow job provider == offer.provider", jA.provider, ex.extra.agentcoin.offer.provider);
expect("job A state after delivery", jA.state, "Submitted");
expect("job A slashBase pinned at fund (E-22)", jA.slashBase, minStake.toString());
const recomputed = keccak256(toBytes(jcs(omit(delivered, ["deliverableHash"]))));
expect("evaluator recomputed deliverableHash == on-chain", recomputed, jA.deliverableHash);

const replay = await fetch(`${PUBLIC_BASE_URL}/v1/demo/resource`, { headers: { "PAYMENT-SIGNATURE": b64(exactPayload) } });
expect("replayed exact payment -> HTTP", replay.status, 402);
log(`  replay reason: ${(await replay.json()).error}`);

// ---------------- A2. unsigned open_job + agentcoin-escrow scheme ----------------
log("\nA2. open_job (unsigned txs, client signs) + `agentcoin-escrow` scheme");
let demoSignErr = "";
try { await call(mcp, "open_job", { provider: A.provider, evaluator: A.evaluator, amount: "1", deadlineSeconds: 60, spec: "x", demoSign: true }); } catch (e) { demoSignErr = e.message; }
expect("demoSign refused without AGENTCOIN_DEMO_SIGN=1", /AGENTCOIN_DEMO_SIGN/.test(demoSignErr), true);
const esc = pr.accepts[1];
const a2 = await openJobAsClient({ provider: esc.payTo, evaluator: esc.extra.evaluator, amount: esc.amount, deadlineSeconds: esc.extra.deadlineSeconds, specHash: esc.extra.specHash });
log(`  open_job mode ${a2.built.mode}: ${a2.built.transactions.map((t) => `${t.step}:${t.label} nonce ${t.nonce}`).join(" | ")}`);
expect("open_job mode", a2.built.mode, "unsigned");
expect("jobId == expectedJobId", a2.jobId, a2.built.expectedJobId);
const r200b = await fetch(`${PUBLIC_BASE_URL}/v1/demo/resource`, { headers: { "PAYMENT-SIGNATURE": b64({ x402Version: 2, resource: pr.resource, accepted: esc, payload: { jobId: a2.jobId, txHash: a2.txHash } }) } });
expect("agentcoin-escrow paid GET -> HTTP", r200b.status, 200);
await r200b.json();

// verdicts for A and A2, then one challenge window
await send(W.evaluator, c.escrow, "verdict", [BigInt(jobAId), 1, 10000, keccak256(toBytes("deliverable matches spec"))]);
await send(W.evaluator, c.escrow, "verdict", [BigInt(a2.jobId), 1, 10000, keccak256(toBytes("deliverable matches spec"))]);
const pA1 = await bal(A.provider), tA1 = await bal(treasury), eA1 = await bal(A.evaluator);
await increaseTime(Number(cfg.challengeWindow) + 1);
const fin = await send(W.client, c.escrow, "finalize", [BigInt(jobAId)]);
log(`  finalize job ${jobAId} tx ${fin.hash}`);
const jobA = await call(mcp, "get_job_status", { jobId: jobAId });
expect("job A state after finalize", jobA.state, "Settled");
expect("provider received (USDC)", fmt6((await bal(A.provider)) - pA1), fmt6(BigInt(q.providerNetAtFullPayout)));
expect("treasury protocol fee (USDC)", fmt6((await bal(treasury)) - tA1), fmt6(BigInt(q.feeAtFullPayout)));
expect("evaluator fee (USDC, E-18)", fmt6((await bal(A.evaluator)) - eA1), fmt6(BigInt(q.evaluatorFeeAtFullPayout)));
log(`  evidence events: ${jobA.evidence.map((e) => e.event).join(" > ")}`);
await send(W.client, c.escrow, "finalize", [BigInt(a2.jobId)]);
expect("job A2 state after finalize", (await call(mcp, "get_job_status", { jobId: a2.jobId })).state, "Settled");
void cA0, pA0, tA0, eA0;

// ---------------- B. missed verdict slash ----------------
log("\nB. slash: missed verdict (timeoutRelease)");
const stake0 = await stakeOf(A.evaluator);
const jb = await openJobAsClient({ provider: A.provider, evaluator: A.evaluator, amount: "5000000", deadlineSeconds: 3600, spec: "demo job B" });
await send(W.provider, c.escrow, "submit", [BigInt(jb.jobId), keccak256(toBytes("deliverable B"))]);
const c0 = await bal(A.client), pB0 = await bal(A.provider);
await increaseTime(Number(cfg.evalWindow) + 1);
const to = await send(W.deployer, c.escrow, "timeoutRelease", [BigInt(jb.jobId)]);
const missedSlash = (minStake * BigInt(cfg.missedVerdictSlashBps)) / 10000n;
log(`  timeoutRelease tx ${to.hash}`);
expect("job B state", (await call(mcp, "get_job_status", { jobId: jb.jobId })).state, "Expired");
expect("evaluator slashed (USDC)", fmt6(stake0 - (await stakeOf(A.evaluator))), fmt6(missedSlash));
expect("client refunded (USDC)", fmt6((await bal(A.client)) - c0), "5.000000");
log(`  provider (harmed party) received ${fmt6((await bal(A.provider)) - pB0)} USDC of the slash`);

// ---------------- C. overturned verdict slash + loser-pays arbitration fee ----------------
log("\nC. slash: verdict overturned by arbitrator (loser pays arbitration fee)");
const jc = await openJobAsClient({ provider: A.provider, evaluator: A.evaluator, amount: "20000000", deadlineSeconds: 3600, spec: "demo job C" });
await send(W.provider, c.escrow, "submit", [BigInt(jc.jobId), keccak256(toBytes("deliverable C"))]);
await send(W.evaluator, c.escrow, "verdict", [BigInt(jc.jobId), 2, 0, keccak256(toBytes("wrong reject"))]);
const quoteC = await call(mcp, "quote", { amount: "20000000" });
await send(W.provider, c.usdc, "approve", [c.escrow.address, BigInt(quoteC.challengeUpfrontTotal)]);
const pC0 = await bal(A.provider);
const ch = await send(W.provider, c.escrow, "challenge", [BigInt(jc.jobId), keccak256(toBytes("deliverable meets spec"))]);
const disputeId = parseEventLogs({ abi: c.escrow.abi, logs: ch.receipt.logs, eventName: "Challenged" })[0].args.disputeId;
expect("challenger paid bond + arbitration fee (USDC)", fmt6(pC0 - (await bal(A.provider))), fmt6(BigInt(quoteC.challengeUpfrontTotal)));
log(`  challenge tx ${ch.hash} disputeId ${disputeId} bond ${quoteC.challengeBond} arbitrationFee ${quoteC.arbitrationFee}`);
const s0 = await stakeOf(A.evaluator);
const pC1 = await bal(A.provider);
const ruling = await send(W.deployer, c.arbitrator, "giveRuling", [disputeId, 10000]);
const s1 = await stakeOf(A.evaluator);
log(`  giveRuling(100%) tx ${ruling.hash}`);
const jobC = await call(mcp, "get_job_status", { jobId: jc.jobId });
expect("job C state", jobC.state, "Settled");
expect("job C payoutBps", jobC.payoutBps, 10000);
const wrongSlash = (minStake * BigInt(cfg.wrongVerdictSlashBps)) / 10000n;
expect("evaluator stake reduced by slash + reimbursed fee (USDC)", fmt6(s0 - s1), fmt6(wrongSlash + BigInt(quoteC.arbitrationFee)));
expect("ArbitrationFeeReimbursed event", parseEventLogs({ abi: c.escrow.abi, logs: ruling.receipt.logs, eventName: "ArbitrationFeeReimbursed" }).length, 1);
log(`  provider received ${fmt6((await bal(A.provider)) - pC1)} USDC (net payout + bond back + fee back + harmed share of slash); no evaluator fee on an overturned verdict`);

// ---------------- D. ERC-8183 adapter ----------------
log("\nD. ERC-8183 adapter: external kernel names the adapter as evaluator");
const acfg = await read(c.adapter, "currentConfig");
const BUDGET = 50_000_000n;
// E-1a: the quote states the earliest kernel expiry the adapter accepts right now
const qD = await call(mcp, "quote", { amount: BUDGET.toString() });
log(`  adapter quote: requiredExpiryDuration ${qD.erc8183Adapter.requiredExpiryDurationSeconds}s minKernelExpiry ${qD.erc8183Adapter.minKernelExpiry} challengeBond ${qD.erc8183Adapter.challengeBond} arbitrationFee ${qD.erc8183Adapter.arbitrationFee}`);
expect("requiredExpiryDuration == eval + challenge + arbitrationTimeout + margin", qD.erc8183Adapter.requiredExpiryDurationSeconds, String(acfg.evalWindow + acfg.challengeWindow + acfg.arbitrationTimeout + acfg.expiryMargin));
const expiredAt = BigInt(qD.erc8183Adapter.minKernelExpiry) + 600n; // small slack for blocks mined before assign/accept
const kc = await send(W.client, c.kernel, "createJob", [A.provider, c.adapter.address, expiredAt, "demo job D: JSON summary of input", "0x0000000000000000000000000000000000000000"]);
const kjId = parseEventLogs({ abi: c.kernel.abi, logs: kc.receipt.logs, eventName: "JobCreated" })[0].args.jobId;
await send(W.client, c.kernel, "setBudget", [kjId, BUDGET, "0x"]);
await send(W.client, c.usdc, "approve", [c.kernel.address, BUDGET]);
await send(W.client, c.kernel, "fund", [kjId, BUDGET, "0x"]);
log(`  kernel ${c.kernel.address} job ${kjId}: evaluator ${(await read(c.kernel, "getJob", [kjId])).evaluator} (adapter ${c.adapter.address}), status ${KERNEL_STATES[(await read(c.kernel, "getJob", [kjId])).status]}`);
const as = await send(W.client, c.adapter, "assign", [c.kernel.address, kjId, A.evaluator]);
const aid = parseEventLogs({ abi: c.adapter.abi, logs: as.receipt.logs, eventName: "Assigned" })[0].args.id;
await send(W.evaluator, c.adapter, "acceptAssignment", [aid]);
expect("adapter job state after accept", ADAPTER_STATES[(await read(c.adapter, "getJob", [aid])).state], "Active");
await send(W.provider, c.kernel, "submit", [kjId, keccak256(toBytes("deliverable D")), "0x"]);
const vd = await send(W.evaluator, c.adapter, "verdict", [aid, 8000, keccak256(toBytes("80% of fields correct"))]);
const held = parseEventLogs({ abi: c.adapter.abi, logs: vd.receipt.logs, eventName: "VerdictHeld" })[0].args;
log(`  verdict payoutBps ${held.payoutBps} -> completes ${held.completes} (completeThresholdBps ${acfg.completeThresholdBps}; partial mapped to binary, lossy)`);
expect("adapter job held", ADAPTER_STATES[(await read(c.adapter, "getJob", [aid])).state], "Held");
expect("kernel job still Submitted during challenge window", KERNEL_STATES[(await read(c.kernel, "getJob", [kjId])).status], "Submitted");
let early = "";
try { await send(W.deployer, c.adapter, "finalize", [aid]); } catch (e) { early = e.shortMessage ?? e.message; }
expect("finalize before challenge window reverts", early.length > 0, true);
await increaseTime(Number(acfg.challengeWindow) + 1);
const pD0 = await bal(A.provider), eD0 = await bal(A.evaluator), tD0 = await bal(treasury);
const fd = await send(W.deployer, c.adapter, "finalize", [aid]);
log(`  finalize tx ${fd.hash}`);
expect("adapter job state", ADAPTER_STATES[(await read(c.adapter, "getJob", [aid])).state], "Executed");
expect("kernel job status", KERNEL_STATES[(await read(c.kernel, "getJob", [kjId])).status], "Completed");
const [kPlat, kEval] = await Promise.all([read(c.kernel, "platformFeeBP"), read(c.kernel, "evaluatorFeeBP")]);
const kFee = (BUDGET * kPlat) / 10000n, kEv = (BUDGET * kEval) / 10000n;
expect("provider paid by kernel (USDC)", fmt6((await bal(A.provider)) - pD0), fmt6(BUDGET - kFee - kEv));
expect("kernel evaluator fee forwarded to staked evaluator (USDC)", fmt6((await bal(A.evaluator)) - eD0), fmt6(kEv));
expect("kernel platform fee to kernel treasury (USDC)", fmt6((await bal(treasury)) - tD0), fmt6(kFee));
expect("evaluator exposure released", (await read(c.registry, "evaluatorInfo", [A.evaluator])).exposure, 0);

// ---------------- D1. E-1a min-expiry refusal ----------------
log("\nD1. E-1a: adapter refuses a kernel job that expires before the windows can finish");
const qD1 = await call(mcp, "quote", { amount: "1000000" });
const shortExpiry = BigInt(qD1.erc8183Adapter.minKernelExpiry) - 3600n;
const kc1 = await send(W.client, c.kernel, "createJob", [A.provider, c.adapter.address, shortExpiry, "demo job D1", "0x0000000000000000000000000000000000000000"]);
const kj1 = parseEventLogs({ abi: c.kernel.abi, logs: kc1.receipt.logs, eventName: "JobCreated" })[0].args.jobId;
await send(W.client, c.kernel, "setBudget", [kj1, 1_000_000n, "0x"]);
await send(W.client, c.usdc, "approve", [c.kernel.address, 1_000_000n]);
await send(W.client, c.kernel, "fund", [kj1, 1_000_000n, "0x"]);
let refusal = "";
try { await send(W.client, c.adapter, "assign", [c.kernel.address, kj1, A.evaluator]); } catch (e) { refusal = e.cause?.data?.errorName ?? e.shortMessage ?? e.message; }
log(`  kernel job ${kj1} expiredAt ${shortExpiry} < minKernelExpiry ${qD1.erc8183Adapter.minKernelExpiry}; assign -> ${refusal}`);
expect("assign below min kernel expiry refused", /ExpiryTooSoon/.test(refusal), true);

// ---------------- D2. E-1c late-submission refusal ----------------
log("\nD2. E-1c: provider submits too late for the adapter's windows -> refused, exposure released, no slash");
const qD2 = await call(mcp, "quote", { amount: "2000000" });
const expD2 = BigInt(qD2.erc8183Adapter.minKernelExpiry) + 600n;
const kc2 = await send(W.client, c.kernel, "createJob", [A.provider, c.adapter.address, expD2, "demo job D2", "0x0000000000000000000000000000000000000000"]);
const kj2 = parseEventLogs({ abi: c.kernel.abi, logs: kc2.receipt.logs, eventName: "JobCreated" })[0].args.jobId;
await send(W.client, c.kernel, "setBudget", [kj2, 2_000_000n, "0x"]);
await send(W.client, c.usdc, "approve", [c.kernel.address, 2_000_000n]);
await send(W.client, c.kernel, "fund", [kj2, 2_000_000n, "0x"]);
const as2 = await send(W.client, c.adapter, "assign", [c.kernel.address, kj2, A.evaluator]);
const aid2 = parseEventLogs({ abi: c.adapter.abi, logs: as2.receipt.logs, eventName: "Assigned" })[0].args.id;
const exp0 = (await read(c.registry, "evaluatorInfo", [A.evaluator])).exposure;
await send(W.evaluator, c.adapter, "acceptAssignment", [aid2]);
expect("D2 exposure locked at accept", (await read(c.registry, "evaluatorInfo", [A.evaluator])).exposure - exp0, 2_000_000n);
await increaseTime(3600); // provider is slow: now + requiredExpiryDuration > kernel expiredAt
await send(W.provider, c.kernel, "submit", [kj2, keccak256(toBytes("deliverable D2")), "0x"]);
const st2 = await stakeOf(A.evaluator);
const ns2 = await send(W.deployer, c.adapter, "noteSubmission", [aid2]);
const risk2 = parseEventLogs({ abi: c.adapter.abi, logs: ns2.receipt.logs, eventName: "ExpiryRisk" });
log(`  kernel job ${kj2} expiredAt ${expD2}; noteSubmission tx ${ns2.hash}: ExpiryRisk expiredAt ${risk2[0]?.args.expiredAt} < requiredExpiredAt ${risk2[0]?.args.requiredExpiredAt}`);
expect("D2 ExpiryRisk emitted with the refusal", risk2.length, 1);
expect("D2 adapter job state", ADAPTER_STATES[(await read(c.adapter, "getJob", [aid2])).state], "ExpiryRefused");
expect("D2 no eval window started (submittedAt)", (await read(c.adapter, "getJob", [aid2])).submittedAt, 0);
expect("D2 exposure released", (await read(c.registry, "evaluatorInfo", [A.evaluator])).exposure, exp0);
expect("D2 evaluator not slashed", await stakeOf(A.evaluator), st2);
let v2 = "";
try { await send(W.evaluator, c.adapter, "verdict", [aid2, 10000, keccak256(toBytes("late"))]); } catch (e) { v2 = e.cause?.data?.errorName ?? e.shortMessage ?? e.message; }
expect("D2 verdict after refusal reverts WrongState", /WrongState/.test(v2), true);
expect("D2 kernel job still Submitted (falls to the kernel refund path at expiry)", KERNEL_STATES[(await read(c.kernel, "getJob", [kj2])).status], "Submitted");

// ---------------- D3. E-1d Proposed assignment on a kernel job that ends ----------------
log("\nD3. E-1d: Proposed (never accepted) assignment; kernel job expires; anyone closes the assignment");
const qD3 = await call(mcp, "quote", { amount: "1000000" });
const kc3 = await send(W.client, c.kernel, "createJob", [A.provider, c.adapter.address, BigInt(qD3.erc8183Adapter.minKernelExpiry) + 600n, "demo job D3", "0x0000000000000000000000000000000000000000"]);
const kj3 = parseEventLogs({ abi: c.kernel.abi, logs: kc3.receipt.logs, eventName: "JobCreated" })[0].args.jobId;
await send(W.client, c.kernel, "setBudget", [kj3, 1_000_000n, "0x"]);
await send(W.client, c.usdc, "approve", [c.kernel.address, 1_000_000n]);
await send(W.client, c.kernel, "fund", [kj3, 1_000_000n, "0x"]);
const as3 = await send(W.client, c.adapter, "assign", [c.kernel.address, kj3, A.evaluator]);
const aid3 = parseEventLogs({ abi: c.adapter.abi, logs: as3.receipt.logs, eventName: "Assigned" })[0].args.id;
expect("D3 adapter job state (evaluator never accepts)", ADAPTER_STATES[(await read(c.adapter, "getJob", [aid3])).state], "Proposed");
let early3 = "";
try { await send(W.deployer, c.adapter, "closeKernelEnded", [aid3]); } catch (e) { early3 = e.cause?.data?.errorName ?? e.shortMessage ?? e.message; }
expect("D3 close while the kernel job is live reverts WrongKernelStatus", /WrongKernelStatus/.test(early3), true);
// D2/D3 finish after the 30-day advance in E (kernel expiry passes)

// ---------------- F. A-1b/A-1e v0.1.2: k-of-n keepers ----------------
log("\nF. A-1e k-of-n: authorization submitted to the token directly; 3 local keepers, threshold 2; 1-of-3 does not credit, 2-of-3 does");
const o = x402Offer();
const route = await read(c.routeFactory, "routeFor", [o]);
const vault = c.vault;
expect("factory.vault == deployments recoveryVault", await read(c.routeFactory, "vault"), vault.address);
expect("keeper threshold k", await read(c.routeFactory, "threshold"), 2);
expect("keeper count n", await read(c.routeFactory, "keeperCount"), 3);
for (const [i, w] of K.entries()) expect(`keeper ${i} (Anvil #${7 + i}) ${w.account.address} allowlisted`, await read(c.routeFactory, "isKeeper", [w.account.address]), true);
expect("deployer (Anvil #0) is NOT a keeper any more", await read(c.routeFactory, "isKeeper", [A.deployer]), false);
const nowF = (await publicClient.getBlock()).timestamp;
const authF = { from: A.client, to: route, value: o.amount, validAfter: 0n, validBefore: nowF + 3600n, nonce: toHex(randomBytes(32)) };
const sigF = await clientAcct.signTypedData({
  domain: { name: ex.extra.name, version: ex.extra.version, chainId: LOCAL_CHAIN_ID, verifyingContract: ex.asset },
  types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization",
  message: authF,
});
const fromBlockF = await publicClient.getBlockNumber();
const jobsBeforeF = await read(c.escrow, "jobCount");
const direct = await send(W.deployer, c.usdc, "transferWithAuthorization", [authF.from, authF.to, authF.value, authF.validAfter, authF.validBefore, authF.nonce, sigF]);
log(`  direct token transferWithAuthorization tx ${direct.hash}: route balance ${fmt6(await bal(route))} USDC, no job opened`);
expect("no escrow job opened by the direct transfer", await read(c.escrow, "jobCount"), jobsBeforeF);
let frontRunErr = "";
try {
  await send(W.deployer, c.routeFactory, "settle", [o, authF.from, authF.value, authF.validAfter, authF.validBefore, authF.nonce, sigF]);
} catch (e) {
  // the revert comes from the token (bubbled through the route), so decode it with the token ABI
  const raw = e.walk?.((x) => typeof x?.raw === "string")?.raw;
  try { frontRunErr = decodeErrorResult({ abi: ABI.usdc, data: raw }).errorName; } catch { frontRunErr = errName(e); }
}
log(`  facilitator presents the same authorization to factory.settle: reverts ${frontRunErr}`);
expect("presenting the used authorization to settle reverts (no front-run path)", /AuthorizationAlreadyUsed/.test(frontRunErr), true);
// finality: the Transfer is younger than the confirmation depth
const kp0a = await keeperPass({ c, offers: [o], signer: K[0], fromBlock: fromBlockF });
log(`  keeper #7 pass right after the tx: ${kinds(kp0a)} (block ${kp0a.actions[0]?.block}, safe head ${kp0a.finality.safeHead}, confirmations ${kp0a.finality.confirmations}, source ${kp0a.finality.source})`);
expect("keeper waits for finality (confirmation depth; Anvil has no `finalized` tag in use)", kinds(kp0a), "pending-finality");
expect("nextFromBlock does not skip the pending log", BigInt(kp0a.nextFromBlock) <= direct.receipt.blockNumber, true);
await mine(Number(DEFAULT_CONFIRMATIONS));
const kp0 = await keeperPass({ c, offers: [o], signer: K[0], fromBlock: fromBlockF });
log(`  keeper #7 actions: ${kp0.actions.map((a) => `${a.kind} ${a.votes ?? ""} log ${a.tx}#${a.logIndex}${a.attestTx ? ` attestTx ${a.attestTx}` : ""}`).join("; ")}`);
expect("keeper #7 vote recorded, 1 of 2 needed", kp0.actions.map((a) => `${a.kind}:${a.votes}`).join(","), "vote-recorded:1/2");
expect("1-of-3: no escrow job opened", await read(c.escrow, "jobCount"), jobsBeforeF);
expect("1-of-3: route still holds the payment (USDC)", fmt6(await bal(route)), fmt6(o.amount));
const cvF = await claimView(c, direct.hash, BigInt(kp0.actions[0].logIndex), A.keeper0);
expect("claim status after 1 vote", `${cvF.status} ${cvF.count}`, "Pending 1");
expect("keeper #7 re-run: already voted", kinds(await keeperPass({ c, offers: [o], signer: K[0], fromBlock: fromBlockF })), "already-voted");
const kp1 = await keeperPass({ c, offers: [o], signer: K[1], fromBlock: fromBlockF });
const att = kp1.actions.find((a) => a.kind === "credited-job");
log(`  keeper #8 actions: ${kp1.actions.map((a) => `${a.kind} log ${a.tx}#${a.logIndex}${a.jobId && a.jobId !== "0" ? ` job ${a.jobId}` : ""}${a.attestTx ? ` attestTx ${a.attestTx}` : ""}`).join("; ")}`);
expect("2-of-3: keeper #8's matching vote credits the Transfer log of the direct tx", att?.tx, direct.hash);
const jF = await call(mcp, "get_job_status", { jobId: att.jobId });
expect("credited job client == payer", jF.client, A.client);
expect("credited job state", jF.state, "Funded");
expect("route balance after credit", await bal(route), 0);
expect("factory.attested(transferId(txHash, logIndex))", await read(c.routeFactory, "attested", [cvF.id]), true);
let dupErr = "";
try { await send(K[2], c.routeFactory, "attestDeposit", [o, att.tx, BigInt(att.logIndex), A.client, o.amount, false]); } catch (e) { dupErr = errName(e); }
log(`  keeper #9 attesting ${att.tx}#${att.logIndex} after the credit: ${dupErr}`);
expect("third vote / double attestation of the same (txHash, logIndex) reverts AlreadyAttested", /AlreadyAttested/.test(dupErr), true);
let nkErr = "";
try { await send(W.client, c.routeFactory, "attestDeposit", [o, toHex(randomBytes(32)), 0n, A.client, 1n, true]); } catch (e) { nkErr = errName(e); }
expect("non-keeper attestation reverts NotKeeper", /NotKeeper/.test(nkErr), true);
expect("keeper #9 pass is a no-op", kinds(await keeperPass({ c, offers: [o], signer: K[2], fromBlock: fromBlockF })), "already-attested");

// ---------------- F2. conflicting attestation freezes ----------------
log("\nF2. conflicting attestation: keeper #9 attests a wrong value -> the deposit is frozen; owner resolution is timelocked");
const fromBlockF2 = await publicClient.getBlockNumber() + 1n;
const plain = await send(W.client, c.usdc, "transfer", [route, o.amount]);
await mine(Number(DEFAULT_CONFIRMATIONS));
const kpF2 = await keeperPass({ c, offers: [o], signer: K[1], fromBlock: fromBlockF2 });
expect("keeper #8 votes honestly (1/2)", kpF2.actions.map((a) => `${a.kind}:${a.votes}`).join(","), "vote-recorded:1/2");
const liF2 = BigInt(kpF2.actions[0].logIndex);
const badVote = await send(K[2], c.routeFactory, "attestDeposit", [o, plain.hash, liF2, A.client, o.amount - 1n, false]); // malicious/buggy keeper #9
const fz = parseEventLogs({ abi: ABI.routeFactory, logs: badVote.receipt.logs, eventName: "DepositFrozen" });
log(`  keeper #9 attests value ${o.amount - 1n} instead of ${o.amount}: tx ${badVote.hash}, DepositFrozen ${fz.length ? `recorded ${fz[0].args.recordedDigest} vs ${fz[0].args.conflictingDigest}` : "missing"}`);
expect("conflicting attestation emits DepositFrozen", fz.length, 1);
const cvF2 = await claimView(c, plain.hash, liF2, A.keeper0);
expect("claim status", cvF2.status, "Frozen");
expect("nothing credited: route still holds the transfer (USDC)", fmt6(await bal(route)), fmt6(o.amount));
expect("keeper #7 pass skips the frozen deposit", kinds(await keeperPass({ c, offers: [o], signer: K[0], fromBlock: fromBlockF2 })), "frozen-awaiting-resolution");
let fzErr = "";
try { await send(K[0], c.routeFactory, "attestDeposit", [o, plain.hash, liF2, A.client, o.amount, false]); } catch (e) { fzErr = errName(e); }
expect("a direct vote on a frozen deposit reverts DepositIsFrozen", /DepositIsFrozen/.test(fzErr), true);
let ownErr = "";
try { await send(W.client, c.routeFactory, "proposeResolution", [cvF2.id, 1, route, A.client, o.amount, false]); } catch (e) { ownErr = errName(e); }
expect("non-owner proposeResolution reverts", /OwnableUnauthorizedAccount/.test(ownErr), true);
const prop = await send(W.deployer, c.routeFactory, "proposeResolution", [cvF2.id, 1, route, A.client, o.amount, false]); // 1 = ResolutionKind.Credit
const pev = parseEventLogs({ abi: ABI.routeFactory, logs: prop.receipt.logs, eventName: "ResolutionProposed" })[0];
log(`  owner proposes resolution Credit(${A.client}, ${o.amount}) tx ${prop.hash}, eta ${pev?.args.eta}`);
let earlyRes = "";
try { await send(W.deployer, c.routeFactory, "executeResolution", [cvF2.id, o]); } catch (e) { earlyRes = errName(e); }
expect("executeResolution before the 48h timelock reverts TimelockNotElapsed", /TimelockNotElapsed/.test(earlyRes), true);

// ---------------- G. RecoveryVault (start) ----------------
log("\nG. A-1a/A-1d RecoveryVault: a keeper starts the sweep before a wrong-amount transfer is attested; swept funds go to the vault");
const sweepTo = await read({ address: route, abi: ABI.route }, "sweepTo");
expect("route sweepTo fixed at creation == RecoveryVault (A-1d, no sweep to treasury)", sweepTo, vault.address);
expect("vault treasury (after the horizon only)", await read(vault, "treasury"), treasury);
expect("vault horizon (s)", await read(vault, "horizon"), 365 * 24 * 3600);
const fromBlockG = await publicClient.getBlockNumber() + 1n;
const wrongAmt = 500_000n;
await send(W.client, c.usdc, "transfer", [route, wrongAmt]); // wrong-amount transfer (attributable to the client)
await send(W.deployer, c.usdc, "mint", [route, 1_000_000n]); // unattributable (Transfer from address(0))
let nkSweep = "";
try { await send(W.client, { address: route, abi: ABI.route }, "startSweep"); } catch (e) { nkSweep = errName(e); }
expect("non-keeper startSweep reverts NotKeeper", /NotKeeper/.test(nkSweep), true);
const st = await send(K[0], { address: route, abi: ABI.route }, "startSweep"); // lagging: before anyone attested the 0.5
const snap = await read({ address: route, abi: ABI.route }, "sweepAmount");
log(`  keeper #7 startSweep tx ${st.hash}: snapshot ${fmt6(snap)} USDC (frozen F2 deposit ${fmt6(o.amount)} + unattested transfer 0.5 + mint 1.0)`);
expect("sweep snapshot (USDC)", fmt6(snap), fmt6(o.amount + wrongAmt + 1_000_000n));
let tooEarly = "";
try { await send(W.deployer, { address: route, abi: ABI.route }, "sweep"); } catch (e) { tooEarly = errName(e); }
expect("sweep before delay reverts", /SweepDelayNotElapsed/.test(tooEarly), true);

// ---------------- E. E-17a stale dispute: fee refunded ----------------
log("\nE. E-17a stale dispute: arbitrator never rules -> bond + arbitration fee refunded to challenger");
const je = await openJobAsClient({ provider: A.provider, evaluator: A.evaluator, amount: "10000000", deadlineSeconds: 3600, spec: "demo job E" });
await send(W.provider, c.escrow, "submit", [BigInt(je.jobId), keccak256(toBytes("deliverable E"))]);
await send(W.evaluator, c.escrow, "verdict", [BigInt(je.jobId), 1, 10000, keccak256(toBytes("complete"))]);
const qE = await call(mcp, "quote", { amount: "10000000" });
await send(W.client, c.usdc, "approve", [c.escrow.address, BigInt(qE.challengeUpfrontTotal)]);
const cEpre = await bal(A.client);
const chE = await send(W.client, c.escrow, "challenge", [BigInt(je.jobId), keccak256(toBytes("client disputes"))]);
const cE0 = await bal(A.client);
expect("challenger paid bond + arbitration fee (USDC)", fmt6(cEpre - cE0), fmt6(BigInt(qE.challengeUpfrontTotal)));
const escE = parseEventLogs({ abi: c.escrow.abi, logs: chE.receipt.logs, eventName: "ArbitrationFeeEscrowed" });
expect("arbitration fee held by escrow at challenge (ArbitrationFeeEscrowed)", escE.length === 1 && escE[0].args.fee === BigInt(qE.arbitrationFee), true);
const arbBalE = await bal(c.arbitrator.address);
const pE0 = await bal(A.provider);
const waitE = Math.max(Number(cfg.arbitrationTimeout), Number(await read(c.routeFactory, "sweepDelay"))) + 1;
await increaseTime(waitE);
log(`  advanced ${waitE}s (arbitrationTimeout ${cfg.arbitrationTimeout}s, sweepDelay ${await read(c.routeFactory, "sweepDelay")}s)`);
const rs = await send(W.deployer, c.escrow, "resolveStaleDispute", [BigInt(je.jobId)]);
const refundEv = parseEventLogs({ abi: c.escrow.abi, logs: rs.receipt.logs, eventName: "ArbitrationFeeRefunded" });
log(`  resolveStaleDispute tx ${rs.hash}`);
expect("job E state", (await call(mcp, "get_job_status", { jobId: je.jobId })).state, "Settled");
expect("challenger refunded bond + arbitration fee (USDC)", fmt6((await bal(A.client)) - cE0), fmt6(BigInt(qE.challengeUpfrontTotal)));
expect("ArbitrationFeeRefunded event", refundEv.length, 1);
expect("arbitrator received nothing", (await bal(c.arbitrator.address)) - arbBalE, 0);
expect("verdict executed: provider paid net (USDC)", fmt6((await bal(A.provider)) - pE0), fmt6(BigInt(qE.providerNetAtFullPayout)));

// ---------------- D2 / D3 finish (kernel expiry has passed) ----------------
const cD2 = await bal(A.client);
await send(W.deployer, c.kernel, "claimRefund", [kj2]);
expect("D2 kernel refund path: client refunded by the kernel (USDC)", fmt6((await bal(A.client)) - cD2), "2.000000");
expect("D2 kernel job status", KERNEL_STATES[(await read(c.kernel, "getJob", [kj2])).status], "Expired");
expect("D2 evaluator still not slashed", await stakeOf(A.evaluator), st2);
await send(W.deployer, c.kernel, "claimRefund", [kj3]);
let acc3 = "";
try { await send(W.evaluator, c.adapter, "acceptAssignment", [aid3]); } catch (e) { acc3 = e.cause?.data?.errorName ?? e.shortMessage ?? e.message; }
expect("D3 accept on an ended kernel job reverts WrongKernelStatus", /WrongKernelStatus/.test(acc3), true);
const cl3 = await send(W.deployer, c.adapter, "closeKernelEnded", [aid3]);
log(`  D3 closeKernelEnded tx ${cl3.hash}`);
expect("D3 adapter job state", ADAPTER_STATES[(await read(c.adapter, "getJob", [aid3])).state], "KernelEnded");
expect("D3 KernelJobEnded event", parseEventLogs({ abi: c.adapter.abi, logs: cl3.receipt.logs, eventName: "KernelJobEnded" }).length, 1);

// ---------------- G. RecoveryVault (finish; 30d+ have passed) ----------------
log("\nG (finish). F2 resolution executes after the timelock; sweep into the vault; 2-of-3 claim from the vault");
const res = await send(W.client, c.routeFactory, "executeResolution", [cvF2.id, o]); // anyone executes
const rev = parseEventLogs({ abi: ABI.routeFactory, logs: res.receipt.logs, eventName: "DepositResolved" })[0];
log(`  executeResolution tx ${res.hash}: job ${rev?.args.jobId} refunded ${rev?.args.refunded}`);
expect("frozen deposit resolved by the timelocked owner resolution (job opened for the payer)", rev && rev.args.jobId > 0n && !rev.args.refunded, true);
expect("resolved job client", (await call(mcp, "get_job_status", { jobId: rev.args.jobId.toString() })).client, A.client);
expect("claim status after resolution", (await claimView(c, plain.hash, liF2)).status, "Credited");
const tG0 = await bal(treasury);
const vG0 = await read(vault, "unclaimed", [route]);
const kpS = await keeperPass({ c, offers: [o], signer: K[2], fromBlock: fromBlockG, sweep: true });
const swept = kpS.actions.find((a) => a.kind === "swept-to-vault");
log(`  keeper #9 pass with --sweep: ${kpS.actions.map((a) => `${a.kind}${a.amount ? ` ${a.amount}` : ""}${a.votes ? ` ${a.votes}` : ""}`).join("; ")}`);
// keeper #9 also votes on the 0.5 transfer in the same pass (attestations run before the sweep step)
expect("keeper #9 votes the unattested transfer (1/2), skips the mint, then sweeps", kinds(kpS), "vote-recorded,unattributable-mint,swept-to-vault");
expect("sweep amount = snapshot - resolved credit (USDC)", fmt6(BigInt(swept?.amount ?? 0)), fmt6(wrongAmt + 1_000_000n));
expect("treasury received nothing from the sweep", (await bal(treasury)) - tG0, 0);
expect("vault unclaimed[route] after sweep (USDC)", fmt6((await read(vault, "unclaimed", [route])) - vG0), fmt6(wrongAmt + 1_000_000n));
expect("route balance after sweep", await bal(route), 0);
const cG0 = await bal(A.client);
const kpV = await keeperPass({ c, offers: [o], signer: K[0], fromBlock: fromBlockG });
const claim = kpV.actions.find((a) => a.kind === "credited-vault-refund");
log(`  keeper #7 actions: ${kpV.actions.map((a) => `${a.kind}${a.attestTx ? ` attestTx ${a.attestTx}` : ""}`).join("; ")}`);
expect("2-of-3: keeper #7's matching vote pays the payer back from the RecoveryVault", kinds(kpV), "credited-vault-refund,unattributable-mint");
expect("payer refunded the swept wrong-amount transfer (USDC)", fmt6((await bal(A.client)) - cG0), fmt6(wrongAmt));
expect("vault unclaimed[route] after claim = the mint (USDC)", fmt6((await read(vault, "unclaimed", [route])) - vG0), "1.000000");
expect("vault balance == totalUnclaimed", await bal(vault.address), await read(vault, "totalUnclaimed"));
let dblErr = "";
try { await send(K[1], c.routeFactory, "attestDeposit", [o, claim.tx, BigInt(claim.logIndex), A.client, wrongAmt, true]); } catch (e) { dblErr = errName(e); }
log(`  keeper #8 claiming ${claim?.tx}#${claim?.logIndex} again: ${dblErr}`);
expect("double claim of the same (txHash, logIndex) reverts AlreadyAttested", /AlreadyAttested/.test(dblErr), true);
let relErr = "";
try { await send(W.deployer, vault, "releaseExpired", [route]); } catch (e) { relErr = errName(e); }
const relAt = await read(vault, "releasableAt", [route]);
log(`  releaseExpired before the horizon: ${relErr}; releasableAt ${relAt} (${new Date(Number(relAt) * 1000).toISOString()})`);
expect("unclaimed funds cannot go to the treasury before the 365d horizon", /HorizonNotElapsed/.test(relErr), true);

// ---------------- reputation + verification ----------------
log("\nReputation (get_evaluator_reputation)");
const rep = await call(mcp, "get_evaluator_reputation", { evaluator: A.evaluator });
log(`  counts ${JSON.stringify(rep.counts)}`);
log(`  currentStake ${rep.currentStake} slashedTotal ${rep.slashedTotal} totalVolume ${rep.totalVolume} avgTimeToVerdictSeconds ${rep.avgTimeToVerdictSeconds}`);
expect("verdictsOverturned", rep.counts.verdictsOverturned, 1);
expect("missedVerdicts", rep.counts.missedVerdicts, 1);
expect("slash evidence entries", rep.evidence.slashes.length, 2);
expect("arbitration fee reimbursement entries", rep.evidence.arbitrationFeeReimbursements.length, 1);
expect("adapter verdicts", rep.counts.adapter.verdicts, 1);
log(`  slash tx evidence: ${rep.evidence.slashes.map((s) => `${s.source}:${s.txHash}`).join(", ")}`);

log("\nverify_attestation on trust manifest and agent card (jku -> /.well-known/jwks.json)");
const manifest = JSON.parse(readFileSync(new URL("../artifacts/trust-manifest.json", import.meta.url)));
const ver = await call(mcp, "verify_attestation", { document: manifest });
expect("manifest valid", ver.valid, true);
log(`  ${ver.checks.length} checks; stake note: ${ver.checks.find((x) => x.check.includes("stake@latest")).detail}`);
const card = await (await fetch(`${PUBLIC_BASE_URL}/.well-known/agent-card.json`)).json();
const vc = await call(mcp, "verify_attestation", { document: card });
expect("agent card valid", vc.valid, true);
log(`  ${vc.checks.map((x) => `${x.pass ? "ok" : "FAIL"} ${x.check}`).join("; ")}`);

await mcp.close();
log(`\n${failures === 0 ? "DEMO OK" : `DEMO FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
