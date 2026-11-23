# Security notes (v0 local prototype)

**Status: unaudited.** Nothing here has had an external review or a formal audit. The contracts have only run on a local Anvil
chain (chainId 31337). This file lists who is trusted with what, the known risks, and what testing covers and what it does not.
Design decisions and OPEN QUESTIONs are in `docs/ASSUMPTIONS.md`. Gas figures are in `docs/GAS.md`.

## Trust assumptions

### Owner / admin (one EOA in the local deploy)
`JobEscrow`, `EvaluatorRegistry` and `ERC8183EvaluatorAdapter` use OpenZeppelin `Ownable2Step`. The owner can:
- **Escrow:**
  - `setConfig`: creates a new config version. Existing jobs keep the version pinned at creation. The slash base is pinned at fund (E-22).
  - `setTreasury`: protocol fees and the slash treasury share go to whatever address is current when they are paid. Route sweeps do not: since v0.1.2 each route sweeps to the factory's immutable `RecoveryVault` (`sweepTo == vault`), and only the vault's expired balances go to the treasury it was constructed with (A-1d, A-1f).
  - `setArbitrator`: affects future challenges only, because each dispute snapshots its arbitrator (E-16).
- **Registry:**
  - `setConfig`: minStake, unbondingPeriod, exposureMultiplier, harmed share and treasury.
    - A higher `minStake` can deactivate evaluators for new jobs.
    - Jobs already funded keep their pinned slash base.
  - Slasher changes go through `proposeSlasher` → `executeSlasher` after the immutable timelock (default 48h, R-5).
    - Within that window evaluators can see the change coming.
    - Unbonding takes 7 days, so an evaluator cannot fully exit before a malicious slasher becomes active. They can only stop taking new jobs.
- **Adapter:** `setConfig` (versioned and pinned per job), `setTreasury` (its share of failed challenge bonds) and `setArbitrator` (snapshotted per dispute).
- **Route factory (v0.1.1, v0.1.2):** its owner (Ownable2Step) controls the keeper allowlist and the attestation threshold `k`, both only through the 48h timelock (`proposeKeeper`/`proposeThreshold` → `execute*`; `cancel*`), plus the timelocked resolution of frozen deposits (below). `sweepDelay`, the vault, its treasury and horizon, and `keeperTimelock` are fixed at construction; routes are immutable CREATE2 contracts. A malicious owner can queue malicious keepers, a lower `k` (never below 2 outside chain ids 31337/1337/11155111/84532, `ThresholdBelowTwoOnProductionChain`) or a malicious resolution; each is visible on-chain for 48h (`KeeperChangeProposed`, `ThresholdChangeProposed`, `ResolutionProposed`) before it takes effect.
- **Contracts are not upgradeable.** The owner cannot move escrowed job funds directly, but it controls where every fee and slash share ends up (not route sweeps, A-1d).
- **Key management is out of scope.** In production this should be a multisig behind a timelock.

### Arbitrator
- It is fully trusted for each dispute's outcome: `rule(jobId, payoutBps)` from the snapshotted arbitrator is final. Any ruling from 0 to 10000 bps is accepted.
- Under E-17a it is paid the held cost only when it rules.
- If it never rules, anyone can call `resolveStaleDispute` after `arbitrationTimeout` (escrow 30d, adapter 7d). That path:
  - executes the original verdict;
  - refunds the bond and the held fee to the challenger.
  - A ruling that arrives after that reverts.
- `MockArbitrator` is a test stub: the owner rules by hand and sets a flat fee.
- Arbitrators that need payment with the request (for example Kleros) do not fit this flow. E-17c: v0.3 adds a stub wrapper (below).

### External arbitration adapter stubs (v0.3, local only, UNAUDITED)
- `KlerosArbitratorAdapter` and `UMAArbitratorAdapter` (`src/arbitration/`) are thin `IArbitrator` stubs tested only against
  mocks. They are not deployed anywhere and have not been run against real Kleros or UMA contracts.
- Both trust their owner: the owner sets the allowlist of arbitrables, the token fee charged to the escrow, and can withdraw
  tokens (and, for Kleros, native currency) from the adapter at any time, including fees for open disputes.
