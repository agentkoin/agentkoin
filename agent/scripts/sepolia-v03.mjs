#!/usr/bin/env node
// v0.3 Base Sepolia TESTNET scenario runner (also runs against a loopback anvil fork of Base Sepolia for rehearsal).
// Phases (run in order, each records every tx in the state file):
//   fund      ETH gas top-ups deployer->provider/evaluator; USDC deployer->evaluator (stake) and ->provider (challenge bond)
//   dispute   escrow job -> submit -> Reject verdict -> provider challenge -> MockArbitrator.giveRuling(10000) (overturn)
//   route     EscrowDepositRouteFactory.deploy(offer) for the x402 demo offer (route instance)
//   x402      start local x402 server (127.0.0.1), pay it with x402/pay-client.mjs (EIP-3009, Circle test USDC), evaluator verdict
//   adapter   deploy MockERC8183Kernel (MOCK), adapter.setConfig(short testnet windows), kernel job -> assign/accept/submit/verdict
//   finalize  after the 600 s challenge windows: escrow.finalize(x402 job), adapter.finalize(adapter job)
// Usage: AGENTCOIN_NETWORK=base-sepolia [RPC_URL=http://127.0.0.1:8546] node scripts/sepolia-v03.mjs <phase>
// Keys: .secrets/testnet-*.key via roleKey(); never printed. Stops on the first failure (no blind retries of broadcasts).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { keccak256, toBytes, parseEventLogs, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT, NETWORK, RPC_URL, CHAIN_ID, roleKey, isLoopback, ABI, AGENT_DIR } from "../lib/config.mjs";
import { publicClient, wallet, contracts, send, read, assertChain, increaseTime, fmt6, feeOverrides } from "../lib/chain.mjs";

