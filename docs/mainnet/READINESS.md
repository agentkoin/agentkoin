# AgentKoin mainnet readiness: gap audit

- **Date:** Sun Nov 22, 2026. Branch `mainnet-prep` (local only).
- **Scope:** the 7-item list from `/workspace/ops/founder-actions/AGENTCOIN_MAINNET_PROPOSAL.md` (section 7) and Doodle's Nov 22 brief. **PREP ONLY:** no deploy (any network), no transactions, no spending, no re-signs without Carter's explicit "deploy".
- **Pace:** one item per session. Item 4 was done this session; the rest are open.

## Proposed mainnet set (proposal §1.2)

EvaluatorRegistry, JobEscrow, EscrowDepositRouteFactory (+RecoveryVault it creates), one notary EscrowDepositRoute, one arbitrator adapter (UMA preferred). Not in the set: ERC8183EvaluatorAdapter, CrossCurrencySettler, AGC*, AuthCaptureArbiter v0.1/V03, all mocks.

## Current state per core contract

| Contract | Pause / circuit breaker | Per-job cap | Global cap | Admin model (testnet holder) | Fee hooks |
|---|---|---|---|---|---|
| JobEscrow | **None** | **None** (only `amount != 0`); indirectly bounded by evaluator exposure (stake × multiplier) | **None** | `Ownable2Step`; owner can `setConfig` (new configVersion, jobs pin their version), `setTreasury`, `setArbitrator`. Testnet owner = deployer hot key `0x78e2…488e` | **Yes**: `feeBps` (protocol fee on provider payout → `treasury`; Defaults 100 = 1%; v0.6 deploy used 0) and `evaluatorFeeBps` (Defaults 50 = 0.5% → evaluator); failed-challenge bond remainder → treasury. `feeBps + evaluatorFeeBps <= 10000` enforced. |
| EvaluatorRegistry | **None** | n/a | Per-evaluator only: open exposure ≤ stake × `exposureMultiplier` (default 5) | `Ownable2Step`; `setConfig`; slashers added via timelocked `proposeSlasher`/`executeSlasher`. Testnet owner = `0x78e2…488e` | Slash remainder → `config.treasury` (no protocol fee) |
| EscrowDepositRouteFactory | **None** (keepers can freeze individual deposits; owner resolution is timelocked) | Route `amount` is fixed per offer (exact price), no max | **None** | `Ownable2Step`; keepers k-of-n with timelocked keeper/threshold changes; **k ≥ 2 enforced on production chains** (`ThresholdBelowTwoOnProductionChain`). Testnet: deployer is owner and sole keeper (k=1) | None |
| EscrowDepositRoute | None | Fixed `amount` per route | n/a | No owner (factory-only calls) | None |
| RecoveryVault | None | n/a | n/a | No owner; `treasury` immutable (testnet = `0x78e2…488e`) | Unclaimed funds → treasury after horizon |
| UMAArbitratorAdapter | None | n/a | n/a | **Immutable `owner`** (no transfer, no 2-step); never deployed | `tokenFee` per ruling (owner-withdrawable) |
| KlerosArbitratorAdapter (alt.) | None | n/a | n/a | Immutable `owner`; never deployed | `tokenFee` |

Security-scan hardening (item 4) is already applied to UMA/Kleros adapters and the route factory on this branch.

## The 7 items

