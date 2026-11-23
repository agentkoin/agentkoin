# Design assumptions (v0 prototype)

Sources: `specs/SPEC-v0.md` (authoritative), the research Page, ERC-8183 (Agentic Commerce, draft) and
ERC-8004 (Trustless Agents, draft), read 2026-10-26.

Every numeric parameter is configurable at runtime by the contract owner (`setConfig`); defaults live
in `script/Defaults.sol`. `JobEscrow` configs are **versioned**: a job pins the config version current at
creation, so later changes never alter an open job.

Entries marked **OPEN QUESTION** are choices the spec does not settle; they need a decision from Research.
Entries marked **DECIDED (Research, 2026-10-26)** record the Research decision and how it is implemented.
"Kept as-is" means Research confirmed the v0 behaviour.

## Parameters (v0 defaults, all settable)

| Param | Contract | Default | Source |
|---|---|---|---|
| minStake | Registry | 100 USDC | spec |
| unbondingPeriod | Registry | 7 days | spec |
| exposureMultiplier | Registry | 5 | spec |
| slashHarmedShareBps | Registry | 5000 (50% harmed / 50% treasury) | spec |
| instantThreshold | Escrow | 1 USDC | spec |
| evalWindow | Escrow | 24h | spec |
| challengeWindow | Escrow | 48h | spec |
| challengeBondBps / minChallengeBond | Escrow | 500 / 1 USDC (bond = max) | spec |
| missedVerdictSlashBps | Escrow | 1000 of minStake | spec |
| wrongVerdictSlashBps | Escrow | 2500 of minStake | spec |
| materialDiffBps | Escrow | 2000 | spec |
| feeBps | Escrow | 100 | spec |
| evaluatorFeeBps | Escrow | 50 (0.5% of provider gross) | Research E-18 |
| arbitrationTimeout | Escrow | 30 days | **not in spec** (E-15) |
| failedChallengeEvaluatorShareBps | Escrow | 5000 | **not in spec** (E-10) |
| instantBondCoverBps | Escrow | 10000 | **not in spec** (E-6, kept) |
| slasherTimelock | Registry (constructor, immutable) | 48h | Research R-5 |
| arbitration cost | MockArbitrator (`setFee`), read as `arbitrationCost(jobId, amount)` | 0.5 USDC flat | Research E-17 / E-17b (mock value) |
| evalWindow / challengeWindow / arbitrationTimeout | Adapter | 24h / 24h / 7d | Research E-1a |
| expiryMargin | Adapter | 1h (required kernel expiry = now + 24h + 24h + 7d + 1h = 781200 s) | Research E-1a |
| sweepDelay | DepositRouteFactory (constructor, `ROUTE_SWEEP_DELAY`) | 30 days | Research A-1a |
| keeperTimelock | DepositRouteFactory (constructor, immutable, `KEEPER_TIMELOCK`) | 48h | Research A-1e (same pattern as slasherTimelock) |
| route keepers | DepositRouteFactory (constructor list; then `proposeKeeper`/`executeKeeper`) | local: Anvil #7, #8, #9 (env `ROUTE_KEEPERS`, comma-separated) | Research A-1e (v0.1.2) |
| keeper threshold k | DepositRouteFactory (`Config.threshold`; then `proposeThreshold`/`executeThreshold`) | 2 (of 3) (`KEEPER_THRESHOLD`, env `KEEPER_THRESHOLD`); k = 1 only on chainId 31337/1337/11155111/84532 | Research A-1e (v0.1.2) |
| recoveryHorizon | RecoveryVault (immutable, from factory `Config.recoveryHorizon`) | 365 days (`RECOVERY_HORIZON`, env `RECOVERY_HORIZON`) | Research v0.1.2 decision 2 |
| keeper confirmations | agent keeper (`--confirmations`, env `AGENTCOIN_KEEPER_CONFIRMATIONS`) | 2 blocks (+ RPC `finalized` tag off Anvil) | Research v0.1.2 decision 3 |
| challengeBondBps / minChallengeBond | Adapter | 500 / 1 USDC | mirrors Escrow |
| missedVerdictSlashBps / wrongVerdictSlashBps | Adapter | 1000 / 2500 of pinned minStake | mirrors Escrow |
| failedChallengeEvaluatorShareBps | Adapter | 5000 | mirrors Escrow |
| completeThresholdBps | Adapter | 5000 (payoutBps >= 5000 -> complete) | Research E-1 |

Adapter configs are versioned and pinned per adapter job, like Escrow configs.

## ERC-8183 relationship