if (NETWORK !== "base-sepolia") throw new Error("AGENTCOIN_NETWORK=base-sepolia required");
await assertChain();
const FORK = isLoopback(RPC_URL);
const STATE = path.join(ROOT, "deployments", FORK ? "fork-base-sepolia-v03.json" : "base-sepolia-v03.json");
const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { network: NETWORK, chainId: CHAIN_ID, fork: FORK, txs: [], phases: {} };
const save = () => writeFileSync(STATE, JSON.stringify(st, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
const c = contracts();
const W = { deployer: wallet(roleKey("deployer")), provider: wallet(roleKey("provider")), evaluator: wallet(roleKey("evaluator")) };
const A = Object.fromEntries(Object.entries(W).map(([k, w]) => [k, w.account.address]));
const usdcBal = (a) => read(c.usdc, "balanceOf", [a]);
const stakeOf = async (a) => (await read(c.registry, "evaluatorInfo", [a])).stake;
const log = (...x) => console.log(...x);

async function tx(phase, label, w, contract, fn, args) {
  const r = await send(w, contract, fn, args);
  const rec = { phase, label, hash: r.hash, from: w.account.address, block: r.receipt.blockNumber, gasUsed: r.receipt.gasUsed, effectiveGasPrice: r.receipt.effectiveGasPrice, l1Fee: r.receipt.l1Fee ?? null };
  st.txs.push(rec);
  save();
  log(`  ${label}: ${r.hash} (gas ${r.receipt.gasUsed})`);
  return r;
}
async function ethTx(phase, label, w, to, value) {
  const hash = await w.sendTransaction({ to, value, ...(await feeOverrides()) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed ${hash}`);
  st.txs.push({ phase, label, hash, from: w.account.address, block: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, l1Fee: receipt.l1Fee ?? null, value });
  save();
  log(`  ${label}: ${hash}`);
  return receipt;
}
const done = (p) => { if (st.phases[p]?.done) { log(`phase ${p} already done; skipping`); return true; } return false; };
async function snap(extra = {}) {
  const out = {};
  for (const [k, a] of Object.entries({ ...A, ...extra })) out[k] = (await usdcBal(a)).toString();
  return out;
}
const diff = (b, a) => Object.fromEntries(Object.keys(a).map((k) => [k, fmt6(BigInt(a[k]) - BigInt(b[k]))]));

const phase = process.argv[2];
log(`network ${NETWORK} chainId ${CHAIN_ID} rpc ${FORK ? "loopback fork" : RPC_URL} phase ${phase}`);
log(`ETH: ${Object.entries(A).map(([k, a]) => k).join(",")}`, (await Promise.all(Object.values(A).map((a) => publicClient.getBalance({ address: a })))).map(String).join(" "));

if (phase === "fund" && !done("fund")) {
  const P = "fund";
  const PROVIDER_ETH = BigInt(process.env.PROVIDER_TOPUP_WEI ?? "30000000000000"); // 0.00003 ETH
  const EVALUATOR_ETH = BigInt(process.env.EVALUATOR_TOPUP_WEI ?? "20000000000000"); // 0.00002 ETH
  await ethTx(P, "ETH deployer->provider (gas)", W.deployer, A.provider, PROVIDER_ETH);
  await ethTx(P, "ETH deployer->evaluator (gas)", W.deployer, A.evaluator, EVALUATOR_ETH);
  await tx(P, "USDC deployer->evaluator 2 (extra stake)", W.deployer, c.usdc, "transfer", [A.evaluator, 2_000_000n]);
  await tx(P, "USDC evaluator approve registry 2", W.evaluator, c.usdc, "approve", [c.registry.address, 2_000_000n]);
  await tx(P, "EvaluatorRegistry.stake(2) by evaluator", W.evaluator, c.registry, "stake", [2_000_000n]);
  await tx(P, "USDC deployer->provider 1 (challenge bond)", W.deployer, c.usdc, "transfer", [A.provider, 1_000_000n]);
  st.phases[P] = { done: true, evaluatorStake: (await stakeOf(A.evaluator)).toString() };
  save();
}

if (phase === "dispute" && !done("dispute")) {
  const P = "dispute";
  const AMOUNT = 1_000_000n;
  const before = await snap({ mockArbitrator: c.arbitrator.address, escrow: c.escrow.address });
  const stake0 = await stakeOf(A.evaluator);
  const deadline = (await publicClient.getBlock()).timestamp + 86400n;
  await tx(P, "USDC client approve escrow 1", W.deployer, c.usdc, "approve", [c.escrow.address, AMOUNT]);
  const cr = await tx(P, "JobEscrow.createAndFund (dispute job)", W.deployer, c.escrow, "createAndFund", [A.provider, A.evaluator, AMOUNT, deadline, keccak256(toBytes("agentcoin v0.3 smoke: dispute path"))]);
  const jobId = parseEventLogs({ abi: ABI.escrow, logs: cr.receipt.logs, eventName: "JobCreated" })[0].args.jobId;
  log(`  jobId ${jobId}`);
  await tx(P, "JobEscrow.submit", W.provider, c.escrow, "submit", [jobId, keccak256(toBytes("v0.3 dispute deliverable"))]);
  await tx(P, "JobEscrow.verdict Reject 0", W.evaluator, c.escrow, "verdict", [jobId, 2, 0, keccak256(toBytes("evaluator: does not meet spec"))]);
  const q = await read(c.escrow, "quote", [AMOUNT, 0n]);
  const upfront = q[3] + q[4];
  log(`  challenge bond ${fmt6(q[3])} + arbitration ${fmt6(q[4])}`);
  await tx(P, "USDC provider approve escrow (bond+arb)", W.provider, c.usdc, "approve", [c.escrow.address, upfront]);
  await tx(P, "JobEscrow.challenge by provider", W.provider, c.escrow, "challenge", [jobId, keccak256(toBytes("provider: deliverable meets spec"))]);
  const d = await read(c.escrow, "getDispute", [jobId]);
  log(`  disputeId ${d.disputeId}`);
  const mid = await snap({ mockArbitrator: c.arbitrator.address, escrow: c.escrow.address });
  const rl = await tx(P, "MockArbitrator.giveRuling(disputeId, 10000)", W.deployer, c.arbitrator, "giveRuling", [d.disputeId, 10000]);
  const after = await snap({ mockArbitrator: c.arbitrator.address, escrow: c.escrow.address });
  const j = await read(c.escrow, "getJob", [jobId]);
  const events = parseEventLogs({ abi: [...ABI.escrow, ...ABI.registry], logs: rl.receipt.logs }).map((e) => ({ event: e.eventName, args: e.args }));
  st.phases[P] = {
    done: true, jobId, disputeId: d.disputeId, amount: AMOUNT, challengeBond: q[3], arbitrationFee: q[4],
    state: j.state, payoutBps: j.payoutBps,
    evaluatorStakeBefore: stake0, evaluatorStakeAfter: await stakeOf(A.evaluator),
    usdcDeltaFromStart: diff(before, after), usdcDeltaAtRuling: diff(mid, after), rulingEvents: events,
  };
  save();
  log(JSON.stringify(st.phases[P], (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
}

async function x402Offer() {
  process.env.DEMO_PRICE ??= "1000000";
  const mod = await import("../x402/server.mjs");
  return mod;
}

if (phase === "route" && !done("route")) {
  const P = "route";
  const { offer } = await x402Offer();
  const o = offer();
  const predicted = await read(c.routeFactory, "routeFor", [o]);
  const r = await tx(P, "EscrowDepositRouteFactory.deploy(offer)", W.provider, c.routeFactory, "deploy", [o]);
  const ev = parseEventLogs({ abi: ABI.routeFactory, logs: r.receipt.logs, eventName: "RouteDeployed" })[0];
  st.phases[P] = { done: true, route: ev.args.route, predicted, offer: o, sweepTo: await read(c.routeFactory, "sweepTo").catch(() => null), block: r.receipt.blockNumber };
  if (getAddress(ev.args.route) !== getAddress(predicted)) throw new Error("route != routeFor");
  save();
  log(`  route ${ev.args.route}`);
}

if (phase === "x402" && !done("x402")) {
  const P = "x402";
  const PORT = process.env.X402_PORT ?? "4020";
  const before = await snap({ route: st.phases.route.route, escrow: c.escrow.address });
  const child = spawn(process.execPath, [path.join(AGENT_DIR, "x402", "server.mjs")], { env: { ...process.env, DEMO_PRICE: process.env.DEMO_PRICE ?? "1000000", X402_PORT: PORT }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((res, rej) => { child.stdout.on("data", (b) => { if (String(b).includes("listening")) res(); }); child.on("exit", (code) => rej(new Error(`server exited ${code}`))); });
  let out;
  try {
    const { payExact } = await import("../x402/pay-client.mjs");
    out = await payExact(`http://127.0.0.1:${PORT}/v1/demo/resource`, { log: (x) => log("  client:", JSON.stringify(x)) });
  } finally {
    child.kill();
  }
  const pr = out.paymentResponse;
  const jobId = BigInt(pr.extensions.agentcoin.jobId);
  for (const [label, h] of [["x402 settle: EscrowDepositRouteFactory.settle (EIP-3009 transferWithAuthorization + createAndFundFor)", pr.transaction], ["x402 provider JobEscrow.submit", pr.extensions.agentcoin.submitTx]]) {
    const rc = await publicClient.getTransactionReceipt({ hash: h });
    st.txs.push({ phase: P, label, hash: h, from: rc.from, block: rc.blockNumber, gasUsed: rc.gasUsed, effectiveGasPrice: rc.effectiveGasPrice, l1Fee: rc.l1Fee ?? null });
    log(`  ${label}: ${h}`);
  }
  save();
  const mid = await snap({ route: st.phases.route.route, escrow: c.escrow.address });
  const v = await tx(P, "JobEscrow.verdict Complete 10000 (x402 job)", W.evaluator, c.escrow, "verdict", [jobId, 1, 10000, keccak256(toBytes("evaluator: meets spec"))]);
  const vb = await publicClient.getBlock({ blockNumber: v.receipt.blockNumber });
  const j = await read(c.escrow, "getJob", [jobId]);
  const cfg = await read(c.escrow, "config", [j.configVersion]);
  st.phases[P] = { done: true, jobId, payer: out.payer, client: j.client, resource: out.resource, paymentResponse: pr, usdcDeltaAtSettle: diff(before, mid), verdictAt: vb.timestamp, finalizableAfter: vb.timestamp + cfg.challengeWindow };
  save();
  log(JSON.stringify(st.phases[P], (_, v2) => (typeof v2 === "bigint" ? v2.toString() : v2), 1));
}

if (phase === "adapter" && !done("adapter")) {
  const P = "adapter";
  const BUDGET = 1_000_000n;
  let kernelAddr = st.phases.adapterKernel?.address;
  if (!kernelAddr) {
    const art = JSON.parse(readFileSync(path.join(ROOT, "out", "MockERC8183Kernel.sol", "MockERC8183Kernel.json"), "utf8"));
    const args = [c.usdc.address, A.deployer, 100n, 50n];
    const hash = await W.deployer.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args, ...(await feeOverrides()) });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`kernel deploy failed ${hash}`);
    kernelAddr = rc.contractAddress;
    st.txs.push({ phase: P, label: "deploy MockERC8183Kernel (MOCK, test only)", hash, from: A.deployer, block: rc.blockNumber, gasUsed: rc.gasUsed, effectiveGasPrice: rc.effectiveGasPrice, l1Fee: rc.l1Fee ?? null });
    st.phases.adapterKernel = { address: kernelAddr, deployTx: hash, block: rc.blockNumber, gasUsed: rc.gasUsed, constructorArgs: { token: c.usdc.address, treasury: A.deployer, platformFeeBP: 100, evaluatorFeeBP: 50 } };
    save();
    log(`  kernel ${kernelAddr} (${hash})`);
  }
  const kernel = { address: kernelAddr, abi: ABI.kernel };
  const cur = await read(c.adapter, "currentConfig");
  const short = { ...cur, evalWindow: 3600n, challengeWindow: 600n, arbitrationTimeout: 3600n, expiryMargin: 600n };
  if (cur.challengeWindow !== 600n) {
    await tx(P, "ERC8183EvaluatorAdapter.setConfig (testnet-short windows)", W.deployer, c.adapter, "setConfig", [short]);
  }
  const version = await read(c.adapter, "currentConfigVersion");
  const required = await read(c.adapter, "requiredExpiryDuration", [version]);
  const now = (await publicClient.getBlock()).timestamp;
  const expiredAt = now + required + 900n;
  const before = await snap({ kernel: kernelAddr });
  const kc = await tx(P, "Kernel.createJob (evaluator = adapter)", W.deployer, kernel, "createJob", [A.provider, c.adapter.address, expiredAt, "agentcoin v0.3 adapter smoke job", "0x0000000000000000000000000000000000000000"]);
  const kjId = parseEventLogs({ abi: ABI.kernel, logs: kc.receipt.logs, eventName: "JobCreated" })[0].args.jobId;
  await tx(P, "Kernel.setBudget 1", W.deployer, kernel, "setBudget", [kjId, BUDGET, "0x"]);
  await tx(P, "USDC client approve kernel 1", W.deployer, c.usdc, "approve", [kernelAddr, BUDGET]);
  await tx(P, "Kernel.fund", W.deployer, kernel, "fund", [kjId, BUDGET, "0x"]);
  const as = await tx(P, "Adapter.assign(kernel, job, evaluator)", W.deployer, c.adapter, "assign", [kernelAddr, kjId, A.evaluator]);
  const aid = parseEventLogs({ abi: ABI.adapter, logs: as.receipt.logs, eventName: "Assigned" })[0].args.id;
  await tx(P, "Adapter.acceptAssignment (evaluator)", W.evaluator, c.adapter, "acceptAssignment", [aid]);
  await tx(P, "Kernel.submit (provider)", W.provider, kernel, "submit", [kjId, keccak256(toBytes("v0.3 adapter deliverable")), "0x"]);
  const vd = await tx(P, "Adapter.verdict 10000 (evaluator)", W.evaluator, c.adapter, "verdict", [aid, 10000, keccak256(toBytes("evaluator: meets spec"))]);
  const vb = await publicClient.getBlock({ blockNumber: vd.receipt.blockNumber });
  st.phases[P] = { done: true, kernel: kernelAddr, kernelJobId: kjId, adapterJobId: aid, configVersion: version, config: short, requiredExpiryDuration: required, expiredAt, verdictAt: vb.timestamp, finalizableAfter: vb.timestamp + 600n, usdcBefore: before };
  save();
  log(`  adapter job ${aid} kernel job ${kjId}; finalizable after ${vb.timestamp + 600n}`);
}

