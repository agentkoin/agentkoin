#!/usr/bin/env node
// AD-010 deploy step 4 (Base Sepolia): deployer -> reference evaluator 2 test USDC (minStake); the evaluator approves
// AGC, wrap(minStake), approves the AGC EvaluatorRegistry and stakes. Keys read from .secrets, never printed.
// Records txs in deployments/base-sepolia-agc.json. DRY_RUN=1 (default) prints the plan only.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseAbi, getAddress } from "viem";
import { ROOT, CHAIN_ID } from "../lib/config.mjs";
import { contracts, read, send, wallet, publicClient } from "../lib/chain.mjs";

if (CHAIN_ID !== 84532) throw new Error("Base Sepolia only");
const dry = process.env.DRY_RUN !== "0";
const out = path.join(ROOT, "deployments", "base-sepolia-agc.json");
const rec = JSON.parse(readFileSync(out, "utf8"));
const c = contracts();
const key = (f) => readFileSync(path.join(ROOT, ".secrets", f), "utf8").trim();
const deployer = wallet(key("testnet-deployer.key"));
const ev = wallet(key("testnet-evaluator.key"));
const AGC = { address: getAddress(rec.contracts.AGC.address), abi: parseAbi(["function wrap(uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]) };
const REG = { ...c.registry, address: getAddress(rec.contracts.EvaluatorRegistryAGC.address) };
const minStake = await read(REG, "minStake", []);
const log = (o) => console.log(JSON.stringify(o));
rec.evaluatorFunding ??= { evaluator: ev.account.address, minStake: minStake.toString(), txs: [] };
const tx = async (label, from, fn) => {
  if (dry) return log({ dry: true, label });
  const r = await fn();
  const t = { label, from, hash: r.hash, block: r.receipt.blockNumber.toString(), status: r.receipt.status };
  rec.evaluatorFunding.txs.push(t); writeFileSync(out, JSON.stringify(rec, null, 2) + "\n"); log(t);
};
log({ evaluator: ev.account.address, usdc: (await read(c.usdc, "balanceOf", [ev.account.address])).toString(), eth: (await publicClient.getBalance({ address: ev.account.address })).toString(), minStake: minStake.toString(), activeOnAGCRegistry: await read(REG, "isActive", [ev.account.address]) });
const have = await read(c.usdc, "balanceOf", [ev.account.address]);
if (have < minStake) await tx("USDC deployer -> reference evaluator (AGC minStake)", deployer.account.address, () => send(deployer, c.usdc, "transfer", [ev.account.address, minStake - have > 0n ? minStake : minStake]));
await tx("USDC evaluator approve AGC", ev.account.address, () => send(ev, c.usdc, "approve", [AGC.address, minStake]));
await tx("AGC.wrap(minStake) by evaluator", ev.account.address, () => send(ev, AGC, "wrap", [minStake]));
await tx("AGC evaluator approve AGC registry", ev.account.address, () => send(ev, AGC, "approve", [REG.address, minStake]));
await tx("EvaluatorRegistry(AGC).stake(minStake) by evaluator", ev.account.address, () => send(ev, REG, "stake", [minStake]));
if (!dry) { rec.evaluatorFunding.activeOnAGCRegistry = await read(REG, "isActive", [ev.account.address]); rec.evaluatorFunding.stake = (await read(REG, "stakeOf", [ev.account.address])).toString(); writeFileSync(out, JSON.stringify(rec, null, 2) + "\n"); log(rec.evaluatorFunding); }