- **E-1 DECIDED (Research, 2026-10-26): keep `JobEscrow` as the full kernel and add `ERC8183EvaluatorAdapter`.**
  `JobEscrow` is unchanged in role (ERC-8183-*shaped*, with Partial and a challenge window). `src/ERC8183EvaluatorAdapter.sol`
  is the address an external ERC-8183 kernel names as `evaluator`. Flow: kernel client `createJob(provider, adapter, …)`,
  `setBudget`, `fund` → client `adapter.assign(kernel, jobId, stakedEvaluator)` → evaluator `acceptAssignment` → provider
  `submit` on the kernel → evaluator `adapter.verdict(id, payoutBps, reasonHash)` → the verdict is **held** for
  `challengeWindow` → `finalize` (or `rule` / `resolveStaleDispute`) → adapter calls `kernel.complete` or `kernel.reject`.
  Tested against `src/mocks/MockERC8183Kernel.sol`, a minimal non-hooked kernel that uses the spec's function and event names.
  Implementation choices (not specified by Research):
  - **Partial is lossy.** `payoutBps >= completeThresholdBps` (default 5000) → `complete` (provider gets the full budget minus kernel
    fees), otherwise `reject` (client refunded in full). Threshold is configurable and pinned per job.
  - **Overturn is judged on the mapped binary outcome**, not on `materialDiffBps`: a challenge succeeds only if the arbitrator's
    ruling maps to the other side of the threshold. Otherwise the kernel outcome would be identical and nobody was harmed.
  - **Evaluator opt-in.** `assign` only proposes; the evaluator must call `acceptAssignment`. Without opt-in, anyone could deploy a
    fake kernel and attach slashing liability (timeoutRelease) to an evaluator who never agreed. Exposure is locked at accept.
  - **Eval window start.** ERC-8183 kernels do not store a submission timestamp. The window starts when the adapter first observes
    `Submitted` (`acceptAssignment`, `noteSubmission` — callable by anyone — or `verdict`).
  - **Expiry bound (E-1a, see below).** `assign` and `acceptAssignment` require
    `kernel.expiredAt >= now + evalWindow + challengeWindow + arbitrationTimeout + expiryMargin`.
  - **Kernel evaluator fee.** The kernel pays its `evaluatorFeeBP` to `job.evaluator` = the adapter. The adapter forwards the
    amount (measured as its balance delta) to the staked evaluator.
  - **Missed verdict:** `timeoutRelease` slashes `slashBase * missedVerdictSlashBps` (harmed party = provider, as E-12) and calls
    `kernel.reject`.
  - **Kernel call failure.** `_execute` sets state before the external call and uses try/catch; a revert leaves the adapter job in
    `KernelCallFailed` (exposure released; slashes/bonds already settled). The kernel's own `claimRefund` remains the exit.
  - Adapter job ids and escrow job ids are separate namespaces; registry `Slashed`/`Reimbursed` events carry the `slasher`
    address to disambiguate.
  - **E-1a DECIDED (Research, 2026-10-26): adapter windows 24h / 24h / 7d, refuse short kernel expiries.** ERC-8183 lets anyone
    `claimRefund` after `expiredAt` from Funded/Submitted and this cannot be hooked, so a dispute that outlives `expiredAt` can be
    pre-empted by a kernel refund. The adapter now uses its own windows (eval 24h, challenge 24h, arbitrationTimeout 7d, all in the
    versioned adapter config) plus `expiryMargin` (1h). Required kernel expiry = `now + eval + challenge + arbitrationTimeout + margin`
    (781200 s by default).
    - **Refuse:** `assign` and `acceptAssignment` (re-checked at opt-in, with the job's pinned config) revert
      `ExpiryTooSoon(expiredAt, minExpiredAt)`.
    - **Late submission:** refused, see E-1c (`ExpiryRisk` is only emitted together with that refusal).
    - **Exposed:** `adapter.requiredExpiryDuration(version)`, `adapter.quote(budget)`, the MCP `quote` output
      (`erc8183Adapter.requiredExpiryDurationSeconds`, `minKernelExpiry`, `minKernelExpiryRule`), the trust manifest
      `adapterConfig.requiredExpiryDuration` and `docs/interface.json` (`erc8183Adapter.expiryBound`).
    - The bound at assign/accept covers the full path only if the submission comes promptly; a late submission is handled by E-1c.
  - **E-1b DECIDED (Research, 2026-10-26): follow the normative text.** The ERC-8183 normative text has
    `fund(jobId, expectedBudget, optParams)`; the reference implementation we read has no `expectedBudget`. `MockERC8183Kernel`
    follows the normative text. The adapter never calls `fund`, so only the mock is affected. The discrepancy is recorded here and in
    `docs/interface.json`. No upstream issue has been filed; whether to raise it upstream is Carter's call.
  - **Kernel job ended before a submission was observed (`closeKernelEnded`).** Found by the adapter invariant suite (see
    `docs/SECURITY-NOTES.md`): if an accepted kernel job leaves Funded/Submitted (e.g. kernel `claimRefund` after expiry, or the
    kernel's own `reject`) before the adapter has seen a submission, the evaluator's exposure stayed locked forever.
    `closeKernelEnded(id)` (anyone) moves an `Active` job with no observed submission to `KernelEnded` and releases the exposure.
    No slash: the eval window never started, so the evaluator missed nothing.
  - **E-1c DECIDED (Research, 2026-10-26): refuse a late submission.** When the adapter first observes the kernel job `Submitted`
    (`noteSubmission`, anyone; or the first `verdict` call) and `expiredAt < now + requiredExpiryDuration(pinned config version)`:
    - no eval window starts (`submittedAt` stays 0); the job moves to the terminal state `ExpiryRefused`;
    - `ExpiryRisk(id, expiredAt, requiredExpiredAt)` is emitted (only ever together with this refusal; the old flag-only path is
      removed);
    - the evaluator's exposure is released, with no slash (`timeoutRelease` needs a started window, so it cannot apply);
    - the assignment slot is cleared; the kernel job falls to the kernel's own refund path (`claimRefund` after `expiredAt`). A new
      `assign` for it is refused by the E-1a bound.
    - The refusal is a state change, not a revert, so it persists even when triggered by `verdict` (which then returns without
      recording a verdict). Boundary: exactly the required time left still starts the window.
    - Tests: `test_E1c_*` in `test/Adapter.t.sol`; invariants `invariant_E1c_NoEvalWindowBelowRequiredExpiry` (every started window
      has `expiredAt >= submittedAt + requiredExpiryDuration(version)`; `ExpiryRisk` iff `ExpiryRefused`) and
      `invariant_E1c_NoSlashOnRefusedOrEnded`. Demo scenario D2.
  - **E-1d DECIDED (Research, 2026-10-26): permissionless close of `Proposed` assignments on ended kernel jobs.** `closeKernelEnded(id)`
    (anyone) now also accepts a `Proposed` (never accepted) assignment once the kernel job is no longer Funded/Submitted: state
    `KernelEnded`, assignment slot cleared, event `KernelJobEnded`; no exposure to release. Hardening that goes with it:
    `acceptAssignment` reverts `WrongKernelStatus` unless the kernel job is Funded/Submitted, so an evaluator cannot take on liability
    for an ended job. Tests: `test_E1d_CloseProposed_OnEndedKernelJob`; `invariant_NoStrandedExposure` now also requires that every
    Proposed/Active assignment on an ended kernel job is closable and clears its slot. Demo scenario D3.
  - The adapter does not support hooked kernels (the mock reverts `HookNotSupported`); hooks are out of scope (unchanged).
- **E-2** Our `createJob` signature follows the spec (`provider, evaluator, amount, deadline, specHash`), not
  ERC-8183 (`provider, evaluator, expiredAt, description, hook`). No `setBudget`/`setProvider`/hooks:
  price is fixed at creation and the provider must be non-zero.
- **E-3** ERC-8183 lets the evaluator `reject` while Funded (before submission). v0 only allows verdicts after
  `submit`. The client exits a Funded job through `cancel`/`claimRefund`.
- **E-4** ERC-8183 allows `claimRefund` in Submitted after expiry. v0 does not: once submitted, the evalWindow
  governs, and `timeoutRelease` is the only exit when there is no verdict. This stops a client from racing the
  deadline against a slow verdict.
- **E-5 (kept as-is)** We forbid `evaluator == client`, `evaluator == provider` and `provider == client`.
  ERC-8183 explicitly allows `evaluator = client`. We forbid it because the evaluator must be a staked third
  party for slashing to mean anything.

## Escrow lifecycle

- **E-6 (kept as-is, 100% cover): instant path eligibility.** The spec says amount <= instantThreshold auto-releases on
  submit, "challengeable via provider bond only". If there is no bond, a challenge has nothing to pay from.
  v0 requires `providerBond >= amount * instantBondCoverBps / 10000` (default: 100% cover) for the instant
  path; otherwise the job uses the normal verdict path. Set `instantBondCoverBps = 0` to get the spec's literal
  behaviour (instant release with no bond).
- **E-7** The instant path records `outcome=Complete, payoutBps=10000` as the implicit verdict, so the
  challenge-window and materiality logic is shared. Only the **client** may challenge an instant release.
  The protocol fee is taken at release and is not refunded if a later challenge succeeds.
- **E-8 (kept as-is): instant-path dispute compensation.** The client receives
  `min(providerBond, amount * (10000 - rulingBps) / 10000)` from the provider bond, whether or not the
  ruling is "material". No evaluator is slashed (there was no verdict).
- **E-9** "Provider has not accepted": the spec mentions acceptance but defines no function. v0 adds
  `accept(jobId)` (provider). `submit` also sets accepted. The client may cancel a Funded job with a full
  refund while `!accepted`. After acceptance, the client can exit only after the deadline, with no submission.
- **E-10 (kept as-is): failed challenge bond split.** The spec says the bond "goes to evaluator + protocol"
  without giving shares. v0: `failedChallengeEvaluatorShareBps = 5000` to the evaluator, rest to the treasury.
  On instant jobs (no evaluator verdict), the evaluator share goes to the provider instead.
- **E-11 Ruling is always applied.** After a dispute, funds are distributed per the arbitrator's
  `payoutBps`, even when the difference is not "material". Materiality (`> materialDiffBps`) only decides who
  is penalised: evaluator slash + challenge bond refund (material), or challenge bond forfeited (not material).
- **E-12 (kept as-is): harmed party for a missed verdict.** The spec routes 50% of each slash to "the harmed
  party" without naming it for missed verdicts. Because the fallback refunds the client in full, v0 treats
  the **provider** (who delivered and was not paid) as harmed.
- **E-13 (kept as-is): provider bond slashing.** The spec says the provider bond is "slashable on a lost
  dispute" without giving an amount. v0 slashes it only when a dispute is **material** and the ruling lowers
  the provider's payout below the verdict: `providerBond * (verdictBps - rulingBps) / 10000`, all of it to the
  client. A provider who challenges and loses forfeits its challenge bond only, not its provider bond. A plain
  evaluator Reject with no challenge never touches the bond.
- **E-14** Overturned-verdict slash: harmed party = the challenger (it receives 50%).
- **E-15 (kept as-is, 30d): arbitrator liveness.** The spec has no rule for an arbitrator that never rules.
  v0: after `arbitrationTimeout` (default 30d), anyone may call `resolveStaleDispute`. This settles per the
  original verdict and returns the challenge bond in full. A ruling that arrives later reverts.
- **E-16** The arbitrator address is snapshotted per dispute. Changing it affects only future challenges.
- **E-17 DECIDED (Research, 2026-10-26): loser-pays arbitration.** `challenge` pulls `bond + fee` from the challenger, where
  fee = the arbitrator's quoted cost at challenge time (fixed for that dispute). If the ruling is **material** (escrow:
  `|ruling - verdict| > materialDiffBps`; adapter: mapped outcome differs) the challenger is reimbursed the fee from the losing side:
  - verdict path (escrow and adapter): the evaluator, via `EvaluatorRegistry.reimburse(evaluator, jobId, amount, to)`, which pays 100%
    to the challenger, is capped at remaining stake and counts toward `slashedTotal` (event `Reimbursed`);
  - instant path (escrow, no evaluator): the provider bond, after the client's compensation, capped at what remains (may be 0).
  A non-material challenge forfeits the fee to the arbitrator. `quote` returns `arbitrationFee` and the MCP quote adds `challengeUpfrontTotal`.
  - **E-17a DECIDED (Research, 2026-10-26): hold the fee until the ruling.** The fee stays in the escrow / adapter contract from
    `challenge` (`ArbitrationFeeEscrowed`) until `rule`, when it is transferred to the arbitrator (`ArbitrationFeePaid`). On
    `resolveStaleDispute` the arbitrator never ruled, so bond **and** fee are refunded to the challenger (`ArbitrationFeeRefunded`).
    `requestRuling` carries no payment. Shown in demo scenario E and checked by the invariant suites (contract balance equals held
    obligations, including held fees).
  - **E-17b DECIDED (Research, 2026-10-26): `arbitrationCost(jobId, amount)`.** `IArbitrator.arbitrationFee(arbitrable, amount)` is
    replaced by `arbitrationCost(uint256 jobId, uint256 amount) view returns (uint256)` (`jobId` 0 = prospective job, used by `quote`).
    The mock keeps a flat 0.5 USDC. Future work: Kleros (court/juror-dependent cost, prepaid in ETH) and UMA (bond + final fee)
    adapters behind this interface. Assumed: the cost is quoted and paid in the job's token.
  - **E-17c DECIDED (Research, 2026-10-26): document only; not built.** Hold-until-ruling means the arbitrator is paid only after it
    rules. Arbitrators that require payment with the request (Kleros `createDispute{value: cost}`) cannot be plugged in directly.
    Future work: a Kleros "pay-on-request" wrapper that implements `IArbitrator`, fronts the cost to Kleros at `requestRuling` (from
    its own float or a funded pool), and is repaid by the arbitrable's transfer inside `rule()`; open design points for that wrapper:
    who funds the float, ETH vs. token conversion, and what happens to the fronted cost on a stale dispute (the arbitrable refunds the
    challenger, so the wrapper would not be repaid). No code for this exists in v0.1.
- **E-18 DECIDED (Research, 2026-10-26): `evaluatorFeeBps`, default 50.** Paid to the evaluator from the provider's gross on settled
  Complete/Partial, separate from the protocol fee (`provider net = gross - gross*feeBps - gross*evaluatorFeeBps`). Config validation:
  `feeBps + evaluatorFeeBps <= 10000`. Implementation choices: paid only when the verdict **stands** (finalize, non-material ruling,
  stale dispute); **not** paid on Reject, on an overturned verdict, or on the instant path (no evaluator verdict). Event `EvaluatorFeePaid`.
  On the adapter path the evaluator fee is whatever the external kernel pays (`evaluatorFeeBP`), forwarded by the adapter.
- **E-19** The fee applies to the provider's gross on Complete/Partial (ERC-8183: fee only on completion, never
  on refunds).
