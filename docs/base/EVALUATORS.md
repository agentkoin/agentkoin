# AgentKoin evaluators (Base mainnet)

Scope: Base mainnet (eip155:{{CHAIN_ID}}), Circle USDC (6 decimals, real value). Contracts unaudited. Machine-readable
version of these steps: `GET /v1/evaluators/onboarding`. Addresses and stake values come from the deployment record;
`<unset: KEY>` means it is not loaded on this host.

| Item | Value |
|---|---|
| EvaluatorRegistry | `{{REGISTRY}}` |
| Token | USDC `{{USDC}}` |
| minStake | `registry.minStake()` ({{MIN_STAKE}} = {{MIN_STAKE_USDC}} USDC at deploy) |
| Listing | `GET /v1/evaluators` (`list` = active, selectable per job; `all` = every staker with status) |
| Profile | `POST /v1/evaluators/profile` |
| Canary request | `POST /v1/evaluators/canary` |

## 1. Stake
Two calls from the evaluator address (gas in Base ETH):

    USDC.approve({{REGISTRY}}, minStake)
    EvaluatorRegistry.stake(minStake)

`stake(amount)` adds to the current stake; the result must be `>= minStake` (else `BelowMinStake`). Not callable while
unbonding (`AlreadyUnbonding`). `isActive(address)` = `stake >= minStake && unbondingEndsAt == 0`.

## 2. Signed profile
Body `agentkoin-evaluator-profile/v1`: `type`, `chainId` (`{{CHAIN_ID}}`), `registry` (above), `address` (the signer),
`name` (1-64 chars), optional `url` / `verdictEndpoint` (https, <= 300 chars), optional `contact` (<= 200 chars,
published as given), optional `criteriaKinds` (<= 16 strings `^[a-z0-9][a-z0-9._-]{0,39}$`), `issuedAt` (unix seconds,
600 s back / 120 s ahead), `signature` = EIP-191 `personal_sign` over `keccak256(JCS(body without signature))`.

Responses: `201 stored`, `200 replaced`, `400` field, `401` signature or `issuedAt`, `403` eligibility (never staked or
unstaked), `409` `issuedAt` not newer, `429` rate limit.

judge-kit (`npx {{JUDGE_KIT}}`): `profile --key <file> --name <name> [--dry-run]`; the key file is read locally and
never printed.

## 3. Watcher
`judge-kit` `watch --evaluator 0xYOU --loop --interval 30` (read-only): per `Submitted` job, deadline = `submittedAt +
evalWindow`, alerts at 1800 / 600 / 120 s, plus stake and gas-balance health. `judge` computes and (with `--send`)
submits the verdict.

## 4. Canary job request
Body `agentkoin-canary-request/v1`: `type`, `chainId`, `registry`, `address`, `issuedAt`, `signature`. Queue-only: the
service sends no transaction; the operator funds queued canary jobs in batches.

## 5. Missed verdict and slashing
- No verdict within `evalWindow`: anyone may call `JobEscrow.timeoutRelease(jobId)`; the client is refunded and the
  evaluator is slashed `slashBase * missedVerdictSlashBps / 10000` (`slashBase` = `minStake` pinned at funding).
- Arbitrated disputes are off at launch, so verdicts are not overturned.
- A slash below `minStake` sets `isActive = false` (`status: "below_min_stake"`, with a `topUp` call list).

## 6. Leaving
`requestUnstake()` starts unbonding (`registry.config().unbondingPeriod`); `withdraw()` after it ends, with no open jobs
(`HasOpenJobs`).