- Kleros adapter: pays the native Kleros cost from its own prefunded balance (`InsufficientPrepayment` otherwise); exchange-rate
  risk between that cost and the token fee is on the owner. Ruling 0 (refused) lets the original verdict stand. Appeals are
  not handled.
- UMA adapter: the outcome is whatever OOv3 resolves for a proposed claim; a proposer who is not challenged during liveness sets
  the ruling. One pending proposal per dispute. If nobody proposes, the escrow's `resolveStaleDispute` timeout applies.

### Evaluators
- Evaluators are trusted to judge, within economic bounds:
  - Stake must be at least `minStake`.
  - Open exposure must be at most `stake × exposureMultiplier`.
  - A missed verdict is slashed 10% of the pinned slash base; an overturned verdict 25%, plus the arbitration fee reimbursement. Both are capped at remaining stake.
- **The slash is smaller than the job value at the exposure cap.** With defaults, an evaluator staking 100 can hold 500 of open jobs but loses at most 100. A colluding evaluator–provider pair can therefore profit on large jobs if nobody challenges.
- Challenges plus the arbitrator are the backstop.
- On the adapter path the evaluator must opt in (`acceptAssignment`). Before accepting, it should vet the kernel contract: the adapter calls whatever kernel the client named.

### External ERC-8183 kernel (adapter path)
- The kernel is untrusted code chosen by the client.
- Mitigations:
  - evaluator opt-in;
  - `nonReentrant` on every state-changing adapter function;
  - state is written before the kernel call;
  - `try/catch` around `complete`/`reject` (`KernelCallFailed`);
  - the evaluator fee is measured as the adapter's balance delta.
- A malicious kernel can still refuse to pay, lie in `getJob`, or end the job early. The evaluator's risk is limited to its exposure lock, which `closeKernelEnded`, `KernelCallFailed` and `finalize` release.
- Hooked kernels are not supported.

### Route keepers (A-1b, A-1e): TRUSTED k-of-n ROLE since v0.1.2
- Only allowlisted keepers (`EscrowDepositRouteFactory.isKeeper`) can vote with `attestDeposit` and call `route.startSweep`. Local deploy: Anvil #7, #8, #9 with `k = 2` (`script/Defaults.sol`: `KEEPER_THRESHOLD = 2`); `agent/scripts/keeper.mjs --keeper 0|1|2` picks one. Changes go through the 48h keeper timelock with events.
- **k-of-n credit.** A vote is keyed by `transferId = keccak256(abi.encode(txHash, logIndex))` and carries `digest = keccak256(abi.encode(route, from, value, refundOnly))`. The deposit is credited only by the k-th vote with the same digest, from distinct keepers, in the current keeper epoch (`AttestationRecorded`, then `DepositAttested`). Fewer than k votes move no funds. Second votes revert (`AlreadyVoted`), as do votes on a credited id (`AlreadyAttested`).
- **Conflicts freeze.** A vote whose digest differs from the first vote of the round sets the claim to `Frozen` and emits `DepositFrozen(id, keeper, expected, got)` (no revert, so the conflict is recorded). Frozen claims accept no votes, survive keeper-set changes, and keep their funds in the route or, after a sweep, in the vault.
- **Resolution of a frozen deposit.** The factory owner calls `proposeResolution(id, kind, route, from, value, refundOnly)` with kind `Credit` (pay it exactly like a k-of-n credit) or `Reset` (discard all votes so keepers attest afresh). Anyone can call `executeResolution` after `keeperTimelock` (48h); the owner can `cancelResolution`. **OPEN QUESTION:** this trusts the timelocked owner; there is no arbitration path (an `IArbitrator` ruling could replace the owner, not built).
- **Keeper-set changes mid-attestation.** Every executed keeper or threshold change bumps `keeperEpoch`. The next vote on a Pending claim from an older epoch starts a new round (`AttestationRoundReset`) and old votes no longer count. So removing an honest keeper or lowering `k` cannot finalize pending attestations; the remaining keepers must re-vote under the new set (tests `test_Epoch_*`, invariant `invariant_A1e_NoCreditBelowK`). Cost: honest pending votes must be re-cast after every change.
- **What the contract enforces:** keeper-only votes; k matching votes per credit; each `(txHash, logIndex)` credited at most once; credit <= route balance, or else paid from the route's own vault balance (`vault.payout`, bounded by `unclaimed[route]`); the credit goes to the attested `from`; credits during a pending sweep are deducted from its snapshot.
- **What only the keepers check (trust assumption):** that the cited log exists in a canonical block at the keeper's finality head, was emitted by the token, is a `Transfer` with `to = route` and the attested `from` and `value`, that the tx succeeded, and that it was not the atomic `settle` transfer. The EVM exposes neither logs nor tx hashes, so the on-chain bound is the route's uncredited funds, not the individual transfer's value.
- **What k colluding or compromised keepers can do:** credit any uncredited route balance and the route's vault balance to any address (fabricated ids), and start sweeps early. **What k-1 can do:** nothing that moves funds. **What one malicious keeper can do:** freeze any deposit by voting a different digest first or second (griefing; funds stay put until the 48h resolution). OPEN QUESTION: no slashing or bond for keepers.
- **What lazy or offline keepers cause:** with fewer than k online, front-run deposits are not credited; no sweep starts. Swept attributable deposits are not lost: they wait in the RecoveryVault (A-1f) for k attestations until the horizon.
- The x402 facilitator path (atomic `settle`) needs no keeper and no trust beyond the token.
- Mitigations not built: receipt/log proofs, keeper bonds/slashing, arbitration of frozen deposits. Exact-committed routes were evaluated and rejected (`docs/A-1e-commitment-routes.md`).

