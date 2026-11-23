# AD-014 amendments (x402 #2887 comment 6928914178)

These amendments were agreed on [x402-foundation/x402#2887](https://github.com/x402-foundation/x402/issues/2887) (our reply is comment 6928914178). They refine `specs/AD-014-payout-schedule.md` without editing that file. This note is the implementation source of truth for the differences below. The rest of the spec still applies.

Drafted with the v0.6 JobEscrow work, 2026-11-16. Local code only; nothing deployed or posted.

## The three amendments

### 1. The schedule keys on `required_pass`

`required_pass` is the number of **required** criteria whose result is exactly `"pass"`.

- `"fail"` does not count.
- `"not-evaluated"` does not count (already in the original counting rule).
- `"error"` does not count. The original receipt enum was `pass` / `fail` / `not-evaluated`. The amendment adds `error` as a fourth result that is also excluded. A checker that cannot complete a required criterion, or that records an error, must not increase `required_pass`.
- Optional criteria (`required: false`) are ignored, as in the original spec.
- The record's overall `verdict` field is not used.

On-chain this is `popcount(passMask restricted to required criteria)`. A bit is set only for a required criterion whose result is exactly `pass`. Bits for fail, not-evaluated, and error stay unset.

### 2. `required_total` is committed at funding

`required_total` is the number of required criteria in the committed criteria document whose sha256 is the job's `specHash`. It is stored on-chain per job in `PayoutSchedule.requiredTotal` (the spec's `requiredCount` field, renamed to match the amendment).

The contract cannot hash or parse the JCS criteria document. Deriving the number from the document is an off-chain obligation at funding: the client must pass the true count. The escrow stores and later enforces that stored number. Verifiers should check `getSchedule(jobId).requiredTotal` against the criteria document before the provider accepts, the same way they check the JSON table against `bpsTable`.

Bounds stay `1..=15`. The packed `bpsTable` has entries `k = 0..requiredTotal`.

### 3. `verdict` reverts unless the record matches the commitment and the mask

`verdictScheduled` takes the record's `required_total` and `required_pass` as arguments, together with the pass mask and `reasonHash`:

```solidity
function verdictScheduled(
    uint256 jobId,
    uint16 passMask,
    uint8 requiredTotal,
    uint8 requiredPass,
    bytes32 reasonHash
) external nonReentrant;
```

It reverts when:

- `requiredTotal` ≠ the `requiredTotal` committed on the job (`RequiredTotalMismatch`);
- `passMask` has any bit at or above `requiredTotal` (`InvalidPassMask`);
- `requiredPass` ≠ `popcount(passMask & ((1 << requiredTotal) - 1))` (`RequiredPassMismatch`).

Payout is then `bpsTable[requiredPass]`, and the outcome is derived (10000 = Complete, 0 = Reject, otherwise Partial), as in the original spec.

The original three-argument `verdictScheduled(jobId, passMask, reasonHash)` is not used. Without the two count arguments the contract could not revert on a record whose `required_total` differs from the commitment.

## What is still off-chain

The escrow still cannot parse the signed acceptance record or verify Ed25519. It trusts `msg.sender == evaluator` for the supplied counts and mask, and stores `reasonHash`. Checking that those arguments equal the values in the record pointed to by `reasonHash` (and that `receipt.criteria.sha256 == specHash`) remains an off-chain verifier / challenge-window check, as the original spec already said for the mask.

The amendment makes a *lying or sloppy count* revert on-chain when the caller actually passes the record's numbers. It does not make a false per-criterion result trustless.

## Other resolutions (not in the comment, needed to build)

- Unscheduled jobs on the same contract keep v0.5 behaviour: `createAndFund` / `submit` / `verdict` / `complete` / `reject` / `finalize`, instant release, fees and windows as pinned on the job's config. Existing Foundry tests are not rewritten.
- Instant release stays disabled on scheduled jobs (`submit` skips `_instantEligible` when a schedule is present).
- `rule` on a scheduled job is constrained to a table value (`InvalidPayout` otherwise). That is the spec's default; it is still an open decision for Carter (see below).
- `createAndFundForScheduled` is out of scope, as in the spec.
- `docs/interface.json`, the service default escrow, and QUICKSTART are not switched to v0.6 in this work.

## Open decisions for Carter

1. Confirm that `verdictScheduled` may use the five-argument form above (counts + mask), rather than the three-argument form in the original spec.
2. Confirm the default that `rule` may only return a `payoutBps` that appears in the committed table.
3. All live-network steps in the spec (deploy v0.6, `proposeSlasher` / `executeSlasher`, criteria POST, GitHub post, job 2 funding, `/jobs/2/` deploy, any faucet top-up) still need a typed yes. This work is local only.

## materialDiffBps and one-step rulings

Live (and v0.6) config pins `materialDiffBps` at 2000. A ruling is "overturned" only when `|rulingBps - verdictBps| > 2000`.

That means a ruling that is off by a single criterion is **not** treated as an overturn when the table steps are `<= 2000` bps (for example a linear 5-criterion table with 2000-bps steps, or any flatter table). The 4-criterion linear table in the spec (`[0, 2500, 5000, 7500, 10000]`) has 2500-bps steps, so a one-criterion miss *is* overturned (`2500 > 2000`). If a later job commits smaller steps, a one-criterion miss would stand and the evaluator would not be slashed for a wrong verdict. Clients should pick step size with this threshold in mind.
