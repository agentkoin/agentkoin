# AD-010 (proposed): AGC, the agent dollar. Base Sepolia testnet design spec

Status: design only, written 2026-11-15 by AgentCoin Research. Nothing deployed, nothing published.
Approval: Carter, 8:02 AM ET Nov 15 2026, card t96s482: "Yes, design AGC and have Developer build it on Base Sepolia testnet".
Scope: Base Sepolia (chain 84532) only, $0 real value. Mainnet, real USDC, publishing packages, or any public
announcement each need Carter's separate approval and, for mainnet, counsel review first (section 9). Not legal advice.

## 0. Summary
- AGC is one agent dollar: an ERC-20 (6 decimals) minted only by depositing Base Sepolia USDC 1:1 and burned only by
  redeeming 1:1 for USDC. No fee, no admin, no upgrade, no pause, no owner mint, no lending of the reserve.
- The reserve check is on-chain: `USDC.balanceOf(AGC) >= AGC.totalSupply()` is enforced after every wrap and unwrap
  and is readable by anyone at any block.
- AGC implements EIP-2612 `permit` and EIP-3009 (`transferWithAuthorization`, `receiveWithAuthorization`,
  `cancelAuthorization`), using the same function signatures as Circle FiatToken v2.2. That lets the existing
  `EscrowDepositRoute` and standard x402 `exact` clients pay in AGC with no new code paths.
- AGC gets its own `EvaluatorRegistry` (stake in AGC) and `JobEscrow` (pay in AGC, fee 0), deployed from the same
  existing repo bytecode (not externally audited). No change to `JobEscrow.sol` or `EvaluatorRegistry.sol`.
- EURC and any later asset come in through the existing immutable `CrossCurrencySettler`
  (`0x6258D112bf27006287253424a1fa877C607B564a`) unchanged. A new stateless `AGCSettlerAdapter` sits in the
  settler's `escrow` slot, wraps the USDC output into AGC, and opens an AGC escrow job or pays AGC to a wallet.
- In the 402 header, an AGC `exact` entry replaces the USDC `agentcoin-escrow` entry, which stays in the body. The
  estimate is about 5,850 B of 6,144 B (today 5,990 B), so we win back about 140 B of margin instead of spending it.

## 1. What exists today (read from the repo, commit bbf2f9a)
| Piece | Address / file | Relevant facts |
|---|---|---|
| Test USDC (Circle FiatToken) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | 6 decimals; EIP-712 name "USDC", version "2"; EIP-3009 incl. `bytes signature` overloads |
| EURC (Circle) | `0x808456652fdb597867f38412077A9182bf77359F` | 6 decimals; EIP-3009 |
| JobEscrow (USDC) | `0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D` | `IERC20 public immutable token`; `createAndFundFor(client, provider, evaluator, amount, deadline, specHash)`; jobIds start at 1 (`++jobCount`); live config `feeBps 0`, `evaluatorFeeBps 0` (read from the v0.5.12 402 fixture) |
| JobEscrow (EURC) | `0x17349D60efD6469Fd399F807c644Ce0a92798516` | same bytecode; `executeSlasher` after Nov 17 12:12 AM ET |
| EvaluatorRegistry | `0x30576DE005df028D1947C56dEcc85a2a5612036a` | `token` immutable (USDC); constructor takes an initial slasher list; later slasher changes need a 48 h timelock; minStake 2 USDC on testnet |
| EscrowDepositRoute factory | `0x32174eFD01e600E621Cf3f0D19Ff694483B19b95` | factory `token` and `escrow` immutable; route = CREATE2 address per offer; route `settle` calls `token.transferWithAuthorization(..., bytes signature)` |
| CrossCurrencySettler | `0x6258D112bf27006287253424a1fa877C607B564a` | immutable, no fee, router SwapRouter02; in escrow mode it approves `q.escrow` for `amountOut` and calls `q.escrow.createAndFundFor(buyer, recipient, evaluator, amountOut, now+deadlineSeconds, specHash)`; requires `evaluator != 0` and `deadlineSeconds != 0` in escrow mode |
| Service | agentcoinhq.com v0.5.14, `agent/service/app.mjs` | 402 `accepts = [exact USDC (payTo = route 0x6A32…84f), agentcoin-escrow USDC, agentcoin-swap EURC]`; `headerPR()` slims the header copy; all response headers are 5,990 B against a 6,144 B budget |