### RecoveryVault (A-1f, v0.1.2)
- Routes sweep to the vault, never to the treasury. The vault records per-route `unclaimed`, and `payout(route, id, to, value)` is callable only by the factory, as part of a k-of-n credit (always a refund to the attested payer); it reverts above `unclaimed[route]`. The id is marked credited on the route side, so double claims revert (`AlreadyAttested`).
- `releaseExpired(route)` sends a route's unclaimed balance to the treasury only `recoveryHorizon` (default 365 days, set at factory construction, validated) after the route's last sweep. Each new sweep restarts that route's horizon (OPEN QUESTION: per-sweep horizons not built).
- Tokens sent to the vault directly (not through a sweep) are not tracked and are stuck (OPEN QUESTION). After the horizon, payers can only recover off-chain from the treasury.

### Slasher timelock
- Only addresses in the registry's slasher set (escrow and adapter) can call `slash`, `reimburse`, `lockExposure` and `releaseExposure`.
- Adding or removing a slasher takes `slasherTimelock` (48h, set in the constructor and immutable).
- The initial slashers are set at deploy, with no timelock.

## Known risks and limitations

- **Same-nonce double-sign (A-1e): FIXED in v0.1.1-local.** EIP-3009 only records that `(from, nonce)` was used, not which struct, so in v0.1 a payer could sign A (`to = route`) and B (`to = elsewhere`, 1 unit) with one nonce, execute B and present A to `route.refund` or the front-run `settle` to take other people's funds. Both paths are removed: `settle` credits only the authorization it executes itself (a used nonce reverts in the token), and everything else needs a keeper attestation of a specific Transfer log. Regression tests `test_Regression_SameNonceDoubleSign_*`; invariant `invariant_A1e_AttacksFail`. The fix moves the residual risk into the keeper trust assumption above.
- **Sweep vs. an unattested deposit (A-1c/A-1e/A-1f).** Keepers attest every attributable Transfer before starting a sweep; credits during the delay are deducted from the snapshot. Since v0.1.2 a deposit that is swept anyway (keepers lagging for the whole 30-day delay) moves to the RecoveryVault and stays claimable with k attestations until the horizon (invariant `invariant_A1c_AttributableFundsRecoverable`: route + vault unclaimed + released >= uncredited attributable deposits). Residual: unclaimed after the horizon, it goes to the treasury.
- **Sweep destination (A-1d).** The factory's immutable vault (`route.sweepTo() == vault`); the escrow owner's `setTreasury` cannot redirect sweeps or vault releases. A wrong vault treasury at deploy cannot be fixed; a new factory gives new route addresses.
- **Kernel expiry race (E-1a, E-1c).** ERC-8183 `claimRefund` after `expiredAt` cannot be hooked.
  - The adapter refuses kernel jobs whose expiry does not cover eval + challenge + arbitrationTimeout + margin (781200 s by default), checked at both `assign` and `acceptAssignment` (which also requires the kernel job to be Funded/Submitted, E-1d).
  - E-1c: a submission first observed with less than that left is refused: no eval window, `ExpiryRisk`, exposure released, no slash; the kernel's own refund path applies. There is no flag-only path any more.
  - Residual: the bound covers the full chain only if each step uses its full window. Within it, a kernel refund cannot pre-empt the adapter. If a kernel ends a job by other means (its own `reject`), the adapter's later call ends in `KernelCallFailed` after bonds and slashes were settled on the verdict and ruling.