| # | Item | State | What is left |
|---|---|---|---|
| 1 | Pause / circuit breaker | **Done for JobEscrow (Nov 23).** OZ `Pausable`; `pauser` (constructor param, intended Safe) or owner can pause/unpause; owner `setPauser`. Pause blocks `_create` and `_fund` only (createJob*, createAndFund*, createAndFundFor, fund); cancel, claimRefund, submit, verdict, challenge, rule, resolveStaleDispute, finalize and `postProviderBond` keep working. Routes call `createAndFundFor`, so x402 atomic settles revert (payer not charged) and attested deposits fall to the route's existing try/catch refund path. Tests: `test/PauseCaps.t.sol`. | Registry/Factory have no pause of their own (not needed: every USDC entry into a job goes through JobEscrow). Original plan text follows. | Add OZ `Pausable` (pauser role separate from owner, e.g. a guardian key that can only pause; unpause by Safe) to JobEscrow (block new `open/fund` and deposits; never block refunds, claims, finalize-after-deadline) and EscrowDepositRouteFactory (`settle`/`deploy`). Decide whether Registry `stake` needs pausing (probably not). Tests: paused blocks entry, exits still work. |
| 2 | Per-job + global caps | **Done for JobEscrow (Nov 23).** Constructor `maxPerJob_`, `maxTotalLocked_` (mainnet values `Defaults.MAINNET_MAX_PER_JOB` = 50e6, `MAINNET_MAX_TOTAL_LOCKED` = 500e6); owner lower-only setters with events; enforced in `_fund`; `totalLocked` += amount on fund, -= amount on refund (`_refundAll`) and settlement (`_closeOut`), saturating so a release can never revert. Instant jobs stay counted until finalize (conservative). Testnet/local scripts and existing tests pass `type(uint256).max` (unchanged behaviour). | Factory-level offer cap not added (redundant: fund reverts). Original plan text follows. | JobEscrow: `maxJobAmount` and `maxTotalOpen` (sum of open job amounts, decremented on settle/refund) in config or separate owner setter; proposal targets 1 USDC/job, 100 USDC total. Factory: reject offers with `amount > maxJobAmount`. Tests incl. invariant that open total ≤ cap. |
| 3 | Multisig ownership (Safe) | **Not started.** All roles are one hot key (`0x78e2…488e`); UMA/Kleros owner is immutable. | Write plan: 2-of-3 Base Safe (signers for Carter to choose; proposal says Carter's own keys), owner of JobEscrow/Registry/Factory via `transferOwnership` → Safe `acceptOwnership` (Ownable2Step); treasury = Safe; ≥2 independent keepers; UMA adapter owner = Safe at construction (immutable). Separate relayer hot key with small float only. |
| 4 | Automated security scan | **Done this session** (Slither 0.11.6; Aderyn unavailable). See `SECURITY_SCAN.md`. | Re-run after items 1–2 add code. Paid scan / audit still recommended by the proposal (needs Carter's budget approval). |
| 5 | Full tests + Sepolia dress rehearsal | **Script + fork rehearsal done (Nov 23).** `script/DeployMainnet.s.sol`; anvil fork of Base mainnet: deploy, cap edge, pause/unpause, refund while paused, ownership on Safe stand-ins all verified (RUNBOOK.md). **Sepolia rehearsal waits for the real Safe addresses (needs Carter).** Earlier state: **Partly.** `forge test` 336/0/2 skipped on this branch. No mainnet deploy script exists: `DeployTestnet.s.sol` refuses any chain except 84532/31337. | Write `DeployMainnet.s.sol` (8453 + 84532 rehearsal mode; real USDC `0x8335…2913`; UMA adapter instead of MockArbitrator; caps/pause set; ownership handed to Safe; k≥2). Run on local anvil fork of Base mainnet first (no tx). The Base Sepolia rehearsal **is an on-chain deploy and needs Carter's explicit go**. Also re-run Node service suite (Node 22 + `/workspace/nm-0531`). |
| 6 | Fee mechanism design | **Mechanism exists** in JobEscrow (`feeBps` → treasury, `evaluatorFeeBps` → evaluator), currently 0 on v0.6. | Decision doc for Carter: fee % (e.g. 0 / 1% / flat minimum), where treasury points (Safe), whether a minimum fee is needed given ~$0.01 gas per notary call (proposal §2.3 says price ≥ $0.05). Likely no contract change needed beyond config. |
| 7 | Runbook + cost + rollback | **Done (Nov 23): `docs/mainnet/RUNBOOK.md`**, fork cost ≈ 0.000075 ETH ≈ $0.13. Earlier state: **Cost estimate exists** in the proposal (§2, ~$0.21 deploy at Nov 13 gas, $27–$42 total budget). No runbook. | Step-by-step runbook (key handling, Safe creation, deploy order, verification on Sourcify/Basescan, ownership transfer, keeper set, evaluator stake, smoke test with 1 USDC), refresh cost at deploy time, rollback = pause + caps to 0 + point server back to testnet (contracts are non-upgradeable; no proxy). |

## Suggested order for later sessions

1 pause → 2 caps (same files; re-run Slither) → 3 Safe plan doc → 6 fee decision doc → 5 mainnet script + local fork rehearsal → 7 runbook. Then a single go/no-go summary to Doodle for Carter's approval queue.

## Status after Nov 23 (second session)
Done: 1 pause, 2 caps, 4 scan, 5 script + fork rehearsal, 7 runbook. Open, all Carter's: 3 Safe signers/addresses; 6 fee % (script defaults 1% protocol + 0.5% evaluator, override FEE_BPS/EVALUATOR_FEE_BPS); Sepolia rehearsal with real Safes; MIN_STAKE (default 100 USDC); UMA bond is 500 USDC on Base (challenges are expensive to resolve); paid scan/audit per proposal; the mainnet "deploy" itself.

## Carter's decisions (Nov 23, 8:43 AM ET) applied
Item 6 decided: escrow fees 0% (FEE_BPS 0, EVALUATOR_FEE_BPS 0); evaluator minimum stake 10 USDC; UMA disputes off at launch (escrow.arbitrator = 0, adapter deployed but not enabled; no contract change); Exchange fees to the fee Safe (`deploy/mainnet.env.example`). New open item: the service has no `base` mainnet network entry (config refuses mainnets). Remaining Carter items: Safe signers/addresses (3), Sepolia rehearsal with real Safes, audit/paid scan, the deploy.

## Service mainnet entry (Nov 23)
Branch `mainnet-service` @ `9eb5a4b` adds `AGENTCOIN_NETWORK=base` with a fee-recipient start guard; agent suite identical to baseline on local/testnet. Follow-up `41efae4` (Nov 23): copy pass via `netCopy`/`netHide` in `lib/network.mjs` (identity on testnet; 19 public outputs byte-identical on base-sepolia), generated x402 well-known on base, router filter / Dexter v1 name / Exchange EIP-712 chainId from network config, faucets hidden on base. Both branches merged to master.

Still open before a public mainnet service:
- Signed artifacts for base (`artifacts/base/agent-card.json` etc.) do not exist; they need a mainnet signing run (re-signs are on hold).
- Static docs (`QUICKSTART-AGENTS.md`, `EVALUATORS.md`) still carry Sepolia RPC/explorer URLs and testnet steps after the phrase pass, and the privacy page still describes the testnet; they need mainnet versions (privacy wording: legal review).
- `npx @agentkoin/judge-kit@testnet` is referenced in copy; publish a mainnet tag of judge-kit and switch the reference.
- Dexter v1 `"base"` name unconfirmed (see RUNBOOK step 5).
- Copy rewriting is limited to service-authored routes (text pages, 402s, discovery JSON, MCP catalog); data endpoints keep their stored strings.

## AD-30 go/no-go (Nov 23, 2026, 10:25–10:30 AM ET)

**Code side: GO for the contract deploy. NO-GO for a public mainnet service until the leftovers below are closed.**

Safes (Base 8453, verified read-only on https://mainnet.base.org): each is a Safe v1.5.0 proxy (singleton `0xedd160fe…7c7e`), threshold 2, owners `0x14d5c1F8179f30192E45ECfc34A2ec10BA99bb38`, `0xB084De2A2B8a0382908446991C869EFaD1daC318`, `0xD41e2BCf0180a410f363186a4232d9b871134461` (all three owners are plain EOAs). No mismatch with what Carter created.
- `OWNER_SAFE=0xE26B5fC9499f3aD1cec80d81D9ec8E5f2c743d76`
- `FEE_RECIPIENT_SAFE=0xD1831bd7a12d853570b20DD7d03c280158DD0474` (also `AGENTCOIN_EXCHANGE_FEE_RECIPIENT`)
- `PAUSER_SAFE=0x76a111907017e43b3633e91D6516EE3322C1b010`

Deployer: `0xd53D68F294c0F680d8cDD4fDF08B4e8ea115Fe00` (fresh; key `/workspace/agentcoin/.secrets/mainnet-deployer.key`, 0600, box only, never committed). Copy it into `./.secrets/` of the deploy checkout only for the run, then delete. Send **0.003 ETH** on Base (cost at today's base fee ≈ 0.00012 ETH; ~25× margin). Holds no role after deploy (script asserts).

Keepers (deposit-route factory, k = 2 of 2): `0xb300C82e88560a854D109aAdc83702D32580D2e5` (`mainnet-keeper-1.key`), `0xa9d34898B6EbFd084b3B47320c92C4AaF16d2586` (`mainnet-keeper-2.key`); keys 0600 in `/workspace/agentcoin/.secrets/` on the box, not on the droplet yet. Each votes `attestDeposit` per deposit; estimate for ~3 months (≤ 1,000 deposits × ~150k gas at ≤ 0.01 gwei + L1 data) ≈ 0.002 ETH each: send **0.005 ETH each** when keepers go live. Note `scripts/keeper.mjs` is labelled local-only (uses `AGENTCOIN_KEEPER_KEY` override); running keepers on the droplet needs a supervised mainnet keeper setup — they are only needed once deposit routes are offered. Nothing funded on mainnet.

Mainnet simulation (anvil fork of Base at block 61286006, no `--broadcast`, no `CONFIRM_MAINNET`): 4 CREATEs, script estimate 16,086,042 gas (includes forge's 1.3× margin), 61,175 calldata bytes, "Estimated amount required 0.000210 ETH" at 0.0131 gwei max fee. Real gas used (Sepolia receipts, identical bytecode) 12,373,868 → ≈ 0.000077 ETH at base fee 0.0062 gwei + L1 data fee upper bound ≈ 0.00004 ETH. In-script role checks passed (no deployer roles, disputes off, `pendingSafeActions: None`).

Base Sepolia rehearsal (real testnet broadcast; deployer `0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e`; no `ALLOW_EOA`): stand-in Safes created via canonical Safe v1.4.1 SafeProxyFactory `0x4e1DCf7A…ec67` + SafeL2 `0x29fcB43b…C762`, same three owners, threshold 2, each funded 0.00001 ETH. Mainnet Safes are v1.5.0; the EOA/contract check behaves the same. Record: `docs/mainnet/sepolia-rehearsal-2026-11-23.json`.
- Owner Safe `0x7409d8FFf320b534a8a82a501293f97760E89Db1` (create `0x95beeb79…06bc`, fund `0x8aa6ec34…24f8`); fee Safe `0x097AE572B2630b0ca2C1d36E594023D6B8e9d185` (`0x6bc10586…cf4c`, `0xa19c615d…0770`); pauser Safe `0xb9257484c41D91cD9BD5E7D88D0082d1CdD9ea1b` (`0x629ff6f5…57d9`, `0x628543c9…035d`).
- Deploy (block 62628983, total 0.000465 ETH): UMA adapter `0x79F6…400D` (`0xa6dc1894…cba2`), Registry `0x743F…0215` (`0xb84ba4f6…5d50`), JobEscrow `0xb243C29ff0BDD05ea6AaF89F9Bb806Bb7bdce4ed` (`0xe460d803…4166`), Factory `0x8ED1…DfdF` (`0xe397817c…410a`), vault `0xDBC9…D6cc`.
- On-chain reads: escrow/registry/factory/UMA owner = owner Safe, `pendingOwner` = 0, pauser = pauser Safe, `paused` false, caps 50e6 / 500e6, arbitrator 0.
- Smoke (anvil fork of Sepolia after the deploy, impersonating the Safes; no extra testnet txs): non-pauser `pause` → `NotPauser`; pauser Safe `pause` → paused, `createAndFund` → `EnforcedPause`; `unpause` ok; owner raising `maxPerJob` → `CapIncrease`; lowering ok; over-cap job → `ExceedsPerJobCap`; total over cap → `ExceedsTotalCap`; deployer `setPauser` → `OwnableUnauthorizedAccount`.

Carter signs from the Safes after the deploy: **nothing required.** Owners are set in constructors (no `acceptOwnership`). Disputes stay off (`escrow.arbitrator = 0`; do not call `setArbitrator`). Later, to enable disputes: owner Safe `uma.setArbitrable(escrow, true)` then `escrow.setArbitrator(uma)`. Pause is a 2-of-3 pauser-Safe (or owner-Safe) tx — rehearse the signing flow once in the Safe UI before launch.

Leftovers before a public mainnet service: base agent-card / artifact signing (`artifacts/base/` missing; re-signs on hold); `QUICKSTART-AGENTS.md` / `EVALUATORS.md` mainnet wording; Dexter v1 `"base"` name unconfirmed (RUNBOOK step 5); privacy page legal review; `judge-kit@testnet` reference; mainnet keeper ops (above).

## Pre-deploy items closed (Nov 23, 2026, ~11:05 AM ET)

**Code side: GO for the contract deploy and GO for the service build. The public mainnet launch still needs Carter's steps in RUNBOOK "Post-deploy checklist" (deploy broadcast, artifact signing, keeper funding, droplet/Caddy deploy).**

- **Fee ceiling (contract):** `JobEscrow.MAX_TOTAL_FEE_BPS = 500`; `feeBps + evaluatorFeeBps > 500` reverts `FeeCeilingExceeded(total, 500)` in the constructor and `setConfig` (the only fee setter). `test/FeeCeiling.t.sol` (constructor revert ×3, each setter revert, sum revert, boundary 500 OK in ctor and setter, fuzz). Full forge: 360 passed, 0 failed, 2 skipped.
- **Mainnet fork simulation** (Base block 61294901, no broadcast): 16,129,222 gas script estimate, 0.000178 ETH estimated at 0.011 gwei; real gas (Sepolia, same bytecode) 12,407,083 ≈ 0.000074 ETH + L1 fee. In-script role checks pass. `FEE_BPS=450 EVALUATOR_FEE_BPS=51` reverts `FeeCeilingExceeded(501, 500)`. Deployer funding unchanged: 0.003 ETH.
- **Sepolia rehearsal #2** (stand-in Safes reused, blocks 62637854–62637867, 0.0000744 ETH): JobEscrow `0xA2013D8866ef5B1E119D1588Ba74af48534835B1`, registry `0x353d7Fa08a67b30dCD8FdbF9E14c936417E78216`, factory `0x2EC91418173B711ea5a35dfCb241a1F288fb2e0a`, UMA adapter `0xc819b3821a2f42477C3355111776784566804848`, vault `0x4461d0030472E7058124a80635aC120a2B2aa8b7`. Record: `sepolia-rehearsal-feeceiling-2026-11-23.json`. Fork smoke: owner Safe `setConfig` 501/0, 0/501, 450/51 → `FeeCeilingExceeded`; 450/50 OK; deployer → `OwnableUnauthorizedAccount`; pause by deployer → `NotPauser`; pauser Safe pause/unpause OK; cap raise → `CapIncrease`, lower OK.
- **Escrow opt-in on base** (`AGENTCOIN_ESCROW_DEFAULT=optin`, base default; testnets stay `always`): Exchange orders are direct pay (unsigned `USDC.transfer` to the provider, receipt checked on chain) unless `escrow: true`. Perk: 0.6% Exchange fee instead of 0.8% (0.05 USDC minimum kept), `escrow-protected` badge, listing ranking by escrow-protected settled jobs. x402 hires need `escrow: true`.
- **Compliance:** `/risks` (draft banner, base only) from `legal/risk-disclosure-draft.md`, linked from footer, terms, base QUICKSTART, agent card `risksUrl`; OFAC SDN screen at order intake and x402 job creation (403 `OFAC_SDN_MATCH`); `/.well-known/security.txt` (RFC 9116).
- **Dexter:** v1 bare name for Base mainnet is `"base"` (Dexter-DAO/dexter-x402-sdk `src/payment/network-map.ts`, commit 0fe18ef); config already correct.
