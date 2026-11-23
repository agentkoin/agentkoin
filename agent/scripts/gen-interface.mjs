// Generates docs/interface.json: machine-readable lifecycle, functions, events, errors and defaults,
// derived from the compiled ABIs in out/ plus the state machine in src/JobEscrow.sol.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ABI, ROOT, STATES, OUTCOMES, ADAPTER_STATES, KERNEL_STATES, TOKEN_EIP712 } from "../lib/config.mjs";

const fn = (abi) => abi.filter((x) => x.type === "function").map((f) => ({ name: f.name, stateMutability: f.stateMutability, inputs: f.inputs.map((i) => `${i.type} ${i.name}`), outputs: f.outputs.map((o) => o.type + (o.name ? ` ${o.name}` : "")) }));
const evs = (abi) => abi.filter((x) => x.type === "event").map((e) => ({ name: e.name, inputs: e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`) }));
const errs = (abi) => abi.filter((x) => x.type === "error").map((e) => e.name + "(" + e.inputs.map((i) => i.type).join(",") + ")");

const iface = {
  v: "agentcoin-interface/0.1.2",
  spec: "specs/SPEC-v0.md",
  units: { token: "USDC base units, 6 decimals", bps: "basis points, 10000 = 100%", time: "seconds (unix)" },
  states: STATES,
  outcomes: OUTCOMES,
  transitions: [
    { from: "None", to: "Open", fn: "createJob", by: "client" },
    { from: "None", to: "Funded", fn: "createAndFund", by: "client" },
    { from: "Open", to: "Funded", fn: "fund", by: "client" },
    { from: "Open", to: "Cancelled", fn: "cancel", by: "client" },
    { from: "Funded", to: "Cancelled", fn: "cancel", by: "client", when: "not accepted" },
    { from: "Funded", to: "Expired", fn: "cancel|claimRefund", by: "client|anyone", when: "block.timestamp >= deadline" },
    { from: "Funded", to: "Submitted", fn: "submit", by: "provider", when: "before deadline, not instant-eligible" },
    { from: "Funded", to: "Completed", fn: "submit", by: "provider", when: "amount <= instantThreshold and providerBond*10000 >= amount*instantBondCoverBps (instant release)" },
    { from: "Submitted", to: "Completed|Rejected|Partial", fn: "verdict|complete|reject", by: "evaluator", when: "within evalWindow of submit" },
    { from: "Submitted", to: "Expired", fn: "timeoutRelease", by: "anyone", when: "evalWindow elapsed; evaluator slashed missedVerdictSlashBps of minStake; client refunded" },
    { from: "Completed|Rejected|Partial", to: "Disputed", fn: "challenge", by: "client|provider (client only if instant)", when: "within challengeWindow of verdict; bond = max(amount*challengeBondBps/10000, minChallengeBond)" },
    { from: "Completed|Rejected|Partial", to: "Settled", fn: "finalize", by: "anyone", when: "challengeWindow elapsed" },
    { from: "Disputed", to: "Settled", fn: "rule", by: "snapshotted arbitrator" },
    { from: "Disputed", to: "Settled", fn: "resolveStaleDispute", by: "anyone", when: "arbitrationTimeout elapsed; settles per verdict; challenge bond and held arbitration cost refunded to the challenger (E-17a)" },
  ],
  fees: {
    protocolFee: "feeBps of provider gross (to treasury); 0 on reject/refund",
    evaluatorFee: "evaluatorFeeBps of provider gross (to evaluator) on settled Complete/Partial when the verdict stands; 0 on reject, overturn, instant release",
    arbitrationFee: "IArbitrator.arbitrationCost(jobId, amount) quoted at challenge time (jobId 0 = prospective quote); challenger pays it with the bond; held by the escrow/adapter until the ruling (E-17a); paid to the arbitrator inside rule(); on a material ruling the losing side reimburses the challenger (evaluator stake on verdict path, provider bond on instant path); on a stale dispute refunded to the challenger",
  },
  erc8183Adapter: {
    contract: "ERC8183EvaluatorAdapter",
    role: "evaluator address named by an external ERC-8183 kernel; a staked evaluator in EvaluatorRegistry makes the decision",
    states: ADAPTER_STATES,
    kernelStates: KERNEL_STATES,
    expiryBound: {
      rule: "kernel expiredAt >= now + evalWindow + challengeWindow + arbitrationTimeout + expiryMargin at assign and at acceptAssignment (E-1a)",
      defaults: { evalWindow: 86400, challengeWindow: 86400, arbitrationTimeout: 604800, expiryMargin: 3600, requiredExpiryDuration: 781200 },
      views: ["requiredExpiryDuration(uint32 version)", "minKernelExpiry()", "quote(uint256 budget) -> (challengeBond, arbitrationCost, requiredExpiry, minKernelExpiry, configVersion)"],
      lateSubmission: "E-1c refuse: if the submission is first observed (noteSubmission or verdict) when expiredAt < now + requiredExpiryDuration(pinned version), no eval window starts: state -> ExpiryRefused, ExpiryRisk(id, expiredAt, requiredExpiredAt) emitted, evaluator exposure released, no slash; the kernel job falls to the kernel's own refund path (claimRefund after expiry). ExpiryRisk is only ever emitted together with this refusal.",
      erc8183FundNote: "follows the ERC-8183 normative text fund(jobId, expectedBudget, optParams); the reference implementation differs, see ASSUMPTIONS E-1b",
    },
    mapping: "payoutBps >= completeThresholdBps -> kernel.complete, else kernel.reject (lossy: ERC-8183 has no partial outcome)",
    transitions: [
      { from: "None", to: "Proposed", fn: "assign", by: "kernel client", when: "kernel.evaluator == adapter, kernel status Funded|Submitted, paymentToken == token, expiredAt >= now + evalWindow + challengeWindow + arbitrationTimeout + expiryMargin (see minKernelExpiry), evaluator active" },
      { from: "Proposed", to: "Withdrawn", fn: "withdrawAssignment", by: "kernel client" },
      { from: "Proposed", to: "Active", fn: "acceptAssignment", by: "named evaluator", when: "kernel status Funded|Submitted; expiry bound re-checked against the pinned config; locks exposure, pins slashBase = registry minStake" },
      { from: "Proposed", to: "KernelEnded", fn: "closeKernelEnded", by: "anyone", when: "E-1d: kernel job no longer Funded|Submitted; clears the assignment slot; no exposure was locked" },
      { from: "Active", to: "KernelEnded", fn: "closeKernelEnded", by: "anyone", when: "no submission observed and kernel job no longer Funded|Submitted (e.g. claimRefund after expiry); exposure released, no slash" },
      { from: "Active", to: "ExpiryRefused", fn: "noteSubmission|verdict", by: "anyone|evaluator", when: "E-1c: first observed submission with less than requiredExpiryDuration left before kernel expiry; ExpiryRisk emitted; exposure released, no slash; terminal" },
      { from: "Active", to: "Held", fn: "verdict", by: "evaluator", when: "kernel Submitted; within evalWindow of first observed submission" },
      { from: "Active", to: "Executed", fn: "timeoutRelease", by: "anyone", when: "evalWindow elapsed; evaluator slashed; kernel.reject" },
      { from: "Held", to: "Disputed", fn: "challenge", by: "kernel client|provider", when: "within challengeWindow; bond + arbitrationCost held by the adapter until the ruling" },
      { from: "Held", to: "Executed", fn: "finalize", by: "anyone", when: "challengeWindow elapsed; kernel.complete|reject" },
      { from: "Disputed", to: "Executed", fn: "rule", by: "snapshotted arbitrator", when: "overturned iff mapped binary outcome differs" },
      { from: "Disputed", to: "Executed", fn: "resolveStaleDispute", by: "anyone", when: "arbitrationTimeout elapsed; bond and held arbitration cost refunded to the challenger" },
      { from: "Executed", to: "KernelCallFailed", fn: "(kernel call reverted, e.g. job already expired/refunded on the kernel)", by: "-" },
    ],
  },
  x402: {
    accepts: [
      { scheme: "exact", assetTransferMethod: "eip3009", eip712Domain: { ...TOKEN_EIP712, chainId: 31337, verifyingContract: "token" }, payTo: "EscrowDepositRouteFactory.routeFor(offer) (CREATE2, offer-bound)", settle: "EscrowDepositRouteFactory.settle(offer, from, value, validAfter, validBefore, nonce, signature) -> atomic only: executes transferWithAuthorization then opens the escrow job with client = from; reverts if the authorization was already used (A-1e)" },
      { scheme: "exact-attest", note: "A-1e (v0.1.2 k-of-n): the only way to credit funds that reached a route outside the atomic settle. EscrowDepositRouteFactory.attestDeposit(offer, txHash, logIndex, from, value, refundOnly) -> (credited, jobId, refunded) is a VOTE by an allowlisted keeper (isKeeper). Votes are keyed by transferId = keccak256(abi.encode(txHash, logIndex)) and must agree on digest = keccak256(abi.encode(route, from, value, refundOnly)); the deposit is credited by the threshold-th (k, default 2 of n = 3) matching vote of distinct current keepers in the current keeperEpoch (AttestationRecorded per vote; DepositAttested(route, transferId, from, value, jobId, refunded, fromVault) on credit). A vote with a different digest freezes the deposit (DepositFrozen; status Frozen; further votes revert DepositIsFrozen). claimOf(id) -> {digest, epoch, round, count, status None|Pending|Credited|Frozen}; hasAttested(id, keeper); attested(id) == Credited. value == offer.amount and !refundOnly opens a job for `from` (refund if it cannot open); otherwise refunds `from`. If the route no longer holds value (swept), the route balance is flushed into the RecoveryVault and the claim is paid from the vault (refund only, fromVault = true; reverts InsufficientUnclaimed beyond the route's unclaimed funds). Keeper set and threshold: deploy-time, then proposeKeeper/executeKeeper and proposeThreshold/executeThreshold after keeperTimelock (default 48h); every executed change bumps keeperEpoch, which discards all pending (not frozen) votes (AttestationRoundReset); k <= n re-checked at execution; k < 2 only on chainId 31337/1337/11155111/84532 (ThresholdBelowTwoOnProductionChain otherwise)." },
      { scheme: "exact-resolve", note: "A-1e v0.1.2: a Frozen deposit is resolved only by the factory owner through the keeper timelock: proposeResolution(id, Credit|Reset, route, from, value, refundOnly) (ResolutionProposed, eta = now + keeperTimelock), cancelResolution(id), executeResolution(id, offer) by anyone after eta (DepositResolved). Credit pays exactly like a k-th vote with the given values (route must match the offer: WrongRoute); Reset returns the claim to None and starts a new voting round. OPEN QUESTION: owner trust; arbitration alternative not built (ASSUMPTIONS A-1e)." },
      { scheme: "exact-sweep", note: "A-1a/A-1d/A-1e v0.1.2: startSweep() is keeper-only (any single keeper) and snapshots the balance; credits during the delay are deducted from the snapshot; sweep() is permissionless after sweepDelay (default 30d) and moves min(snapshot, balance) to route.sweepTo() == the factory's RecoveryVault (immutable per route; never the treasury directly), recorded as unclaimed[route]. Events SweepStarted, Swept, FlushedToVault." },
      { scheme: "exact-recovery-vault", note: "RecoveryVault (one per factory, address = factory.vault()): unclaimed[route], totalUnclaimed, lastSweptAt[route], releasableAt(route). Payers claim swept attributable Transfers through the same k-of-n attestDeposit (paid from the vault, at most once per (txHash, logIndex), never more than the route's unclaimed funds). releaseExpired(route), anyone, after lastSweptAt[route] + horizon (default 365d, factory Config.recoveryHorizon; every sweep into the vault restarts the route's horizon) sends the route's unclaimed funds to the treasury (ReleasedToTreasury). payout is factory-only; recordSweep route-only. Tokens sent to the vault directly are unattributed and stay there (OPEN QUESTION)." },
      { scheme: "exact-keeper", note: "A-1b/A-1e v0.1.2: agent/scripts/keeper.mjs --keeper 0|1|2 (local, trusted allowlisted keepers Anvil #7/#8/#9) scans token Transfer logs to watched routes; acts only on logs at or below the safe head = latest - confirmations (default 2, AGENTCOIN_KEEPER_CONFIRMATIONS / --confirmations) and, where the RPC supports it and not on Anvil, the `finalized` block; re-checks the receipt's blockHash against the canonical chain; verifies the log off-chain (token emitter, to == route, from, value, no DepositSettled in the same tx, from != 0); skips Credited, Frozen and already-voted claims; then votes attestDeposit. Action kinds: pending-finality, reorged-out, vote-recorded, credited-job, credited-refund, credited-vault-refund, frozen, frozen-awaiting-resolution, already-voted, already-attested, unattributable-mint, atomic-settled, swept-to-vault, sweep-started. Trust: docs/SECURITY-NOTES.md. Alternative without keepers (evaluated, not built; no exact-committed scheme): docs/A-1e-commitment-routes.md" },
      { scheme: "agentcoin-escrow", payload: "{jobId, txHash}", note: "non-standard alternative; buyer funds the escrow job itself" },
    ],
  },
  contracts: {
    JobEscrow: { functions: fn(ABI.escrow), events: evs(ABI.escrow), errors: errs(ABI.escrow) },
    EvaluatorRegistry: { functions: fn(ABI.registry), events: evs(ABI.registry), errors: errs(ABI.registry) },
    ERC8183EvaluatorAdapter: { functions: fn(ABI.adapter), events: evs(ABI.adapter), errors: errs(ABI.adapter) },
    EscrowDepositRouteFactory: { functions: fn(ABI.routeFactory), events: evs(ABI.routeFactory), errors: errs(ABI.routeFactory) },
    EscrowDepositRoute: { functions: fn(ABI.route), events: evs(ABI.route), errors: errs(ABI.route) },
    RecoveryVault: { functions: fn(ABI.vault), events: evs(ABI.vault), errors: errs(ABI.vault) },
    MockUSDC: { note: "test token with EIP-3009", functions: fn(ABI.usdc), events: evs(ABI.usdc), errors: errs(ABI.usdc) },
    MockERC8183Kernel: { note: "test-only reference-style ERC-8183 kernel (no hooks)", functions: fn(ABI.kernel), events: evs(ABI.kernel), errors: errs(ABI.kernel) },
    IArbitrator: {
      functions: [
        { name: "arbitrationCost", stateMutability: "view", inputs: ["uint256 jobId", "uint256 amount"], outputs: ["uint256"], note: "quote; jobId 0 = prospective job" },
        { name: "requestRuling", inputs: ["uint256 jobId", "address challenger", "uint16 verdictPayoutBps", "bytes32 reasonHash"], outputs: ["uint256 disputeId"], note: "no payment with the request; the arbitrable holds the cost and transfers it inside rule() (E-17a). Prepay-style arbitrators (Kleros, UMA) need an adapter that fronts the cost (future work, ASSUMPTIONS E-17c)" },
      ],
    },
    IArbitrable: { functions: [{ name: "rule", inputs: ["uint256 jobId", "uint16 payoutBps"], outputs: [] }] },
  },
  defaults: { source: "script/Defaults.sol", table: "docs/ASSUMPTIONS.md" },
  agentInterfaces: {
    mcp: { transport: "stdio", command: "node agent/mcp/server.mjs", tools: ["find_service", "route_task", "place_order", "get_order", "claim_listing", "verify"], legacyTools: ["quote", "open_job", "get_job_status", "get_evaluator_reputation", "verify_attestation"], hosted: "POST {base}/mcp and stdio both serve the six router tools (v0.5); legacyTools remain callable via A2A aliases", open_job: "returns unsigned EIP-1559 txs; server signing only with AGENTCOIN_DEMO_SIGN=1 and demoSign:true" },
    http: { base: "http://127.0.0.1:4020", routes: ["GET /v1/quote", "GET /v1/demo/resource (x402)", "GET /discovery/resources", "GET /facilitator/supported", "POST /a2a/v1/message:send", "GET /.well-known/agent-card.json", "GET /.well-known/jwks.json", "GET /.well-known/agent-registration.json", "GET /.well-known/agentcoin-trust.json", "GET /schemas/trust-manifest-0.1.json", "GET /docs/interface.json"] },
  },
};
writeFileSync(path.join(ROOT, "docs", "interface.json"), JSON.stringify(iface, null, 2) + "\n");
console.log(`wrote docs/interface.json (${iface.contracts.JobEscrow.functions.length} escrow fns, ${iface.contracts.JobEscrow.events.length} events)`);
