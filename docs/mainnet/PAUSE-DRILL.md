# Pause drill (Base mainnet, JobEscrow)

A rehearsal you run yourself in the Safe web app. No private key, seed phrase or signing request ever goes through us or any agent: you sign with your own wallets, in your own browser, in the Safe UI.

**Time:** about 15 minutes, 2 signers. **Cost:** a fraction of a cent (see "Gas" below). **Best time:** when no escrow jobs are open or being funded (the pause blocks new escrow funding for the minutes it lasts).

## What you are using

| Item | Value |
|---|---|
| Network | Base mainnet (chain id 8453) |
| Pauser Safe | `0x76a111907017e43b3633e91D6516EE3322C1b010` (Safe v1.5.0, 2-of-3 owners at the time of writing) |
| Owner Safe | `0xE26B5fC9499f3aD1cec80d81D9ec8E5f2c743d76` (also allowed to pause and unpause) |
| JobEscrow | `0xB647158dE59588e1070d616BDB31459d610CE885` |
| Safe app | https://app.safe.global (open the Pauser Safe on **Base**) |
| Basescan | https://basescan.org/address/0xB647158dE59588e1070d616BDB31459d610CE885 |

Source of truth for the addresses: `deployments/8453.json` (`escrow`, `pauserSafe`, `ownerSafe`).

## Which contracts can be paused, and who can pause or unpause

Only **JobEscrow** is pausable (OpenZeppelin `Pausable`). The EvaluatorRegistry, the deposit-route factory, the RecoveryVault and the UMA adapter have no pause function, so there is nothing to build for them.

From `src/JobEscrow.sol`:

```solidity
function pause()   external { if (msg.sender != pauser && msg.sender != owner()) revert NotPauser(); _pause(); }
function unpause() external { if (msg.sender != pauser && msg.sender != owner()) revert NotPauser(); _unpause(); }
```

- `pause()` and `unpause()` can each be called by the **Pauser Safe** (`pauser()`) or the **Owner Safe** (`owner()`). Nobody else.
- So the same Pauser Safe that pauses can also unpause. You do not need the Owner Safe for this drill.
- Read-only checks: `paused()` (bool), `pauser()` (address), `owner()` (address).

**What a pause does:** blocks creating and funding jobs (`createAndFundFor`, `fund`, and the x402 route settle, which reverts so payers are not charged). Still works while paused: `cancel`, `claimRefund`, `submit`, verdict, `challenge`, `rule`, `finalize`, `timeoutRelease`. Money already in escrow can always exit.

## Step 1. Check the starting state (read only)

On Basescan open the JobEscrow, tab **Contract > Read Contract** (if Basescan shows no Read Contract tab, use the cast lines below):

- `paused()` should be `false`
- `pauser()` should be `0x76a1...b010`

Or with Foundry (read-only, no key):

```
cast call 0xB647158dE59588e1070d616BDB31459d610CE885 'paused()(bool)' --rpc-url https://mainnet.base.org
cast call 0xB647158dE59588e1070d616BDB31459d610CE885 'pauser()(address)' --rpc-url https://mainnet.base.org
```

## Step 2. Build the pause transaction (Transaction Builder)

1. Go to https://app.safe.global, connect your wallet, switch to **Base**, open the Pauser Safe `0x76a1...b010`.
2. Left menu: **Apps** > **Transaction Builder**.
3. **Enter Address or ENS Name**: paste `0xB647158dE59588e1070d616BDB31459d610CE885`.
4. If the ABI does not load automatically (the contract is not verified on Basescan), choose **Enter ABI** and paste:
   ```
   [{"type":"function","name":"pause","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
    {"type":"function","name":"unpause","inputs":[],"outputs":[],"stateMutability":"nonpayable"}]
   ```
5. **Contract Method Selector**: `pause`. There are no parameters. Leave ETH value at 0.
6. Click **Add new transaction**, then **Create Batch**, then **Send Batch**.
7. Check the preview: **to** = the JobEscrow address, **data** = `0x8456cb59` (the `pause()` selector), **value** = 0. If anything differs, stop and do not sign.

## Step 3. Sign and execute

1. Click **Sign** and approve in your wallet (signer 1). It is an off-chain signature, no gas yet.
2. The second owner opens the Safe (**Transactions > Queue**), opens the transaction, checks the same three fields (to, data `0x8456cb59`, value 0), and clicks **Sign**.
3. With 2 of 3 signatures, anyone with a wallet that holds a little ETH on Base clicks **Execute** and confirms. The executor pays the gas.
4. Wait for the green "Success" and copy the transaction hash.

## Step 4. Verify the pause

- Basescan > JobEscrow > Read: `paused()` returns `true`. The transaction page shows a `Paused(account)` event with account = the Pauser Safe.
- Or: `cast call 0xB647158dE59588e1070d616BDB31459d610CE885 'paused()(bool)' --rpc-url https://mainnet.base.org` prints `true`.
- Optional: an escrow order on the Exchange should now be refused. Direct (non-escrow) orders are not affected. Do not create real paid orders for the test.

## Step 5. Unpause

Same flow in Transaction Builder on the Pauser Safe: method `unpause` (data `0x3f4ba83a`), to = JobEscrow, value 0, two signatures, execute. Then check `paused()` returns `false` and the transaction shows an `Unpaused(account)` event. Do not leave the escrow paused after the drill.

If the Pauser Safe cannot execute for any reason, the Owner Safe `0xE26B...3d76` can call `unpause()` the same way (it is also `owner()`).

## Gas on Base

`pause()` itself is about 30,000 gas (simulated against the live contract). The Safe execution wrapper adds roughly 60,000 to 90,000 gas, so about 100,000 to 130,000 gas in total. At Base gas around 0.006 gwei (Nov 23, 2026) that is roughly 0.0000007 ETH on L2, plus a small L1 data fee, so well under one cent per transaction. Keep a few cents of ETH (0.0005 ETH is plenty) in the wallet that clicks Execute. Check the live price with `cast gas-price --rpc-url https://mainnet.base.org`.

## Real incident, same steps

If you ever need an actual emergency pause, do Steps 2 to 4 only and do not unpause. Then see "Rollback / emergency" in `docs/mainnet/RUNBOOK.md` (lower the caps, let open jobs exit, point offers back to testnet).

## Record the result

Write down: the pause tx hash, the unpause tx hash, the time between them, and anything in the Safe UI that surprised you. Send those to AgentCoin Research.
