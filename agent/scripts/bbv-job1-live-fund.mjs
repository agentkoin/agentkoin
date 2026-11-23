#!/usr/bin/env node
// LIVE Base Sepolia only: USDC.approve + JobEscrow.createAndFund for bbv-job1.
// Requires CONFIRM=1. Never prints keys. Refuses any chain other than 84532.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { ROOT, CHAIN_ID, RPC_URL } from "../lib/config.mjs";
import { assertChain, contracts, read, send, wallet, publicClient, feeOverrides } from "../lib/chain.mjs";

const DIR = path.join(ROOT, "jobs", "bbv-job1");
const ESCROW_EXPECT = "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D";
const USDC_EXPECT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PROVIDER = "0x745528C4E0CBdA5759175A660da06d0aaA72db7F";
const EVAL = "0xB87b0d6AD3B17A8a1795d6640317c7997140d140";
const AMOUNT = 1_000_000n;
const DEADLINE_SECS = 604800n;
const RESERVE_WEI = 80_000_000_000_000n; // 0.00008 ETH, same reserve used when funding the evaluator
const log = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v)));

if (CHAIN_ID !== 84532) throw new Error(`refusing chainId ${CHAIN_ID}`);
if (process.env.CONFIRM !== "1") throw new Error("refusing to broadcast: set CONFIRM=1");
if (new URL(RPC_URL).hostname === "127.0.0.1" || new URL(RPC_URL).hostname === "localhost") {
  throw new Error("refusing loopback RPC for a live send");
}

const respPath = path.join(DIR, "criteria-commit-response.json");
if (!existsSync(respPath)) throw new Error("missing criteria-commit-response.json; POST criteria first");
const resp = JSON.parse(readFileSync(respPath, "utf8"));
const proposed = JSON.parse(readFileSync(path.join(DIR, "hashes.json"), "utf8")).specHashProposed;
const rawId = resp.criteria_id ?? resp.criteriaId ?? resp.sha256 ?? resp.id;
if (!rawId || typeof rawId !== "string") throw new Error(`no criteria_id in POST response; keys=${Object.keys(resp)}`);
const specHash = (rawId.startsWith("0x") ? rawId : "0x" + rawId).toLowerCase();
if (!/^0x[0-9a-f]{64}$/.test(specHash)) throw new Error(`criteria_id is not a 32-byte hex sha256: ${specHash.slice(0, 18)}…`);
if (specHash !== proposed.toLowerCase()) {
  log({ warning: "criteria_id differs from proposed sha256 of criteria.json; using the API's criteria_id", proposed, criteria_id: specHash });
}

await assertChain();
const c = contracts();
if (getAddress(c.escrow.address) !== getAddress(ESCROW_EXPECT)) throw new Error("escrow address mismatch");
if (getAddress(c.usdc.address) !== getAddress(USDC_EXPECT)) throw new Error("usdc address mismatch");

const key = readFileSync(path.join(ROOT, ".secrets", "testnet-deployer.key"), "utf8").trim();
const w = wallet(key);
const from = getAddress(w.account.address);
if (from !== getAddress("0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e")) throw new Error("deployer key does not match expected address");

const active = await read(c.registry, "isActive", [EVAL]);
if (!active) throw new Error("evaluator is not isActive on the registry");
const jobCount = await read(c.escrow, "jobCount", []);
const ts = BigInt((await publicClient.getBlock()).timestamp);
const deadline = ts + DEADLINE_SECS;
const eth = await publicClient.getBalance({ address: from });
const usdc = await read(c.usdc, "balanceOf", [from]);
const fees = await feeOverrides();
log({
  rpc: new URL(RPC_URL).host,
  from,
  jobCount: jobCount.toString(),
  nextJobId: (jobCount + 1n).toString(),
  deadline: deadline.toString(),
  specHash,
  balances: { eth: eth.toString(), usdc: usdc.toString() },
  fees: { maxFeePerGas: fees.maxFeePerGas?.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas?.toString() },
});
if (usdc < AMOUNT) throw new Error("deployer USDC short");
// ~360k gas * maxFee * 2 buffer
const gasCap = 400_000n;
const costCap = gasCap * (fees.maxFeePerGas ?? 1_000_000n) * 2n;
if (eth < costCap) throw new Error(`deployer ETH short for conservative cap ${costCap} (have ${eth})`);
if (eth - costCap < 0n) throw new Error("eth math");
// keep a reserve after the txs so we are not stranded
if (eth < costCap + 20_000_000_000_000n) {
  // still allow if conservative cap fits, but warn; the earlier fund script reserved 0.00008
  log({ note: "ETH is below the 0.00008 reserve plus cap; proceeding only because conservative cap still fits", reserve: RESERVE_WEI.toString(), costCap: costCap.toString(), eth: eth.toString() });
}

const t1 = await send(w, c.usdc, "approve", [c.escrow.address, AMOUNT]);
log({ approve: { hash: t1.hash, status: t1.receipt.status, gasUsed: t1.receipt.gasUsed.toString(), costWei: t1.costWei.toString() } });
const t2 = await send(w, c.escrow, "createAndFund", [PROVIDER, EVAL, AMOUNT, deadline, specHash]);
log({ createAndFund: { hash: t2.hash, status: t2.receipt.status, gasUsed: t2.receipt.gasUsed.toString(), costWei: t2.costWei.toString() } });

const newCount = await read(c.escrow, "jobCount", []);
const jobId = newCount;
const job = await read(c.escrow, "getJob", [jobId]);
const after = { eth: (await publicClient.getBalance({ address: from })).toString(), usdc: (await read(c.usdc, "balanceOf", [from])).toString() };
const out = {
  chainId: 84532,
  jobId: jobId.toString(),
  client: from,
  provider: PROVIDER,
  evaluator: EVAL,
  amount: AMOUNT.toString(),
  deadline: deadline.toString(),
  specHash,
  criteriaIdMatchedProposed: specHash === proposed.toLowerCase(),
  txs: {
    approve: { hash: t1.hash, block: t1.receipt.blockNumber.toString(), status: t1.receipt.status, gasUsed: t1.receipt.gasUsed.toString() },
    createAndFund: { hash: t2.hash, block: t2.receipt.blockNumber.toString(), status: t2.receipt.status, gasUsed: t2.receipt.gasUsed.toString() },
  },
  jobState: typeof job === "object" ? { client: job.client ?? job[0], provider: job.provider ?? job[1], evaluator: job.evaluator ?? job[2], state: job.state ?? job[4], amount: (job.amount ?? job[13])?.toString?.(), specHash: job.specHash ?? job[16] } : String(job),
  balancesAfter: after,
};
writeFileSync(path.join(DIR, "live-fund.json"), JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
log({ wrote: "jobs/bbv-job1/live-fund.json", jobId: out.jobId, balancesAfter: after });
if (getAddress(out.jobState.evaluator) !== getAddress(EVAL)) throw new Error("funded job evaluator mismatch");
if ((out.jobState.specHash || "").toLowerCase() !== specHash) throw new Error("funded job specHash mismatch");
