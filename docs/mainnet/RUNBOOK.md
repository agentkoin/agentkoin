# AgentKoin Base mainnet deploy runbook

**Nothing in this runbook may be broadcast until Carter types "deploy to mainnet" in chat.** Script: `script/DeployMainnet.s.sol` (branch `mainnet-prep`). Rehearsed on a local anvil fork of Base mainnet on Nov 23, 2026 (`docs/mainnet/fork-rehearsal-2026-11-23.json`).

## What it deploys (Base 8453; Sepolia 84532 for rehearsal)
UMAArbitratorAdapter (owner = OWNER_SAFE, oracle = UMA OOv3 `0x2aBf1Bd76655de80eDB3086114315Eec75AF500c`) → EvaluatorRegistry (owner = OWNER_SAFE, slasher = escrow, treasury = FEE_RECIPIENT_SAFE) → JobEscrow (owner = OWNER_SAFE, pauser = PAUSER_SAFE, treasury = FEE_RECIPIENT_SAFE, arbitrator = UMA adapter, caps 50e6 / 500e6) → EscrowDepositRouteFactory + RecoveryVault (owner = OWNER_SAFE, keepers k-of-n, vault treasury = FEE_RECIPIENT_SAFE). USDC is fixed per chain (Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). Routes are created later on demand by `factory.deploy(offer)`; ERC8183 adapter, CrossCurrencySettler, AGC are not deployed.

## Prerequisites
1. Three Safes on Base (can be the same Safe; script requires each to have contract code, refuses EOAs and EIP-7702-delegated EOAs unless `ALLOW_EOA=1`, rehearsal only): `OWNER_SAFE`, `FEE_RECIPIENT_SAFE`, `PAUSER_SAFE`. Signers chosen by Carter (READINESS item 3).
2. `KEEPERS`: ≥ 2 keeper hot keys (comma-separated), threshold `KEEPER_THRESHOLD` (default 2; the factory refuses k < 2 on 8453). The deployer must not be a keeper (script refuses).
3. Fresh deployer key in a file (`DEPLOYER_KEY_FILE`, under `./.secrets/` because of `fs_permissions`), funded with **0.002 ETH** on Base (fork cost ≈ 0.000075 ETH; 0.002 covers a >20× gas spike).
4. Carter's launch decisions (Nov 23, 8:43 AM ET), now the script defaults: `FEE_BPS=0`, `EVALUATOR_FEE_BPS=0` ("Escrow fees 0%, like testnet"), `MIN_STAKE=10e6` (10 USDC), `DISPUTES_ENABLED=false` ("Launch with UMA disputes off"). Still overridable by env. Other defaults: `UMA_LIVENESS` 7200 s, `UMA_TOKEN_FEE` 0.
5. Service env for mainnet: `deploy/mainnet.env.example` (`AGENTCOIN_NETWORK=base`, `AGENTCOIN_EXCHANGE_FEE_RECIPIENT=<FEE_RECIPIENT_SAFE>`, "Exchange fees go to the new fee Safe"). Needs the service from branch `mainnet-service` (commit `9eb5a4b`, off master `26c5531`, not merged): chain 8453, Circle USDC EIP-712 domain ("USD Coin", "2"), RPC mainnet.base.org, addresses from `deployments/8453.json` or env, keys from env only, x402 network `eip155:8453`, basescan.org links, `testnet`/`realValue` flags false/true only on base. The service **refuses to start** on base if the fee recipient is unset, malformed or equal to the operator signer (no fallback). Not yet covered on base: human-readable copy that still says "Base Sepolia testnet" (llms.txt, OpenAPI titles, MCP titles, notary description), the static `well-known-x402.json`, the router's Sepolia-only payment-option filter (`router/parse.mjs`), the Dexter facilitator network name, and testnet faucet links; these need a copy/behaviour pass before a public mainnet service.

## Commands
```bash
export PATH=$HOME/.foundry/bin:$PATH
export OWNER_SAFE=0x… FEE_RECIPIENT_SAFE=0x… PAUSER_SAFE=0x… KEEPERS=0x…,0x… DEPLOYER_KEY_FILE=.secrets/mainnet-deployer.key
# 1. SIMULATE (documented default; no --broadcast = nothing is sent). Review addresses and "Estimated amount required".
forge script script/DeployMainnet.s.sol --rpc-url https://mainnet.base.org
# 2. BROADCAST — only after Carter types "deploy to mainnet". Without CONFIRM_MAINNET the script reverts MainnetNotConfirmed.
CONFIRM_MAINNET="deploy to mainnet" forge script script/DeployMainnet.s.sol --rpc-url https://mainnet.base.org --broadcast --slow
```
Output: `deployments/8453.json` (addresses, Safes, caps, fees, keepers, deploy block). The script asserts at the end that the deployer holds no role (owner/pendingOwner/pauser/treasury/keeper/slasher) and that caps are 50e6 / 500e6.

