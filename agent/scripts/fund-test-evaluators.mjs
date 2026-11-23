#!/usr/bin/env node
// AD-011: fund and stake the two test evaluators in the EXISTING Base Sepolia EvaluatorRegistry. Test tokens only.
// Per evaluator: deployer -> evaluator 0.000003 test ETH (gas for approve + stake) and minStake test USDC; then the
// evaluator approves the registry and stakes minStake. Keys are read from .secrets files and never printed.
// DRY_RUN=1 (default) prints the plan only. Writes tx hashes to deployments/base-sepolia-ad011.json.
// Usage: AGENTCOIN_NETWORK=base-sepolia DRY_RUN=0 node scripts/fund-test-evaluators.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT, CHAIN_ID } from "../lib/config.mjs";
import { contracts, read, send, wallet, publicClient } from "../lib/chain.mjs";

if (CHAIN_ID !== 84532) throw new Error(`Base Sepolia only (chainId ${CHAIN_ID})`);
const dry = process.env.DRY_RUN !== "0";
const key = (f) => readFileSync(path.join(ROOT, ".secrets", f), "utf8").trim();
const deployerKey = key("testnet-deployer.key");
const deployer = wallet(deployerKey);
const evs = ["a", "b"].map((n) => ({ n, pk: key(`testnet-test-evaluator-${n}.key`) })).map((e) => ({ ...e, address: privateKeyToAccount(e.pk).address }));
const c = contracts();
const GAS_ETH = parseEther("0.000003");
const minStake = await read(c.registry, "minStake", []);
const service = ["relayer", "provider", "evaluator", "deployer"].map((r) => privateKeyToAccount(key(`testnet-${r}.key`)).address);
for (const e of evs) if (service.includes(e.address)) throw new Error("test evaluator key equals a service key");
const out = path.join(ROOT, "deployments", "base-sepolia-ad011.json");
const rec = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { network: "base-sepolia", chainId: 84532, task: "AD-011 test evaluators", registry: c.registry.address, usdc: c.usdc.address, minStake: minStake.toString(), evaluators: {}, txs: [] };
const log = (o) => console.log(JSON.stringify(o));
const save = () => writeFileSync(out, JSON.stringify(rec, null, 2) + "\n");
const tx = async (label, from, fn) => {
  if (dry) return log({ dry: true, label, from });
  const r = await fn();
  const t = { label, from, hash: r.hash, block: r.receipt.blockNumber.toString(), gasUsed: r.receipt.gasUsed.toString(), status: r.receipt.status };
  rec.txs.push(t);
  save();
  log(t);
};
log({ deployer: deployer.account.address, eth: formatEther(await publicClient.getBalance({ address: deployer.account.address })), usdc: (await read(c.usdc, "balanceOf", [deployer.account.address])).toString(), minStake: minStake.toString(), evaluators: evs.map((e) => e.address) });
for (const e of evs) {
  rec.evaluators[e.n] = { address: e.address, label: `test evaluator ${e.n.toUpperCase()} (testnet demo)`, keyFile: `.secrets/testnet-test-evaluator-${e.n}.key` };
  if (await read(c.registry, "isActive", [e.address])) {
    log({ skip: "already active", evaluator: e.address });
    continue;
  }
  if ((await publicClient.getBalance({ address: e.address })) < GAS_ETH)
    await tx(`ETH deployer->test evaluator ${e.n.toUpperCase()} (gas)`, deployer.account.address, async () => {
      const hash = await deployer.sendTransaction({ to: e.address, value: GAS_ETH });
      return { hash, receipt: await publicClient.waitForTransactionReceipt({ hash }) };
    });
  if ((await read(c.usdc, "balanceOf", [e.address])) < minStake) await tx(`USDC deployer->test evaluator ${e.n.toUpperCase()} (minStake)`, deployer.account.address, () => send(deployer, c.usdc, "transfer", [e.address, minStake]));
  const w = wallet(e.pk);
  await tx(`USDC test evaluator ${e.n.toUpperCase()} approve registry`, e.address, () => send(w, c.usdc, "approve", [c.registry.address, minStake]));
  await tx(`EvaluatorRegistry.stake(minStake) by test evaluator ${e.n.toUpperCase()}`, e.address, () => send(w, c.registry, "stake", [minStake]));
  if (!dry) log({ evaluator: e.address, active: await read(c.registry, "isActive", [e.address]), stake: (await read(c.registry, "stakeOf", [e.address])).toString() });
}
if (!dry) save();