Consequence: an AGC stack can reuse every existing contract as-is (new instances where the token is immutable).
The only new Solidity is `AGC.sol` and `AGCSettlerAdapter.sol`.

## 2. Contract: `src/AGC.sol`
### 2.1 Identity
- `name()` "AgentCoin Dollar", `symbol()` "AGC", `decimals()` 6. EIP-712 domain `{name: "AgentCoin Dollar",
  version: "1", chainId, verifyingContract}`. The name is open question Q1, and it must be final before deploy
  because the EIP-712 domain is immutable.
- Constructor: `constructor(IERC20 usdc_)`, which stores `USDC` as immutable. It checks `usdc_.decimals() == 6`. There
  are no other constructor arguments and no owner.
- Base: OpenZeppelin `ERC20` + `ERC20Permit` (already in `lib/`), plus a local `EIP3009` module (OZ has none).

### 2.2 Wrap (mint) and unwrap (burn). These are the only supply changes.
| Function | Behavior |
|---|---|
| `wrap(uint256 amount)` | `USDC.safeTransferFrom(msg.sender, this, amount)`; the balance delta must equal `amount` (else revert `PullMismatch`); `_mint(msg.sender, amount)` |
| `wrapTo(address to, uint256 amount)` | Same as `wrap`, but mints to `to` (used by the adapter and by agents funding another agent) |
| `wrapWithPermit(amount, deadline, v, r, s)` | `USDC.permit(msg.sender, this, amount, deadline, v, r, s)` wrapped in try/catch (front-run-safe pattern), then `wrap` |
| `wrapWithAuthorization(from, value, validAfter, validBefore, nonce, bytes signature)` | `USDC.receiveWithAuthorization(from, this, value, ..., signature)`; mints **to `from` only**. The USDC signature does not bind a mint recipient, so a relayer must never be able to choose it. This gives a one-signature, gasless wrap that a relayer can submit |
| `unwrap(uint256 amount)` | `_burn(msg.sender, amount)` **then** `USDC.safeTransfer(msg.sender, amount)` |
| `unwrapTo(address to, uint256 amount)` | Burns from `msg.sender`, pays `to` |
| `unwrapWithAuthorization(from, to, value, validAfter, validBefore, nonce, bytes signature)` | EIP-712 `UnwrapWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)` signed by `from`; shares the EIP-3009 nonce space; burn then pay `to`. This gives gasless redemption, so "always redeemable" does not depend on the holder having ETH |

- There is no fee on any of these, and no minimum or maximum beyond `amount > 0`.
- Reserve guard: at the end of every wrap and unwrap, `if (USDC.balanceOf(this) < totalSupply()) revert
  ReserveShortfall(balance, supply)`. This costs about 2.6k gas. It cannot fail through AGC logic. It exists so that
  any outside USDC behavior change (fee-on-transfer, upgrade) halts minting loudly instead of creating an
  unbacked supply.
- No other `_mint` call site exists. A test asserts this by grepping the source and checking the bytecode selectors.

### 2.3 Transfers and authorizations
- Standard ERC-20 `transfer`, `transferFrom`, `approve`, and EIP-2612 `permit`, `nonces`, `DOMAIN_SEPARATOR`.
- EIP-3009, matching FiatToken v2.2 so existing callers work unchanged:
  - `transferWithAuthorization(from,to,value,validAfter,validBefore,nonce,v,r,s)` and the `bytes signature`
    overload, which `EscrowDepositRoute` calls.
  - `receiveWithAuthorization(...)` (both overloads), with the extra rule `msg.sender == to`. The settler and the
    adapter rely on it.
  - `cancelAuthorization(authorizer, nonce, v,r,s)` (both overloads), `authorizationState(authorizer, nonce)`.
  - Typehashes byte-identical to FiatToken (`TransferWithAuthorization(...)`, `ReceiveWithAuthorization(...)`,
    `CancelAuthorization(address authorizer,bytes32 nonce)`).
  - Signature check via OZ `SignatureChecker`, so EOAs and ERC-1271 smart wallets both work.
- `to == address(this)` on any transfer reverts `UseUnwrap()`, so nobody can strand AGC in the contract.

