# AgentKoin mainnet prep: automated security scan (readiness item 4)

- **Date:** Sun Nov 22, 2026 (afternoon session, ET).
- **Branch:** `mainnet-prep` (local, private repo; not pushed, nothing deployed).
- **This is NOT an audit.** Static analysis plus manual triage. A paid scan / manual audit is still required before mainnet (see READINESS.md).
- Changes below are for the **future mainnet deploy only**. Deployed Base Sepolia contracts are untouched; their verified sources stay on `master`.

## Tools

| Tool | Version | Result |
|---|---|---|
| Slither (crytic) | 0.11.6 (venv `/tmp/slither-venv`) | Run before and after fixes. Config: `slither.config.json` (filters `lib/ test/ script/ src/mocks/`). |
| solc / Foundry | solc 0.8.28, forge 1.8.6 (6bad0a6) | Build + full test suite |
| Aderyn (Cyfrin) | **not run** | Not installable: npm `@cyfrin/aderyn` 404, GitHub releases API returns no release, no cargo on the box (prior note: project retired). Substitute: Foundry fuzz/invariant/reentrancy suites (all pass). |

Reproduce: `slither . --config-file slither.config.json` (note: Slither runs `forge clean` first, which wipes `out/` and `cache/`; rebuild with `forge build`).
Raw text output: `docs/mainnet/raw/slither-before.txt`, `docs/mainnet/raw/slither-after.txt`.

## Totals

| | High | Medium | Low | Info | Total |
|---|---|---|---|---|---|
| Before (master `a432a6c`) | 2 | 29 | 79 | 24 | 134 |
| After (`mainnet-prep`) | 2 | 29 | 69 | 24 | 124 |

The Medium count is unchanged because Slither still reports `reentrancy-no-eth` on `UMAArbitratorAdapter.proposeRuling` after `nonReentrant` was added (it models cross-function reentrancy into the unguarded oracle callback). See row M-3.

## Findings

