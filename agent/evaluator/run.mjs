#!/usr/bin/env node
// AD-011 Fix 1: standalone test evaluator for the AgentCoin notary spec (testnet demo). Runs as its own process with its
// own key; it shares no key or process with the service (relayer / provider / reference evaluator / deployer).
// It only decides jobs whose on-chain evaluator is its own address (the buyer named it in the signed job terms).
//
// Check (agentcoin-notary/v1): GET <SERVICE_URL>/v1/notarize/<jobId> returns the receipt; the evaluator recomputes
// keccak256(RFC8785(receipt)) and compares it with JobEscrow.getJob(jobId).deliverableHash, and checks the receipt's
// chainId / escrow / jobId / client against the chain and that receipt.settleTx emitted JobCreated(jobId) on the escrow.
// Pass -> verdict Complete (10000 bps). Mismatch, or no verifiable receipt before 90% of evalWindow -> Reject (0 bps).
//
// Env: EVALUATOR_KEY_FILE (required; never printed), RPC_URL, ESCROW, SERVICE_URL, SPEC_HASH (optional filter),
//      POLL_MS (default 5000), START_BLOCK (default latest - 5000), MAX_LOG_RANGE (default 2000), ONCE=1 (single pass).
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, getAddress, keccak256, toBytes, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { jcs } from "../lib/canonical.mjs";

const ESCROW_ABI = parseAbi([
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 amount, uint64 deadline, bytes32 specHash, uint32 configVersion)",
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverableHash)",
  "function getJob(uint256) view returns ((address client,address provider,address evaluator,uint32 configVersion,uint8 state,uint8 outcome,bool accepted,bool instant,uint16 payoutBps,uint64 deadline,uint64 submittedAt,uint64 verdictAt,uint64 disputedAt,uint256 amount,uint256 providerBond,uint256 slashBase,bytes32 specHash,bytes32 deliverableHash,bytes32 reasonHash))",
  "function config(uint32) view returns ((uint256 instantThreshold,uint256 minChallengeBond,uint64 evalWindow,uint64 challengeWindow,uint64 arbitrationTimeout,uint16 challengeBondBps,uint16 missedVerdictSlashBps,uint16 wrongVerdictSlashBps,uint16 materialDiffBps,uint16 feeBps,uint16 failedChallengeEvaluatorShareBps,uint16 instantBondCoverBps,uint16 evaluatorFeeBps))",
  "function verdict(uint256 jobId, uint8 outcome, uint16 payoutBps, bytes32 reasonHash)",
]);
const SUBMITTED = 3;

import { deliverableSha256 } from "../lib/criteria.mjs";
export const receiptHash = (receipt) => keccak256(toBytes(jcs(receipt)));

/** Pure check of a notary receipt against the on-chain job. Returns { ok, reason }. */
export function checkReceipt({ receipt, job, jobId, escrow, chainId, settleLogs }) {
  if (!receipt || typeof receipt !== "object") return { ok: false, reason: "no receipt" };
  if (![receiptHash(receipt), deliverableSha256(receipt)].includes(String(job.deliverableHash).toLowerCase())) return { ok: false, reason: "receipt hash != deliverableHash" };
  if (String(receipt.jobId) !== String(jobId)) return { ok: false, reason: "receipt.jobId mismatch" };
  if (Number(receipt.chainId) !== Number(chainId)) return { ok: false, reason: "receipt.chainId mismatch" };
  if (!receipt.escrow || getAddress(receipt.escrow) !== getAddress(escrow)) return { ok: false, reason: "receipt.escrow mismatch" };
  if (!receipt.client || getAddress(receipt.client) !== getAddress(job.client)) return { ok: false, reason: "receipt.client != job.client" };
  const created = parseEventLogs({ abi: ESCROW_ABI, logs: (settleLogs ?? []).filter((l) => l.address && getAddress(l.address) === getAddress(escrow)), eventName: "JobCreated" });
  if (!created.some((l) => String(l.args.jobId) === String(jobId))) return { ok: false, reason: "settleTx did not create this job" };
  return { ok: true, reason: "receipt hash verified" };
}

