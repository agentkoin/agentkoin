# AgentKoin arbiter for x402 `auth-capture`

Status: prototype, unaudited. Code: `src/arbiter/AgentKoinAuthCaptureArbiter.sol`. Build spec:
`research/adoption-week1/arbiter-spec.md` (AR, Nov 18 2026). TS helper: `arbiter-sdk/`.

## What it is

An immutable x402 `operatorType: "custom"` operator for Base Commerce Payments `AuthCaptureEscrow` v1.1
(`0xf96815976523E00e65Be8f34cA5e64b4f41EB19c`, same address on Base and Base Sepolia). It is `PaymentInfo.operator`
(x402 `extra.captureAuthorizer`), so it alone can `capture`/`void`. Funds stay in the escrow (this operator's
`TokenStore`). No owner, no admin setter, no proxy; all parameters are constructor immutables. If everything fails,
the escrow's `reclaim` returns the funds to the payer after `authorizationExpiry`; nothing in the arbiter blocks it.

## Terms and binding (mode 1, committed)

```
termsHash = keccak256(abi.encode(TERMS_TYPEHASH, evaluator, criteriaHash, scheduleHash, requiredTotal,
                                 bpsTable, submitBy, evalWindow))
TERMS_TYPEHASH = keccak256("AgentKoinTerms(address evaluator,bytes32 criteriaHash,bytes32 scheduleHash,uint8 requiredTotal,uint256 bpsTable,uint48 submitBy,uint32 evalWindow)")
PaymentInfo.salt = uint256(keccak256(abi.encode(AGK_SALT_TYPEHASH, termsHash, saltNonce)))
AGK_SALT_TYPEHASH = keccak256("AgentKoinTermsSalt(bytes32 termsHash,uint256 saltNonce)")
```

The salt is inside the client's ERC-3009/Permit2 nonce, so the buyer's one signature commits to the evaluator,
criteria, schedule, payout table and windows. Requires x402 unbound mode (`receiverAuthorizer` and `policy` zero).
`bpsTable` uses the JobEscrow v0.6 packing (entry k = bps when k required criteria pass, 16 bits at `[16k,16k+16)`),
e.g. `[0,2500,5000,7500,10000]` = `0x27101d4c138809c40000`.

## Lifecycle

`None → Authorized → Bound → Submitted → Verdict → (Challenged) → Finalized`, or `→ Voided`.

| Call | Who | When | Effect |
| --- | --- | --- | --- |
| `authorize(info, amount, collector, data)` | anyone (facilitator/relayer) | lifecycle floor fits before `authorizationExpiry` | checks, forwards to escrow, stores PaymentInfo |
| `charge(...)` | anyone | — | reverts `ChargeNotSupported` |
| `bindTerms(info, terms, saltNonce)` | the named evaluator (acceptance) | Authorized, `now <= submitBy` | salt check, evaluator active and ≠ payer/receiver, table valid, deadline fit, `lockExposure` |
| `submit(info, deliverableHash, resultDigest)` (v0.2; v0.1 has no `resultDigest`) | `info.receiver` | Bound, `now <= submitBy` | Submitted; `resultDigest` fixed |
| `verdictScheduled(info, passMask, requiredTotal, requiredPass, resultDigest, reasonHash)` (v0.2; v0.1 has no `resultDigest`) | evaluator | `now <= submittedAt + evalWindow` | JobEscrow v0.6 checks; `resultDigest` must equal the submitted one; `payoutBps = bpsTable[passCount]` |
| `verdictBySig(info, OutsideVerdict, sig)` (v0.2) | anyone relays the evaluator's EIP-712 signature (EOA or ERC-1271) | same as above | every field must match stored state; `payoutBps` must equal the table entry |
| `recordBuyerAcceptance(info, BuyerAcceptance, sig)` (v0.2) | payer directly (empty sig) or anyone relaying the payer's signature | Submitted, Verdict, Challenged or Finalized | separate record, first one final, no effect on capture/void |
| `challenge(info, reasonHash)` | payer or receiver | `now <= verdictAt + challengeWindow`, ARBITRATOR ≠ 0 | pulls `minChallengeBond + arbitrationCost`, `requestRuling` |
| `rule(paymentKey, bps)` (IArbitrable) | ARBITRATOR | `now <= disputedAt + rulingWindow`, bps in table | overturn rule as v0.6; settles at the ruled bps |
| `resolveStaleDispute(info)` | anyone | `now > disputedAt + rulingWindow` | bond + fee back to challenger; settles per verdict |
| `finalize(info)` | anyone | `now > verdictAt + challengeWindow`, no challenge | settles |
| `timeoutRelease(info)` | anyone | Submitted, `now > submittedAt + evalWindow` | slash `minStake*missedVerdictSlashBps` (reason 1, harmed = receiver), full void |
| `voidUnbound(info, terms, saltNonce)` | anyone | Authorized, `now > submitBy` (salt-verified) | full void, no slash |
| `voidNoSubmit(info)` | anyone | Bound, `now > submitBy` | full void, release exposure, no slash |

