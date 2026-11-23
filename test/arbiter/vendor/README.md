# Vendored test-only dependencies (unmodified copies)

Used only by `test/arbiter/*` to run the real escrow locally. Nothing here is deployed.

- `commerce-payments/` — https://github.com/base/commerce-payments at commit
  `b748fdd7a830a655a19a530edcf2a94b9dc7d25f` (2026-09-03, v1.1 fee model: absolute `feeAmount`).
  Files: `src/AuthCaptureEscrow.sol`, `src/TokenStore.sol`, `src/collectors/{TokenCollector,ERC3009PaymentCollector,
  ERC6492SignatureHandler,PreApprovalPaymentCollector,OperatorRefundCollector}.sol`, `src/interfaces/{IERC3009,IMulticall3}.sol`.
  License: MIT (`commerce-payments/LICENSE.md`).
- `solady/utils/{ReentrancyGuardTransient,LibClone}.sol` — https://github.com/Vectorized/solady at
  `5ea5d9f57ed6d24a27d00934f4a3448def931415` (the commerce-payments submodule pin). License: MIT.
  Remapped as `solady/=test/arbiter/vendor/solady/` in `foundry.toml`.

Compiled here with this repo's settings (solc 0.8.28, optimizer 200, no via-IR), so bytecode differs from the
canonical deployment (built with via-IR, 100000 runs). Behaviour against the live deployment is covered by
`test/fork/AuthCaptureArbiterFork.t.sol`.