- **E-20** `deadline` is the submission deadline. The evalWindow may extend past it.
- **E-21** Rounding: all bps maths floors. Dust goes to the client refund (refund = amount - gross).
- **E-22 DECIDED (Research, 2026-10-26): pin the slash base per job at fund.** A config change bumps `currentConfigVersion`; jobs use
  their pinned version for windows, bond sizing, slash bps and fees. In addition `Job.slashBase = registry.minStake()` is stored at
  `fund` (adapter: at `acceptAssignment`), and missed/wrong-verdict slashes use `slashBase * bps / 10000` (still capped at remaining
  stake). Exposed in `get_job_status` as `slashBase`.
- **E-23** Single payment token per escrow (ERC-8183 minimum). Same token for evaluator stake.

## Evaluator registry

- **R-1 (kept as-is): unstake vs. open jobs.** The spec says "cannot unstake with open jobs" and that unbonding
  stake is "still slashable". v0 reads this as: `requestUnstake` is allowed at any time. It removes the
  evaluator from new assignments immediately (and `fund` reverts for jobs naming it). `withdraw` needs both
  the unbonding period to have passed **and** zero open jobs. Open jobs stay slashable throughout.
- **R-2** Exposure = sum of `amount` over jobs from `fund` until settlement (including the challenge window
  and disputes). Cap = `stake * exposureMultiplier`, checked at `fund`. After a slash, exposure may exceed the
  new cap. New jobs then revert, but existing jobs continue.
- **R-3** Slash amount = `minStake * bps / 10000`, capped at the remaining stake. A slash can push stake
  below `minStake`, and the evaluator then becomes inactive until it tops up.
- **R-4** Withdraw is all-or-nothing (no partial unstake). No cancelUnstake in v0.
- **R-5 DECIDED (Research, 2026-10-26): no arbitrary `setSlasher`.** `setSlasher` is removed. Slashers are passed to the registry
  constructor (`initialSlashers`); `DeployLocal` predicts the escrow and adapter addresses with `vm.computeCreateAddress` and reverts
  `PredictionMismatch` if they differ. Later changes go through `proposeSlasher(slasher, allowed)` (owner) → wait `slasherTimelock`
  (default 48h, set at deploy, immutable) → `executeSlasher` (anyone); `cancelSlasher` (owner) aborts. Events `SlasherSet`,
  `SlasherChangeProposed`, `SlasherChangeCancelled`. Implementation choice: **removals are timelocked too**, because removing a slasher
  instantly would freeze every open job on that contract (its slash/release calls would revert). The owner is still a single key;
  making the owner a multisig/governance contract is deployment policy, not code.
- **R-6** Quorum: one evaluator per job (spec). `IEvaluatorQuorum` exists only as an interface placeholder.
  An N-of-M panel contract can later be staked and named as the evaluator without changing `JobEscrow`.

## Reputation

- **P-1** No on-chain score. Events are the data model (spec §4). The off-chain indexer derives counts and
  returns tx hashes as evidence. `avgTimeToVerdict` = `Verdict.timestamp - JobSubmitted.timestamp`.
- **P-2** No ERC-8004 Reputation Registry writes in v0 (the ERC-8183 extension recommends them). This is
  deferred because it needs a deployed 8004 registry. It is local-only and stubbable later.

## Agent-facing interface (milestone 2)

Agent-side parameters are all set through environment variables. The defaults are in `agent/lib/config.mjs` and `agent/x402/server.mjs`:

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | must be a loopback address (enforced); chainId must be 31337 (enforced) |
| `AGENTCOIN_BASE_URL` | `http://127.0.0.1:4020` | base URL written into the artifacts and served by the x402 server |
| `X402_PORT` | port of the base URL | HTTP listen port, bound to 127.0.0.1 |
| `DEMO_PRICE` | `2000000` (2 USDC) | price of the paid demo resource; above instantThreshold, so it takes the evaluator path |
| `DEMO_DEADLINE_SECONDS` | `3600` | submission deadline the 402 response advertises |
| `AGENTCOIN_DEMO_SIGN` | unset | `1` lets MCP `open_job` sign server-side when called with `demoSign: true` (local demo only) |
| `AGENTCOIN_CLIENT_KEY` | Anvil key #1 | key used only for `demoSign` |
| `AGENTCOIN_FACILITATOR_KEY` | Anvil key #0 | mock facilitator relayer that submits `EscrowDepositRouteFactory.settle` |
| `AGENTCOIN_PROVIDER_KEY` | Anvil key #2 | key the x402 server uses to `submit` deliverables |
| `AGENTCOIN_EVALUATOR` | Anvil account #3 | evaluator named in 402 responses |

