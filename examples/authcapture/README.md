# Sample authCapture terms (Base Sepolia)

- `terms.base-sepolia.json` is a sample terms object for the deployed AgentKoinAuthCaptureArbiter v0.1
  `0x8b4B3A8c6389a17AA7f66e18F59Afb36Cc9C453A` on AuthCaptureEscrow v1.1 `0xf96815976523E00e65Be8f34cA5e64b4f41EB19c`
  (chain 84532, test funds only). It has two parts: the x402 `outside-verdict` block, and the arbiter-native `Terms` struct
  with its `termsHash`.
- `criteria.json` and `schedule.json` are the committed documents (RFC 8785 bytes). `criteriaHash` and `scheduleHash` are
  their sha256.
- `terms.schema.json` is the JSON Schema (draft 2020-12).
- `build.mts` generates all three files from `arbiter-sdk`. Validation:
  - `arbiter-sdk/test/sample-terms.test.ts`: SDK recompute.
  - `arbiter-sdk/test/crosscheck.test.ts`: the Solidity `termsHash` on anvil.
  - `integrations/python/agentcoin-core/tests/test_arbiter.py`: JSON Schema plus a Python recompute.

What the deployed v0.1 contract does not have:
- `resultDigest` in submit and verdicts
- `verdictBySig`
- the `BuyerAcceptance` record

Those are in the v0.2 source only. On v0.1, the arbitrator is the zero address, so challenges are disabled.
