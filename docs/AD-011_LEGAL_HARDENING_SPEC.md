# AD-011 Legal-hardening spec (testnet only) — AgentCoin Research, 2026-11-15

Carter's approval, verbatim (Nov 15, 2026 10:37 AM ET, in my chat), replying to my offer
"I'll have Developer start on the evaluator and relayer changes on testnet, since those cost nothing":
> "Do the three fixes please"

Scope: Base Sepolia testnet and local only. $0. No mainnet, no publishing, no new external
posts. Basis: /workspace/ops/agentcoin-research/LICENSING_2026-11-15.md (FinCEN FIN-2019-G001
"total independent control" test; FIN-2014-R004/R005 escrow rulings; DOJ Aug 21 2025 policy).
Goal: STOS never has independent control over anyone's funds, and never decides where escrowed
funds go.

## Fix 1: STOS is not the evaluator
Today the service's `evaluator` key (our notary) issues the verdicts that release or refund escrow.
1. No STOS-controlled key may be the default or the only evaluator on any route. The `evaluator`
   wallet in app.mjs becomes an optional, clearly labeled "reference evaluator (operated by STOS
   Technologies, testnet demo)" and is never chosen implicitly.
2. Buyers pick the evaluator per job from EvaluatorRegistry (staked, permissionless registration).
   402 responses and /v1 docs list registered evaluators with stake and track record; the buyer's
   signed job terms name the evaluator. Our service must not override or rewrite that choice.
3. Stand up at least 2 independent test evaluators run as separate processes with separate keys
   (not the service's keys, not in the service's container), so the registry isn't one-entry.
   Label them honestly as test evaluators. They must not share keys with relayer/provider/deployer.
4. Keep the existing safety valves that don't need STOS: timeoutRelease / claimRefund when an
   evaluator goes dark. Confirm no admin path lets STOS force an outcome.
5. Remove or disable any service code path where the service itself calls finalize/verdict on a
   job it didn't evaluate as the buyer-chosen evaluator. finalize after the timeout is fine only if
   it's permissionless (anyone can call it and the outcome is fixed by contract rules).

## Fix 2: Forward-only relayer
1. The relayer only submits transactions/authorizations the payer already signed (EIP-3009,
   EIP-2612, signed job terms). It never holds user funds, even momentarily, and is never a
   `from`, `to`, or intermediate holder of USDC/EURC/AGC in any flow. Verify by test: relayer
   token balances stay 0 across every route (exact, swap, settler, AGC wrap).
2. Relayer takes no cut and no fee. It only pays gas.
3. Anyone can bypass it: every route must be callable directly on-chain by the payer with the same
   result. Add a documented "self-submit" path (docs + example script) and a test proving it.
4. The relayer can't change amounts, recipients, or evaluators. Anything not covered by the
   payer's signature gets rejected by the contracts, not just by the service.
5. Note in SECURITY-NOTES.md: relayer is a convenience gas-payer; the protocol works without it.

## Fix 3: AGC issuer posture and fees
1. Agents mint (wrap) and redeem (unwrap) AGC directly against the contract: 1:1, no fee, no STOS
   approval, no STOS-held reserve. Already true per AD-010; add an explicit test plus a doc line.
2. No yield, interest, or rewards paid for holding AGC (GENIUS Act). Staking rewards, if any, must
   be for evaluator work, not for holding.
3. Naming: "AgentCoin" / AGC. No "dollar" or "stablecoin" branding in token name, metadata, 402
   copy, or docs. Describe it as "a wrapper over USDC, redeemable 1:1."
4. Fees: protocol feeBps and any fee taken as a percentage of payments stay 0 on every route we
   configure (JobEscrow default shows feeBps 100 in the struct comment; make sure the deployed and
   to-be-deployed configs are 0, and the AGC deploy plan sets 0). evaluatorFeeBps goes to the
   independent evaluator, never to STOS. If we ever charge, it'll be a flat software/API fee,
   which is out of scope here.
5. Any fee or treasury recipient address in configs must not be a STOS key; set to zero/none.

## Acceptance (I'll verify each myself)
- A. Evaluator listing in 402 + docs shows ≥2 non-STOS evaluators; reference evaluator labeled.
- B. Test job settled end-to-end with a non-STOS evaluator chosen by the buyer (tx hashes).
- C. Self-submit test: payer settles directly without the relayer (tx hash on Base Sepolia).
- D. Relayer token balance 0 before and after every route test; relayer never a transfer party.
- E. feeBps = 0 on all live/planned configs; no STOS fee recipient.
- F. AGC wrap/unwrap direct, no fee, no yield; no "dollar" wording anywhere (rg check).
- G. Forge + node test suites pass; v0.5.15 behavior otherwise unchanged; rollback container kept.

Deploying these changes to the live testnet service is covered by Carter's approval above (testnet,
$0 beyond existing test ETH). AGC contract deploy itself is still gated on Carter's yes in your chat,
as before. Report: commits, test counts, tx hashes, anything you disagree with or can't do.
