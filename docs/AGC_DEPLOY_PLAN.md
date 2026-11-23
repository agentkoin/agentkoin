# AD-010 AGC — Base Sepolia deploy plan (contracts EXECUTED 2026-11-15; service entry NOT enabled)

Status (2026-11-15, 12:3x PM ET): Carter approved the AGC testnet deploy (his "Yes" + "Both", 12:23-12:25 PM ET).
Steps 1-4 done: fork test 6/6, dry run, broadcast (5 contracts, blocks 59211003-59211034), evaluator funded and
staked on the AGC registry; addresses and txs in `deployments/base-sepolia-agc.json`. Acceptance check 5 ran live
(EURC->AGC job + forced refund). Sourcify NOT submitted (publishing source needs separate approval). Step 6 (402
entry): enabled for about 1 minute at ~12:36 PM ET and rolled back, because with AGC on the header carries
[exact USDC, exact AGC] and drops the USDC agentcoin-escrow entry (spec 6.2 by design), which fails the condition
"USDC exact/escrow entries byte-identical". Headers were 5,494 B. Carter accepted the 6.2 layout at 2:54 PM ET; a
second enable at 2:55 PM ET was rolled back after ~15 s because UltravioletaDAO discovery no longer listed the USDC
route (q=agentcoin returned 0 items; still 0 after rollback, so the cause is unconfirmed). Sourcify: all five
contracts exact_match (AGC and AGCSettlerAdapter submitted 2:57 PM ET; registry, escrow and factory were matched by
Sourcify itself at 12:35 PM ET). AGC 402 entry: OFF.
Testnet only: chain 84532, $0 real money.

## What is built (local)
- `src/AGC.sol` — ERC-20 "AgentCoin" / AGC, 6 decimals, 1:1 wrapper over Circle test USDC
  (0x036CbD53842c5426634e7929541eC2318f3dCF7e). EIP-2612 permit, EIP-3009 (transfer/receive/cancel,
  plus wrap/unwrapWithAuthorization), no owner, no pause, no mint outside wrap, reserve views.
- `src/AGCSettlerAdapter.sol` — stateless; wraps settler USDC output into an AGC JobEscrow job.
- AGC EvaluatorRegistry + JobEscrow + EscrowDepositRouteFactory built from the live USDC stack's
  parameters (`script/DeployAGC.s.sol`, `AGCStackBuilder`): feeBps 0, live evaluatorFeeBps,
  live registry/factory config, keepers=[deployer], threshold 1. Only the AGC escrow is a slasher.
- Service behind env flags; off unless all four AGC_* addresses are set.
- AD-011: AGC is a wrapper over USDC, redeemable 1:1. Anyone wraps/unwraps directly against the contract: no fee,
  no STOS approval, no STOS-held reserve, no yield or rewards for holding (`test/LegalHardening.t.sol`).
  AGC escrow + registry owner = 0x000000000000000000000000000000000000dEaD (no setConfig / setTreasury /
  setArbitrator / proposeSlasher after deploy), no arbitrator (challenge() reverts NoArbitrator; the
  evaluator's verdict stands, timeouts stay permissionless), treasury / registry slash remainder / RecoveryVault
  recipient = 0x…dEaD, feeBps 0, evaluatorFeeBps = live value (0) and paid only to the job's evaluator.
  Remaining STOS role: route-factory owner and sole keeper (k = 1) for stray non-`settle` deposits.

## Preconditions (read-only, checked 2026-11-15 ~8:24 AM ET, block 59136030)
- Deployer 0x78e2…488e: 0.000206 ETH, 9.537 USDC. Deploy ≈ 13.0M gas (fork-measured
  12,986,824 after AD-011) ≈ 0.000078 ETH at 0.006 gwei → enough ETH. No faucet needed.
- Evaluator 0xfb01…509a: 0.015 USDC, 0.000118 ETH. AGC registry minStake = live minStake (2 USDC);
  needs 2 test USDC → one deployer→evaluator test-USDC transfer (testnet tx; needs approval).
- Re-check balances and gas price immediately before running.

## Steps (each needs approval)
1. Dry run on fork: `FORK_BASE_SEPOLIA_RPC=https://sepolia.base.org forge test --match-path test/fork/AGCFork.t.sol`
   then `forge script script/DeployAGC.s.sol --rpc-url https://sepolia.base.org` (no --broadcast).
2. Broadcast: same command with `--broadcast`; key read from DEPLOYER_KEY_FILE
   (default .secrets/testnet-deployer.key), never printed.
3. Record addresses in `deployments/base-sepolia-agc.json` (AGC_ADDRESS, AGC_REGISTRY, AGC_ESCROW,
   AGC_ROUTE_FACTORY, AGC_ADAPTER, tx hashes, block) and verify all five on Sourcify.
4. Evaluator: transfer 2 test USDC deployer→evaluator; evaluator approves AGC, `wrap(2e6)`,
   approves AGC registry, `stake(2e6)`. Confirm `isActive(evaluator)` on the AGC registry.
5. Smoke (testnet, small): one wrap/unwrap of 0.01; one AGC exact payment via pay-client with an
   AGC-only wallet; one EURC→AGC swap through the settler + adapter; one forced swap refund.
6. Service v0.5.16: build from a clean HEAD copy (deploy/make-context.sh + Dockerfile.prebuilt),
   back up data+env as `.bak-pre-0.5.16`, keep `agentcoin-testnet-0.5.15` for rollback, add env:
   `AGC_ADDRESS AGC_ESCROW AGC_ROUTE_FACTORY AGC_ADAPTER` (leave `AGC_FIRST` unset = 0;
   `AGC_SWAP_OUT` default 1). Docker commands scoped to agentcoin-* only; Caddy untouched.
7. Live checks: USDC exact/escrow entries byte-identical; /.well-known/x402 sha256 unchanged
   (e592bf95…); total 402 headers ≤ 5,888 B; GET /v1/agc reserve == totalSupply at one block;
   USDC-only wallet still pays USDC; listings still show the USDC route.

## Rollback
- Service: unset the four AGC_* env vars and restart (→ byte-identical v0.5.15 402/headers, tested
  in `agent/test/agc.test.mjs` "rollback"), or swap back to container agentcoin-testnet-0.5.15.
- Contracts are ownerless and cannot be paused; holders can always `unwrap`. Rollback = stop
  advertising AGC; nothing to migrate.

## Keep off / not done (deliberate)
- `AGC_FIRST` stays 0: reference @x402/core picks `accepts[0]` with no balance check, so AGC-first
  would break USDC-only clients using stock x402 clients (only our pay-client is balance-aware).
- Trust manifest / signed artifacts: adding AGC needs re-signing → separate approval.
- Not implemented: `agentcoin.next {payIn:"AGC"}` growth loop (instruction-shaped),
  GET /v1/reputation/{address} indexer, MCP tools / integrations updates, legal items (spec 9.x).