Settlement: before `authorizationExpiry`, `capture(held * bps / 10000, feeAmount 0, feeReceiver 0)` then `void()`
the remainder, then `releaseExposure`. At/after expiry the escrow refuses capture, so settlement voids whatever is still
held (same result as `reclaim`) and still releases exposure and dispute funds.

Deadline fit: `bindTerms` requires `submitBy + evalWindow + challengeWindow + rulingWindow + minMarginSeconds <=
authorizationExpiry`; `authorize` requires the same with `now` and the config evalWindow floor. The worst case
(submit at submitBy, verdict at end of eval window, challenge at end of challenge window, stale resolution right
after the ruling window) is tested to still capture (`test_DeadlineFit_WorstCaseStillCaptures`). `minMarginSeconds`
must be > 0 and is the keeper's time to call `finalize` after a no-challenge verdict.

Challenge rules (spec says "same as JobEscrow"; choices where silent):
- Bond = `minChallengeBond` (flat), plus the arbitrator's `arbitrationCost`, both held in the arbiter until the
  dispute ends.
- Overturned (`|ruling − verdict| > materialDiffBps`): evaluator reimburses the arbitration cost from stake
  (`registry.reimburse`), is slashed `wrongVerdictSlashBps` of minStake (reason 2, harmed = challenger), bond returned.
- Upheld: bond goes to the evaluator (there is no treasury in an ownerless contract). Arbitration cost goes to the
  arbitrator in both cases. Stale dispute: bond + cost returned, verdict stands.
- `ARBITRATOR = address(0)` disables challenges (`NoArbitrator`). The challenge window is still waited out before
  `finalize`. This matches AD-015 Phase 0 (no overturn slashing until an arbitrator is set).

## v0.2 (source only): resultDigest and BuyerAcceptance

The Base Sepolia deployment `0x8b4B3A8c6389a17AA7f66e18F59Afb36Cc9C453A` is v0.1 (commit `5981d9e`, Sourcify exact match) and is
immutable. The changes below are in the source for the next deployment; the deployed contract does not have them. They
implement what the x402 #4324 reply committed to.

- **resultDigest.** `sha256` over the exact canonical bytes of the result (raw bytes, or UTF-8 of RFC 8785 JCS for JSON),
  the same way `criteriaHash` commits the criteria. The receiver commits it on-chain in `submit` (before `submitBy`). Every
  verdict, on-chain or signed, must name the same digest, or it reverts `ResultDigestMismatch(committed, given)`. A swap of
  the artifact after submit is therefore rejected on-chain, not just detectable. The contract checks equality only; it cannot
  see the bytes. If the evaluator is served bytes that do not hash to the committed digest, the protocol answer is a
  verdict on the committed digest whose checks fail (criteria item `result-digest` in the sample), not a verdict on the swapped
  bytes. If it posts nothing, `timeoutRelease` voids and slashes as before.