### 2.4 Views (proof of reserve)
`reserve()` = `USDC.balanceOf(this)`; `surplus()` = `reserve() - totalSupply()`; `isFullyBacked()` = `reserve() >=
totalSupply()`; `backing()` returns `(reserve, supply)` in one call. Any USDC sent directly to the contract becomes
permanent surplus. With no admin, nobody can sweep it. That is acceptable on testnet and documented.

### 2.5 What AGC deliberately does not have
There is no owner, no `Ownable`, no proxy or upgrade, no pause, no blacklist or freeze, no fee switch, no
`rescueERC20`, no lending, staking, or investment of the reserve, no rebasing, and no interest or rewards for
holding (see the yield prohibition in 9.1). The trust model is "read the bytecode and the USDC balance." Mainnet
might need compliance hooks such as a sanctions freeze. That is a counsel question (Q5), and on mainnet it would be
a new contract, not an upgrade.

### 2.6 Risks that remain (disclosed, not solved)
- **Circle controls USDC.** USDC is an upgradeable proxy with a blacklist. If Circle blacklisted the AGC contract or
  changed USDC, the reserve could be frozen and unwraps would fail. AGC can only be as redeemable as USDC itself.
- **Testnet USDC has no value.** Testnet AGC has none either, and every surface must say so.

## 3. AGC escrow stack (same bytecode, new instances)
Deploy in one script (`script/DeployAGC.s.sol`). Precompute addresses with `vm.computeCreateAddress` so the
registry can name the escrow and the adapter as initial slashers. That avoids the 48 h `proposeSlasher`/
`executeSlasher` wait that the EURC escrow has.
1. `AGC(USDC)`.
2. `EvaluatorRegistry(token = AGC, config = live registry config (minStake 2e6, unbonding 7 d, multiplier 5,
   harmedShare 5000, treasury 0x78e2…488e), owner 0x78e2…488e, initialSlashers = [predicted JobEscrowAGC],
   slasherTimelock 172800)`.
3. `JobEscrow(token = AGC, registry = AGC registry, treasury 0x78e2…488e, arbitrator 0x3C4587eD99B1969581cA4f041FD9535a0D269736
   (MockArbitrator, testnet), config = live USDC escrow currentConfig() with feeBps = 0 and evaluatorFeeBps = live value,
   owner 0x78e2…488e)`.
4. `EscrowDepositRouteFactory(token = AGC, escrow = JobEscrowAGC, owner, live route-factory config, keepers =
   [0x78e2…488e])`. The notary's AGC `exact` payTo is `factory.routeFor(notaryOffer)`.
5. `AGCSettlerAdapter(AGC, JobEscrowAGC)` (section 4).
Evaluator: the notary evaluator `0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a` wraps at least 2 test USDC and stakes it in the AGC
registry. Its USDC stake in the old registry is untouched, so the USDC path keeps working.
Slashes for AGC jobs are paid in AGC. That gives a single-currency accounting loop, unlike the EURC escrow, which
slashes in USDC.

## 4. Other assets in: `src/AGCSettlerAdapter.sol` (stateless, no owner)
The live settler is immutable, and its escrow mode only calls `createAndFundFor` on whatever `q.escrow` the buyer
signed. The adapter implements that interface:
```
function createAndFundFor(address client, address provider, address evaluator, uint256 amount,
                          uint64 deadline, bytes32 specHash) external returns (uint256 jobId)
  USDC.safeTransferFrom(msg.sender, this, amount)          // settler approved exactly amountOut
  AGC.wrapTo(this, amount)                                 // 1:1
  if (evaluator == address(this)) {                        // "convert" mode: EURC -> AGC into a wallet
      AGC.transfer(provider, amount); return 0;             // provider = recipient wallet (may be the buyer)
  }
  AGC.forceApprove(escrowAGC, amount)
  jobId = escrowAGC.createAndFundFor(client, provider, evaluator, amount, deadline, specHash)
  AGC.forceApprove(escrowAGC, 0)
```
- The buyer's EIP-3009 signature covers `quoteHash(q)`, which includes `q.escrow` (= adapter), `recipient`,
  `evaluator`, and `minOut`. A relayer therefore cannot switch modes or recipients.
