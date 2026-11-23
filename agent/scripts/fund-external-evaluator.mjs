#!/usr/bin/env node
// Base Sepolia only: deployer -> external evaluator EOA, test USDC + a little test ETH (Carter approved babyblueviper1
// funding, Nov 15 2026). Keys read from .secrets, never printed. Refuses a contract address and keeps an ETH reserve.
// Env: EVAL=0x.. USDC_UNITS (default 2000000) ETH_WEI (default 30000000000000) RESERVE_WEI (default 80000000000000)
// RECORD=1 appends txs to deployments/base-sepolia-external-evaluators.json (live run only).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { getAddress } from "viem";
import { ROOT, CHAIN_ID, RPC_URL } from "../lib/config.mjs";
import { contracts, read, send, wallet, publicClient } from "../lib/chain.mjs";

if (CHAIN_ID !== 84532) throw new Error("Base Sepolia only");
const to = getAddress(process.env.EVAL);
const usdcUnits = BigInt(process.env.USDC_UNITS ?? "2000000");
const ethWei = BigInt(process.env.ETH_WEI ?? "30000000000000");
const reserve = BigInt(process.env.RESERVE_WEI ?? "80000000000000");
const c = contracts();
const dep = wallet(readFileSync(path.join(ROOT, ".secrets", "testnet-deployer.key"), "utf8").trim());
const from = dep.account.address;
const log = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
const code = await publicClient.getCode({ address: to });
if (code && code !== "0x") throw new Error("target has code; refusing");
const bal = async () => ({ depEth: await publicClient.getBalance({ address: from }), depUsdc: await read(c.usdc, "balanceOf", [from]), evEth: await publicClient.getBalance({ address: to }), evUsdc: await read(c.usdc, "balanceOf", [to]) });
const before = await bal();
log({ rpc: new URL(RPC_URL).host, from, to, before });
if (before.depUsdc < usdcUnits) throw new Error("deployer USDC short");
const t1 = await send(dep, c.usdc, "transfer", [to, usdcUnits]);
const afterUsdc = await publicClient.getBalance({ address: from });
let t2 = null;
if (afterUsdc - ethWei < reserve) log({ skipEth: true, reason: "deployer ETH would drop below reserve", depEth: afterUsdc, reserve });
else { const h = await dep.sendTransaction({ to, value: ethWei }); t2 = { hash: h, receipt: await publicClient.waitForTransactionReceipt({ hash: h }) }; }
const after = await bal();
const txs = [{ label: "USDC deployer -> evaluator", hash: t1.hash, block: t1.receipt.blockNumber, status: t1.receipt.status, amount: usdcUnits }];
if (t2) txs.push({ label: "ETH deployer -> evaluator", hash: t2.hash, block: t2.receipt.blockNumber, status: t2.receipt.status, amountWei: ethWei });
log({ txs, after });
if (process.env.RECORD === "1") {
  const f = path.join(ROOT, "deployments", "base-sepolia-external-evaluators.json");
  const rec = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { chainId: 84532, evaluators: {} };
  rec.evaluators[to] = { ...(rec.evaluators[to] ?? {}), funding: txs, fundedFrom: from, balancesAfter: { eth: after.evEth, usdc: after.evUsdc } };
  writeFileSync(f, JSON.stringify(rec, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}