- **Proposed assignments on ended kernel jobs (E-1d).** Anyone can close them (`closeKernelEnded`), which frees the assignment slot; nothing was locked.
- **Lossy Partial mapping (adapter).** Below `completeThresholdBps` the provider gets nothing from the kernel, and at or above it everything.
- **Keeper indexing limits.** Since v0.1.1 the keeper reads token `Transfer` logs (not calldata), so nested payments (multicalls, smart wallets) are seen. It only handles offers it is configured with, and relies on the RPC it reads (k keepers should use independent RPCs).
- **Finality and reorgs (A-1g, v0.1.2).** A keeper only votes on logs at or below its safe head: `min(latest - confirmations, finalized)` when the RPC supports the `finalized` tag (default off on chain 31337, `--finalized-tag` forces it), else `latest - confirmations` (default 2, `AGENTCOIN_KEEPER_CONFIRMATIONS`). Before voting it re-fetches the receipt and checks that the log's block hash is canonical; a log that was reorged out is not voted on, and a pending log holds back the scan cursor. Residual: a reorg deeper than the depth or past `finalized` after k votes is not handled on-chain; the credit stands, bounded by the route's balance or vault balance.
- **Reputation is computed off-chain** from events by rescanning on every call (A-8), and is not itself attested on-chain beyond the manifest snapshot.
- **The arbitration fee is fixed at challenge time.** A later fee change does not affect open disputes. Fees are assumed to be in the job token.
- **Base Sepolia testnet (v0.2/v0.3).** MockArbitrator is owner-ruled (the deployer decides every testnet dispute); 0.5 USDC
  from the v0.3 dispute is stuck in it (no withdraw). MockERC8183Kernel is deployed as a flagged mock. Keeper k = 1 (deployer).
  The x402 facilitator is in-process and, on Sepolia, relays with the provider key, so the provider pays settle gas and the
  facilitator is not independent of the provider. Adapter config v2 uses testnet-short windows (eval 1h, challenge 10 min,
  arbitration 1h, margin 10 min), far below the spec defaults. All keys are throwaway testnet keys in `.secrets/` (gitignored,
  never logged).
- **Mocks.** MockUSDC (EIP-3009, public `mint`), MockArbitrator, MockIdentityRegistry and MockERC8183Kernel are test fixtures. Real USDC differs: it has a blocklist and pause, `transferWithAuthorization` and fees behave differently, and it is an upgradeable proxy. None of this has been tested against real tokens or real kernels.
- **Exposure cap vs. slash size.** Covered above under Evaluators.
- **No ERC-2771 or ERC-2612**, no hooks, no upgradeability.

## Pre-mainnet backlog

These are the eight open questions carried over from v0.1.2-local, in priority order. #1 and #2 must be fixed before any mainnet deployment. #3–#8 are documented limits: they are acceptable for the local prototype and testnet, and should be revisited before mainnet.