- The adapter holds nothing between transactions. Anyone may call it, but a call without a USDC approval reverts.
- `minOut` stays denominated in USDC units, which equal AGC units (1:1, both 6 decimals).
- The swap-failure refund path is unchanged: the settler refunds EURC to the buyer before the adapter is ever called.
- Convert mode: the quote sets `evaluator = adapter` and any nonzero `deadlineSeconds` (both required by the settler; ignored by the adapter).
- jobId 0 means "convert, no job". This is unambiguous because `JobEscrow` ids start at 1.
- The free `/v1/quote` gains `to=AGC`: it quotes EURC→USDC on the same pool and reports an identity step USDC→AGC
  (`rateSource.kind: "uniswap-v3-quoterv2+agc-wrap-1:1"`).
- Future assets: any token with a Uniswap v3 pool against USDC and EIP-3009 works with zero contract changes. Tokens
  without EIP-3009 would need a permit-based settler v2, which is out of scope.

## 5. Why an agent would hold AGC instead of plain USDC
| Utility | Mechanism | Honest note |
|---|---|---|
| One balance for everything | EURC (and later assets) convert to AGC at payment time via the settler and adapter; providers receive AGC; evaluators stake AGC; slashes and refunds come back in AGC | This is the real value. It removes per-asset escrows from the agent's view |
| Zero protocol fee | `JobEscrowAGC.feeBps = 0`, pinned per job at creation | The live USDC escrow is **also** at 0 today, so the "discount" is only real if the USDC fee is raised later (Q3). Charging fees also weakens the money-services analysis (MULTI_ASSET_SPEC F6) |
| Native escrow and gasless payment | Permit plus EIP-3009 on AGC; the relayer pays gas on testnet; `wrapWithAuthorization` and `unwrapWithAuthorization` are gasless | USDC already has EIP-3009. The gain here is wrap, unwrap, and redeem without ETH |
| Evaluator staking in AGC | AGC registry; evaluator fees (if ever above 0) and slashes all in AGC | Needs evaluators to wrap; this is a one-time step |
| Receipts and reputation | See below | Off-chain index of on-chain events; no new token |

**Receipts.** The notary receipt `agentcoin-notary/v1` and its `responseSchemaHash` (sha256:1f66a3f2…4586) stay
byte-identical. The paid response and PAYMENT-RESPONSE carry `agentcoin.payment` (already pending for USDC and EURC
on `GET /v1/notarize/{id}`) with `{scheme, paid{symbol,asset,amount}, received{symbol:"AGC",asset,amount,into:jobId},
escrow, settleTx, quoteId?}`. Because the field is outside the receipt, the schema hash does not change.

**Reputation.** A free `GET /v1/reputation/{address}` built from on-chain events of all AgentCoin escrows (USDC,
EURC, AGC). It reports jobs as client, provider, and evaluator, outcomes (Completed, Partial, Rejected, Expired,
Disputed), settled volume per asset, slashes, and the first and last block. Every number links to a tx hash so an
agent can verify it. AGC-settled volume is shown as the headline unit (1 AGC = 1 USD-equivalent on testnet). Whether
reputation should count **only** AGC jobs is Q4. I recommend against it, since excluding USDC history would be
artificial and easy to see through.

**Agent-native growth loops (no yield, no points-for-holding):**
1. AGC listed first in `accepts[]`, gated on the client-selection check in 6.3.
2. A closed loop: providers paid in AGC spend AGC on the next 402 without unwrapping, so every AGC payment seeds
   another AGC payer.
3. The receipt carries a free hint: `agentcoin.next: {payIn: "AGC", wrap: "<AGC address>", wrapGasless: true}`. It is
   one small field in the body only, not in the header.
4. A free `GET /v1/agc` (reserve proof: reserve, supply, surplus, block, contract, USDC) and an entry in
   `/.well-known/agentcoin-trust.json`. Agents and graders can check backing without trusting us.
5. MCP and SDK tools make AGC the default pay asset when the agent holds it (section 7), with a fallback to USDC.
6. The x402-escrow-hint extension and the bazaar listing add AGC as a second asset. Discovery listings keep USDC
   first (6.4) so the UltravioletaDAO listing does not break.

