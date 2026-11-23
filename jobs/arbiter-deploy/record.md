# AgentKoinAuthCaptureArbiter deploy (Base Sepolia 84532 only)

Record of the approved testnet deploy plus registry slasher **propose** (not execute), Wed 18 Nov 2026, America/New_York (EST, UTC-5).

## Approval

- Carter, in the AgentCoin Research chat: "do it, yes", replying to Research's list of testnet items that need his yes. Research quotes the item as "Yes, deploy the x402 judge contract on testnet and register it". The scope is Base Sepolia only, with Arc not approved.
- Not done, as instructed: `executeSlasher`, any push, post, mainnet, Arc, faucet, or Basescan API key.

## Preconditions (all checked before broadcasting)

- Spec reconciliation committed: `5981d9e`. Arbiter source is unchanged since then: `git diff 5981d9e HEAD -- src/arbiter` is empty, and HEAD at deploy time was `48f8e2b`.
- Tests green on `5981d9e`:
  - arbiter unit tests: 24/24 (fuzz 10,000 runs)
  - fork tests: 5/5
  - arbiter-sdk cross-check: 4/4
  - one full suite run: 301 passed, 0 failed, 2 skipped
- Key: loaded inside the forge script from `DEPLOYER_KEY_FILE` (default `.secrets/testnet-deployer.key`). It was never printed or logged. The script asserts `vm.addr(pk) == 0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e`.
- Registry `0x30576DE005df028D1947C56dEcc85a2a5612036a`:
  - `owner()` = `0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e` (the deployer)
  - `slasherTimelock` = 172800 s (48 h)
  - `minStake` = 2e6
- Deployer balance before: **0.000051258353957735 ETH**, nonce 82, gas price 0.006 gwei. No faucet was used.

## Constructor (immutable, no owner)

| param | value |
|---|---|
| escrow | `0xf96815976523E00e65Be8f34cA5e64b4f41EB19c` (AuthCaptureEscrow v1.1) |
| registry | `0x30576DE005df028D1947C56dEcc85a2a5612036a` |
| arbitrator | `0x0` (challenges disabled, AD-015 Phase 0) |
| token | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| maxAmountPerPayment | 1,000,000 (1 test USDC) |
| evalWindow / challengeWindow / rulingWindow / minMarginSeconds | 3600 / 600 / 3600 / 3600 s |
| missedVerdictSlashBps / wrongVerdictSlashBps / materialDiffBps | 1000 / 2500 / 2000 |
| minChallengeBond | 1,000,000 |

Scripts: `script/DeployAuthCaptureArbiter.s.sol` and `script/ProposeArbiterSlasher.s.sol`. Both require chain 84532.

## Deploy

- Dry run: `forge script script/DeployAuthCaptureArbiter.s.sol --skip script/DeployTestnet.s.sol --rpc-url https://sepolia.base.org`, with no broadcast. Estimated gas was 4,552,067, needing up to 0.000050072737 ETH at a 0.011 gwei max fee.
- Broadcast with `--broadcast --slow`:
  - **Arbiter: `0x8b4B3A8c6389a17AA7f66e18F59Afb36Cc9C453A`**
  - tx `0x9deda5ee5a2d71878b96e03be4bf239a509dc600753f23ffd76f99b61da7609b`
  - **block 60,686,016**, 10:31:12 PM EST (timestamp 1795059072), status 1
  - gas 3,501,590 at 0.006 gwei, L1 fee 7,728 wei
  - cost 0.000021009540007728 ETH
- Read-back after deploy: `ESCROW`, `REGISTRY`, `ARBITRATOR`, `TOKEN` and `MAX_AMOUNT_PER_PAYMENT` all match the table above.

## Verification

- Sourcify: **exact_match**, for both creation and runtime bytecode.
  - Verified at 2026-11-19T03:32:03Z, which is 10:32:03 PM EST on 18 Nov.
  - https://repo.sourcify.dev/84532/0x8b4B3A8c6389a17AA7f66e18F59Afb36Cc9C453A
  - Job: https://sourcify.dev/server/verify-ui/jobs/24cba20d-439b-490f-8af2-acfb6089f360
- Basescan: **not verified**. The Etherscan v2 API returns "Missing/Invalid API Key" without a key, so this was skipped as instructed.
  - Unverified page: https://sepolia.basescan.org/address/0x8b4B3A8c6389a17AA7f66e18F59Afb36Cc9C453A

## proposeSlasher (propose only)

- Dry run:
  - `eth_call` of `proposeSlasher(arbiter, true)` from the deployer returned `0x` with no revert.
  - `forge script` simulation estimated 66,827 gas.
- Broadcast:
  - tx `0x346a81e70adc4977580ea0ec2586f230958e25a8194d8725a6e835aa09fa3a58`
  - **block 60,686,194**, 10:31:47 PM EST (timestamp 1795059107), status 1
  - gas 48,383, cost 0.000000290298000094 ETH
- Read-back:
  - `pendingSlasher(arbiter)` = `(true, 1795231907)`
  - `isSlasher(arbiter)` = false
- **eta = 1795231907 = Fri 20 Nov 2026, 10:31:47 PM EST.** `executeSlasher(arbiter)` becomes callable at or after that time. It has **not** been run; Carter will schedule it.

## After

- Deployer balance left: **0.000029958515949913 ETH**
- Total spent: 0.000021299838007822 test ETH.

## executeSlasher (Nov 20 2026)
- tx: 0xef37de760ed5d66890f592e9729cb3493d366375c6fb589532357bb40ccee0e1
- block: 61555628
- status: 0x1
- time: 2026-11-20 10:49:54 PM ET
- isSlasher(0x8b4B3A8c6389a17AA7f66e18F59Afb36Cc9C453A) readback: true
