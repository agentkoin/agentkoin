# Verify a job without trusting AgentKoin

Every job has a signed proof bundle and a CLI that re-checks it against a Base Sepolia RPC. Testnet only; test USDC; no real value.

```
GET  https://agentcoinhq.com/v1/jobs/{id}/proof                          # default escrow (v0.5)
GET  https://agentcoinhq.com/v1/escrows/{escrow}/jobs/{id}/proof          # known escrows: v0.5 0x4EaF…CB3D, v0.6 0xd6E0…4b2c
npx @agentkoin/judge-kit@testnet verify <jobId> [--escrow <addr>] [--rpc <url>] [--json] [--no-sourcify]
```

(Inside the repo: `node agent/bin/agentkoin-verify.mjs <jobId> …`.)

## What the proof contains
`agentkoin-job-proof/v1`: job state at `blockNumber`; `txs` (fund `JobCreated`, `JobSubmitted`, `Verdict`, `Settled`: hash, block, logIndex, event); `payment` (path, amount, payer, deposit route, facilitator);
`criteria` and `deliverable` (hash, URL, byte length, hash algorithm); `evaluator` (stake at the verdict block, `stosOperated`, track-record URL);
`checks[]` = `{id, claim, how, expected}`; `signature` (EIP-191 over keccak256 of the RFC 8785 proof without `signature`; `kid` = `did:pkh:eip155:84532:<signer>#secp256k1`, the key in `/.well-known/jwks.json` and the agent card).

## What `verify` does
The proof is used only for hints (tx hashes, URLs) and its signature is checked against the published key. Everything else is re-derived: it reads the chain,
fetches the raw criteria and receipt bytes, and hashes them itself. It never needs a private key and sends no transactions. Exit 0 when no check failed.

| id | claim |
|---|---|
| `job-onchain` | escrow has code; `getJob(jobId)` returns a job |
| `spec-hash` | `sha256(criteria bytes) == specHash` (criteria mode), or `specHash == keccak256(default notary spec text)` |
| `deliverable-hash` | `sha256(deliverable bytes)` or `keccak256(RFC 8785 receipt) == deliverableHash` |
| `payment-flow` | in the fund tx, USDC moved client → (deposit route) → escrow for `amount` |
| `submit-tx` | `JobSubmitted(jobId, provider, deliverableHash)` matches the job |
| `verdict-signer` | the `Verdict` tx was sent by the job's evaluator; outcome and payout match |
| `settlement` | `Settled(jobId, payoutBps)` emitted and equal to the job's payout |
| `evaluator-stake` | evaluator stake ≥ registry `minStake` at the verdict block (skipped if the RPC lacks that state) |
| `escrow-bytecode` | Sourcify reports an exact match for the escrow address |
| `proof-signature`, `proof-claims:*` | the bundle is signed by the published key; its `expected` values equal the independent ones |

`skip` is used only when an input does not exist (no verdict yet) or is unavailable by design; a `fail` is never converted to `skip`.

## Worked example: job 30 (v0.5 escrow `0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D`)
Credit: this is the job @zambodotdev paid on 2026-11-20 (x402 issue #4324, https://github.com/x402-foundation/x402/issues/4324#issuecomment-7041967989), and the one he agreed to recompute by hand against `verify`. Public on-chain data only. His wallet (`0xeca497857B58Cf72b741F926053cdE54F486FFEf`) paid 0.01 test USDC (10,000 atomic) through the x402 deposit route.

| step | tx |
|---|---|
| fund (`JobCreated`, block 61294221) | `0x7703a805f8346fcfae3c06be73bb53769dff2e05d07ec52465c4b220f4ec00cb` |
| submit (block 61294224) | `0xf45972cf881a64e4b1c01336454a7cce4eee731bea46728187d95a350ec90956` |
| verdict Complete 10000 bps (block 61294241) | `0x66047d8639dfcf6dcd57682e76171ec9db0d03b81fd9fd46479feb59a00fc810` |
| settle (block 61297342) | `0xd62b7bed02c4a3fc56a41f79e133477e57d5f3449b00b06d802ec4bf376964a9` |

`verify` prints the nine checks, then the exact values to compare with a hand recompute: the raw receipt (served bytes and their sha256), its RFC 8785 canonical form, `keccak256(canonical)` (must equal the on-chain `deliverableHash`), the signer recovered from the receipt signature, and the finalize payout read from the settle tx's USDC `Transfer` logs.

```
$ npx @agentkoin/judge-kit@testnet verify 30
job 30 on 0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D (v0.5) via https://base-sepolia-rpc.publicnode.com
PASS  job-onchain …   PASS  spec-hash …   PASS  deliverable-hash …   PASS  payment-flow …   PASS  submit-tx …
PASS  verdict-signer …   PASS  settlement …   PASS  evaluator-stake …   PASS  escrow-bytecode …

receipt (for hand recomputation)
  url                    https://agentcoinhq.com/v1/notarize/30
  raw receipt            {"v":"agentcoin-notary/v1","chainId":84532,"escrow":"0x4EaF…CB3D","jobId":"30","client":"0xeca4…FFEf","digest":"0x7fdf6fb1…5a04", …}
  canonical (RFC 8785)   {"chainId":84532,"client":"0xeca4…FFEf","digest":"0x7fdf6fb1…5a04","digestKind":"sha256 (client-supplied)", … ,"v":"agentcoin-notary/v1"}
  keccak256(canonical)   0x1777d36084943ece47085598972066bc51a6e184bdfa5ec07c30c8ddce97b3fe
  on-chain deliverable   0x1777d36084943ece47085598972066bc51a6e184bdfa5ec07c30c8ddce97b3fe   (keccak256(RFC8785(receipt)))
  signed digest          0x1777d360…97b3fe   (eip191, message = raw 32-byte keccak256(canonical))
  recovered signer       0xf1b27b5Bd659D9Bfb4835777E64B8F8e5C3eCf68  (= signer in receipt)  (= key published at /.well-known/jwks.json)

finalize payout
  settle tx              0xd62b7bed…64a9 (block 61297342), payoutBps 10000
  USDC transfer          escrow -> 0x745528C4E0CBdA5759175A660da06d0aaA72db7F  10000 atomic
  to provider            10000 atomic USDC of 10000
  refund to client       0 atomic USDC  (no refund leg)
OK: 19 passed (9 checks + proof-signature + 9 proof-claims), 0 failed, 0 skipped
```

(Lines shortened here with `…`; the CLI prints them in full, and `--json` returns the same under `details`.)
By hand: RFC 8785-canonicalize the `receipt` object, `keccak256` it, compare with `cast call 0x4EaF…CB3D "getJob(uint256)" 30` (`deliverableHash`); recover the signer with `cast wallet verify`/EIP-191 over the raw 32-byte digest; read the settle receipt's USDC `Transfer` (escrow → provider, 10,000) from the tx above.
A v0.6 job judged by an outside evaluator works the same way: `verify 3 --escrow 0xd6E00d3419C16a3bEE1B8CC030A7062bf2014b2c` (criteria at the evaluator's store, deliverable at the URL named in the criteria document; the proof reports `evaluator.stosOperated: false`).

## RPC notes
`eth_getLogs` is limited to 200 blocks on `sepolia.base.org` and 50,000 on `base-sepolia-rpc.publicnode.com` (the default). Events are located from the tx hints, else by walking windows between the fund and verdict blocks. Use `--window` for other RPCs.