## Fee ceiling (contract)
`JobEscrow.MAX_TOTAL_FEE_BPS = 500`: `feeBps + evaluatorFeeBps` above 5% reverts `FeeCeilingExceeded(total, 500)` in the constructor and in `setConfig` (the only setter that touches either fee). Launch values are 0 / 0. `FEE_BPS=450 EVALUATOR_FEE_BPS=51` makes the deploy script revert before any tx.

## Verify
1. Source verification (Sourcify needs no API key; Basescan needs `ETHERSCAN_API_KEY`). For each contract in `broadcast/DeployMainnet.s.sol/8453/run-latest.json` (constructor args are in each CREATE's `arguments`):
   ```
   forge verify-contract <escrow> src/JobEscrow.sol:JobEscrow --chain 8453 --verifier sourcify --watch \
     --constructor-args $(cast abi-encode "constructor(address,address,address,address,(uint256,uint256,uint64,uint64,uint64,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16),address,address,uint256,uint256)" <args from run-latest.json>)
   forge verify-contract <registry> src/EvaluatorRegistry.sol:EvaluatorRegistry --chain 8453 --verifier sourcify --watch --guess-constructor-args --rpc-url https://mainnet.base.org
   forge verify-contract <factory> src/EscrowDepositRoute.sol:EscrowDepositRouteFactory --chain 8453 --verifier sourcify --watch --guess-constructor-args --rpc-url https://mainnet.base.org
   forge verify-contract <uma> src/arbitration/UMAArbitratorAdapter.sol:UMAArbitratorAdapter --chain 8453 --verifier sourcify --watch --guess-constructor-args --rpc-url https://mainnet.base.org
   ```
   Repeat with `--verifier etherscan` for Basescan. Same compiler settings as `foundry.toml` (no edits between deploy and verify). Rehearse on Sepolia first with `--chain 84532` against the rehearsal addresses.
2. Read back (`R=https://mainnet.base.org`, `E=<escrow>`): `cast call $E 'owner()(address)'`, `'pendingOwner()(address)'` (= 0), `'pauser()(address)'`, `'treasury()(address)'`, `'maxPerJob()(uint256)'` (50000000), `'maxTotalLocked()(uint256)'` (500000000), `'paused()(bool)'` (false), `'arbitrator()(address)'` (0x0 = disputes off), `'currentConfig()'` feeBps/evaluatorFeeBps 0; registry `minStake()` = 10000000; `owner()` on registry, factory, UMA adapter = OWNER_SAFE; `registry.isSlasher(escrow)` = true; `factory.threshold()` ≥ 2.

## Disputes (off at launch)
JobEscrow is deployed with `arbitrator = address(0)`. `challenge()` then reverts `NoArbitrator` before any state change or token transfer, so no job can be frozen in `Disputed`; verdict → finalize after the challenge window and all refunds (cancel, claimRefund) work as normal. No contract change was needed. The UMA adapter is still deployed (owner = OWNER_SAFE) but does not list the escrow; the script asserts both at the end. **To enable later (owner Safe, two txs, in order):** `UMAArbitratorAdapter.setArbitrable(<escrow>, true)`, then `JobEscrow.setArbitrator(<uma>)`. Note: with disputes off, a client's only protection against a wrong verdict is the evaluator's choice; instant-release jobs (≤ 1 USDC with provider bond) have no recourse either.

## Post-deploy Safe transactions
- **No acceptOwnership step is needed**: every owner is set to OWNER_SAFE in the constructor (no transfer, `pendingOwner` = 0). If ownership is ever transferred later, the new Safe must call `acceptOwnership()` (Ownable2Step) on JobEscrow, EvaluatorRegistry and the factory. The UMA adapter owner is immutable.
- None required at launch (disputes off). Enabling disputes later is the two-tx sequence above (`setArbitrable` was 45,711 gas on the fork).
- Real UMA OOv3 minimum bond for Base USDC is **500 USDC** (read on the fork). Whoever proposes a ruling must post it; budget accordingly before enabling challenges for real.

## Pause procedure
PAUSER_SAFE (or OWNER_SAFE) executes `JobEscrow.pause()`. Effect: no new jobs or funding (x402 route settles revert so payers are not charged). Still works while paused: cancel, claimRefund, submit, verdict, challenge, rule, finalize. Verify `paused()` = true. Resume with `unpause()` (pauser or owner).

## Rollback / emergency
Contracts are not upgradeable. Emergency: (1) pause; (2) optionally owner lowers caps (`setMaxPerJob`, `setMaxTotalLocked`, lower-only) to stop new funding permanently; (3) let open jobs exit: clients `cancel` unaccepted jobs, anyone `claimRefund` after deadline, `finalize` after the challenge window; (4) point the server/x402 offers back to Base Sepolia; (5) redeploy a fixed version and move offers to it. Keeper or vault issues: factory owner resolutions are timelocked (48h); route sweeps go to the RecoveryVault, never to the treasury.

## Cost (fork rehearsal, Nov 23, 2026, 8:26 AM ET)
| Tx | Gas |
|---|---|
| UMAArbitratorAdapter | 1,281,351 |
| EvaluatorRegistry | 1,658,157 |
| JobEscrow | 4,945,478 |
| EscrowDepositRouteFactory (+ RecoveryVault) | 4,487,526 |
| **Total deploy** | **12,372,512** |
| Safe `setArbitrable` | 45,711 |

At Base gas price 0.006 gwei (`cast gas-price`, mainnet.base.org) the L2 cost is 0.0000742 ETH; L1 data fee (GasPriceOracle `getL1Fee` on the four init codes) 0.00000065 ETH; **total ≈ 0.000075 ETH ≈ $0.13** at ETH $1,721.87 (CoinGecko). 10× gas: ≈ $1.29. Fork job flow gas: stake 96,916; createAndFund 351,657 (first) / 334,545; cancel-refund 74,258; pause 29,819; unpause 29,774.

## Fork re-run with launch defaults (Nov 23, 8:45 AM ET)
Deploy 12,372,248 gas (≈ 0.000075 ETH ≈ $0.13 at 0.006 gwei). escrow.arbitrator = 0, uma.isArbitrable(escrow) = false, feeBps 0 / evaluatorFeeBps 0, minStake 10 USDC. Evaluator staked 10 USDC (active); 10 USDC job funded (351,645 gas), submitted (68,151), verdict Complete (65,649); client `challenge()` reverted `NoArbitrator`; finalize after 48 h (82,961): provider +10.000000 USDC (100%), fee Safe +0, totalLocked 0, escrow balance 0; second job funded and cancelled: client refunded 5 USDC (74,258).

## Service start on mainnet (after the contract deploy)
1. Copy `deploy/mainnet.env.example`, fill `AGENTCOIN_EXCHANGE_FEE_RECIPIENT` with the fee Safe, keys from the secret store, `deployments/8453.json` from the deploy.
2. Start; it must fail fast if the fee recipient is missing or equals the operator. Check `GET /` reports `chainId 8453`, `testnet: false`, `realValue: true`, and explorer links point to basescan.org.
3. Instant release stays ON at mainnet (Carter, Nov 23, 8:56 AM ET): defaults unchanged — `instantThreshold` 1e6 (≤ 1 USDC) and `instantBondCoverBps` 10000 (the provider's bond must cover 100% of the price). Why: the amount is capped at 1 USDC and the provider is bonded, so a wrong instant release is covered by the provider's stake; with disputes off these jobs have no other recourse.
4. Copy check on base: `/llms.txt`, `/openapi.json`, MCP `initialize`/`tools/list`, the notary description and `x-agentcoin-real-value: true` must say "Base"/"USDC" (no "Sepolia", "test USDC", faucets). `/v1/faucets` returns `[]`. `/.well-known/x402` is generated from the live 402 (`eip155:8453`, Base USDC). Re-check with `AGENTCOIN_NETWORK=base node scripts/public-output-snapshot.mjs <dir>` against the deployed addresses.
5. Dexter (confirmed Nov 23 from public source, nothing contacted): v2 uses CAIP-2 `eip155:8453`; the x402 v1 bare name for Base mainnet is `"base"`. Source: Dexter-DAO/dexter-x402-sdk `src/payment/network-map.ts` (`{ caip2: 'eip155:8453', bare: 'base' }`, commit 0fe18ef, Nov 17, 2026) and its `v1-header.test.ts`; docs.dexter.cash/docs/reference/networks lists Base as `eip155:8453`. `X402_V1_NETWORK` in `agent/lib/network.mjs` is `"base"` on base, `"base-sepolia"` on testnets: no change needed.

## Cost after the fee ceiling (Nov 23, 2026, 11:00 AM ET)
Mainnet fork simulation (anvil fork of Base at block 61294901, no `--broadcast`, no `CONFIRM_MAINNET`): 4 CREATEs, script estimate 16,129,222 gas (forge 1.3× margin), "Estimated amount required 0.000178 ETH" at 0.011 gwei max fee (base fee 0.005 gwei). Real gas on the Sepolia rehearsal (same bytecode): 12,407,083 (UMA 1,281,555; registry 1,658,565; escrow 4,979,029; factory+vault 4,487,934), paid 0.0000744 ETH incl. L1 fee. Mainnet ≈ 12.41M × (0.005 + 0.001) gwei ≈ 0.000074 ETH + L1 data fee (< 0.00004 ETH). Deployer funding stays **0.003 ETH**.

## Post-deploy checklist (in order)
Contracts (right after the broadcast; deployer = `0xd53D…Fe00`):
1. Save `deployments/8453.json` and `broadcast/DeployMainnet.s.sol/8453/run-latest.json`; commit both (stage by path). Delete `./.secrets/mainnet-deployer.key` from the deploy checkout.
2. Read back every role (see Verify step 2) and `MAX_TOTAL_FEE_BPS() = 500`, `currentConfig()` fees 0 / 0, `arbitrator() = 0`, `paused() = false`.
3. Verify source on Sourcify and Basescan (Verify step 1).
4. Sweep any leftover deployer ETH is optional; the deployer holds no role.

Artifacts and config:
5. Sign the Base artifacts: `node agent/scripts/sign-base-artifacts.mjs --deploy deployments/8453.json --evaluator <reference evaluator> --rpc <base rpc>` with `AGENTCOIN_OPERATOR_KEY_FILE` set. Output `agent/artifacts/base/` (agent card + JWKS, ERC-8004 registration + sidecar, trust manifest). Until then `/.well-known/agent-card.json` returns 503 `ARTIFACTS_NOT_SIGNED`.
6. Refresh the OFAC list: `node agent/scripts/ofac-refresh.mjs` (writes `agent/static/ofac-sdn-addresses.json`); commit it. Re-run weekly.
7. Fill the mainnet env from `deploy/mainnet.env.example`: `AGENTCOIN_NETWORK=base`, `AGENTCOIN_DEPLOYMENT_FILE`, `AGENTCOIN_EXCHANGE_FEE_RECIPIENT` = fee Safe `0xD183…0474`, operator/relayer keys from the secret store, `RPC_URL`, `AGENTCOIN_JUDGE_KIT_TAG` (default `mainnet`; publish `@agentkoin/judge-kit@mainnet` or set the tag that exists), `AGENTCOIN_ESCROW_DEFAULT=optin` (base default) and `AGENTCOIN_ESCROW_FEE_BPS=60`. Put `legal/risk-disclosure-draft.md` and `legal/privacy-policy-mainnet-draft.md` under the service root (or set `AGENTCOIN_RISK_DRAFT` / `AGENTCOIN_PRIVACY_DRAFT`).

Keepers:
8. Fund keeper 1 `0xb300…D2e5` and keeper 2 `0xa9d3…6586` with 0.005 ETH each; start them per `KEEPERS.md` with the service's offers file.

Service (needs Carter: droplet + Caddy):
9. Deploy the service build with the mainnet env; start; check `GET /` → `chainId 8453`, `testnet: false`; run the copy check (step 4 above) and `AGENTCOIN_NETWORK=base node agent/scripts/public-output-snapshot.mjs <dir>`.
10. Check `/risks`, `/terms`, `/privacy` (draft banners), `/.well-known/security.txt`, `/.well-known/agent-card.json` (200 once signed), `/exchange` (escrow checkbox, direct pay default).
11. Smoke with real USDC ≤ 1 USDC: one direct-pay Exchange order, one `escrow: true` order (badge, 0.6% fee), one sanctioned-address request → 403 `OFAC_SDN_MATCH`.

Safes (Carter, 2-of-3):
12. Practise a pause: pauser Safe `0x76a1…b010` proposes `JobEscrow.pause()`, two owners sign, execute; check `paused() = true`; then `unpause()`. Do it once in the Safe UI right after launch while no jobs are open.
13. Nothing else to sign at launch (no acceptOwnership; disputes off). If disputes are enabled later: post a notice on the site ≥ 7 days ahead, then owner Safe `uma.setArbitrable(escrow, true)` → `escrow.setArbitrator(uma)`.
14. Record everything (addresses, tx hashes, Safe tx hashes) in `docs/mainnet/READINESS.md`.

