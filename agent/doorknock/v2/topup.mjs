#!/usr/bin/env node
// One Carter-approved testnet ETH transfer: deployer -> evaluator (Base Sepolia only), sized for ~10x gas on the (c)
// verdicts. Refuses unless chainId 84532, TOPUP_ACK=deployer-to-evaluator-testnet, and the deployer keeps its reserve.
// Sent once (no retry). Records the tx in out/v2/topup.json.
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, formatEther, getAddress } from "viem";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "out", "v2");
export const EVALUATOR = "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a";
export const TOPUP_WEI = parseEther("0.0001"), DEPLOYER_RESERVE_WEI = parseEther("0.0004");
async function main() {
  const f = path.join(OUT, "topup.json");
  if (existsSync(f)) throw new Error("top-up already done (out/v2/topup.json); approved once");
  process.env.AGENTCOIN_NETWORK = "base-sepolia";
  const chain = await import("../../lib/chain.mjs"); const { roleKey } = await import("../../lib/config.mjs");
  await chain.assertChain();
  if ((await chain.publicClient.getChainId()) !== 84532) throw new Error("not Base Sepolia");
  const w = chain.wallet(roleKey("deployer"));
  const before = { deployer: await chain.publicClient.getBalance({ address: w.account.address }), evaluator: await chain.publicClient.getBalance({ address: EVALUATOR }) };
  if (before.deployer - TOPUP_WEI < DEPLOYER_RESERVE_WEI) throw new Error(`deployer would drop below reserve ${formatEther(DEPLOYER_RESERVE_WEI)} ETH`);
  if (process.env.TOPUP_ACK !== "deployer-to-evaluator-testnet") { console.log(JSON.stringify({ live: false, amount: formatEther(TOPUP_WEI), before: { deployer: formatEther(before.deployer), evaluator: formatEther(before.evaluator) } })); return; }
  const hash = await w.sendTransaction({ to: getAddress(EVALUATOR), value: TOPUP_WEI, ...(await chain.feeOverrides()) });
  const r = await chain.publicClient.waitForTransactionReceipt({ hash });
  const after = { deployer: await chain.publicClient.getBalance({ address: w.account.address }), evaluator: await chain.publicClient.getBalance({ address: EVALUATOR }) };
  const out = { at: new Date().toISOString(), chainId: 84532, from: w.account.address, to: EVALUATOR, amountEth: formatEther(TOPUP_WEI), hash, status: r.status, block: r.blockNumber.toString(), feeEth: formatEther(chain.txCostWei(r)), before: { deployer: formatEther(before.deployer), evaluator: formatEther(before.evaluator) }, after: { deployer: formatEther(after.deployer), evaluator: formatEther(after.evaluator) } };
  writeFileSync(f, JSON.stringify(out, null, 2) + "\n"); console.log(JSON.stringify(out, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => (console.error(e.shortMessage ?? e.message), process.exit(1)));
