#!/usr/bin/env node
// v0.4 "public testnet" Base Sepolia runner (also runs against a loopback anvil fork for rehearsal).
// Phases (each records every tx in the state file; stops on the first failure, no blind rebroadcasts):
//   plan      read-only: balances, gas estimates for every later phase, relayer budget math
//   fee       JobEscrow.setConfig(current config with feeBps = 0, evaluatorFeeBps = 0) by the owner (deployer)
//   fund      ETH deployer -> relayer (service gas), -> provider (submit gas), -> operator (ERC-8004 registration gas)
//   route     EscrowDepositRouteFactory.deploy(notary offer) so the first paid call does not pay route deployment
//   register  operator: official ERC-8004 IdentityRegistry.register() then setAgentURI(agentId, data: URI of the
//             registration JSON that names the agentId). Records agentId in deployments/base-sepolia.json (erc8004)
//   uri       (after public hosting) operator: setAgentURI(agentId, https://<host>/.well-known/agent-registration.json)
//             only after checking that URL serves a registration naming this agentId. Needs AGENTCOIN_HOSTED=1 + https AGENTCOIN_BASE_URL.
// Usage: AGENTCOIN_NETWORK=base-sepolia [RPC_URL=http://127.0.0.1:8546] node scripts/sepolia-v04.mjs <phase>
// Keys: .secrets/testnet-*.key and agent/.keys/operator.json; never printed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseEventLogs, getAddress, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT, NETWORK, RPC_URL, CHAIN_ID, roleKey, isLoopback, ABI } from "../lib/config.mjs";
import { publicClient, wallet, contracts, send, read, assertChain, feeOverrides, txCostWei } from "../lib/chain.mjs";
import { operatorKey } from "../lib/keys.mjs";
import { jcs } from "../lib/canonical.mjs";

if (NETWORK !== "base-sepolia") throw new Error("AGENTCOIN_NETWORK=base-sepolia required");
await assertChain();
const FORK = isLoopback(RPC_URL);
const STATE = path.join(ROOT, "deployments", FORK ? "fork-base-sepolia-v04.json" : "base-sepolia-v04.json");
const DEPLOY = path.join(ROOT, "deployments", "base-sepolia.json");
const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { network: NETWORK, chainId: CHAIN_ID, fork: FORK, txs: [], phases: {} };
const J = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
const save = () => writeFileSync(STATE, J(st));
const OFFICIAL_IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e"; // erc-8004-contracts README, Base Sepolia
const c0 = contracts();
const c = { ...c0, identity: { address: OFFICIAL_IDENTITY, abi: ABI.identity } };
const operator = operatorKey();
const W = { deployer: wallet(roleKey("deployer")), provider: wallet(roleKey("provider")), evaluator: wallet(roleKey("evaluator")), relayer: wallet(roleKey("relayer")), operator: wallet(operator.privateKey) };
const A = Object.fromEntries(Object.entries(W).map(([k, w]) => [k, w.account.address]));
const log = (...x) => console.log(...x);
const RELAYER_WEI = BigInt(process.env.RELAYER_FUND_WEI ?? "150000000000000"); // 0.00015 ETH
const PROVIDER_WEI = BigInt(process.env.PROVIDER_TOPUP_WEI ?? "20000000000000"); // 0.00002 ETH
const OPERATOR_WEI = BigInt(process.env.OPERATOR_FUND_WEI ?? "30000000000000"); // 0.00003 ETH (setAgentURI with a ~1.8 KB data: URI needs ~1.4M gas; simulation needs balance >= gas * maxFee)