1. **Keeper bonds / slashing (MUST FIX).** A single malicious keeper can freeze any deposit by casting a conflicting vote (`DepositFrozen`). The only remedy is the factory owner's 48h-timelocked `proposeResolution` → `executeResolution`. Keepers post no bond and cannot be slashed, so griefing is free. Arbitration of frozen deposits (for example via `IArbitrator`) is not built either.
2. **On-chain Transfer value checks (MUST FIX).** A credit is capped only by the route's uncredited balance (or its vault `unclaimed`), not by the cited Transfer's value. The log, `from` and `value` are verified only off-chain by keepers. So k colluding or compromised keepers can steal all uncredited route funds and the route's vault share. Options: receipt/log proofs, or per-payment commitments (evaluated and rejected for v0, `docs/A-1e-commitment-routes.md`).
3. **Vault claims are refund-only (documented limit).** A deposit credited from the RecoveryVault always refunds the payer; it never opens the job.
4. **Tokens sent directly to the vault are untracked and stuck (documented limit).** Only sweeps (`recordSweep`) are accounted in `unclaimed`. A plain transfer to the vault has no recovery path.
5. **Each sweep restarts the 365d window (documented limit).** `releasableAt` is per route, measured from its last sweep, not per swept deposit.
6. **Post-horizon recovery is off-chain only (documented limit).** After `recoveryHorizon`, `releaseExpired` sends the funds to the treasury. A late payer can only be refunded by the treasury off-chain.
7. **Reorgs deeper than the confirmation depth / `finalized` are unhandled (documented limit).** Credits that k keepers voted on stand even if the log is later reorged out, bounded by the route or vault balance.
8. **Honest keepers must re-vote after a keeper-set or k change (documented limit).** The epoch bump discards pending votes, which is intended, so that removing a keeper or lowering k cannot finalize them. The cost is liveness: every pending deposit needs k fresh votes.

**By decision, not a backlog item:** k = 1 remains allowed on Base Sepolia (84532) and Sepolia (11155111), as well as on local chains (31337, 1337). The testnet deploy uses k = 1 with the deployer as sole keeper (`docs/ASSUMPTIONS.md`). On every other chain, k < 2 reverts `ThresholdBelowTwoOnProductionChain`.

## Testing coverage

- Foundry unit and integration tests (`test/*.t.sol`) cover the lifecycles, slashes, the fee flow, routes and the adapter.
- **Invariant tests** (`test/invariant/`, `[invariant] runs = 256, depth = 200, fail_on_revert = true`):
  - `EscrowInvariant` (JobEscrow + EvaluatorRegistry + DepositRouteFactory/routes):
    - the escrow token balance equals the sum of held obligations (budgets, provider bonds, challenge bonds, held arbitration fees);
    - no job is paid out twice;
    - registry stake, exposure and openJobs accounting per evaluator;
    - route balances equal inflow minus outflow;
    - route jobs match settles + attestations;
    - A-1c/A-1e/A-1f (`invariant_A1c_AttributableFundsRecoverable`): route balance + vault unclaimed + released >= all uncredited attributable deposits (handler: 4 keepers, one malicious; `attestPending` casts one honest vote; `claimFromVault` has lagging keepers claim a swept deposit; `startSweep` attests first or lags);
    - A-1e (`invariant_A1e_NoCreditBelowK`): no credit with fewer than k current-epoch votes, and the malicious keeper never credits alone (handler: `conflictAttest`, `rotateKeeper` adds/removes keepers or changes k mid-attestation, `resolveFrozen`);
    - A-1f (`invariant_Vault_BalanceEqualsUnclaimed`): vault token balance == `totalUnclaimed` == sum of per-route unclaimed == swept in − paid out − released;
    - A-1e: no credited amount exceeds the actual Transfer: per synthetic `(txHash, logIndex)` credited <= value, claim status agrees with the ghost, per route credited (atomic + attested) <= attributable Transfers in, and the route's `attestedTotal` agrees;
    - A-1e: attack actions (same-nonce double-sign via `settle`, settling an already-used authorization, duplicate attestation of a credited id, non-keeper `attestDeposit` / `startSweep` / `vault.payout`) never succeed;
    - A-1d: every route's `sweepTo` stays the vault while a handler action rotates the escrow treasury.
  - `AdapterInvariant` (adapter + registry + mock kernel):
    - the adapter balance equals held dispute funds;
    - the kernel balance equals open budgets;
    - no kernel job is executed twice, with at most one live assignment per kernel job;
    - stake and exposure accounting;
    - no assignment is accepted below the minimum expiry;
    - no stranded exposure (for every Active or Proposed job whose kernel job has ended unseen, `closeKernelEnded` succeeds, releases any exposure and clears the slot; E-1d);
    - E-1c: every started eval window has `expiredAt >= submittedAt + requiredExpiryDuration(version)`; `ExpiryRisk` is emitted iff the job is `ExpiryRefused`;
    - no slash on `ExpiryRefused` or `KernelEnded` jobs.
  - Handlers ghost-count successful calls and print coverage with `-vv`. Rare paths (giveRuling, resolveStaleDispute, sweep, releaseVault, claimFromVault, closeKernelEnded) are reached at low counts; see the last run's log. The vault-claim path is also covered deterministically (`test_HandlerVaultClaimPath`) and by `test/Decisions4.t.sol` (16 unit tests).
