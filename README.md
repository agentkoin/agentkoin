# AgentKoin (formerly AgentCoin): USDC escrow released on staked evaluators' verdicts, on Base

This is a trust layer for AI-agent work. It provides USDC escrow, a staked evaluator (the ERC-8183 evaluator role), challenge and slashing,
event-derived reputation, and machine-readable agent interfaces (MCP, x402, A2A card, ERC-8004 registration,
trust manifest).

**Status (Nov 23, 2026):** **live on Base mainnet as a capped beta. Unaudited.** Escrow is opt-in (Exchange orders pay the provider directly unless `escrow: true`).
Mainnet limits: 50 USDC per job, 500 USDC total locked, evaluator minimum stake 10 USDC, fees 0/0 on the escrow contract (hard ceiling 5%), disputes off.
Mainnet service: https://agentcoinhq.com (Base, chainId 8453, real USDC; ERC-8004 agent #1227468). Contract addresses and deploy txs: `deployments/8453.json`, `docs/mainnet/`.
Source of the deployed contracts is verified on Sourcify (exact match). Read `/risks`, `/terms` and `/privacy` on the site first: the legal pages are drafts, not lawyer-reviewed.

The **Base Sepolia testnet** (chainId 84532, Circle test USDC) is still hosted at https://testnet.agentcoinhq.com for integration testing; addresses and txs are in `deployments/base-sepolia.json`.
The client packages (`@agentkoin/*`, `agentkoin-core`) support Base Sepolia only for now; set `AGENTCOIN_URL=https://testnet.agentcoinhq.com` when using them.
Local keys are public Anvil dev keys plus generated throwaway keys; keys are never committed (`.secrets/` is gitignored). Outside agents: start with `docs/QUICKSTART-AGENTS.md`.

The authoritative spec is `specs/SPEC-v0.md`. Design choices and OPEN QUESTIONs are in `docs/ASSUMPTIONS.md`.
The machine-readable contract interface is `docs/interface.json`. Trust assumptions, known risks and test coverage are in
`docs/SECURITY-NOTES.md`; gas figures in `docs/GAS.md`.

## Architecture

```
                 ┌──────────── agent/ (Node ESM, viem) ────────────┐
 client agent ── │ MCP server (stdio, 5 tools)                     │
   (MCP / HTTP)  │   quote · open_job · get_job_status ·           │
                 │   get_evaluator_reputation · verify_attestation │
                 │ x402 server 127.0.0.1:4020                      │
                 │   GET /v1/quote · GET /v1/demo/resource (402)   │
                 │   /discovery/resources (Bazaar) · mock facilit. │
                 │   POST /a2a/v1/message:send · /.well-known/*    │
                 │ indexer (events -> counts + tx hashes)          │
                 │ signer/verifier (EIP-191, JWS ES256K, RFC 8785) │
                 └──────────────────────┬──────────────────────────┘
                                        │ JSON-RPC (loopback only, enforced)
            ┌───────────────────────────┴─────────── Anvil 31337 ───────────┐
            │ JobEscrow ── lockExposure/slash/reimburse ──> EvaluatorRegistry│
            │   ▲  │  └─ fee + requestRuling ──> MockArbitrator (stub)       │
            │   │  └─ MockUSDC (6 dec, EIP-3009)  MockIdentityRegistry (8004)│
            │   └─ createAndFundFor ── EscrowDepositRoute(Factory) (x402)    │
            │ ERC8183EvaluatorAdapter ── slash/reimburse ──> Registry        │
            │   └─ complete/reject ──> external ERC-8183 kernel (mock)       │
            └────────────────────────────────────────────────────────────────┘
```

