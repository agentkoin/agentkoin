#!/usr/bin/env node
// Door-knocker v2 budget check: READ-ONLY Base Sepolia balance reads (no txs) vs. the cycle-1 plan. Writes out/v2/budget.json.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, formatEther, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "out", "v2");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// gas estimates (units) from the v0.4 Base Sepolia runs / contract shape; deliberately rounded up
export const GAS = { approve: 60000, createAndFund: 320000, verdict: 120000, finalize: 160000 };
export function needs({ jobs, jobUsdc, x402Usdc, gasPriceWei }) {
  // finalize is permissionless (anyone after the challenge window): the deployer calls it, the evaluator only issues verdicts
  const clientGas = BigInt(jobs) * BigInt(GAS.approve + GAS.createAndFund + GAS.finalize);
  const evalGas = BigInt(jobs) * BigInt(GAS.verdict);
  return { deployerUsdc: jobUsdc + x402Usdc, deployerEthWei: clientGas * gasPriceWei, evaluatorEthWei: evalGas * gasPriceWei };
}
async function main() {
  const plan = JSON.parse(readFileSync(path.join(OUT, "plan.json"), "utf8"));
  const dep = JSON.parse(readFileSync(path.join(HERE, "..", "..", "..", "deployments", "base-sepolia.json"), "utf8"));
  const c = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org") });
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const who = { deployer: dep.deployer, evaluator: "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a", relayer: "0x0a7BFbed71B157Eb3Ce3140CA197f41B43D4877C" };
  const gasPriceWei = await c.getGasPrice(); const block = await c.getBlockNumber();
  const bal = {};
  for (const [k, a] of Object.entries(who)) bal[k] = { address: a, eth: formatEther(await c.getBalance({ address: a })), usdc: formatUnits(await c.readContract({ address: USDC, abi, functionName: "balanceOf", args: [a] }), 6) };
  const stressGas = gasPriceWei * 10n > 100000000n ? gasPriceWei * 10n : 100000000n; // 10x current, floor 0.1 gwei
  const n = needs({ jobs: plan.jobs.count, jobUsdc: Number(plan.jobs.totalUsdcIfAllAccept), x402Usdc: Number(plan.x402.totalUsdcMax), gasPriceWei });
  const s = needs({ jobs: plan.jobs.count, jobUsdc: Number(plan.jobs.totalUsdcIfAllAccept), x402Usdc: Number(plan.x402.totalUsdcMax), gasPriceWei: stressGas });
  const ok = (have, need) => Number(have) >= Number(need);
  const out = {
    readOnly: true, chainId: 84532, block: block.toString(), checkedAt: new Date().toISOString(), gasPriceGwei: Number(gasPriceWei) / 1e9, stressGasPriceGwei: Number(stressGas) / 1e9, balances: bal,
    cycle1: { jobs: plan.jobs.count, jobUsdc: plan.jobs.totalUsdcIfAllAccept, x402Payments: plan.x402.count, x402UsdcMax: plan.x402.totalUsdcMax, sendsCostNoGas: "A2A / MCP knocks are HTTP POSTs (no chain cost)" },
    need: { deployerUsdc: n.deployerUsdc.toFixed(3), deployerEth: formatEther(n.deployerEthWei), deployerEthAt10x: formatEther(s.deployerEthWei), evaluatorEth: formatEther(n.evaluatorEthWei), evaluatorEthAt10x: formatEther(s.evaluatorEthWei) },
    sufficient: { deployerUsdc: ok(bal.deployer.usdc, n.deployerUsdc), deployerEthAt10x: ok(bal.deployer.eth, formatEther(s.deployerEthWei)), evaluatorEth: ok(bal.evaluator.eth, formatEther(n.evaluatorEthWei)), evaluatorEthAt10x: ok(bal.evaluator.eth, formatEther(s.evaluatorEthWei)) },
    note: "x402 exact payments are signed by the deployer (EIP-3009) and settled by the seller's facilitator: no deployer gas. Jobs are opened only after a target accepts, so these are maxima. Our relayer is not used by the knocker.",
  };
  writeFileSync(path.join(OUT, "budget.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => (console.error(e), process.exit(1)));