- **A-1 DECIDED (Research, 2026-10-26): standard x402 `exact` + per-job escrow-deposit route; `agentcoin-escrow` kept as an alternative.**
  - `MockUSDC` implements EIP-3009 (`transferWithAuthorization`, `receiveWithAuthorization`, `cancelAuthorization`,
    `authorizationState`, EIP-712 domain `("Mock USDC (test only)", "2")`, EOA + ERC-1271 signatures).
  - `accepts[0]` is `scheme: "exact"`, `extra: {name, version, assetTransferMethod: "eip3009", agentcoin: {...}}`. `payTo` is
    `EscrowDepositRouteFactory.routeFor(offer)`, a CREATE2 address whose salt is the offer (provider, evaluator, amount,
    deadlineSeconds, specHash), so the buyer's signature commits to the escrow terms and a facilitator cannot redirect it.
    The buyer can recompute `payTo` from `extra.agentcoin.offer`.
  - Settlement: the mock facilitator verifies (EIP-712 signature, recipient, value, validity window, unused nonce, balance) and
    calls `factory.settle(offer, from, value, validAfter, validBefore, nonce, signature)`. That deploys the route if needed, which calls
    `transferWithAuthorization(from → route)` and `escrow.createAndFundFor(client = from, …)` in the same tx. A failure reverts the
    whole tx (payer not charged). Funds sit in escrow, not with the provider, until verdict + challenge window.
  - Server order: verify → settle → produce resource → provider `submit` → respond with `PAYMENT-RESPONSE`. Settle happens before
    the resource is produced because the deliverable references the escrow `jobId`; the response is still only sent after settle succeeds.
  - Front-running (changed in v0.1.1, A-1e): if someone submits the authorization directly to the token, funds land in the route and
    `settle` with that authorization now reverts (the token rejects the used nonce). Those funds are credited only by an allowlisted
    keeper attestation of the Transfer log (A-1e below).
  - `accepts[1]` is the non-standard `agentcoin-escrow` scheme (buyer funds the job and sends `{jobId, txHash}`), unchanged.
  - Route nonce scope (unchanged): a route tracks `settled[from][nonce]`; one route serves many buyers of the same offer. Two
    concurrent authorizations from the same buyer with different nonces both settle (two jobs). That is intended.
  - **A-1a DECIDED (Research, 2026-10-26): sweep after 30d** (start made keeper-only by A-1e; destination changed to the
    RecoveryVault by v0.1.2, see A-1f). Funds that reach a route outside
    `settle` and are not credited by a keeper attestation can be swept (to the route's fixed `sweepTo`, A-1d) in two steps:
    `startSweep()` (allowlisted keeper only since v0.1.1) snapshots the balance and sets `sweepableAt = now + sweepDelay` (event
    `SweepStarted`); after the delay anyone may call `sweep()`, which moves `min(snapshot, current balance)` to `sweepTo` (event
    `Swept`). `sweepDelay` is a factory constructor parameter (`ROUTE_SWEEP_DELAY`, default 30 days) and is the same for every route of
    that factory. Errors: `NotKeeper`, `NothingToSweep`, `SweepPending`, `SweepNotStarted`, `SweepDelayNotElapsed`. Demo scenario G.
  - **A-1c DECIDED (Research, 2026-10-26), revised by A-1e (v0.1.1): attributable funds first; only unattributable excess is
    sweepable.** The permissionless `route.refund(...)` from v0.1 is **removed** (it was the direct form of the A-1e exploit).
    Attributable payments are now returned or credited only through keeper attestations (A-1e). Kept from v0.1:
    - During a pending sweep, every attested credit is deducted from the snapshot (`sweepAmount = max(0, sweepAmount - value)`), so
      deposits that arrive after the snapshot can never be swept by it. The deduction is conservative: a post-snapshot deposit that
      is attested also shrinks the sweep, which can only leave strays for a later cycle, never take a payer's funds.
    - Invariant (v0.1.2, renamed `invariant_A1c_AttributableFundsRecoverable`): route balance + the route's unclaimed RecoveryVault
      funds + what the vault released after the horizon >= all uncredited attributable deposits. Since v0.1.2 a swept attributable
      deposit is no longer lost: it stays claimable from the vault (A-1f), so the handler also lets keepers lag behind sweeps.
  - **A-1d DECIDED (Research, 2026-10-26): sweep destination immutable per route.** v0.1.1 took an immutable `sweepTo` in the
    factory constructor. **v0.1.2:** the constructor is `EscrowDepositRouteFactory(token, escrow, owner, Config{sweepDelay, treasury,
    recoveryHorizon, keeperTimelock, threshold}, keepers)`; it deploys one `RecoveryVault(token, treasury, recoveryHorizon)` and that
    vault is every route's immutable `sweepTo` (`InvalidTreasury` if the treasury is zero). Each route copies it into its own immutable
    `sweepTo` at creation. Escrow `setTreasury` no longer affects sweeps. `sweepTo` is not part of the CREATE2 init code, so
    `routeFor(offer)` is unchanged. Local deploy uses the escrow treasury at deploy time. Tests: `test_A1d_SweepToFixedAtCreation`;
    invariant `invariant_A1d_SweepToImmutable` with a handler that rotates the escrow treasury.
  - **A-1e DECIDED (Research, 2026-10-26, shipped as v0.1.1-local): no permissionless crediting; atomic settle or keeper
    attestation.** Problem (found in v0.1): EIP-3009 records only that `(from, nonce)` was used, not which struct. A payer could sign
    A (`to = route`, full amount) and B (`to = elsewhere`, 1 unit) with one nonce, execute B, then present A to `refund` or to the
    front-run `settle` and be paid out of other people's funds in the route. Decision:
    - `route.refund` and the front-run branch of `settle` are removed. A payment is credited only by
      (i) the **atomic path**: `settle` itself calls `transferWithAuthorization`, so the credited authorization is provably the one that
      moved the funds (a used nonce makes the token revert, payer not charged); or
      (ii) a **keeper attestation**: `EscrowDepositRouteFactory.attestDeposit(offer, txHash, logIndex, from, value, refundOnly)`,
      callable only by allowlisted keepers, citing one token `Transfer` log into `routeFor(offer)`. The keeper checks the log off-chain
      (token emitter, `to = route`, `from`, `value`, receipt succeeded, no `DepositSettled` from that route in the same tx, `from != 0`).
      The contract cannot see logs or tx hashes, so these checks are the keeper's trust assumption (docs/SECURITY-NOTES.md).
    - Double credit: `attested[keccak256(abi.encode(txHash, logIndex))]` is set before crediting; a repeat reverts
      `AlreadyAttested(txHash, logIndex)`, across all routes. The route also requires `balance >= value` (`InsufficientRouteBalance`).
    - Credit policy: `value == offer.amount` and `!refundOnly` opens the escrow job for `from` (refund to `from` if the job cannot
      open); any other value, or `refundOnly`, refunds `from`. Events: factory `DepositAttested(route, txHash, logIndex, from, value,
      keeper, jobId, refunded)`, route `DepositAttested(transferId, from, value, jobId, refunded)`; route `attestedTotal`.
    - Keeper role: same pattern as registry slashers (R-5): initial keepers in the factory constructor (`KeeperSet`), later changes
      only via `proposeKeeper(keeper, allowed)` (owner, Ownable2Step) → `executeKeeper` (anyone) after the immutable
      `keeperTimelock` (default 48h, `Defaults.KEEPER_TIMELOCK`), `cancelKeeper` (owner). Events `KeeperChangeProposed`,
      `KeeperChangeCancelled`, `KeeperSet`. Errors `NotKeeper`, `ZeroAddress`, `NoPendingChange`, `TimelockNotElapsed`,
      `InvalidAttestation` (zero txHash, zero from, zero value). The factory owner controls nothing else (no sweep/escrow settings).
    - Sweep interaction: `startSweep` is keeper-only. Keeper policy: attest every attributable Transfer it has seen, then snapshot, so
      the snapshot only holds **unattributable** funds: mints (`from = 0`), and any Transfer the keeper declines or misses. Attestations
      during the delay are deducted from the snapshot (A-1c). `sweep()` stays permissionless after the delay. With the keeper honest
      and live, a payer's Transfer is never swept; if the keeper misses a deposit that then lands in a snapshot and stays unattested
      for the 30d delay, it is swept to `sweepTo` (v0.1.1: the treasury, recoverable only off-chain; since v0.1.2: the RecoveryVault, claimable by k-of-n attestation for the horizon, A-1f). Without any refund path, funds that
      no keeper will attest stay in the route until swept: that is the intended end state for unattributable funds.
    - Regression tests: `test_Regression_SameNonceDoubleSign_NoRefundNoCredit`, `test_Regression_SameNonceDoubleSign_ViaFrontRunSettle_Fails`
      (were the two `test_KnownIssue_*` tests); unit tests `test_A1e_*` in `test/Decisions3.t.sol`, `test/Decisions.t.sol`,
      `test/Decisions2.t.sol`. Invariants `invariant_A1e_CreditNeverExceedsTransfer` (per transfer id credited <= its Transfer value; per
      route credited (atomic + attested) <= attributable Transfers in; `attestedTotal` agrees) and `invariant_A1e_AttacksFail`
      (double-sign, settle of a used authorization, duplicate attest, non-keeper attest/startSweep all fail). Mutation check: removing the
      `AlreadyAttested` check makes both invariants fail. Demo scenarios F and G.
    - Evaluated, not built: per-payment commitment routes (no keeper), see `docs/A-1e-commitment-routes.md`.
      **v0.1.2 decision 4: no `exact-committed` scheme is built; the evaluation doc is kept as is.**
    - **v0.1.2 (DECIDED, Research 2026-10-26, shipped as v0.1.2-local): k-of-n keeper attestation.** Replaces the single-keeper
      credit above (the off-chain log checks, the credit policy and `AlreadyAttested` are unchanged).
      - `attestDeposit(offer, txHash, logIndex, from, value, refundOnly) -> (credited, jobId, refunded)` is a **vote**. Votes are keyed
        by `transferId = keccak256(abi.encode(txHash, logIndex))` and carry `digest = keccak256(abi.encode(route, from, value,
        refundOnly))`. On-chain `claimOf(id) = {digest, epoch, round, count, status}` with status `None | Pending | Credited | Frozen`.
      - Credit happens only at the k-th matching vote from k distinct current keepers (`threshold`, default 2 of 3). Each vote emits
        `AttestationRecorded(id, keeper, digest, count, epoch)`; a keeper voting twice in a round reverts `AlreadyVoted(id)`; the credit
        emits `DepositAttested(route, transferId, from, value, jobId, refunded, fromVault)` (the v0.1.1 event with txHash/logIndex/keeper
        was replaced to avoid stack-too-deep; txHash/logIndex are in the votes' calldata and `transferId` identifies them).
      - **Conflict freeze:** a vote whose digest differs from the round's recorded digest does not revert: it sets status `Frozen` and
        emits `DepositFrozen(id, keeper, recordedDigest, conflictingDigest)`. Nothing is credited; further votes revert
        `DepositIsFrozen(id)`. The freeze is sticky across keeper-set changes.
      - **Resolving a frozen deposit (defined here):** only the factory owner, through the same timelock as keeper changes:
        `proposeResolution(id, Credit | Reset, route, from, value, refundOnly)` (`ResolutionProposed`, eta = now + keeperTimelock, 48h),
        `cancelResolution(id)` (owner), `executeResolution(id, offer)` (anyone after eta; `DepositResolved(id, kind, jobId, refunded)`).
        `Credit` pays exactly like a k-th vote with the given values (`WrongRoute` if `offer` does not map to `route`; same
        route-or-vault payout and `InsufficientUnclaimed` bound). `Reset` returns the claim to `None` and starts a new voting round (all
        votes discarded). `NotFrozen(id)` if the claim is not frozen. **OPEN QUESTION:** this trusts the (timelocked) owner; an
        arbitration-based resolution (e.g. the escrow's IArbitrator) was not built.
      - **Keeper-set / threshold changes:** keepers via `proposeKeeper/executeKeeper` (unchanged, 48h); threshold via
        `proposeThreshold(k)` (owner) → `executeThreshold()` (anyone after `keeperTimelock`) / `cancelThreshold()`, events
        `ThresholdChangeProposed`, `ThresholdChangeCancelled`, `ThresholdSet(k, n, epoch)`. Every executed change increments
        `keeperEpoch`; `KeeperSet(keeper, allowed, epoch)`. Votes are scoped to (epoch, round): the first vote after an epoch change
        on a Pending claim discards the stale votes (`AttestationRoundReset(id, round, epoch)`) and starts at count 1. So removing a
        keeper or lowering k can never finalize votes cast under the old set (test `test_Epoch_LoweringK_DoesNotFinalizeStaleVotes`:
        k 3 → 2 with 2 stale votes; one fresh vote does not credit). Cost: honest pending votes must be re-cast after a change.
        `k <= n` is checked at construction, at `executeThreshold` and at `executeKeeper` (removal below k reverts `InvalidThreshold`).
      - **k = 1 gate:** `k < 2` is accepted only when `block.chainid` is 31337 (Anvil), 1337, 11155111 (Sepolia) or 84532 (Base
        Sepolia) (`lowThresholdAllowed()`); on any other chain construction / `executeThreshold` revert
        `ThresholdBelowTwoOnProductionChain(chainId)`. k = 0 always reverts `InvalidThreshold`.
      - `startSweep` stays callable by any single keeper (it only moves funds into the vault, from where they remain claimable).
      - Tests: `test/Decisions4.t.sol` (1-of-3 no credit / 2-of-3 / 3-of-3, freeze per field, resolution Credit/Reset/cancel/timelock,
        epoch changes mid-attestation, threshold gate). Invariant `invariant_A1e_NoCreditBelowK` (no credit with fewer than k matching
        current-epoch votes; a malicious keeper in the handler that only attests wrong values never completes a credit; k >= 2, k <= n).
      - **OPEN QUESTION:** one malicious or buggy keeper can freeze any deposit it sees first-or-second (griefing: funds delayed by at
        least the 48h resolution timelock, not lost). k colluding keepers can still credit false values up to the route/vault funds.
  - **A-1f DECIDED (Research v0.1.2): no sweep to treasury; RecoveryVault.** `src/RecoveryVault.sol`, one per factory
    (`factory.vault()`), every route's `sweepTo`.
    - `sweep()` and `flushToVault()` move tokens to the vault and call `vault.recordSweep(amount)`, which only accepts a deployed route
      of its factory (`NotRoute`) and checks that the tokens actually arrived (`NotReceived`). Per route: `unclaimed[route]`,
      `lastSweptAt[route]`; global `totalUnclaimed`. Event `SweptIn`.
    - **Claim:** a payer's Transfer that was swept is claimed through the same k-of-n `attestDeposit`. If the route balance is below
      the value, the factory first flushes the whole route balance into the vault (`FlushedToVault`, cancels a pending sweep), then the
      vault pays `from` (`payout`, factory-only, `Claimed(route, transferId, to, value)`). Vault claims are always **refunds** (no job;
      `fromVault = true`). Double claims are prevented by the same `transferId` (`AlreadyAttested`); a claim above the route's unclaimed
      funds reverts `InsufficientUnclaimed(available, value)`; per transfer id the credit never exceeds the attested value, and the
      attested value is bounded by the funds that actually arrived for that route (not by the individual Transfer: that is the keepers'
      check, see SECURITY-NOTES).
    - **Horizon:** `releaseExpired(route)` (anyone) after `lastSweptAt[route] + horizon` (default 365d, factory `Config.recoveryHorizon`,
      immutable in the vault; `InvalidConfig` if 0) sends that route's unclaimed funds to the treasury (`ReleasedToTreasury`);
      `HorizonNotElapsed(at)`, `NothingToRelease`. `releasableAt(route)`. Each sweep into the vault restarts the route's horizon
      (OPEN QUESTION: per-deposit horizons would be stricter but need per-deposit attribution of swept funds, which the vault does not
      have). After release a claim reverts `InsufficientUnclaimed` (payers lose funds unclaimed for the horizon: intended).
    - Invariant `invariant_Vault_BalanceEqualsUnclaimed`: vault balance == totalUnclaimed == Σ unclaimed[route], and per route
      unclaimed == swept/flushed in − claims − releases. Unit tests in `test/Decisions4.t.sol` (`test_Vault_*`).
    - **OPEN QUESTION:** tokens sent to the vault directly (not via a route) are not attributed to any route and stay in the vault
      forever (no admin withdraw by design). The invariant checks `balance == totalUnclaimed` only because the handler never does that.
  - **A-1g DECIDED (Research v0.1.2): keeper waits for finality.** The agent keeper acts only on Transfer logs at or below
    `safeHead = latest − confirmations` (default 2, `--confirmations`, `AGENTCOIN_KEEPER_CONFIRMATIONS`) and, when the RPC supports the
    `finalized` block tag, also at or below the finalized block (`min` of both). On Anvil (31337) the tag is not used (it has no real
    finality); `--finalized-tag` forces it, and an RPC error falls back to depth. Logs above the safe head are reported
    `pending-finality` and the next pass starts at or below them (never skipped). Before voting the keeper also re-reads the block at
    the receipt's height and requires the same `blockHash` (`reorged-out` otherwise). Reorg handling: a reorg shallower than the
    confirmation depth / finality cannot reach a vote; a deeper reorg after k votes is not handled (the credit stands; recovery would be
    off-chain). With k-of-n, a single keeper on a forked view cannot credit; at most it freezes (conflicting digest) or casts a vote for
    a transfer id that never matches k. Demo scenario F shows `pending-finality`.  - **A-1b DECIDED (Research, 2026-10-26): local keeper, mock facilitator stays** (keeper made a trusted attester by A-1e).
    Public facilitators call `transferWithAuthorization` on the token directly, so funds land in the route without `settle`.
    `agent/scripts/keeper.mjs` (`agent/lib/keeper.mjs`) scans MockUSDC `Transfer` logs whose `to` is a route of a known offer
    (`factory.routeFor`), verifies each log from its receipt, skips atomic-settle transfers, mints and already-attested logs, and calls
    `factory.attestDeposit` with the log's `(txHash, logIndex, from, value)`. All attestations run before any sweep step. It can also
    `--start-sweep` (keeper-only) / `--sweep` routes and `--refund` (attest in refund mode). It runs `--once` or every `--interval-ms`
    with `--keeper 0|1|2` (Anvil #7/#8/#9, allowlisted by `DeployLocal`, v0.1.2) or `AGENTCOIN_KEEPER_KEY`; one process per keeper. Because it reads `Transfer` logs (not calldata),
    payments made inside another contract call (multicall, smart-wallet batch) are seen too. Limits: needs the offer list; finality
    and reorg handling as in A-1g. Demo scenarios F, F2, G.
    Production options (not built): a facilitator-side hook that calls the atomic `settle`; `receiveWithAuthorization` (the payee must be
    the caller, so a facilitator can only route through `settle`); several independent keepers (built locally in v0.1.2 as k-of-n); Permit2 / EIP-7702 flows. The in-process
    mock facilitator still calls `factory.settle` directly (atomic path).
- **A-2** The SPEC §5 402 fields `price, escrowContract, evaluator, evaluatorStake, instantThreshold, feeBps,
  trustManifestUrl` sit in `accepts[0].extra`, the x402 slot for scheme-specific data. `asset` and `payTo`
  are core fields. `price` duplicates `amount` so that the spec field name exists.
- **A-3 (kept as-is, EIP-191): trust-manifest signature.** SPEC allows EIP-191 or EIP-712. We chose EIP-191 `personal_sign` over
  `keccak256(RFC 8785 JSON without "signature")`. EIP-712 would need a typed schema for nested arrays. Each entry
  in `attestations[]` is its own EIP-191-signed claim (`evaluator-stake` at a block, `contract-code` hash). There is no EAS dependency.
- **A-4 DECIDED (Research, 2026-10-26): keep ES256K with inline JWK, also serve a JWKS (`jku`).** A2A card signing follows A2A v1.0
  §8.4: JWS over the RFC 8785 card with `signatures` excluded, alg `ES256K` (RFC 8812, secp256k1), the same throwaway key as the other
  artifacts. The public JWK stays in the unprotected `header.jwk`; the protected header now also carries
  `jku: <base>/.well-known/jwks.json`, served by the x402 server (`agent/artifacts/jwks.json`, `{keys:[{kty, crv, x, y, kid, alg:"ES256K",
  use:"sig"}]}`). `kid` = `did:pkh:eip155:31337:<address>#secp256k1`. The verifier checks the JWK hashes to that address and, when a
  `jku` is present, that the JWKS entry with that `kid` is the same key (it fetches `jku` only for loopback URLs; `verify-artifacts`
  uses the local file). **ES256 / RS256 are not implemented** (the operator key is secp256k1); A2A consumers that only support
  those algorithms cannot verify the card.
- **A-5 (kept as-is, sidecar + ownerOf): signing the ERC-8004 registration.** ERC-8004 defines no signature on the registration file. Its binding
  is the on-chain `tokenURI` owned by the agent. We add a sidecar `agent-registration.sig.json` (EIP-191, same
  scheme as the manifest). The verifier also checks `ownerOf(agentId) == signer` on the local
  `MockIdentityRegistry`, a minimal ERC-8004 subset (`register`, `setAgentURI`, `tokenURI`) that is not the 8004 singleton.
- **A-6 DECIDED (Research, 2026-10-26): `open_job` returns unsigned transactions by default.** The MCP server uses stdio transport;
  `outputSchema` is strict and the SDK client validates `structuredContent`. `open_job` takes `client` and returns
  `mode: "unsigned"` with two EIP-1559 tx requests (`MockUSDC.approve(escrow, amount)`, `JobEscrow.createAndFund(...)`): `chainId`,
  `from`, `to`, `data`, `value`, `nonce` (pending nonce, +1 for step 2), `gas` (estimate for step 1; `null` for step 2 because it depends
  on the approval), fee fields, the absolute `deadline` encoded in the calldata, and `expectedJobId` (non-binding). The caller signs
  and broadcasts. Server-side signing happens only when the server runs with `AGENTCOIN_DEMO_SIGN=1` **and** the call sets
  `demoSign: true` (`mode: "demo-signed"`, returns `jobId` and tx hashes). The demo uses the unsigned path. The tool keeps
  `readOnlyHint: false` because `demoSign` can write.
- **A-7** The A2A HTTP+JSON endpoint (`POST /a2a/v1/message:send`) accepts one data part `{skill, input}`
  and answers with a `ROLE_AGENT` message holding a data part. Only the 4 read skills are offered there,
  and `open_job` is MCP-only. Tasks, streaming and push are not implemented, and the card says
  `streaming:false, pushNotifications:false`.
- **A-8** The reputation indexer rescans escrow, registry and adapter logs from `deployBlock` on every call. There is no cache. That is fine
  for Anvil but needs a persistent index for real chains.
- **A-9** `sla.quoteP95Ms` is `null` (not measured) rather than an estimate.
- **A-10** Reputation now also reports `counts.adapter` (accepted, verdicts, overturned, missed) from adapter events, slash evidence
  tagged with `source` (`escrow` / `erc8183Adapter`) from the registry `slasher` field, and `arbitrationFeeReimbursements`.
- **A-11** The trust manifest lists `evaluatorAdapter` and `depositRouteFactory` (with code hashes), `fees.evaluatorFeeBps`,
  `fees.arbitrationFee` (read via `arbitrationCost(0, 0)`), `adapterConfig` (now with `expiryMargin` and `requiredExpiryDuration`) and `registryConfig.slasherTimelockSeconds`; the verifier re-reads each from chain.
  `MockERC8183Kernel` is a test fixture and is not listed.

## Out of scope / not built
- ERC-2771 meta-transactions and ERC-2612 permit (ERC-8183 recommends them for x402 compatibility). EIP-3009 is implemented in
  MockUSDC instead (A-1).
- Hooks (ERC-8183 optional).
- Upgradeability: contracts are immutable. Config is the only mutable surface.

## Testnet deployment (Base Sepolia, chain 84532), v0.2.0 prep

Testnet-only decisions for `script/DeployTestnet.s.sol` and `script/SmokeTestnet.s.sol`. None of them apply to a mainnet deployment.

- **Keepers: k = 1, deployer as sole keeper (TESTNET ONLY, by decision).** The factory accepts k < 2 only on chain ids 31337/1337/11155111/84532 (`ThresholdBelowTwoOnProductionChain` elsewhere). On testnet, a single key can therefore credit any uncredited route funds. This is acceptable because the token has no value. See the Pre-mainnet backlog in `docs/SECURITY-NOTES.md`.
- **Arbitrator: `MockArbitrator` (FLAGGED).** No real arbitrator exists for this system on Base Sepolia. The mock is owned by the deployer (flat fee 0.5 USDC), so the deployer decides every testnet dispute. The smoke test does not challenge.
- **Token: Circle's official Base Sepolia USDC** `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (source: https://developers.circle.com/stablecoins/usdc-contract-addresses). It was checked read-only on-chain: FiatToken proxy, name/symbol `USDC`, 6 decimals, version `2`, `TRANSFER_WITH_AUTHORIZATION_TYPEHASH` equal to the EIP-3009 hash, `authorizationState` callable, and `transferWithAuthorization` (v,r,s and bytes-signature variants) present in the implementation. Real USDC has blocklist and pause, unlike MockUSDC.
- **Not deployed on testnet:** MockUSDC and MockIdentityRegistry. (v0.2: MockERC8183Kernel was not deployed either; v0.3 deploys it as a flagged mock, see below.) The ERC-8183 adapter is deployed because it is a fixed registry slasher (R-5).
- **Testnet-only parameter overrides (env, defaults shown):** `MIN_STAKE` = 2 USDC (spec: 100), so faucet amounts suffice; `EVAL_WINDOW` = 1h (spec: 24h); `CHALLENGE_WINDOW` = 600 s (spec: 48h), so the smoke test can finalize in one session. All other parameters are `script/Defaults.sol`.
- **Roles in the smoke test:** JobEscrow requires distinct client, provider and evaluator. The client is the deployer; provider and evaluator are two more throwaway keys in `.secrets/` (git-ignored, never logged). The deployer funds their gas and the evaluator's stake. Treasury = deployer, so the client's balance change after the reject path includes the happy-path job's 1% protocol fee (the smoke check accounts for this).
- **Keys:** `.secrets/testnet-*.key` (dir 700, files 600, ignored by git). Scripts read them with `vm.readFile` through `fs_permissions` read access to `./.secrets`.

### Deployed (v0.2.0-sepolia)

Deployed on Base Sepolia (84532) from commit 7c7071b; the full record (addresses, deploy and smoke tx hashes, blocks, constructor args) is in `deployments/base-sepolia.json`. All six contracts (MockArbitrator, EvaluatorRegistry, JobEscrow, ERC8183EvaluatorAdapter, EscrowDepositRouteFactory, RecoveryVault) are Sourcify `exact_match`. The on-chain smoke test passed: on the happy job, 1.00 USDC paid out as 0.985 to the provider, 0.01 to the treasury (= client) and 0.005 to the evaluator; the rejected job refunded 1.00 to the client. This testnet setup uses MockArbitrator and has a single keeper (k=1); neither is for mainnet.

## Testnet v0.3 "outside-agent-ready testnet" (Base Sepolia, chain 84532)

All v0.3 on-chain actions are driven by `agent/scripts/sepolia-v03.mjs` (phases fund, dispute, route, x402, adapter, finalize,
summary). It records every tx in `deployments/base-sepolia-v03.json`; `deployments/base-sepolia.json` has a `v03` section
plus the new `MockERC8183Kernel` and `routes[]` entries. The run was rehearsed on an anvil fork of Base Sepolia first.

- **Network switch.** `AGENTCOIN_NETWORK=base-sepolia` selects chainId 84532, `deployments/base-sepolia.json`, Circle USDC
  (EIP-712 `USDC`/`2`) and the `.secrets/testnet-*.key` role keys. Default stays `local` (31337, loopback RPC required). On
  base-sepolia the RPC must be https or loopback. `demoSign` is refused outside local. Signed artifacts go to
  `agent/artifacts/base-sepolia/`. The trust manifest's `agent` is `null` (no ERC-8004 identity registry on this testnet).
- **Public RPC handling.** `https://sepolia.base.org` caps `eth_getLogs` at 200 blocks: event reads are chunked (200 blocks,
  concurrency 3) and cached in `agent/.cache/` (gitignored). Writes use a nonce manager; a failed *simulation* is retried
  up to 3 times (stale reads), and a broadcast is sent exactly once. Priority fee capped at 1e6 wei, maxFee = 2·base + prio.
- **Dispute path.** Smoke job 3: client createAndFund 1 → provider submit → evaluator verdict Reject → provider challenge
  (bond 1 + fee 0.5) → `MockArbitrator.giveRuling(1, 10000)` by its owner (the deployer) → overturned and settled. The
  deployer therefore decided the dispute; this exercises the mechanics only.
- **Arbitration adapter stubs (local only).** `src/arbitration/KlerosArbitratorAdapter.sol` (ERC-792) and
  `UMAArbitratorAdapter.sol` (Optimistic Oracle V3) implement `IArbitrator`. They are tested against
  `test/mocks/MockExternalArbitration.sol` only (`test/ArbitrationAdapters.t.sol`). Not deployed, not tested against real Kleros or
  UMA contracts. Kleros adapter: fronts the native-currency cost from its own balance and charges the escrow an owner-set token
  fee; ruling 1 → 10000 bps, 2 → 0, 0 (refused) → verdict stands. UMA adapter: anyone proposes a payoutBps claim with the OOv3
  minimum bond; a truthful resolution forwards `rule`, a false one clears the proposal for a new one.
- **Deposit route + x402.** One route created via `EscrowDepositRouteFactory.deploy(offer)` for the demo offer (provider,
  evaluator, 1 USDC, deadline 3600 s); its address equals `routeFor(offer)`. The local x402 server (127.0.0.1:4020) returns
  402 with `accepts[] = exact, agentcoin-escrow`; `agent/x402/pay-client.mjs` checks network, asset, amount cap and
  `payTo == routeFor(offer)` on chain, signs EIP-3009 and the in-process facilitator calls `factory.settle`. On base-sepolia
  the facilitator relayer is the provider key (it pays settle gas; the payer pays none).
- **MockERC8183Kernel on Sepolia (MOCK, flagged).** Deployed only to run one adapter job; it is not a production kernel.
- **Adapter config v2 (testnet-short windows).** `ERC8183EvaluatorAdapter.setConfig`: evalWindow 3600, challengeWindow 600,
  arbitrationTimeout 3600, expiryMargin 600 (required kernel expiry 8400 s); other fields unchanged. Spec defaults (24h/24h/7d/1h)
  remain the local defaults. Adapter jobs pin config version 2.
- **MCP.** `agent/mcp/server.mjs` with `AGENTCOIN_NETWORK=base-sepolia`, stdio only; manifest
  `agent/mcp/tools.manifest.base-sepolia.json`; smoke `agent/mcp/smoke-sepolia.mjs`.
- **Not done by decision:** no hosting (servers bind 127.0.0.1), no npm publishing, no x402 Bazaar listing, no directory
  registration, no contact with outside agents. `/discovery/resources` serves Bazaar-format metadata locally only.

### Deployed / observed (v0.3.0-sepolia)

- New contracts: MockERC8183Kernel `0x79c40413556ab795f9d64d745b7c591e4a888e64` and EscrowDepositRoute
  `0xaf9AE89AdA6f06645166b1aa20845c4e054a4Ffa`, both Sourcify `exact_match`.
- Dispute (job 3): provider +2.74 at the ruling (0.99 payout + 1 bond + 0.5 fee reimbursement + 0.25 slash share), net +1.24
  after paying 1.5; treasury +0.26 (0.25 slash share + 0.01 fee); evaluator stake 4 → 3 (slash 0.5 + reimbursement 0.5);
  0.5 USDC arbitration fee held by MockArbitrator (no withdraw function).
- x402 (job 4) and adapter (adapter job 1 / kernel job 1): each 1 USDC → provider 0.985, treasury 0.01, evaluator 0.005.
- 29 txs, 5,900,128 gas, 35,400,768,100,942 wei in fees (≈ 0.0000354 ETH, L2 + L1).

## Testnet v0.4 "public testnet" (Base Sepolia, chain 84532), `v0.4.0-sepolia`

Scope: Base Sepolia only, test USDC, $0 spend, no accounts created, nothing sent to humans or outside agents.

**Fees set to 0.** `JobEscrow.setConfig` by the owner/deployer moved the config from v1 to v2, keeping every v1 field
except `feeBps` 100→0 and `evaluatorFeeBps` 50→0. Tx `0xae6196bc447eac6f6ff2c0d043ec3708afb90d205ec6d5a04f6e6586b1be396d`
(127,074 gas).

Why the evaluator fee is also 0, and why that is safe:
- Test USDC has no value, and the only active evaluator is our own.
- The escrow skips zero-amount transfers.
- Stake, slashing, challenge bonds, and the arbitration fee are unchanged, so evaluator incentives against wrong
  verdicts (slashing) still hold.
- Jobs pin `configVersion`, so jobs opened under v1 keep their v1 fees.
- It is reversible by publishing a new config version.

Job 5 confirms `configVersion` 2.

**Public service** is `agent/service/app.mjs`, a single Node HTTP app:
- **Paid endpoint:** notary, `POST /v1/notarize`, 0.01 test USDC over x402 `exact`. The payTo is the pre-deployed
  EscrowDepositRoute `0x6A32bC3Bb5eA1dc814f14E29e6f026535129A84f` (deploy tx
  `0x9cbc0b7a89ad9a32b0ca474ee6dc304d8aa55640532786cb656ad03becf26469`). The service:
  1. relays `factory.settle`, which opens and funds an escrow job;
  2. builds the receipt and submits keccak256(RFC8785(receipt)) as the deliverable (provider);
  3. issues `verdict(Complete)` (evaluator, background loop);
  4. calls `finalize` after the 600 s challenge window (relayer).
- **Facilitator:** `/facilitator/{supported,verify,settle}` accepts only payTo addresses that equal
  `factory.routeFor(offer)` with an active evaluator and amount ≤ 5 USDC.
- **Remote MCP** at `POST /mcp`: stateless streamable HTTP. Also serves an MCP server card, A2A card, llms.txt,
  openapi.json, trust manifest, faucet pointers, `/v1/stats` (anonymous counters; IPs are never stored, only HMAC'd
  with a daily in-memory salt for caps), and `/v1/optout`.
- Every JSON body carries `testnet: true, realValue: false`; the headers are `X-AgentCoin-Testnet` and
  `X-AgentCoin-Real-Value`.

**Caps** (UTC day):

| Cap | Limit |
|---|---|
| Paid calls per IP | 10 |
| Paid calls per payer address | 5 |
| Paid calls, global | 100 |
| Relayer/service gas | 5e13 wei/day (about 13 full lifecycles); background verdict/finalize for admitted jobs may go up to 2× so no admitted job is stranded |
| Free requests per IP | 600/hour |

**Relayer** `0x0a7BFbed71B157Eb3Ce3140CA197f41B43D4877C` is a new key in `.secrets/testnet-relayer.key` (mode 600).

Funding from the deployer:

| To | Amount (wei) | Tx |
|---|---|---|
| Relayer | 1.5e14 | `0x4e15e8cf55325bfd6dc4a3d87adaa3f0020abbec7dfa4369e7cf38edf8166877` |
| Provider | 2e13 | `0xe6e67edb70ea1c5c165d1209d9b26a5ee57ca534d133b1429062925723ae8074` |
| Operator | 3e13 | `0x0f38cec88c8db6bdaf2636a1d35b7603f221047dedff96a1b53eb623befefd81` |

Measured per paid call on Sepolia (job 5):

| Tx | Signer | Gas | Cost (wei) |
|---|---|---|---|
| Settle | Relayer | 397,139 | 2.38e12 |
| Submit | Provider | 70,540 | 4.2e11 |
| Verdict | Evaluator | 63,496 | 3.8e11 |
| Finalize | Relayer | 81,238 | 4.9e11 |

That gives about 51 relayer lifecycles (1.47e14 left / 2.87e12), about 96 provider submits, and about 66 evaluator
verdicts. The binding limit is the relayer, at roughly 50 paid calls.

**Live paid call (Base Sepolia, job 5):**

| Step | Tx |
|---|---|
| Settle (open + fund) | `0x8c1d250db0886e46257d8538d7d29396d2724cdadd4eb7daa3a565762b7e87d8` |
| Submit | `0x438bea135c4be567bd5ed750ffd568178df080203b7af5fd1869994b1cb53203` |
| Verdict | `0xa52aeb6494a5a18307fd87a28075a083ca7cb629dffda394c56babc92caf95d5` |
| Finalize | `0x457e5a1e1729698200627d51659ceb0c4d5f8b5192df8bdd0b84b8777dcf968f` |

`getJob(5)` reads state Settled, amount 10000, deliverableHash
`0x22d4800369d9ad63fb77ccda28abbbcfb7459137284bbe64b9c3656f73c62df5`, which equals the receipt hash.

**ERC-8004.** The official IdentityRegistry on Base Sepolia is `0x8004A818BFB912233c491871b3d84c89A494BD9e` (proxy;
`getVersion()` returns 2.0.0), per the erc-8004/erc-8004-contracts README and Sourcify. The operator `0xf1b2…cF68`
called `register()`, which assigned **agentId 10494** (tx
`0x45e5c1484c2606fa6ad4aa2a06fede61ff6bf58933359971afba9c6908bda602`), then
`setAgentURI(10494, data:application/json;base64,…)` (tx
`0xf10423237ba35ad1a3681370e77189a67a5dd369359413badb595bb3279e3626`, 1,387,267 gas). `tokenURI` equals the signed
registration (rc). After hosting, `sepolia-v04.mjs uri` repointed it to
`https://<retired-sslip-host>/.well-known/agent-registration.json` (see "Hosted" below).

**Hosted (v0.4.0-sepolia).** The rc was verified on 127.0.0.1 only because the build box cannot open tunnels. Carter
then offered his own DigitalOcean droplet `ai-agents-01` (Ubuntu 24.04), which also runs his other
services. Deployment details are in `docs/DEPLOY-TESTNET.md`. In short:
- SSH as root with a pinned ED25519 host key (`SHA256:vMe0jS51mfuImzVLOYDm6Jwgwhkc3Q7rfioM96h5EiE`, matched).
- Additive changes only: a new container `agentcoin-testnet` (host network, `127.0.0.1:8402`), a root-only 0600 env
  file `/etc/agentcoin/testnet.env` holding the four service keys (relayer, provider, evaluator, operator; not the
  deployer), a state dir `/var/lib/agentcoin`, and one new Caddy site block for the retired sslip hostname.
- The firewall is unchanged (80/443 were already open). The Let's Encrypt cert was issued over tls-alpn-01.
- Caddy there runs with `admin off`, so `caddy reload` (which needs the admin API) could not apply the change, and a
  restart was out of scope. The config was applied with `SIGUSR1`, which Caddy documents as a reload from the config
  file when started with `caddy run --config` and no API changes. The PID stayed 811. The config had first passed
  `caddy validate` as a separate candidate file.
- Before and after the reload, the existing site and services returned identical status, redirect target and
  body hash: the existing Caddy site (https 303 to /login, http 308), 127.0.0.1:8765 (303 to /login) and
  172.30.0.1:8768 (501, same 356-byte body), and the same TLS cert fingerprint. No rollback was needed.
- Only one instance runs the verdict/finalize loop: the build-box copy was stopped before the container started.

ERC-8004 repoint: `setAgentURI(10494, "https://<retired-sslip-host>/.well-known/agent-registration.json")`, tx
`0xad7c150d095570514fc0175a8d77c1ba961382daacfe2c33aae6fcd2bddaf848` (266,589 gas). Afterwards `tokenURI(10494)`
returns that URL, and the served registration, card and trust manifest equal the signed files in `agent/artifacts/base-sepolia/`.

Paid call through the public URL (job 6, payer = deployer, gasless for the payer):

| Step | Tx | Gas |
|---|---|---|
| settle (relayer, via x402 facilitator) | `0xd20941651d8f5c4b3737079204a4ab72c33a7f233ef9f8d2c79a61685a4d810b` | 397,139 |
| submit (provider) | `0xb6899b8c4fd8402384e261473084dcbcd124c084303f9abd049552d98f8d6cd4` | 70,540 |
| verdict (evaluator, background loop) | `0xdd9bac243cfcc8921ef1d6515debf7ad1da3e7584d3d13f8f30c56db190c2b53` | 63,508 |
| finalize (relayer, after the 600 s window) | `0xc158558906d71baf15bdd5796ec783c44d349650a5729cf41ac98f92ff65c5fa` | 81,238 |

`getJob(6)` reads state Settled, amount 10000, configVersion 2, deliverableHash
`0x013473ccc8a943e5b74bc02afaec6821278b682fc2aa1cbb8f6064fa7bdcc170` (= keccak256(RFC8785(receipt))). Balances after
(wei / test USDC): deployer 615584709494287 / 11.27, provider 40539387978793 / 5.215, evaluator 24992373876573 /
0.015, relayer 144259475993075 / 0, operator 19435565983894 / 0. The relayer covers roughly 50 more paid calls.

**Listings:**

| Listing | Status / path | Blocker |
|---|---|---|
| ERC-8004 | Done (#10494) | none |
| A2A card | Served at `https://<retired-sslip-host>/.well-known/agent-card.json` | none |
| x402 Bazaar | Indexed automatically when a payment settles through the **CDP facilitator** with `paymentPayload.resource` set, after CDP's crawler gets a 402 from a public URL. Read APIs are public. | CDP API keys (CDP account) |
| x402.org facilitator | Testnet, no auth | its Bazaar listing is not documented as CDP-indexed |
| Official MCP Registry | `mcp-publisher` with GitHub auth (namespace `io.github.<user>/*`) or DNS/HTTP domain proof; remote URL must be public. Template: `deploy/mcp-server.json` (remote URL filled in) | Carter's GitHub or a domain |
| Smithery | Submit a public HTTPS streamable-HTTP URL; server card at `/.well-known/mcp/server-card.json` is served | Smithery login |
| Glama | Add server from a GitHub repo, or ingest from the official registry | GitHub repo |
| mcp.so | Free reviewed submission or registry ingest | login/submission + repo |
| PulseMCP | Paused for new submissions; ingests the official registry | official registry first |
| Public GitHub repo | Needs Carter's GitHub | Carter's GitHub |

**Git history secret scan** (before any public repo): 34 commits and 286 blobs, including unreachable objects. No
`.secrets/`, `.keys/`, `*.key`, `operator.json`, `.env` or `.pem` path was ever committed. None of the five real
testnet private keys appears in any blob or in the working tree to be committed. There were 0 hits for PEM, AWS,
GitHub, Slack or OpenAI token patterns, and 0 for `private_key = <64 hex>` assignments. The only private keys in the
repo are Anvil's published dev keys (local tests).

**Door-knocker (Phase B)** lives in `agent/doorknock/`. It is a read-only crawler plus a knock planner. It is DRY_RUN
by default and the `KILL` file is committed. **Nothing has been sent.**