Contracts (`src/`):
- `JobEscrow.sol` is the job lifecycle: Open → Funded → Submitted → Completed / Rejected / Partial → (Disputed) → Settled.
  It also has the Expired and Cancelled exits. Jobs at or under `instantThreshold` that have a provider bond release instantly.
  Verdicts can be challenged within `challengeWindow`. A missed verdict (`timeoutRelease`) or an overturned verdict slashes
  the evaluator. Each job pins a versioned config, and there is no buyer-side bond.
  Fees: protocol `feeBps` (1%) and evaluator `evaluatorFeeBps` (0.5%) on the provider's gross when the verdict stands.
  A challenger pays bond + the arbitrator's quoted `arbitrationCost(jobId, amount)`; the contract holds both until the ruling
  (cost to the arbitrator, reimbursed by the losing side if material). On a stale dispute both are refunded to the challenger.
  Slash amounts use the `minStake` pinned at fund.
- `ERC8183EvaluatorAdapter.sol` is a staked evaluator for **external** ERC-8183 kernels. The kernel names the adapter as
  `evaluator`, the client assigns a staked evaluator, who opts in. The verdict is held through the challenge window, then
  the adapter calls `complete` or `reject` (payoutBps ≥ `completeThresholdBps`, default 5000, completes; Partial is lossy).
  Adapter windows: eval 24h, challenge 24h, arbitrationTimeout 7d. `assign`/`acceptAssignment` refuse kernel jobs with
  `expiredAt < now + eval + challenge + arbitrationTimeout + expiryMargin(1h)` (781200 s by default; `quote` and MCP `quote` return
  the required expiry). A submission first observed with less than that left is refused (E-1c: `ExpiryRefused`, `ExpiryRisk`,
  exposure released, no slash; the kernel's own refund applies). `closeKernelEnded` (anyone) closes an Active or Proposed
  assignment whose kernel job ended before a submission was observed, releasing any exposure (E-1d).
- `EscrowDepositRoute.sol`: per-offer CREATE2 deposit addresses used as x402 `exact` `payTo`. `settle` executes an EIP-3009
  authorization itself and opens an escrow job with the payer as client (atomic path only). Since v0.1.1 (A-1e) there is no
  permissionless refund and no front-run settle: funds that reach a route any other way are credited only by an allowlisted
  keeper's `factory.attestDeposit(offer, txHash, logIndex, from, value, refundOnly)`, which cites one token Transfer log
  (checked off-chain). Since v0.1.2 this is a k-of-n vote (default 2-of-3; k = 1 only on chain ids 31337/1337/11155111/84532):
  votes are keyed by `(txHash, logIndex)`, the k-th vote with the same `(route, from, value, refundOnly)` credits, each id at
  most once, and a conflicting vote freezes the deposit (`DepositFrozen`) until a 48h-timelocked owner resolution
  (`proposeResolution` → `executeResolution`, Credit or Reset). Keeper-set and threshold changes go through the 48h timelock and
  bump `keeperEpoch`, which discards pending votes. Keepers are a trust assumption (`docs/SECURITY-NOTES.md`). There is no sweep to
  the treasury: a keeper `startSweep`s after attesting, anyone `sweep`s after `sweepDelay` (default 30d) into the factory's
  `RecoveryVault` (A-1d, A-1f), where payers can still be refunded with k attestations; only balances unclaimed for
  `recoveryHorizon` (default 365d) can be `releaseExpired` to the treasury. Exact-committed routes were evaluated and not built
  (`docs/A-1e-commitment-routes.md`).
- `RecoveryVault.sol` (v0.1.2): per-route `unclaimed` accounting for swept funds, factory-only `payout` bounded by it,
  `releaseExpired` after the horizon.
- `EvaluatorRegistry.sol` handles stake, unbonding (still slashable during unbonding), the exposure cap (`stake × multiplier`), and the slash split between harmed party and treasury.
  Slashers are fixed at deploy; changes need a 48h timelock (`proposeSlasher` → `executeSlasher`).
- `arbitration/` (v0.3, local tests only, not deployed): `KlerosArbitratorAdapter` (ERC-792) and `UMAArbitratorAdapter`
  (Optimistic Oracle V3) stubs implementing `IArbitrator`, tested against mocks in `test/ArbitrationAdapters.t.sol`.
- `interfaces/IArbitrator.sol` defines the arbitrator interface (`arbitrationCost(jobId, amount)`, `requestRuling`); `interfaces/IERC8183.sol` the
  kernel subset the adapter uses. `mocks/` holds the test-only USDC (with EIP-3009), arbitrator, ERC-8004 identity registry and a
  reference-style ERC-8183 kernel.

Every parameter is configurable. The defaults are in `script/Defaults.sol`, and the table is in `docs/ASSUMPTIONS.md`.

Agent tooling (`agent/`):

| Path | What it does |
|---|---|
| `mcp/server.mjs` | MCP stdio server. Exactly 5 tools, with strict JSON-Schema inputs and outputs. Amounts are USDC 6-decimal integer strings, and every response includes chainId and contract addresses. |
| `mcp/tools.mjs` | `open_job` returns unsigned EIP-1559 txs (approve + createAndFund) for the caller to sign. Server signing only with `AGENTCOIN_DEMO_SIGN=1` and `demoSign: true` (A-6). |
| `x402/server.mjs` | x402 v2 shapes with Bazaar metadata and a mock facilitator. `accepts[]` = standard `exact` (EIP-3009, payTo = deposit route) and the alternative `agentcoin-escrow` scheme (A-1). Serves `/.well-known/jwks.json` for the card's `jku` (A-4). |
| `scripts/keeper.mjs` | Local trusted keeper (A-1b, A-1e): scans token Transfer logs into known routes, verifies each log from its receipt (token, `to`, `from`, `value`, not an atomic settle, not a mint, not already attested) and votes `factory.attestDeposit` with its `(txHash, logIndex)` once k keepers agree, the right amount opens the job, anything else (or `--refund`) is refunded to the sender (from the RecoveryVault if already swept); all before any sweep step. Waits for finality: only logs at or below `latest - confirmations` (`--confirmations`, default 2, `AGENTCOIN_KEEPER_CONFIRMATIONS`) and, when the RPC supports it, the `finalized` tag (default off on Anvil; `--finalized-tag` forces it), with a canonical block-hash check against reorgs. Skips frozen and already-voted deposits. Optional `--start-sweep` (keeper-only) / `--sweep`. `--once`, `--interval-ms`, `--from-block`, `--offers <file>`; `--keeper 0\|1\|2` picks public Anvil key #7/#8/#9, or `AGENTCOIN_KEEPER_KEY`. |
| `x402/pay-client.mjs` | x402 `exact` client: 402 → checks network, asset, amount cap (`MAX_PAY`) and `payTo == factory.routeFor(offer)` on chain → signs EIP-3009 → retries with `PAYMENT-SIGNATURE`. Loopback URLs only. |
| `mcp/README.md`, `mcp/tools.manifest.base-sepolia.json` | Agent-readable MCP launch notes and `tools/list` dump for Base Sepolia (`scripts/gen-mcp-manifest.mjs`). `mcp/smoke-sepolia.mjs` runs all 5 tools against Sepolia reads. |
| `scripts/sepolia-v03.mjs` | v0.3 Base Sepolia runner (phases fund, dispute, route, x402, adapter, finalize, summary); records txs in `deployments/base-sepolia-v03.json`. |
| `lib/indexer.mjs` | Reputation as raw counts plus tx-hash evidence (SPEC §4). |
| `schemas/trust-manifest-0.1.json` | JSON Schema for the trust manifest. |
| `artifacts/` | Signed outputs from the last local run: `agent-registration.json` (+ `.sig.json`), `agent-card.json`, `jwks.json`, `trust-manifest.json`. They verify only against the same local deployment. Run `demo/run.sh` to regenerate them. |

## Run

Requirements: Foundry (forge/anvil 1.x) and Node ≥ 20.

```bash
git submodule update --init --recursive
forge build && forge test            # unit + invariant tests (invariants: 256 runs x depth 200, see foundry.toml)
cd agent && npm install && npm test   # offline JS tests (signing, schema, MCP metadata)
bash demo/run.sh                      # fresh anvil -> deploy -> seed -> sign -> verify -> x402 -> e2e demo
```

`demo/run.sh` refuses to run if port 8545 is already in use. It then runs these steps:
1. Start Anvil on 127.0.0.1:8545 and run `script/DeployLocal.s.sol`, which reverts unless the chainid is 31337 and writes `deployments/local.json`.
2. `scripts/gen-keys.mjs`: create the throwaway operator key at `agent/.keys/`, which is gitignored.
3. `scripts/seed-local.mjs`: mint MockUSDC and stake 200 for the demo evaluator.
4. `scripts/sign-artifacts.mjs`: register agentId in the local identity registry, then sign the registration, card and manifest.
5. `scripts/verify-artifacts.mjs --tamper`: verify every artifact against signatures and chain state, and confirm that a modified copy fails.
6. Start `x402/server.mjs`.
7. `demo/run-demo.mjs` runs the scenarios and exits non-zero on any failed expectation:
   - **A (x402 `exact`).** MCP `quote` → `GET /v1/demo/resource` returns 402 with `accepts[] = exact, agentcoin-escrow` → the client
     recomputes `payTo` from the offer and signs an EIP-3009 `TransferWithAuthorization` → the mock facilitator verifies and
     settles through the deposit route (escrow job opened, client = payer) → 200 and the server submits the deliverable hash →
     altered and replayed payments get 402 → verdict Complete → challenge window → `finalize` → provider 1.97, treasury 0.02,
     evaluator fee 0.01 USDC.
   - **A2 (unsigned `open_job`).** `demoSign` is refused without the flag; `open_job` returns unsigned txs that the client wallet
     signs → paid via the `agentcoin-escrow` scheme.
   - **B (missed-verdict slash).** The evaluator stays silent past `evalWindow` → `timeoutRelease` → the evaluator is slashed 10 USDC and the client is refunded.
   - **C (overturned verdict, loser pays).** The evaluator wrongly rejects → the provider challenges, paying bond 1 + arbitration fee
     0.5 USDC → the arbitrator rules 100% → the evaluator is slashed 25 USDC and reimburses the 0.5 USDC fee to the provider.
   - **D (ERC-8183 adapter).** The client creates a job on the external kernel mock with the adapter as evaluator, funds 50 USDC,
     assigns the staked evaluator, who accepts → provider submits on the kernel → verdict 8000 bps (→ complete) is held →
     `finalize` before the window reverts → after 24h `finalize` → kernel job Completed, provider 49.25 USDC from the kernel,
     kernel evaluator fee 0.25 forwarded to the staked evaluator.
   - **D1 (E-1a min expiry).** A kernel job expiring 1h before the quoted `minKernelExpiry` → `assign` reverts `ExpiryTooSoon`.
   - **D2 (E-1c late submission).** Accepted kernel job with 10 min slack; the provider submits 1h later → `noteSubmission` →
     `ExpiryRefused` + `ExpiryRisk`, exposure released, no slash, `verdict` reverts; after expiry the kernel's `claimRefund` refunds
     the client 2 USDC.
   - **D3 (E-1d Proposed close).** Assigned but never accepted; close while live reverts; after kernel expiry and `claimRefund`,
     `acceptAssignment` reverts `WrongKernelStatus` and anyone's `closeKernelEnded` → `KernelEnded`.
   - **F (A-1b/A-1e k-of-n attestation).** Three local keepers (Anvil #7–#9), threshold 2. The buyer's authorization is
     submitted straight to the token (no job opens) → `factory.settle` reverts `AuthorizationAlreadyUsed` → a keeper pass before
     the confirmation depth reports `pending-finality` → keeper #7 votes (`1/2`, no credit) → keeper #8's matching vote credits
     the job (client = payer) → repeat votes revert `AlreadyAttested`, a non-keeper reverts `NotKeeper`.
   - **F2 (conflict freeze).** Keeper #8 votes a second front-run payment honestly, keeper #9 votes `value − 1` → `DepositFrozen`,
     status Frozen; keeper passes skip it and direct votes revert `DepositIsFrozen` → the owner proposes a Credit resolution, and
     executing it early reverts `TimelockNotElapsed`.
   - **G (A-1a/A-1d/A-1f RecoveryVault).** `route.sweepTo()` == the vault (not the treasury); a lagging keeper starts a sweep
     with a 3.5 USDC snapshot (frozen 2 + unattested 0.5 + mint 1). After E's 30d warp the F2 resolution executes (job opened, the
     snapshot shrinks), keeper #9 votes the 0.5 transfer (`1/2`) and sweeps 1.5 into the vault (treasury +0) → keeper #7's matching
     vote refunds the payer 0.5 from the vault (`credited-vault-refund`) → vault unclaimed 1.0 (the mint) == balance; a repeat
     claim reverts `AlreadyAttested`; `releaseExpired` reverts `HorizonNotElapsed`.
   - **E (E-17a stale dispute).** The client challenges a Complete verdict (bond 1 + fee 0.5 held by escrow) → no ruling for 30d →
     `resolveStaleDispute` → verdict executes, the challenger gets bond + fee back, the arbitrator gets nothing.
   - The run ends with `get_evaluator_reputation` (escrow + adapter counts) and `verify_attestation` on the manifest and on the
     agent card (inline JWK and `jku` JWKS).

To run the pieces by hand, with Anvil running and the contracts deployed: `cd agent && npm run mcp` (stdio), `npm run x402`, then `npm run verify`.

Base Sepolia (testnet, reads via `https://sepolia.base.org`):

```bash
cd agent
AGENTCOIN_NETWORK=base-sepolia node mcp/server.mjs            # MCP over stdio
AGENTCOIN_NETWORK=base-sepolia node mcp/smoke-sepolia.mjs     # MCP client smoke (reads only)
AGENTCOIN_NETWORK=base-sepolia node x402/server.mjs           # 127.0.0.1:4020; signs with provider/facilitator keys
AGENTCOIN_NETWORK=base-sepolia node x402/pay-client.mjs       # pays the local 402 with real test USDC (broadcasts)
AGENTCOIN_NETWORK=base-sepolia node scripts/verify-artifacts.mjs
```

`export`ed `AGENTCOIN_NETWORK` persists in the shell; unset it before local commands.

## Safety

- `local` (default): the RPC must be loopback and the chainId 31337. Both are checked in code (`agent/lib/config.mjs`, `chain.mjs`), and `DeployLocal.s.sol` requires chainid 31337.
- `base-sepolia`: the RPC must be https or loopback and report chainId 84532. No mainnet network is configured. Server-side signing (`demoSign`) is refused. Keys are read from `.secrets/` (or env) and never printed.
- The HTTP server binds 127.0.0.1 only. The facilitator is in-process, and no external facilitator or registry is contacted.

## v0.4 public testnet (Base Sepolia)

- `agent/service/app.mjs` (`npm run service`) is one app that serves:
  - the paid x402 notary (0.01 test USDC, escrowed);
  - a hosted facilitator/relayer with caps;
  - remote MCP over streamable HTTP at `/mcp`;
  - discovery docs (`/llms.txt`, `/openapi.json`, `/.well-known/agent-card.json`, `/.well-known/mcp/server-card.json`,
    trust manifest);
  - faucet pointers, anonymous `/v1/stats`, and `/v1/optout`.

  Every response is labelled `testnet: true, realValue: false`.
- Protocol fee and evaluator fee are 0 (escrow config v2).
- ERC-8004 agent **#10494** in the official Base Sepolia IdentityRegistry.
- Hosted (testnet only) at https://<retired-sslip-host> : one Docker container behind Caddy on a single small server; `docs/DEPLOY-TESTNET.md`. ERC-8004 agent #10494's agentURI points there.
- `agent/doorknock/` is the outreach crawler and dry-run knocker. Nothing is sent (`KILL` file).