async function tx(phase, label, w, contract, fn, args) {
  const r = await send(w, contract, fn, args);
  st.txs.push({ phase, label, hash: r.hash, from: w.account.address, block: r.receipt.blockNumber, gasUsed: r.receipt.gasUsed, effectiveGasPrice: r.receipt.effectiveGasPrice, l1Fee: r.receipt.l1Fee ?? null, costWei: r.costWei });
  save();
  log(`  ${label}: ${r.hash} (gas ${r.receipt.gasUsed}, cost ${r.costWei} wei)`);
  return r;
}
async function ethTx(phase, label, w, to, value) {
  const hash = await w.sendTransaction({ to, value, ...(await feeOverrides()) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed ${hash}`);
  st.txs.push({ phase, label, hash, from: w.account.address, block: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, l1Fee: receipt.l1Fee ?? null, costWei: txCostWei(receipt), value });
  save();
  log(`  ${label}: ${hash}`);
  return receipt;
}
const done = (p) => {
  if (st.phases[p]?.done) {
    log(`phase ${p} already done; skipping`);
    return true;
  }
  return false;
};
const balances = async () => Object.fromEntries(await Promise.all(Object.entries(A).map(async ([k, a]) => [k, (await publicClient.getBalance({ address: a })).toString()])));
const zeroFeeConfig = async () => ({ ...(await read(c.escrow, "currentConfig")), feeBps: 0, evaluatorFeeBps: 0 });

// notary offer: must match service/app.mjs notaryOffer() (price 10000, deadline 3600, SPEC_HASH)
async function notaryOffer() {
  const m = await import("../service/app.mjs");
  return m.notaryOffer();
}

const phase = process.argv[2];
log(`network ${NETWORK} chainId ${CHAIN_ID} rpc ${FORK ? "loopback fork" : RPC_URL} phase ${phase}`);
log("addresses", A);
log("ETH", await balances());

if (phase === "plan") {
  const fees = await feeOverrides();
  const price = fees.maxFeePerGas;
  const est = {};
  const cfg = await zeroFeeConfig();
  est.setConfig = await publicClient.estimateContractGas({ ...c.escrow, functionName: "setConfig", args: [cfg], account: A.deployer });
  est.ethTransfer = 21000n;
  const o = await notaryOffer();
  const route = await read(c.routeFactory, "routeFor", [o]);
  const routeCode = await publicClient.getCode({ address: route });
  est.routeDeploy = routeCode ? 0n : await publicClient.estimateContractGas({ ...c.routeFactory, functionName: "deploy", args: [o], account: A.deployer });
  est.register = await publicClient.estimateGas({ account: A.operator, to: OFFICIAL_IDENTITY, data: encodeFunctionData({ abi: ABI.identity, functionName: "register", args: [] }) }).catch((e) => `estimate failed: ${e.shortMessage}`);
  log({ gasPriceMaxFeeWei: price, notaryRoute: route, routeDeployed: !!routeCode, est });
  log("per paid call (measured v0.3 at 0.006 gwei): settle 397151 + submit 70540 + verdict 63508 + finalize 114346 gas ~ 3.87e12 wei incl. L1 fee");
  log(`relayer budget ${RELAYER_WEI} wei / (settle+finalize ~3.07e12) ~ ${RELAYER_WEI / 3_070_000_000_000n} paid calls`);
}

if (phase === "fee" && !done("fee")) {
  const P = "fee";
  const before = await read(c.escrow, "currentConfigVersion");
  const cfg = await zeroFeeConfig();
  await tx(P, "JobEscrow.setConfig(feeBps 0, evaluatorFeeBps 0)", W.deployer, c.escrow, "setConfig", [cfg]);
  const after = await read(c.escrow, "currentConfigVersion");
  const now = await read(c.escrow, "currentConfig");
  if (Number(now.feeBps) !== 0 || Number(now.evaluatorFeeBps) !== 0) throw new Error("fee change not reflected on chain");
  st.phases[P] = { done: true, configVersionBefore: Number(before), configVersionAfter: Number(after), feeBps: Number(now.feeBps), evaluatorFeeBps: Number(now.evaluatorFeeBps) };
  save();
}

if (phase === "fund" && !done("fund")) {
  const P = "fund";
  await ethTx(P, "ETH deployer->relayer (service gas)", W.deployer, A.relayer, RELAYER_WEI);
  await ethTx(P, "ETH deployer->provider (submit gas)", W.deployer, A.provider, PROVIDER_WEI);
  await ethTx(P, "ETH deployer->operator (ERC-8004 registration gas)", W.deployer, A.operator, OPERATOR_WEI);
  st.phases[P] = { done: true, relayer: A.relayer, relayerWei: RELAYER_WEI, providerTopupWei: PROVIDER_WEI, operatorWei: OPERATOR_WEI, balancesAfter: await balances() };
  save();
}

if (phase === "route" && !done("route")) {
  const P = "route";
  const o = await notaryOffer();
  const predicted = await read(c.routeFactory, "routeFor", [o]);
  if (await publicClient.getCode({ address: predicted })) log("  route already deployed");
  else await tx(P, "EscrowDepositRouteFactory.deploy(notary offer)", W.deployer, c.routeFactory, "deploy", [o]);
  st.phases[P] = { done: true, route: predicted, offer: { ...o, amount: o.amount.toString(), deadlineSeconds: o.deadlineSeconds.toString() } };
  save();
}

if (phase === "register" && !done("register")) {
  const P = "register";
  const { buildRegistration } = await import("../lib/artifacts.mjs");
  let agentId = st.phases.register?.agentId != null ? BigInt(st.phases.register.agentId) : null;
  if (agentId === null) {
    const r = await tx(P, "ERC-8004 IdentityRegistry.register() by operator", W.operator, c.identity, "register", []);
    const ev = parseEventLogs({ abi: ABI.identity, logs: r.receipt.logs, eventName: "Registered" })[0];
    if (!ev) throw new Error("no Registered event");
    agentId = ev.args.agentId;
    st.phases[P] = { agentId: agentId.toString(), registerTx: r.hash };
    save();
  }
  const owner = await read(c.identity, "ownerOf", [agentId]);
  if (getAddress(owner) !== getAddress(A.operator)) throw new Error(`agentId ${agentId} owner ${owner} != operator`);
  // record in the deployment so contracts()/artifacts pick it up (identityRegistry + agentId)
  const d = JSON.parse(readFileSync(DEPLOY, "utf8"));
  d.erc8004 = { identityRegistry: OFFICIAL_IDENTITY, reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713", source: "https://github.com/erc-8004/erc-8004-contracts (README, Base Sepolia)", agentId: agentId.toString(), owner: A.operator, agentRegistry: `eip155:${CHAIN_ID}:${OFFICIAL_IDENTITY}`, registerTx: st.phases[P].registerTx };
  if (!FORK) writeFileSync(DEPLOY, J(d));
  else process.env.__FORK_DEPLOY = J(d);
  const reg = await buildRegistration({ agentId });
  reg.registrations = [{ agentId: Number(agentId), agentRegistry: `eip155:${CHAIN_ID}:${OFFICIAL_IDENTITY}` }];
  const uri = "data:application/json;base64," + Buffer.from(jcs(reg)).toString("base64");
  log(`  agentURI data: URI, ${uri.length} chars`);
  const r2 = await tx(P, "ERC-8004 IdentityRegistry.setAgentURI(agentId, data: URI) by operator", W.operator, c.identity, "setAgentURI", [agentId, uri]);
  const onchain = await read(c.identity, "tokenURI", [agentId]);
  if (onchain !== uri) throw new Error("tokenURI != submitted agentURI");
  st.phases[P] = { ...st.phases[P], done: true, setAgentURITx: r2.hash, agentURIBytes: uri.length, registration: reg };
  save();
  if (!FORK) {
    d.erc8004.setAgentURITx = r2.hash;
    d.erc8004.agentURI = "data:application/json;base64 (registration JSON, see deployments/base-sepolia-v04.json phases.register.registration)";
    writeFileSync(DEPLOY, J(d));
  }
}

if (phase === "uri") {
  const base = (process.env.AGENTCOIN_BASE_URL ?? "").replace(/\/+$/, "");
  if (process.env.AGENTCOIN_HOSTED !== "1" || !/^https:\/\//.test(base)) throw new Error("uri phase needs AGENTCOIN_HOSTED=1 and an https AGENTCOIN_BASE_URL");
  const agentId = BigInt(st.phases.register?.agentId ?? JSON.parse(readFileSync(DEPLOY, "utf8")).erc8004.agentId);
  const uri = `${base}/.well-known/agent-registration.json`;
  const r = await fetch(uri);
  const reg = r.ok ? await r.json() : null;
  if (!reg?.registrations?.some((x) => BigInt(x.agentId) === agentId)) throw new Error(`${uri} does not serve a registration naming agentId ${agentId} (HTTP ${r.status})`);
  const P = `uri-${Date.now()}`;
  const r2 = await tx(P, "ERC-8004 IdentityRegistry.setAgentURI(agentId, https URI) by operator", W.operator, c.identity, "setAgentURI", [agentId, uri]);
  if ((await read(c.identity, "tokenURI", [agentId])) !== uri) throw new Error("tokenURI != submitted agentURI");
  st.phases[P] = { done: true, agentId: agentId.toString(), uri, setAgentURITx: r2.hash };
  save();
  if (!FORK) {
    const d = JSON.parse(readFileSync(DEPLOY, "utf8"));
    d.erc8004.agentURI = uri;
    d.erc8004.setAgentURITx = r2.hash;
    writeFileSync(DEPLOY, J(d));
  }
}

log("ETH after", await balances());