if (phase === "finalize" && !done("finalize")) {
  const P = "finalize";
  const target = BigInt(Math.max(Number(st.phases.x402.finalizableAfter), Number(st.phases.adapter.finalizableAfter))) + 2n;
  let now = (await publicClient.getBlock()).timestamp;
  if (now <= target) {
    if (FORK) await increaseTime(Number(target - now) + 1);
    else throw new Error(`not yet: chain time ${now}, finalizable after ${target} (${target - now}s)`);
  }
  const kernelAddr = st.phases.adapter.kernel;
  const kernel = { address: kernelAddr, abi: ABI.kernel };
  const b = await snap({ kernel: kernelAddr, escrow: c.escrow.address });
  const fx = await tx(P, "JobEscrow.finalize (x402 job)", W.deployer, c.escrow, "finalize", [BigInt(st.phases.x402.jobId)]);
  const m = await snap({ kernel: kernelAddr, escrow: c.escrow.address });
  const fa = await tx(P, "Adapter.finalize (-> kernel.complete)", W.deployer, c.adapter, "finalize", [BigInt(st.phases.adapter.adapterJobId)]);
  const a = await snap({ kernel: kernelAddr, escrow: c.escrow.address });
  const xj = await read(c.escrow, "getJob", [BigInt(st.phases.x402.jobId)]);
  const aj = await read(c.adapter, "getJob", [BigInt(st.phases.adapter.adapterJobId)]);
  const kj = await read(kernel, "getJob", [BigInt(st.phases.adapter.kernelJobId)]);
  st.phases[P] = { done: true, x402Job: { state: xj.state, payoutBps: xj.payoutBps, usdcDelta: diff(b, m) }, adapterJob: { state: aj.state, kernelStatus: kj.status, usdcDelta: diff(m, a) }, evaluatorInfo: await read(c.registry, "evaluatorInfo", [A.evaluator]) };
  save();
  log(JSON.stringify(st.phases[P], (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
}

if (phase === "summary") {
  let gas = 0n, fee = 0n;
  for (const t of st.txs) { gas += BigInt(t.gasUsed); fee += BigInt(t.gasUsed) * BigInt(t.effectiveGasPrice) + BigInt(t.l1Fee ?? 0); }
  log(JSON.stringify({ txs: st.txs.length, gas: gas.toString(), feeWei: fee.toString(), byPhase: Object.entries(st.txs.reduce((m, t) => ((m[t.phase] = (m[t.phase] ?? 0n) + BigInt(t.gasUsed)), m), {})).map(([k, v]) => `${k}:${v}`) }));
}
process.exit(0);