## 6. x402 / 402 changes (POST /v1/notarize)
### 6.1 Body `accepts[]` (full entries)
Target order (with `AGC_FIRST=1`):
`[exact AGC, exact USDC, agentcoin-escrow USDC, agentcoin-swap EURC→AGC]`
- **New entry 0, `exact` AGC:** same shape as `exactRequirements()`, but `asset` = AGC, `payTo` =
  `agcRouteFactory.routeFor(notaryOffer)`, `extra.name` "AgentCoin Dollar", `extra.version` "1",
  `extra.agentcoin.escrowContract` = JobEscrowAGC, `depositRouteFactory` = AGC factory, `feeBps 0`, plus
  `extra.agentcoin.backing: "USDC 1:1, see /v1/agc"`. Implement it as a new `agcExactRequirements()`.
  **`exactRequirements()` and `escrowRequirements()` stay byte-identical** (the existing source-unchanged test keeps
  passing).
- **agentcoin-swap entry:** `extra.settlement.escrowContract` changes from the USDC escrow to `AGCSettlerAdapter`, and
  `extra.quote.tokenOut` becomes AGC (minOut 10000 unchanged). EURC payers' jobs then open in AGC. Keep a flag
  `AGC_SWAP_OUT=0` to fall back to the v0.5.14 USDC-out entry.
- If AGC is not configured (`AGC_ADDRESS` unset), the 402 is exactly v0.5.14. That is the rollback.

### 6.2 PAYMENT-REQUIRED header (6,144 B budget)
Exact change: in `headerPR()`, the header copy of `accepts[]` becomes
`[exact AGC (slim), exact USDC (unchanged), agentcoin-swap (slim, unchanged shape)]`.
- The **`agentcoin-escrow` USDC entry is removed from the header** (it stays complete in the body). `bodyOnly` gains
  `"accepts.agentcoin-escrow"`. Rationale: it is a non-standard scheme that only AgentCoin-aware clients use, and
  those clients read the body anyway.
- The **slim AGC exact entry** in the header drops `responseSchemaUrl` (already top-level), `spec`, `payToKind`,
  `trustManifestUrl`, `evaluatorStake`, `evaluatorActive`, and `evaluatorFeeBps`. It keeps everything a standard
  x402 exact client needs to sign: scheme, network, amount, asset, payTo, maxTimeoutSeconds, name, version,
  assetTransferMethod, responseSchemaHash, plus `agentcoin.{depositRouteFactory, escrowContract, offer, feeBps,
  relayerPaysGas, backing}`.
- Measured with the v0.5.12 fixture shapes (python, compact JSON): the USDC escrow entry is 938 B of JSON (~1,250 B
  base64); the slim AGC exact entry is 807 B of JSON (~1,076 B base64); the bodyOnly addition is +27 B of JSON.
  The net change is about −104 B of JSON, or about **−139 B of header**. The estimate is ~5,850 B against 6,144 B
  (margin ~290 B, up from 154 B). This is an estimate; the acceptance test measures the real headers.
- Test: extend `agent/test/multiasset.test.mjs` "all response headers…" to the v0.5.14 live headers plus AGC, with
  the assertion `total <= 6144 - 256`, so we keep at least 256 B of margin, and fail CI otherwise.

### 6.3 AGC-first ordering (gated)
Many x402 clients pick the first `accepts[]` entry whose scheme and network they support, and **they may not check
the asset balance** (uncertain; varies by client and version, so it must be verified). An agent holding only USDC
could then try AGC and fail. Before turning on `AGC_FIRST=1`:
- Test our own `agent/x402/pay-client.mjs`, `integrations/x402-fetch`, and `integrations/agentkit` with a USDC-only
  wallet and an AGC-only wallet. Each must pick a payable entry. Fix our clients to select by balance.
- Record what the reference x402 client's default selector does (read the source; do not assume). If it would pick
  AGC blindly, ship with `AGC_FIRST=0` (AGC second, after exact USDC) and report it. Carter decides on flipping it
  (Q2).

### 6.4 Unchanged on purpose
`/discovery/resources` and `/facilitator/supported` keep USDC `exact` only, plus AGC as an additional `kinds` entry
for our facilitator. The bazaar `accepts` in the agent card adds AGC second. The USDC route payTo
`0x6A32bC3Bb5eA1dc814f14E29e6f026535129A84f` and amount `10000` are unchanged, so third-party listings
(UltravioletaDAO) and graders keep working.