- **OutsideVerdict (EIP-712).** Domain `{name: "x402 outside-verdict", version: "0.2", chainId, verifyingContract: arbiter}`.
  `OutsideVerdict(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 deliverableHash,bytes32 resultDigest,uint16 passMask,uint16 payoutBps,bytes32 reasonHash)`.
  The version is 0.2 because `resultDigest` was added to the #4324 draft's 0.1 struct.
- **BuyerAcceptance (EIP-712, own typehash).** `BuyerAcceptance(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 resultDigest,uint8 decision,bytes32 noteHash)`,
  `decision` 1 = accepted, 2 = rejected. It is signed by the payer, kept in its own mapping, and emitted as `BuyerAcceptanceRecorded`.
  The first record is final. It never changes capture or void.
- **Absence is explicit.** `outcome(key)` returns `{state, verdictRecorded, payoutBps, resultDigest, buyerDecision, buyerAccepted}`,
  where `buyerDecision = None` and `buyerAccepted = false` unless the payer recorded acceptance. `Finalized` carries
  `buyerDecision` at settlement time. A capture on a verdict alone reports `None`.
- **Clients.** TypeScript: `arbiter-sdk` (`resultDigest`, `resultDigestJson`, `canonicalJson`, `buildVerdict`, `verdictTypedData`,
  `buyerAcceptanceTypedData`, `describeOutcome`), checked against the contract on anvil. Python:
  `agentcoin_core.arbiter`, checked against the shared vectors `arbiter-sdk/test/vectors.v02.json`.
  `judge-kit` targets JobEscrow v0.6, not this arbiter, and is unchanged.
- **Sample terms** for the deployed v0.1 arbiter: `examples/authcapture/terms.base-sepolia.json` (built by `build.mts`,
  JSON Schema `terms.schema.json`).
- Runtime size is 20,931 bytes (v0.1: 17,540).

## Spec compliance (`research/adoption-week1/arbiter-spec.md`)