- **Bug found by the invariants (real, fixed):**
  - `invariant_NoStrandedExposure` found that an evaluator's exposure was locked forever when an accepted kernel job left Funded/Submitted (for example the client called kernel `claimRefund` after expiry) before the adapter observed a submission.
  - Shrunk counterexample: `assign → acceptAssignment → warp past expiry → kernel claimRefund`.
  - Fix: `closeKernelEnded(id)` (commit 020c947), plus regression tests in `test/Adapter.t.sol`.
- **Handler bugs (not protocol bugs):** arithmetic overflows in the handler's assignment picker (v0.1) and in the v0.1.2 `resolveFrozen`/keeper pickers (`s + j` with large seeds), caught by `fail_on_revert`.
- **Mutation sanity checks** (each reverted afterwards):
  - removing the stale-dispute fee refund from `JobEscrow` makes `invariant_EscrowBalanceEqualsObligations` fail;
  - removing the A-1c snapshot deduction (`_attributedOut`) makes `invariant_A1c_AttributableFundsNeverSwept` fail (`attributable funds swept: 0 < 3000000`, v0.1.1 handler; now `invariant_A1c_AttributableFundsRecoverable`);
  - removing the A-1e `AlreadyAttested` check makes `invariant_A1e_CreditNeverExceedsTransfer` (`transfer id credited above its value: 1 != 0`) and `invariant_A1e_AttacksFail` (`duplicate attestation succeeded: 1 != 0`) fail;
  - v0.1.2 (runs = 64, each reverted): crediting at the first matching vote (`count >= 1`) breaks `invariant_A1e_NoCreditBelowK` (`credited below k: 1 != 0`) and four other invariants; dropping the keeper-epoch reset breaks `invariant_A1e_NoCreditBelowK`; a `vault.payout` that does not decrement `unclaimed` breaks `invariant_Vault_BalanceEqualsUnclaimed`;
  - disabling the E-1c refusal makes `invariant_E1c_NoEvalWindowBelowRequiredExpiry` fail.
- **Not covered:**
  - formal verification;
  - fuzzing against real USDC, real arbitrators or real ERC-8183 kernels;
  - multi-token setups;
  - griefing and gas-limit analysis beyond `docs/GAS.md`;
  - MEV and ordering attacks on public mempools;
  - the off-chain agent code (MCP/x402 server), beyond its unit tests and the demo.

## v0.4 public testnet service

- **Keys.**
  - Four throwaway testnet keys: relayer, provider, evaluator, operator. They are read from `.secrets/` /
    `agent/.keys/` (gitignored, mode 600) or from `AGENTCOIN_*_KEY` env secrets on a host. They are never logged or
    returned.
  - The relayer key is dedicated, new in v0.4, and holds about 0.00015 ETH (Base Sepolia).
  - A host compromise loses only test ETH/USDC.
- **Relayer abuse.**
  - Only AgentCoin routes are relayed: payTo must equal `factory.routeFor(offer)`, the evaluator must be active, and the
    amount must be ≤ 5 USDC.
  - EIP-3009 authorizations are fully verified before any tx: signature, value, time window, unused nonce, and payer
    balance.
  - Per-IP, per-address and global paid caps apply, plus a global daily gas cap with a 2× allowance for background
    verdict/finalize of already-admitted jobs, so the evaluator is never left with a missed verdict.
- **Payer ≠ provider/evaluator.** The escrow reverts with `InvalidParty` and the service returns an error.
- **Evaluator automation.** The service issues `Complete` only when the on-chain deliverableHash equals the hash of the
  receipt it built. Anything else is left for manual handling.
- **Privacy.**
  - Stats store counters only: user-agent product token, referrer hostname, endpoint template, and unique payer
    addresses, which are public on-chain anyway.
  - IPs exist only in memory, HMAC'd with a random daily salt, for caps.