export function startEvaluator({ keyFile, rpcUrl, escrow, serviceUrl, specHash = null, pollMs = 5000, startBlock = null, maxRange = 2000n, log = (o) => console.log(JSON.stringify(o)) }) {
  const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim());
  const transport = http(rpcUrl);
  const pub = createPublicClient({ transport });
  const wal = createWalletClient({ account, transport });
  escrow = getAddress(escrow);
  const me = account.address;
  let from = startBlock;
  let stopped = false;
  const decided = new Set();
  const pending = new Map(); // jobId -> first seen
  async function decide(jobId) {
    const job = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "getJob", args: [jobId] });
    if (getAddress(job.evaluator) !== me || job.state !== SUBMITTED) return pending.delete(String(jobId));
    if (specHash && job.specHash.toLowerCase() !== specHash.toLowerCase()) return pending.delete(String(jobId)); // not a notary job
    const cfg = await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "config", args: [job.configVersion] });
    const now = Number((await pub.getBlock()).timestamp);
    const windowEnd = Number(job.submittedAt) + Number(cfg.evalWindow);
    if (now > windowEnd) return pending.delete(String(jobId));
    let res;
    try {
      const r = await fetch(`${serviceUrl.replace(/\/$/, "")}/v1/notarize/${jobId}`, { signal: AbortSignal.timeout(10_000) });
      const body = r.ok ? await r.json() : null;
      const settleTx = body?.receipt?.settleTx;
      const rc = settleTx ? await pub.getTransactionReceipt({ hash: settleTx }).catch(() => null) : null;
      res = checkReceipt({ receipt: body?.receipt, job, jobId, escrow, chainId: await pub.getChainId(), settleLogs: rc?.logs });
    } catch (e) {
      res = { ok: false, reason: `fetch: ${String(e.message).slice(0, 80)}`, retry: true };
    }
    const late = now > Number(job.submittedAt) + Math.floor(Number(cfg.evalWindow) * 0.9);
    if (!res.ok && (res.retry || res.reason === "no receipt") && !late) return; // retry next poll
    const outcome = res.ok ? 1 : 2;
    const reasonHash = keccak256(toBytes(`agentcoin-notary/v1 ${res.reason} by ${me}`));
    const hash = await wal.writeContract({ address: escrow, abi: ESCROW_ABI, functionName: "verdict", args: [jobId, outcome, res.ok ? 10000 : 0, reasonHash], chain: null });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    decided.add(String(jobId));
    pending.delete(String(jobId));
    log({ t: new Date().toISOString(), evt: "verdict", evaluator: me, jobId: String(jobId), outcome: res.ok ? "Complete" : "Reject", reason: res.reason, tx: hash, status: rcpt.status });
  }
  async function pass() {
    const latest = await pub.getBlockNumber();
    if (from == null) from = latest > 5000n ? latest - 5000n : 0n;
    for (let b = from; b <= latest; b += maxRange) {
      const to = b + maxRange - 1n > latest ? latest : b + maxRange - 1n;
      const logs = await pub.getLogs({ address: escrow, fromBlock: b, toBlock: to });
      for (const l of parseEventLogs({ abi: ESCROW_ABI, logs, eventName: "JobSubmitted" })) {
        if (!decided.has(String(l.args.jobId))) pending.set(String(l.args.jobId), Date.now());
      }
    }
    from = latest + 1n;
    for (const id of [...pending.keys()]) {
      try {
        await decide(BigInt(id));
      } catch (e) {
        log({ t: new Date().toISOString(), evt: "error", jobId: id, error: String(e.shortMessage ?? e.message).slice(0, 200) });
      }
    }
  }
  let timer = null;
  const loop = async () => {
    if (stopped) return;
    try {
      await pass();
    } catch (e) {
      log({ t: new Date().toISOString(), evt: "error", error: String(e.shortMessage ?? e.message).slice(0, 200) });
    }
    if (!stopped) timer = setTimeout(loop, pollMs);
  };
  log({ t: new Date().toISOString(), evt: "start", evaluator: me, escrow, serviceUrl });
  loop();
  return { address: me, pass, stop: () => ((stopped = true), timer && clearTimeout(timer)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const e = process.env;
  if (!e.EVALUATOR_KEY_FILE || !e.ESCROW || !e.SERVICE_URL) {
    console.error("EVALUATOR_KEY_FILE, ESCROW and SERVICE_URL are required");
    process.exit(2);
  }
  const ev = startEvaluator({ keyFile: e.EVALUATOR_KEY_FILE, rpcUrl: e.RPC_URL ?? "http://127.0.0.1:8545", escrow: e.ESCROW, serviceUrl: e.SERVICE_URL, specHash: e.SPEC_HASH ?? null, pollMs: Number(e.POLL_MS ?? 5000), startBlock: e.START_BLOCK ? BigInt(e.START_BLOCK) : null, maxRange: BigInt(e.MAX_LOG_RANGE ?? 2000) });
  if (e.ONCE === "1") ev.pass().finally(() => ev.stop());
}
