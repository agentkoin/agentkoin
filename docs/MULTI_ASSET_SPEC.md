# AD-009 Phase 1: multi-stablecoin payments (USDC + EURC), Base Sepolia testnet

Status: built and tested locally on 2026-11-15. Testnet only (chain 84532). No mainnet, no real value. Not legal advice.

## 1. Research (read-only, 2026-11-15)

| Item | Value | Source / check |
|---|---|---|
| EURC (Base Sepolia) | `0x808456652fdb597867f38412077A9182bf77359F` | https://developers.circle.com/stablecoins/eurc-contract-addresses (Testnet table). `eth_getCode` 1,798 bytes (FiatToken proxy); `symbol()` EURC, `decimals()` 6, EIP-712 `name()` EURC, `version()` "2"; has `RECEIVE_WITH_AUTHORIZATION_TYPEHASH` (EIP-3009). |
| USDC (Base Sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | https://developers.circle.com/stablecoins/usdc-contract-addresses |
| Uniswap v3 factory / QuoterV2 / SwapRouter02 | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` / `0xC5290058841028F1614F3A6F0F5816cAd0df5E27` / `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4` | https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments; all three have code |
| EURC/USDC pools | fee 100: none, **fee 500: `0x43047A302cD99DDb32E32B2886B40935b60aD2C1`**, fee 3000: none, fee 10000: none | `factory.getPool` |
| Pool state (block ~58,983,124) | token0 USDC, token1 EURC; `liquidity()` 41,850,398,495; `slot0.tick` -174 (≈1.0177 USDC per EURC); balances 306.63 EURC / 815.56 USDC; unlocked | `eth_call` |
| QuoterV2 | 0.01 EURC → 0.010169 USDC; 1 EURC → 1.016975 USDC; exactOut 0.01 USDC needs 0.009833 EURC | `eth_call` |

**Decision: real Uniswap v3 (SwapRouter02, 0.05% pool), not a mock.** The pool exists, is initialized, and has
enough depth for notary-sized payments (0.01) with <0.1% price impact. Caveats recorded in every quote's
`rateSource.note`: the price is set by testnet liquidity providers and is not a reference FX rate; depth is ~300 EURC,
so large amounts would move the price. `MockSwapRouter` (owner-set rate, own mock liquidity, labeled TEST ONLY) is
built and used in the Foundry unit tests and is the documented fallback if the pool becomes unusable
(`MULTIASSET_ROUTER_KIND=mock`, `MULTIASSET_ROUTER=<mock>`); it is not deployed.

## 2. Contracts

### 2.1 Multi-asset escrow
`JobEscrow` was already token-parameterized (`IERC20 public immutable token`). Multi-asset escrow = one `JobEscrow`
instance per asset, same bytecode, same registry / treasury / arbitrator / owner. No change to `JobEscrow.sol`.
- USDC escrow: existing `0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D` (unchanged).
- EURC escrow: new instance, `token = EURC`, config copied from the USDC escrow's `currentConfig()`.
- The shared `EvaluatorRegistry` must list the EURC escrow as a slasher: `proposeSlasher` then `executeSlasher` after
  the registry's 48 h timelock. Until then `createAndFund` on the EURC escrow reverts (tested).
- Shared-registry note: evaluator exposure is summed in atomic units across assets (EURC and USDC both 6 decimals,
  ≈1:1); slashes are paid in the registry's stake token (USDC) even for EURC jobs.

### 2.2 `CrossCurrencySettler` (new, `src/CrossCurrencySettler.sol`)
Buyer pays `tokenIn` (EURC), seller receives `tokenOut` (USDC). No owner, no admin, no fee, holds no funds between
transactions, router immutable.
- `Quote {buyer, tokenIn, tokenOut, amountIn, minOut, poolFee, expiry, quoteId, recipient, escrow, evaluator, deadlineSeconds, specHash}`.
- `quoteHash(q) = keccak256(abi.encode(QUOTE_TYPEHASH, chainId, settler, router, ...q))`. The buyer signs EIP-3009
  `ReceiveWithAuthorization(from=buyer, to=settler, value=amountIn, validAfter, validBefore, nonce=quoteHash(q))`,
  so the signature binds every quote field (minOut, expiry, recipient, escrow terms). A relayer cannot alter them.
- `settle(q, auth)`:
  1. `block.timestamp > expiry` → revert `QuoteExpired` (before any transfer; authorization stays unused).
  2. Pull `amountIn` via `receiveWithAuthorization` (balance delta checked).
  3. `router.exactInputSingle(amountOutMinimum = minOut, recipient = settler)` inside `try`.
  4. Swap reverts (minOut not met, no liquidity, router failure) → `amountIn` returned to the buyer in the same tx,
     event `SwapFailedRefunded`, returns `swapped = false`. The authorization is consumed; the buyer needs a new quote.
  5. Output measured by balance delta; `< minOut` → whole tx reverts (buyer keeps funds).
  6. `escrow == 0` → transfer to `recipient`; else `escrow.createAndFundFor(client = buyer, provider = recipient,
     evaluator, amountOut, now + deadlineSeconds, specHash)`, i.e. a normal USDC escrow job with full client rights.
  7. Event `CrossCurrencySettled(quoteHash, quoteId, buyer, tokenIn, amountIn, tokenOut, amountOut, jobId)`.

## 3. x402 (POST /v1/notarize 402)
`accepts[]` order: `[exact USDC, agentcoin-escrow USDC, agentcoin-swap EURC]`.
- Entries 0 and 1 are produced by unchanged code (`exactRequirements` / `escrowRequirements`) and are byte-identical
  to v0.5.12: exact payTo `0x6A32bC3Bb5eA1dc814f14E29e6f026535129A84f`, amount `10000`, asset USDC; escrow entry
  unchanged. Checked by tests against the live v0.5.12 402 (fixture) and against the v0.5.12 source.
- Entry 2 (only when `MULTIASSET_SETTLER` is set; otherwise the 402 is exactly v0.5.12):
  `scheme "agentcoin-swap"`, `asset` EURC, `payTo` settler, `amount` = maxIn (exactOut quote for 10000 USDC plus
  `slippageBps` buffer, default 50), `extra.quote {quoteId, tokenOut, minOut = 10000, rate, expiry, expiresAt,
  rateSource, pool, poolFee}`, `extra.settlement {settler, router, escrowContract (USDC escrow), provider,
  evaluator, deadlineSeconds, specHash, onSwapFailure}`, `extra.nonce` (quoteHash definition), `quoteUrl`, and the
  same `responseSchemaHash`/`responseSchemaUrl`. Quote TTL 300 s; the 402 quote is cached 60 s.
- PAYMENT-REQUIRED header carries a slim copy of entry 2 (payment terms only); the body carries the full entry.
  All 402 response headers stay < 6 KB (test computes them from the live v0.5.12 headers plus the slim swap entry). The header copy carries name, version, quoteId, minOut and expiry only; signing needs the body entry.
- Payment payload: `{quoteId, authorization {from,to,value,validAfter,validBefore,nonce}, signature}`. The service
  checks quote known and unexpired, `to == settler`, `value == amount`, `nonce == quoteHash`, and the EIP-712
  signature before spending relayer gas, then calls `settle`. Swap failure → 402 with `refund {transaction, amount}`.
- Seller floor: minOut = the USDC price; any excess from the slippage buffer goes into the escrow job amount.
- Not in Phase 1: an EURC-denominated `exact` or `agentcoin-escrow` entry on the notary (the service's delivery and
  evaluator loop are single-escrow). The EURC escrow contract is usable directly.

## 4. GET /v1/quote (free)
`/v1/quote?from=EURC&to=USDC&amount=10000[&side=exactIn|exactOut]` (symbols or Base Sepolia addresses, atomic
units, cap 1000 units). Without `from`/`to` the existing escrow fee quote is served unchanged. Response:
`{quoteId, network, side, from{symbol,asset,amount}, to{...}, rate, rateUnit, slippageBps, minOut, maxIn, issuedAt,
expiry, expiresAt, rateSource{kind: uniswap-v3-quoterv2 | mock-router-owner-set-rate | identity, quoter, router,
pool, poolFee, source, note}, executableVia}`. 400 on bad parameters, 422 when no quote.

## 5. Receipts
The signed notary receipt (`agentcoin-notary/v1`) and its schema hash are unchanged. Cross-currency payments add
`agentcoin.payment` to the paid response and `payment` to PAYMENT-RESPONSE: `{scheme, paid{symbol,asset,amount},
received{symbol,asset,amount,into}, executedRate, quotedRate, rateUnit, rateSource, quoteId, quoteHash, minOut,
settler, settleTx}`. The on-chain `CrossCurrencySettled` event records both assets, amounts, quoteId and jobId.

## 6. Mainnet money-transmission and legal flags (for legal review; not legal advice)
- **F1 Custody in escrow.** `JobEscrow` holds buyer funds for others until verdict/finalize. Today it is a
  non-upgradeable contract whose owner can change config and arbitrator; owner control over held funds' routing
  could be viewed as custody/control by STOS. Reduce: no owner powers over funded jobs (already pinned config per
  job), immutable or timelocked admin, third-party/decentralized arbitrator, user-chosen evaluators.
- **F2 Currency exchange for others.** `CrossCurrencySettler` converts EURC→USDC on behalf of a buyer to pay a
  seller. If STOS operates or is the counterparty of the conversion, that may be exchange / money transmission
  (FinCEN MSB, state MTLs, EU MiCA CASP "exchange of crypto-assets"). Design today: STOS is not a counterparty; the
  swap executes against a public AMM pool, atomically, with no STOS-held balance and no fee. Keep it that way.
- **F3 Relayer submits the settle.** The service relayer (STOS key) submits the buyer's signed authorization and
  pays gas. The funds path is buyer → settler contract → AMM → escrow, never a STOS wallet; still, "accepting and
  transmitting" analysis may look at who initiates. Reduce: let the buyer or any third party submit (already
  permissionless), publish that STOS never holds or can redirect funds.
- **F4 Operating the swap / quotes.** Issuing quotes and choosing the route/pool may be viewed as brokering or
  operating an exchange service. Reduce: quotes are informational eth_calls to a public quoter, minOut is bound by
  the buyer's signature, no spread or fee.
- **F5 Stablecoin rules.** EURC is an EMT under MiCA; offering EUR-stablecoin services to EU users may need CASP
  authorization. USDC/EURC issuer terms and sanctions screening (OFAC; Circle blacklist) apply on mainnet.
- **F6 Fees.** Any protocol fee on conversion or escrow strengthens the "business of" money-services analysis.
- **F7 Refunds.** Automatic refund on swap failure returns funds to the payer only; no STOS discretion. Keep
  refunds non-discretionary.
Non-custodial direction: immutable settler (done), no admin over in-flight funds, user-submittable settlement,
no STOS balances, no fee on conversion, published code and addresses.

## 7. Deploy plan (testnet)
Contracts (script `script/DeployMultiAsset.s.sol`, deployer `0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e`):
1. `CrossCurrencySettler(router = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4)`
2. `JobEscrow(EURC, registry 0x30576DE005df028D1947C56dEcc85a2a5612036a, treasury 0x78e2…488e, arbitrator
   0x3C4587eD99B1969581cA4f041FD9535a0D269736, live USDC escrow currentConfig(), owner 0x78e2…488e)`
3. `registry.proposeSlasher(eurcEscrow, true)`; `executeSlasher` after 48 h (anyone).
Gas (forge fork simulation, 2026-11-15): 6,716,567 gas estimated (incl. forge margin) at ≤0.011 gwei →
≤0.000074 test ETH. Deployer balance 0.000237 test ETH. $0 real.
Settle gas (fork, escrow mode): ~597k per cross-currency payment (relayer).
Test tokens: buyers need test EURC. As of 2026-11-15 no STOS address holds EURC. Circle's faucet
(https://faucet.circle.com) is a captcha web form: a human step.
Droplet (same v0.5.x pattern; agentcoin-* only): build context (`deploy/make-context.sh`, now including the
CrossCurrencySettler ABI), copy, `docker build -t agentcoin-testnet:0.5.13`, run the server test suite inside the
image, back up `/var/lib/agentcoin/*` and `/etc/agentcoin/testnet.env` as `.bak-pre-0.5.13`, add
`MULTIASSET_SETTLER=<settler>` to the env file, `docker rename agentcoin-testnet agentcoin-testnet-0.5.12`,
`docker stop agentcoin-testnet-0.5.12`, `docker run` the same flags with the new image.
Rollback: `docker rm -f agentcoin-testnet && docker rename agentcoin-testnet-0.5.12 agentcoin-testnet && docker
start agentcoin-testnet` and restore `/etc/agentcoin/testnet.env.bak-pre-0.5.13`. The contracts need no rollback:
with `MULTIASSET_SETTLER` unset the service ignores them.
