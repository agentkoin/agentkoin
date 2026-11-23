#!/usr/bin/env node
// AD-011 (b): on the existing deployer-owned JobEscrows (USDC + EURC, Base Sepolia), set arbitrator = address(0)
// (challenge() then reverts NoArbitrator; nobody can overturn a verdict) and treasury = 0x...dEaD (no STOS fee/bond
// recipient). Simulates each call first; DRY_RUN=1 (default) stops after simulation. Deployer key read from .secrets,
// never printed. Appends tx hashes and read-backs to deployments/base-sepolia-ad011.json.
// Usage: AGENTCOIN_NETWORK=base-sepolia DRY_RUN=0 node scripts/remove-escrow-admin-levers.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress, zeroAddress } from "viem";
import { ROOT, CHAIN_ID } from "../lib/config.mjs";
import { contracts, read, send, wallet, publicClient } from "../lib/chain.mjs";

if (CHAIN_ID !== 84532) throw new Error(`Base Sepolia only (chainId ${CHAIN_ID})`);
const dry = process.env.DRY_RUN !== "0";
const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");
const deployer = wallet(readFileSync(path.join(ROOT, ".secrets", "testnet-deployer.key"), "utf8").trim());
const c = contracts();
const multi = JSON.parse(readFileSync(path.join(ROOT, "deployments", "base-sepolia-multiasset.json"), "utf8"));
const escrows = [
  { name: "JobEscrow (USDC)", address: c.escrow.address },
  { name: "JobEscrow (EURC)", address: multi.contracts.JobEscrowEURC.address },
];
const out = path.join(ROOT, "deployments", "base-sepolia-ad011.json");
const rec = JSON.parse(readFileSync(out, "utf8"));
rec.adminLevers ??= { task: "AD-011 (b): arbitrator -> address(0), treasury -> 0x...dEaD on deployer-owned escrows", escrows: {} };
const log = (o) => console.log(JSON.stringify(o));
const state = async (a) => {
  const e = { ...c.escrow, address: a };
  return { owner: await read(e, "owner"), treasury: await read(e, "treasury"), arbitrator: await read(e, "arbitrator"), jobCount: (await read(e, "jobCount")).toString() };
};
for (const x of escrows) {
  const e = { ...c.escrow, address: x.address };
  const before = await state(x.address);
  log({ escrow: x.name, address: x.address, before });
  if (getAddress(before.owner) !== getAddress(deployer.account.address)) { log({ skip: "deployer is not owner", escrow: x.address }); continue; }
  const r = (rec.adminLevers.escrows[x.address] ??= { name: x.name, before, txs: [] });
  for (const [fn, arg] of [["setArbitrator", zeroAddress], ["setTreasury", DEAD]]) {
    const cur = fn === "setArbitrator" ? before.arbitrator : before.treasury;
    if (getAddress(cur) === getAddress(arg)) { log({ skip: `${fn} already ${arg}` }); continue; }
    await publicClient.simulateContract({ ...e, functionName: fn, args: [arg], account: deployer.account });
    const gas = await publicClient.estimateContractGas({ ...e, functionName: fn, args: [arg], account: deployer.account });
    log({ simulated: fn, escrow: x.address, arg, gas: gas.toString() });
    if (dry) continue;
    const s = await send(deployer, e, fn, [arg]);
    const t = { fn, arg, hash: s.hash, block: s.receipt.blockNumber.toString(), status: s.receipt.status };
    r.txs.push(t); writeFileSync(out, JSON.stringify(rec, null, 2) + "\n"); log(t);
  }
  if (!dry) { r.after = await state(x.address); writeFileSync(out, JSON.stringify(rec, null, 2) + "\n"); log({ escrow: x.address, after: r.after }); }
}
