# A-1e evaluation: per-payment commitment routes (not built)

Status: **evaluation only** (Research item 2 of the v0.1.1 round). Nothing here is implemented in `src/`. The only code is a
measurement-only clone probe in `test/GasA1e.t.sol`, used for the gas figures below. All numbers come from local forge runs.

## The idea

Today a route is per **offer**: `salt = keccak256(abi.encode(offer))`, and one route serves every buyer of that offer. When funds
reach it outside the atomic `settle`, the contract cannot tell whose they are. That is why v0.1.1 needs an allowlisted keeper to
attest the Transfer log.

A commitment route is per **payment**:

```
salt    = keccak256(abi.encode(offer, payer, value, nonce, validBefore))
payTo   = CREATE2(factory, salt, routeInitCodeHash)
```

The route stores (or is initialised with) `payer`, `value`, `nonce`, `validBefore` and the offer. Its rules would be:

- `settle(validAfter, signature)` (anyone): atomic path. It executes `transferWithAuthorization(payer → this, value, …, nonce)` and
  opens the job for `payer`.
- `credit()` (anyone, no keeper): if `balance >= value` and no job has been opened yet, open the job for `payer` with `value`.
  This covers an authorization submitted straight to the token.
- `refund()` (anyone, after `validBefore`, or once the job is open): send `min(balance, value)` (or the whole balance, see below) to
  `payer`.
- Single use: once a job is open, further `credit` is refused.

## Does it close A-1e without a trusted keeper?

**Yes, for the payers who use it.**

- The A-1e exploit needs one payer's claim to be paid out of **other people's** funds sitting in a shared route.
- In a commitment route there are no other people's funds by construction: the address is unique to (payer, value, nonce,
  validBefore). Every outflow goes to `payer`, and is capped at what the route holds (and at `value` for the job).
- The same-nonce double-sign (sign A to the route and B elsewhere with one nonce, execute B) leaves the route empty. `credit` and
  `refund` then have nothing to pay. The attacker can only ever receive what was sent to their own route.
- Nobody has to prove which authorization moved the funds, so no log, tx hash or trusted attester is needed. Liveness becomes
  permissionless: anyone (a facilitator, the buyer, a bot) can call `credit`/`refund`.
- A third party who sends tokens to someone's commitment route is paying that payer. That is the same as sending to a wrong
  address, not a theft from the protocol. Excess above `value` can go to `payer` too, or to the A-1a sweep.
- Per-route invariant: credited + refunded <= tokens received, and all of it to `payer`. That is the A-1e property without the keeper.

Including `nonce` and `validBefore` in the salt is not needed for safety (payer + value + single use would be enough). It is needed
so that every payment gets a fresh address, and so the route knows when an unexecuted authorization has expired (refund timing).

## What it costs standard x402 clients

This is the blocker.

- **payTo must be known before the client signs, but it depends on the payer and the nonce.** In standard x402 `exact` the
  server's 402 lists `payTo` without knowing who will pay. The client picks its own wallet (`from`), generates a random 32-byte
  `nonce`, and signs `TransferWithAuthorization` with `to = payTo` taken verbatim from the requirements. The facilitator then
  checks `to == payTo`.
- **A standard client cannot pre-commit a payer.** Two ways around that, both non-standard:
  1. *Client-computed payTo*: the client derives `payTo` itself from `extra.agentcoin` (factory, offer, init-code hash) plus its own
     `from`, `nonce` and `validBefore`. This needs AgentCoin-aware client code, and a facilitator that accepts a `to` that differs
     from the advertised `payTo` (it would have to recompute it too).
  2. *Server-issued payTo*: an extra round trip before the 402, where the client identifies its wallet (header or SIWE-style
     proof) and the server returns a per-payment `payTo` plus the `nonce` and `validBefore` to use. Standard client libraries
     generate their own nonce and do not take one from the server.
- **No route reuse.** Every payment deploys a new contract (see gas). The CREATE2 address is counterfactual, so the buyer pays
  nothing extra up front; the settler pays the deploy.
- **Middle ground that does not need the payer**: a fresh route per 402 response (salt = offer + server-chosen request id). It
  works with standard clients (payTo is just a different address each time). But funds that arrive outside `settle` still cannot
  be attributed to a `from` on-chain. It shrinks the keeper's per-route exposure to one payment but **does not remove the keeper**.

## Gas (local, forge, `test/GasA1e.t.sol`, `-vv`)

Measured:

| Path | Gas |
|---|---|
| `factory.settle`, route not yet deployed (full route CREATE2 + settle) | 1,430,839 |
| `factory.settle`, route already deployed | 355,528 |
| difference = full route deployment per new route | 1,075,311 |
| `factory.deploy` alone (gas report) | 1,047,745 |
| `attestDeposit` opening a job on a deployed route (v0.1.1 keeper path) | 327,952 |
| EIP-1167 clone + initialize of a probe holding offer + payer/value/nonce/validBefore + approval (measurement-only `CommitRouteCloneProbe`) | 330,680 |

Caveat: these run inside one forge test transaction, so some cold-access costs are paid by the first call only. The cold vs warm
difference therefore slightly overstates the deploy cost. Treat the figures as about ±5%.

Per-payment estimate (the commitment-route numbers are estimates built on the measured parts, not a measured implementation):

| Variant | Per payment | vs today's warm route |
|---|---|---|
| Today, offer route already deployed (atomic settle) | ≈ 356k | 1× |
| Commitment route as a full contract (current route code + 4 more immutables) | ≈ 1.43M | ≈ 4× |
| Commitment route as an EIP-1167 clone with storage init | ≈ 356k + 331k + ~20k (delegatecall + ~9 cold SLOADs in place of immutables) ≈ 0.7M | ≈ 2× |
| Clone with immutable args (OZ 5.1 does not have it; Solady `LibClone` does), no per-route approval | likely ≈ 0.45–0.5M (estimate, not measured) | ≈ 1.3× |

On an L2 these absolute numbers are cheap. On L1 the extra 0.1–1M gas per payment is significant for small x402 payments.

## Recommendation

1. **Keep v0.1.1 as the default**: atomic `settle` for the facilitator path (needs no keeper and covers the normal x402 flow), plus
   allowlisted keeper attestation for out-of-band transfers. It is the only option that works with unmodified x402 clients and
   facilitators. The keeper's power is bounded by what sits uncredited in routes, and keeper changes are timelocked (48h).
2. **Do not replace the offer route with commitment routes**: standard clients cannot pre-commit a payer, so it would break the
   point of A-1 (standard `exact` compatibility).
3. **Optional later scheme** for AgentCoin-aware clients: a second `accepts` entry (say `exact-committed`) where the client derives
   `payTo` from (offer, from, value, nonce, validBefore), built as clones with immutable args. It gives a gasless (EIP-3009) payment
   with no keeper at ~1.3–2× the gas. Weigh that against the existing `agentcoin-escrow` scheme, which is already keeper-free but
   makes the buyer send its own transaction. This is worth building only if gasless, keeper-free payments for aware clients become a
   requirement.
4. Cheap improvement whatever is chosen: run more than one independent keeper (any allowlisted keeper can attest, and dedupe is
   global), so liveness does not hang on one key. The trust assumption stays, though: any single keeper can misattest. A k-of-n
   attestation would be needed to reduce it, and is not built.

Open questions for Research: whether a k-of-n keeper threshold is wanted for v1, and whether an `exact-committed` scheme is
worth adding, given that `agentcoin-escrow` already exists for aware clients.