| Spec item | Status |
| --- | --- |
| §1.2–1.4 every path finishes before `authorizationExpiry`; partial = capture then void; never refund | Implemented. I2 checked: `refund` selector absent from runtime bytecode |
| §1.5 fee 0/0, `feeAmount = 0`, `feeReceiver = 0` | Implemented (`FeeNotZero` at authorize, capture passes 0/0) |
| §1.6 `refundExpiry == authorizationExpiry` | Implemented (`RefundExpiryMismatch`) |
| §1.7 permissionless `authorize`/`charge`, immutable operator | Implemented |
| §2 constructor immutables ESCROW, REGISTRY, ARBITRATOR (0 = off), TOKEN, MAX_AMOUNT_PER_PAYMENT, CONFIG; no owner/proxy; reject v1.0 | Implemented (`UnsupportedEscrow` for `0xBdEA…0cff`). CONFIG adds `wrongVerdictSlashBps`, `materialDiffBps` (needed for the v0.6 overturn rule) |
| §2 reuse `PayoutScheduleLib`, v0.6 verdict semantics | Implemented (`scheduleValid`, `requiredPassFromMask`, `entryAt`, `tableContains`) |
| §2.1 authorize checks (operator, token, cap, fees, refundExpiry) | Implemented, plus a floor deadline check (`DeadlineTooShort`) |
| §2.2 Terms struct | **Deviation:** `bpsTable` is `uint256` in JobEscrow v0.6 packing, not `bytes`, so the same library and table format are reused |
| §2.2 mode 1 salt `AGK_SALT_TYPEHASH(termsHash, saltNonce)`, `abi.encode` | Implemented |
| §2.2 mode 2 receiver default terms | **Not implemented** (Research requirement: terms must be buyer-signed). Payments with a random salt can only be reclaimed after `authorizationExpiry` |
| §2.2 `bindTerms` callable by anyone | **Deviation:** only the named evaluator. With anyone-can-bind, an attacker controlling payer + receiver could name an unwilling staked evaluator, let the eval window lapse and collect the receiver's half of the missed-verdict slash with no cost but gas. Evaluator binding = consent |
| §2.2 bind checks (active, conflict, deadline fit, `lockExposure` with `uint256(getHash)`) | Implemented. The jobId cast has no accounting collision risk: the registry sums exposure per evaluator; jobId appears only in events |
| §2.3 submit / verdictScheduled / challenge / rule / finalize / timeoutRelease / voidUnbound / voidNoSubmit / reclaim untouched | Implemented. `voidUnbound` takes `(terms, saltNonce)` to learn the buyer-signed `submitBy`. `rule` also settles immediately (no separate finalize after a ruling). Added `resolveStaleDispute` |
| §2.3 invariants I1–I6 | I1, I4, I6 fuzzed (10,000 runs over 6 lifecycle paths, `testFuzz_Invariants_AllPaths`); I2 bytecode check; I3 by construction (`_settle` only from finalize/rule/stale) plus deadline tests; I5 access tests. Stateful Foundry invariant handler not written |
| §2.4 events and typed errors | Implemented with the spec's names, plus extra errors (`RefundExpiryMismatch`, `SubmitWindowClosed/Open`, `RulingWindowClosed/Open`, `NoArbitrator`, AD-014 count errors) |
| §2.4 ERC-8004 feedback entry per verdict | **Not on-chain** (JobEscrow does not emit one on-chain either); off-chain receipt work for judge-kit |
| §3 off-chain pieces | Partial: `arbiter-sdk/` builds terms/salt/PaymentInfo/nonce/typed data and runs the client refusal checks. x402 server helper, relayer, watcher and keeper not built here |
| §4 x402r path B | Not started |
| §5 tests | All listed cases covered except mode 2 and the stateful invariant suite. Gas below. Slither run and triaged (below) |

## Gas (local, `forge test --gas-report`, median)

authorize 385,564 · bindTerms 206,353 · submit 66,053 · verdictScheduled 73,013 · finalize 160,855 ·
challenge 169,090 · resolveStaleDispute 183,827 · timeoutRelease 232,748 (max) · voidNoSubmit 102,383 (max).
Runtime size 17,540 bytes.

## Slither 0.11.6 (triage)

- reentrancy-no-eth in `rule`/`resolveStaleDispute`: fixed by setting state before external calls (all entry points
  are also `nonReentrant`; ESCROW and REGISTRY are fixed immutables).
- uninitialized-local `toReceiver`: made explicit.
- unused-return (`reimburse`, `paymentState` tuple), reentrancy-benign in `authorize` (record written after the
  escrow call, which needs the hold to exist), timestamp comparisons, naming of spec-mandated immutables: accepted.

## Tests

- `test/arbiter/AuthCaptureArbiter.t.sol`: unmodified vendored commerce-payments escrow + ERC-3009 collector
  (`test/arbiter/vendor/`), MockUSDC, real EvaluatorRegistry, MockArbitrator.
- `test/fork/AuthCaptureArbiterFork.t.sol`: Base Sepolia fork (read-only, nothing broadcast): live v1.1 escrow and
  collector, Circle test USDC, live registry. `FORK_BASE_SEPOLIA_RPC=https://sepolia.base.org forge test --match-path test/fork/AuthCaptureArbiterFork.t.sol`.
- `arbiter-sdk/test/crosscheck.test.ts`: local anvil; every SDK hash equals the Solidity value, and an SDK-built,
  SDK-signed payload passes `authorize` + `bindTerms`. `cd arbiter-sdk && npm test` (after `forge build`).

## Sources

- x402 auth-capture spec: https://github.com/x402-foundation/x402/tree/main/specs/schemes/auth-capture (scheme v1.1, EVM binding v1.1)
- Commerce Payments: https://github.com/base/commerce-payments (read at `b748fdd`)