- **Request limits.** Request bodies are capped. `data` ≤ 4096 chars and `note` ≤ 200. Opt-out `match` ≤ 300.
- **Door-knocker.**
  - Machine channels only (A2A).
  - DRY_RUN by default, and the `KILL` file blocks all sends.
  - A live send also needs an explicit ack env.
  - One knock per endpoint, one follow-up only if engaged, 50/day, and opt-outs honored.

## AD-011 legal hardening (testnet)

- **Relayer = convenience gas-payer only.** The protocol works without it. The relayer submits only what the payer
  signed: an EIP-3009 authorization whose `to` is the offer-bound EscrowDepositRoute (CREATE2 over provider,
  evaluator, amount, deadline, spec), or a CrossCurrencySettler quote whose hash is the EIP-3009 nonce. It is never a
  `from`, `to` or intermediate holder of USDC, EURC or AGC, takes no fee, and cannot change amount, recipient,
  evaluator or payer: the contracts reject anything the signature does not cover (`test/LegalHardening.t.sol`).
  Any payer can submit the same call itself (`agent/scripts/self-submit.mjs`, QUICKSTART §4.3a).
- **Evaluator = buyer's choice.** The service's `evaluator` key is the labeled reference evaluator ("reference
  evaluator (operated by STOS Technologies, testnet demo)"). Buyers pick any active EvaluatorRegistry evaluator with
  `?evaluator=<address>`; the choice is part of the route address and the escrow job. The service verdicts only jobs
  that named the reference evaluator; for other jobs it only calls the permissionless `finalize` / `timeoutRelease`.
  Test evaluators run as separate processes with separate keys (`agent/evaluator/run.mjs`).
- **Admin paths on the deployed (immutable) contracts, Base Sepolia.** Owner = deployer on JobEscrow (USDC, EURC),
  EvaluatorRegistry, ERC8183EvaluatorAdapter and EscrowDepositRouteFactory. No owner function can issue or change a
  verdict, or move escrowed funds of an existing job (config is pinned per job).
  - 2026-11-15 12:25 PM ET (AD-011 b): on JobEscrow USDC `0x4EaF…1CB3D` and JobEscrow EURC `0x1734…8516`
    `setArbitrator(address(0))` and `setTreasury(0x…dEaD)` (txs in `deployments/base-sepolia-ad011.json`; read back
    arbitrator 0x0, treasury 0x…dEaD). `challenge()` now reverts `NoArbitrator` on every job, including completed
    ones still inside their challenge window: a verdict can no longer be overturned by anyone (STOS included), and a
    wrong verdict can no longer be slashed through a challenge. Missed verdicts are still slashed by
    `timeoutRelease`. The owner (deployer) could set an arbitrator or treasury again; that is the remaining lever.
  Remaining STOS-held levers:
  - escrow owner = deployer (could re-set arbitrator/treasury or publish a new config for future jobs);
  - ERC8183EvaluatorAdapter: arbitrator = MockArbitrator (owner = deployer), treasury = deployer (not changed: not an
    escrow, outside the AD-011 (b) approval);
  - registry `config.treasury` = deployer (slash remainder); RecoveryVault `treasury` (immutable) = deployer, for
    route sweeps unclaimed after 365 days (vault balance 0);
  - route keepers = {deployer}, threshold 1: stray deposits sent to a route outside `settle` are credited by keeper
    attestation (the atomic x402 `settle` path does not use keepers);
  - registry owner can queue slashers behind the 48 h timelock.
- **Test evaluators live (AD-011 a).** Test evaluators A `0x000f…124A` and B `0x1164…C298` run in containers
  `agentcoin-evaluator-a` / `-b` on the testnet host with only their own key mounted read-only (no service keys, no
  service env). Both are operated by STOS Technologies LLC, as labeled in `/v1/evaluators` and the trust manifest.
- **AGC stack (deployed to Base Sepolia 2026-11-15 12:34 PM ET, `deployments/base-sepolia-agc.json`).** Escrow and
  registry owner = 0x…dEaD, no arbitrator, treasury / registry slash remainder / vault recipient 0x…dEaD, feeBps 0
  (read back on chain). Route factory owner and sole keeper (k = 1) = deployer. AGC itself has no owner, pause or
  mint outside wrap. The service does not advertise AGC (AGC_* env unset).
