# Exchange e2e: Base Sepolia, local service instance, 2026-11-22 (ET)

- Service: local instance only (`http://127.0.0.1:4471`, code at commit b09906c, AGENTCOIN_NETWORK=base-sepolia, separate SERVICE_STATE_DIR). It ran on no live host.
- Listing: AgentKoin seed `lst_294b97b984a7dc02` (AgentKoin Notary, skill `notarize`, price 10000 = 0.01 test USDC, SLA 3600 s), seller/provider `0x745528C4E0CBdA5759175A660da06d0aaA72db7F`.
- Buyer: `0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e` (AgentKoin testnet deployer, so origin is "agentcoin" and `countedInScore` is false). Hire was ONE x402 `exact` request (EIP-3009 to the offer-bound route `0x82f1Df21D32431fb2D974C051E8Ea24f179e12eE`).
- Evaluator: reference `0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a`. specHash (sha256 of the criteria bytes) is `0x62ea09901b20704ad08727924b24b5c7c858147a1edd1041831b98abf372c706`.
- Order `xo_7357afe788d69ba0` maps to JobEscrow `0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D` job **37**.

| step | tx | block | from | status |
|---|---|---|---|---|
| hire / escrow fund (factory.settle via relayer) | 0x89a7a4c91796f743136c42220e3bbfda3ef794cdf2db7bd1456a368c413de266 | 62370251 | relayer 0x0a7B…877C | success |
| deliver (submit sha256) | 0x661591767dde1a157929109d7ebb7777c500786fd4f79e7abcf302fa27d6d716 | 62370255 | provider 0x7455…db7F | success |
| evaluator verdict (Complete, 10000 bps) | 0xaf4e52e15fb4e30d4860d3d82386b44a38ec6a6d098a8c48062b5a15aacc2727 | 62370305 | evaluator 0xfb01…509a | success |
| finalize / payout (10000 atomic to provider) | 0xb57f34965b3efec4fa2ccb4edb704665e2e633b9e983f0f27a03a7042a4c1b14 | 62373379 | relayer 0x0a7B…877C | success |

judge-kit verify (`node judge-kit/src/cli.ts verify 37 --escrow 0x4EaF… --server http://127.0.0.1:4471 --no-concordium`), exit 0:

```
job 37 on 0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D (v0.5) via https://base-sepolia-rpc.publicnode.com
PASS  proof-signature                    the proof is signed by the key the service publishes in /.well-known/jwks.json
PASS  job-onchain                        the job exists on the named escrow
PASS  spec-hash                          sha256(criteria bytes) == job.specHash
PASS  deliverable-hash                   hash(receipt/deliverable bytes) == job.deliverableHash
PASS  payment-flow                       the USDC that funded the job moved client -> (route) -> escrow in the fund tx
PASS  submit-tx                          JobSubmitted(jobId, provider, deliverableHash) matches the job
PASS  verdict-signer                     the verdict tx was sent by job.evaluator with the on-chain outcome and payout
PASS  settlement                         Settled(jobId, payoutBps) was emitted and equals the job's payoutBps
PASS  evaluator-stake                    the evaluator had at least minStake in the registry at the verdict block
PASS  escrow-bytecode                    escrow runtime bytecode is a Sourcify exact_match
PASS  proof-claims:job-onchain           the proof's expected value for job-onchain equals the independently derived one
PASS  proof-claims:spec-hash             the proof's expected value for spec-hash equals the independently derived one
PASS  proof-claims:deliverable-hash      the proof's expected value for deliverable-hash equals the independently derived one
PASS  proof-claims:payment-flow          the proof's expected value for payment-flow equals the independently derived one
PASS  proof-claims:submit-tx             the proof's expected value for submit-tx equals the independently derived one
PASS  proof-claims:verdict-signer        the proof's expected value for verdict-signer equals the independently derived one
PASS  proof-claims:settlement            the proof's expected value for settlement equals the independently derived one
PASS  proof-claims:evaluator-stake       the proof's expected value for evaluator-stake equals the independently derived one
PASS  proof-claims:escrow-bytecode       the proof's expected value for escrow-bytecode equals the independently derived one

receipt (for hand recomputation)
  url                    http://127.0.0.1:4471/exchange/v1/orders/xo_7357afe788d69ba0/deliverable
  raw bytes              278  sha256 0xbc7dfe7b0b57d25d42573af842448c982a9a1fc1e7a34ed0f12e0043ce741bea
  keccak256(canonical)   0x8097ca2738c108735f11452b1d5a287b55e67da4dab4405d6abfed7688818aa9
  sha256(canonical)      0xbc7dfe7b0b57d25d42573af842448c982a9a1fc1e7a34ed0f12e0043ce741bea
  on-chain deliverable   0xbc7dfe7b0b57d25d42573af842448c982a9a1fc1e7a34ed0f12e0043ce741bea   (sha256)

finalize payout
  settle tx              0xb57f34965b3efec4fa2ccb4edb704665e2e633b9e983f0f27a03a7042a4c1b14 (block 62373379), payoutBps 10000
  USDC transfer          escrow -> 0x745528C4E0CBdA5759175A660da06d0aaA72db7F  10000 atomic
  to provider            10000 atomic USDC of 10000
  refund to client       0 atomic USDC  (no refund leg)
OK: 19 passed, 0 failed, 0 skipped; evaluator 0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a
```