### 6.5 Settlement for AGC exact
Same code path as USDC exact (`EscrowDepositRoute.settle`), parameterized by token. The verify step reads
`AGC.authorizationState` and `AGC.balanceOf`, and `findUsdcTransferToRoute` is generalized to the token. The relayer
pays gas as today, and the caps and budget logic are unchanged.

## 7. Staged plan for Developer
Each stage ends with a short report to Research. Do not start a stage that needs something not approved here.

**Stage 1. Contracts (local only).** `src/AGC.sol`, `src/AGCSettlerAdapter.sol`, `script/DeployAGC.s.sol`.
Solidity 0.8.28 and the OZ already vendored in `lib/`. Run `forge fmt` and `forge build` with no warnings.

**Stage 2. Tests (Foundry, local and fork).**
- Unit: wrap/wrapTo/wrapWithPermit/wrapWithAuthorization (mint goes to `from` even when a relayer submits);
  unwrap/unwrapTo/unwrapWithAuthorization; permit; both 3009 transfer overloads plus receive (`msg.sender == to`)
  plus cancel; nonce reuse reverts; expired and not-yet-valid authorizations revert; ERC-1271 wallet signature;
  transfer to `address(this)` reverts.
- No-admin proof: the selector list in the compiled ABI contains no `owner`, `pause`, `mint` (other than via wrap),
  `upgrade`, `rescue`, `blacklist`, or `set*`. `cast code` shows no proxy pattern.
- Invariant test (`test/invariant/AGCInvariant.t.sol`): `USDC.balanceOf(agc) >= agc.totalSupply()` and `sum of
  balances == totalSupply` under random wrap, unwrap, transfer, authorization, and donation handlers. Fuzz over
  amounts up to 2^128.
- Reserve guard: a mock fee-on-transfer USDC makes `wrap` revert (`PullMismatch`), not mint.
- Integration on fork (Base Sepolia fork, real USDC/EURC/Uniswap): AGC exact through a new route opens a job in
  JobEscrowAGC with fee 0; EURC→AGC via the live settler plus adapter (escrow mode and convert mode); swap failure
  refunds EURC; evaluator stakes AGC, and `timeoutRelease` slashes in AGC to the provider; `claimRefund` returns AGC.
- Service (node): 402 shape tests (6.1), the header budget test (6.2), the "exactRequirements/escrowRequirements
  unchanged" test still green, an AGC-unset rollback test (402 == v0.5.14), and the client-selection tests (6.3).

