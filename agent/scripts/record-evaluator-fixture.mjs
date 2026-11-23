#!/usr/bin/env node
// READ-ONLY: records Base Sepolia EvaluatorRegistry Staked events and current evaluatorInfo/isActive/minStake into
// test/fixtures/evaluators-base-sepolia.json for the onboarding listing test. eth_call / eth_getTransactionReceipt /
// eth_getBlockByNumber only; no key is loaded and nothing is sent.
// Usage: node scripts/record-evaluator-fixture.mjs <stakeTxHash>...   (tx hashes of Staked events to record)
import { writeFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, getAddress, parseEventLogs } from "viem";
import { baseSepolia } from "viem/chains";

const REGISTRY = "0x30576DE005df028D1947C56dEcc85a2a5612036a";
const abi = parseAbi([
  "function minStake() view returns (uint256)",
  "function isActive(address) view returns (bool)",
  "function evaluatorInfo(address) view returns ((uint256 stake,uint256 exposure,uint32 openJobs,uint64 unbondingEndsAt,uint256 slashedTotal))",
  "event Staked(address indexed evaluator, uint256 amount, uint256 newStake)",
]);
const pc = createPublicClient({ chain: baseSepolia, transport: http(process.env.RPC_URL ?? "https://sepolia.base.org") });
const block = await pc.getBlockNumber();
const events = [];
for (const hash of process.argv.slice(2)) {
  const rc = await pc.getTransactionReceipt({ hash });
  const ts = (await pc.getBlock({ blockNumber: rc.blockNumber })).timestamp;
  for (const l of parseEventLogs({ abi, logs: rc.logs.filter((x) => getAddress(x.address) === REGISTRY), eventName: "Staked" }))
    events.push({ evaluator: getAddress(l.args.evaluator), amount: l.args.amount.toString(), newStake: l.args.newStake.toString(), txHash: hash, blockNumber: rc.blockNumber.toString(), timestamp: Number(ts), status: rc.status });
}
const addrs = [...new Set([...events.map((e) => e.evaluator), ...(process.env.EXTRA_ADDRESSES ?? "").split(",").filter(Boolean).map(getAddress)])];
const snapshots = {};
for (const a of addrs) {
  const [i, active] = await Promise.all([pc.readContract({ address: REGISTRY, abi, functionName: "evaluatorInfo", args: [a], blockNumber: block }), pc.readContract({ address: REGISTRY, abi, functionName: "isActive", args: [a], blockNumber: block })]);
  snapshots[a] = { active, stake: i.stake.toString(), exposure: i.exposure.toString(), openJobs: Number(i.openJobs), unbondingEndsAt: i.unbondingEndsAt.toString(), slashedTotal: i.slashedTotal.toString() };
}
const minStake = (await pc.readContract({ address: REGISTRY, abi, functionName: "minStake", blockNumber: block })).toString();
const out = { v: "agentkoin-evaluator-fixture/v1", chainId: 84532, registry: REGISTRY, recordedAtBlock: block.toString(), recordedAt: new Date().toISOString(), source: "Base Sepolia public RPC, read-only", minStake, events, snapshots };
writeFileSync(new URL("../test/fixtures/evaluators-base-sepolia.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ recordedAtBlock: out.recordedAtBlock, events: events.length, addresses: addrs.length }));
