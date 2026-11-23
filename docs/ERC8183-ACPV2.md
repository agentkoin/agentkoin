# ERC8183EvaluatorAdapter vs ERC-8183 / Virtuals ACP v2 (local, untested on any network)

Sources (read-only, 2026-11-18):
- ERC-8183 draft: https://eips.ethereum.org/EIPS/eip-8183 ; source ethereum/ERCs `ERCS/erc-8183.md`, last commit on that path a078cab5cc8e9581c15f76c091ed96eed28f02f7 (2026-03-13).
- Virtuals ACP v2.0 changelog (April 2026, "reference implementation of ERC-8183", hooks replace memos, `hookAddress`): https://whitepaper.virtuals.io/acp/acp-changelogs ; overview https://os.virtuals.io/acp/overview/
- ACP v2 SDK: https://github.com/Virtual-Protocol/acp-node-v2
- Virtuals' deployed Solidity was NOT found/read; the in-EIP reference `AgenticCommerce` / `AgenticCommerceHooked` is the stand-in.

## Already compatible (unchanged)
`getJob` struct (incl. `hook`), `JobStatus` enum, `paymentToken()`, `complete/reject(jobId, bytes32 reason, bytes optParams)`, evaluator-fee forwarding, claimRefund-after-expiry liveness handling.

## Changes
1. `IACPHook` + `ACPSelectors` (src/interfaces/IACPHook.sol), per EIP "Hooks".
2. Adapter implements `IACPHook` + ERC-165. If named as the kernel job's `hook`, `afterAction(submit)` starts the eval window at the real submission (no keeper). Never reverts, no-op for other selectors, keyed by `(msg.sender kernel, jobId)`, failures swallowed (a reverting hook would block the provider's submit). Optional: `noteSubmission()` still works.
3. Event `KernelHookObserved(id, hook, hookIsAdapter)` at assign.
4. `MockACPv2Kernel` (hooked, whitelist, ERC-165 check, hook gas cap, data = `abi.encode(msg.sender, ...)`) and test/AdapterACPv2.t.sol (17 tests). `MockERC8183Kernel` kept.

## Follow-up (2026-11-18)
- **Hook policy:** `assign` reverts `ForeignHookNotAllowed(hook)` unless the kernel job's `hook` is `address(0)` or the adapter itself. Reason: a third-party hook can revert `complete`/`reject` and strand a verdict. Breaking for anyone who assigned third-party-hooked jobs (none exist; nothing deployed). Previously the adapter ended in `KernelCallFailed` in that case.
- **Payment token is per deployment:** the adapter's `token` (immutable, constructor arg, also `acceptedToken()`) is the only token for stake, bonds and the kernel job; `assign` reverts `TokenMismatch` for any other `paymentToken()`. One adapter instance (with its own registry/escrow) per chain+token. Per-kernel multi-token was rejected: stake and bonds are held in `token`, so mixing tokens would break accounting.
- **Virtuals Base Sepolia USDC, verified from source:** `0xECc22a8F6fD62388498fBa19813E214605a2BDb3` = `USDC_ADDRESSES[baseSepolia.id]` in Virtual-Protocol/acp-node-v2 @392dcc6 `src/core/constants.ts` (https://github.com/Virtual-Protocol/acp-node-v2). Same file: ACP core on Base Sepolia `0x0b93793923CD5De81850aF8604a233f3f24d461e`, FundTransferHook `0xbbeC2c985F9483473B9e0Da0704395943034266B`. Not verified on-chain by me (no RPC call made); its decimals are assumed 6 and `DeployTestnet` checks `decimals()==6` at deploy time.
  Ours: Circle `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (https://docs.base.org, Circle USDC page).
- **Deploy script:** `DeployTestnet.s.sol` picks the token via `USDC=<addr>` (wins), else `TOKEN_PROFILE=virtuals` (Virtuals USDC), else Circle. It deploys the whole stack in that token. No deployment was run.

## Spec/reference discrepancies found
- EIP text: `fund(jobId, expectedBudget, optParams)`; EIP reference code: `fund(jobId, optParams)`. Adapter never calls fund; mock has both.
- Hook `data`: EIP table = `abi.encode(reason, optParams)`; reference code = `abi.encode(msg.sender, reason, optParams)`. Adapter does not decode `data`.
- Reference code: setBudget provider-only; EIP text: client or provider. Reference `fund` fails at `expiredAt`.
- `JobCreated` includes `hook` in code, not in the EIP event list.

## Breaking changes
None to existing external functions/events. Additive: new functions (beforeAction, afterAction, hookNoteSubmission, supportsInterface), new event, new contract bytecode (redeploy needed to get it; nothing deployed).

## Open
- Real Virtuals ACP v2 contract addresses/ABI (Base Sepolia 84532) unverified; selectors depend on the exact kernel signatures.

- Kernel may require hooks to be admin-whitelisted: adapter would need whitelisting by Virtuals.