**Stage 3. Testnet deploy (Base Sepolia, $0).** Check deployer test-ETH first. The estimate is about 10M gas for five
contracts (in the same range as AD-009's 5.2M for two) at ~0.006 gwei, about 0.00006 test ETH; report the actual
estimate before broadcasting. Verify on Sourcify. Write `deployments/base-sepolia-agc.json` (addresses, txs, blocks,
gas, constructor args, source commit). Wrap a small amount of existing test USDC for the evaluator stake and the
demo wallets. If test USDC runs short, the Circle faucet is a human captcha step; ask Research and do not work
around it.

**Stage 4. Service integration (v0.5.15).** Env: `AGC_ADDRESS`, `AGC_ESCROW`, `AGC_ROUTE_FACTORY`, `AGC_ADAPTER`,
`AGC_FIRST` (default 0 until 6.3 passes), `AGC_SWAP_OUT` (default 1). Add `agcExactRequirements()`, the swap entry's
escrow → adapter, `headerPR()` per 6.2, `GET /v1/agc`, `/v1/quote?to=AGC`, `agentcoin.payment` on AGC payments and on
`GET /v1/notarize/{id}`, `GET /v1/reputation/{address}`, and a trust manifest entry. Same droplet pattern as v0.5.14:
back up, rename to `agentcoin-testnet-0.5.14`, run, and roll back by unsetting `AGC_ADDRESS` or restoring the
container. Live tests: one AGC exact payment, one EURC→AGC payment, one forced swap refund, one wrap, and one unwrap
from a demo wallet. Tag all of them as internal in traction stats.

**Stage 5. MCP and plugin updates (build and test only; publishing waits for Carter's tokens and approval).**
`agent/mcp/tools.mjs` and `integrations/mcp` add the tools `agc_balance`, `agc_wrap`, `agc_unwrap`, `agc_reserve`, and
`pay_402` (prefer AGC if the balance covers it, else USDC, else EURC swap). Extend `agent/x402/pay-client.mjs`,
`integrations/core-ts`, `x402-fetch`, `agentkit`, `langchain-js`, `openai-agents-js`, `vercel-ai`, and `python` with
balance-aware accept selection and an AGC asset constant. Add AGC to `docs/QUICKSTART-AGENTS.md` and
`docs/DEPLOY-TESTNET.md`. **No npm or PyPI publish, no MCP registry update, and no public posts** under this approval.

### 7.1 Acceptance criteria (Research verifies each on-chain or live)
1. `AGC.USDC() == 0x036CbD53842c5426634e7929541eC2318f3dCF7e`, `decimals() == 6`; Sourcify exact match; the ABI has no
   admin selectors (2.5); `eth_getStorageAt` at the EIP-1967 slots is 0.
2. At the deploy block and at every later check, `USDC.balanceOf(AGC) >= AGC.totalSupply()` (`cast call` both at
   the same block).
3. Wrap tx: a USDC `Transfer(wallet→AGC, X)` and an AGC `Transfer(0x0→wallet, X)` in the same tx. Unwrap tx: an AGC
   `Transfer(wallet→0x0, Y)` and a USDC `Transfer(AGC→wallet, Y)`. Gasless wrap tx: the submitter differs from
   `from`, and the mint goes to `from`.
4. AGC exact payment: the AGC route's `settle` tx emits `JobFunded` on JobEscrowAGC with client = payer and amount
   10000. On settlement the fee paid to the treasury is 0.
5. EURC→AGC payment: one tx with `CrossCurrencySettled(tokenOut = USDC)`, a USDC transfer settler→adapter→AGC, an AGC
   mint to the adapter, and `JobFunded` on JobEscrowAGC. A forced swap-failure tx shows `SwapFailedRefunded` with
   EURC returned to the buyer and no AGC minted.
6. The AGC registry lists JobEscrowAGC as a slasher at deploy (no timelock wait), and the notary evaluator's
   `stakeOf` ≥ minStake in AGC.
7. Live 402: the body and header follow 6.1/6.2; the USDC exact entry is byte-identical to v0.5.14 except for its
   index; total response headers ≤ 5,888 B (6,144 − 256); `/discovery/resources` is unchanged.
8. `GET /v1/agc` reserve and supply match `cast call` at the reported block. `GET /v1/notarize/{id}` shows
   `agentcoin.payment` for AGC, EURC, and USDC jobs.
9. `forge test` and the node test suite pass in the image before deploy (same as v0.5.14).

## 8. Out of scope (needs separate approval)
Mainnet or any real-value USDC; a protocol fee on anything; any incentive, reward, points, or yield for holding AGC;
adding a sanctions freeze, admin, or upgradeability; a public AGC launch post or token listing; publishing SDKs;
a Uniswap AGC pool. A pool is unnecessary, since AGC is redeemable 1:1, and a pool would invite price deviation.

## 9. Legal and risk (for counsel; not legal advice; uncertain items marked)
Why testnet only: AGC is structurally a token redeemable 1:1 for dollars, deployed by STOS Technologies LLC. On
mainnet, several regimes could treat STOS as an issuer, a money transmitter, or an EU service provider. Test USDC
has no value, and we believe a testnet-only token with no monetary value is outside these regimes. **That belief is
unverified; counsel should confirm it.**

### 9.1 GENIUS Act (US payment stablecoins)
- Enacted July 18, 2025 as Pub. L. 119-27 (12 U.S.C. 5901 and following). Verified 2026-11-15 against
  uscode.house.gov and the OCC bulletin 2026-50 final rule page. Generally effective **January 18, 2027** (the
  earlier of 18 months after enactment or 120 days after final regulations; the OCC states January 18, 2027).
- It generally prohibits anyone other than a permitted payment stablecoin issuer from issuing a payment stablecoin
  in the US, and it restricts digital asset service providers from offering non-permitted ones to US persons (per
  the OCC bulletin summary).
- Issuers may not pay holders interest or yield solely for holding, using, or retaining the stablecoin (12 U.S.C.
  5903, "Prohibition on interest"). The AGC design pays nothing for holding. The "zero fee when paying in AGC"
  discount is a price for a service rather than yield, but **whether a fee discount tied to the currency counts as
  "consideration … in connection with use" is uncertain** (Q3).
- **Open legal question (uncertain):** is a fully on-chain, admin-less wrapper backed 1:1 by a permitted issuer's
  stablecoin (USDC) itself a "payment stablecoin" with STOS as its "issuer"? The redemption promise is enforced by
  code, not by STOS, but STOS deployed it and markets it. Wrapped-token treatment, and whether OCC or state rules
  address it, is for counsel.
- The OCC final rule (Oct 21, 2026, per the secondary summary from Sheppard) sets reserve, redemption (generally 2
  business days), and capital ($5M floor) requirements for issuers. If AGC were deemed issued by STOS, those would be
  out of reach for STOS today. This is the main reason the mainnet path may instead be "AGC = an interface over USDC"
  or not issuing a token at all.

### 9.2 Money transmission (US)
- FinCEN's 2019 CVC guidance (FIN-2019-G001) addresses when convertible virtual currency business models are money
  transmission. Our understanding is that it treats anonymity-enhanced and unhosted-wallet software differently from
  custodial models; **verify the exact positions with counsel**. State money transmitter licensing varies by state.
- Relevant facts for counsel: AGC never lets STOS hold or redirect reserve funds. The relayer (an STOS key) submits
  users' signed authorizations. JobEscrow owner powers (config, arbitrator) apply to future jobs. The adapter is
  stateless. These are MULTI_ASSET_SPEC flags F1–F4 and F7, which now apply to AGC too.
- Sanctions: OFAC obligations apply on mainnet regardless. An admin-less AGC cannot freeze sanctioned holders. That
  is a design tension for counsel (Q5).

### 9.3 MiCA (EU)
- Under MiCA, a token that references a single official currency is an e-money token (EMT). Offering EMTs to the
  public in the EU generally requires the issuer to be a credit institution or an e-money institution, and EURC is
  treated as an EMT (stated in MULTI_ASSET_SPEC F5). **Whether a USD-referenced wrapper of USDC deployed by a US LLC
  is an EMT offered in the EU, and whether CASP authorization is needed for the EURC→AGC conversion, is uncertain.**
  No article numbers are cited here on purpose; counsel should supply them.

### 9.4 Securities and naming (uncertain)
1:1 redemption, no yield, and no expectation of profit point away from a security. We recall an SEC staff statement
in 2025 on "covered stablecoins" along these lines, **unverified**. The word "Dollar" in the token name, and calling
AGC a "stablecoin" in marketing, may have legal and trademark implications (Q1). Until counsel reviews, public copy
should describe AGC as a "testnet token, redeemable 1:1 for test USDC."

### 9.5 Technical risks
Circle freeze or upgrade of USDC (2.6); bugs in the custom EIP-3009 module (mitigated by tests, the invariant fuzz,
and byte-matching FiatToken typehashes; an external audit before any mainnet); relayer key compromise (it can only
submit user-signed authorizations, and on testnet the caps limit gas spend); header growth (CI margin test, 6.2).

## 10. Open questions for Carter
- **Q1 Name:** "AgentCoin Dollar" (AGC), or plain "AgentCoin" (AGC)? This is locked at deploy (EIP-712 domain).
  Counsel may dislike "Dollar."
- **Q2 AGC first:** after the client-selection check, list AGC before USDC in `accepts[]` (more AGC adoption, with
  some risk that naive clients pick AGC without holding it), or keep USDC first?
- **Q3 Fees:** USDC escrow is already at 0% protocol fee, so "zero fee in AGC" is only a real advantage if USDC jobs
  get a fee later. Keep everything at 0 on testnet (recommended), or plan a USDC fee? A fee also raises legal risk.
- **Q4 Reputation:** count all escrow jobs (recommended), or only AGC-settled jobs?
- **Q5 Mainnet direction (for later, via Doodle and counsel):** admin-less AGC with no freeze (purest, harder on
  sanctions), AGC with a compliance freeze, or no AGC token on mainnet and USDC with AGC features only.