| ID | Severity (Slither) | Contract | Finding | Status |
|---|---|---|---|---|
| H-1 | High | CrossCurrencySettler `_swap` | reentrancy-balance: balance delta around router call | **Documented, false positive.** Delta measurement is the design ("measured, not trusted"); short fill reverts `MinOutNotMet`; entry is `nonReentrant`. |
| H-2 | High | CrossCurrencySettler `_pull` | reentrancy-balance around `receiveWithAuthorization` | **Documented, false positive.** Mismatch reverts `PullMismatch`; entry `nonReentrant`. CrossCurrencySettler is not in the proposed mainnet set. |
| M-1 | Medium | JobEscrow `_distribute` | divide-before-multiply (`gross*evaluatorFeeBps/BPS` after `amount*payoutBps/BPS`) | **Documented, accepted.** At most 1 base unit (1e-6 USDC) rounding; remainder stays with provider/client, nothing is lost or created. |
| M-2 | Medium | AuthCaptureArbiter v0.1 / V03 `rule` | reentrancy-no-eth | **Documented, mitigated.** `nonReentrant`, state set Finalized before external calls, caller must be arbitrator. Arbiters are not in the proposed mainnet set. |
| M-3 | Medium | UMAArbitratorAdapter `proposeRuling` | reentrancy-no-eth: `pendingAssertion` written after `oracle.assertTruth` | **Fixed (hardened) + documented residual.** Added OZ `ReentrancyGuard` + `nonReentrant` (test `test_uma_proposeRuling_nonReentrant` uses a hostile oracle that re-enters). CEI is impossible because the assertionId is only known after the call. Residual flag is the callback path: `assertionResolvedCallback` is gated `msg.sender == oracle` and reverts `UnknownDispute` for an unregistered assertion; the oracle is the trusted UMA OOv3. |
| M-4 | Medium | Registry, Route, RouteFactory, Arbiters (10) | incorrect-equality (`eta == 0`, `bal == 0`, enum ==) | **Documented, false positive.** Existence / zero checks, not manipulable balance equality. |
| M-5 | Medium | 7 locals (PayoutScheduleLib, JobEscrow, adapters, factory) | uninitialized-local | **Documented, false positive.** Intentional zero-init. |
| M-6 | Medium | Arbiters, CrossCurrencySettler, RouteFactory `_credit` (8) | unused-return | **Documented, benign.** Tuple fields not needed; router output re-measured by balance; `flushToVault()` return is informational (the vault payout amount is `value`, checked by the vault). |
| L-1 | Low | UMAArbitratorAdapter ctor (`owner_`) | missing-zero-check | **Fixed.** Also checks `oracle_`, `currency_`. Error `ZeroAddress()`. |
| L-2 | Low | KlerosArbitratorAdapter ctor (`owner_`) | missing-zero-check | **Fixed.** Also checks `kleros_`. |
| L-3 | Low | KlerosArbitratorAdapter `withdrawNative(to)` | missing-zero-check | **Fixed.** |
| L-4 | Low | EscrowDepositRoute ctor (`escrow_`, `provider_`, `evaluator_`) | missing-zero-check (3) | **Fixed.** Plus `EscrowDepositRouteFactory.deploy` now reverts `ZeroAddress()` for zero provider/evaluator *before* CREATE2 (clear error instead of "create2 failed"). Note: route init code changes, so mainnet route addresses differ from what the testnet bytecode would compute (irrelevant for a fresh mainnet deploy; the server must read `routeFor()` from the new factory, not a hard-coded init-code hash). |
| L-5 | Low | EscrowDepositRouteFactory ctor (`escrow_`) | missing-zero-check | **Fixed.** Also checks `token_`. |
| L-6 | Low | UMAArbitratorAdapter `setLiveness` / `setTokenFee` | events-maths (no event) | **Fixed.** New events `LivenessSet`, `TokenFeeSet` (also emitted in ctor). |
| L-7 | Low | Kleros `requestRuling`, UMA `proposeRuling`, Arbiters `authorize` | reentrancy-benign (4) | **Documented, benign.** Writes after calls to trusted/allow-listed contracts; no value at risk. |
| L-8 | Low | Kleros `requestRuling`, RouteFactory `_credit` / `executeResolution` | reentrancy-events (3) | **Documented, benign.** Event ordering only. |
| L-9 | Low | many (62) | timestamp | **Documented, by design.** Deadlines/timelocks; Base sequencer drift (seconds) is negligible vs windows of hours/days. |
| I-* | Info | various (24) | naming, assembly (CREATE2), low-level call (Kleros native withdraw), missing-inheritance, unindexed event addresses, too-many-digits | **Documented, style.** No change. |

## Code changes (branch `mainnet-prep`)

- `src/arbitration/UMAArbitratorAdapter.sol`: `ReentrancyGuard`, `nonReentrant` on `proposeRuling`, ctor zero-address checks, `LivenessSet`/`TokenFeeSet` events.
- `src/arbitration/KlerosArbitratorAdapter.sol`: ctor zero-address checks, `withdrawNative` zero check.
- `src/EscrowDepositRoute.sol`: route ctor zero checks (escrow/provider/evaluator), factory ctor zero checks (token/escrow), `deploy()` zero-party check.
- `script/DeployTestnet.s.sol`: comment-only fix (`@392dcc6` was parsed as an invalid NatSpec tag and broke `forge build` under forge 1.8.6).
- `test/MainnetPrepHardening.t.sol`: 6 new tests.
- `slither.config.json`: reproducible scan scope.

## Tests

`forge test` (full, incl. fuzz/invariant): **336 passed, 0 failed, 2 skipped (338 total), 26 suites.** The 2 skips are fork suites whose `setUp()` skips without an RPC (`test/fork/PayoutScheduleFork.t.sol`, `test/fork/AuthCaptureArbiterFork.t.sol`). Off-chain Node suites were not re-run (no service code changed).

## Limits

Static analysis only. No economic review of slashing/bond parameters, no formal verification, no review of off-chain relayer/keeper/judge services, and the UMA/Kleros adapters are still tested only against mocks.

## Re-scan after pause + caps (Nov 23, 2026)

Slither 0.11.6, same config, branch `mainnet-prep` with the JobEscrow pause/caps change: **124 results (2 High, 29 Medium, 69 Low, 24 Info), identical to the post-item-4 totals.** No new finding on JobEscrow; its remaining entries are the already-triaged divide-before-multiply (M-1), uninitialized-local `next` (M-5), 12 timestamp, and 3 info items.
