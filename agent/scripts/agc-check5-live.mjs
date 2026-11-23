#!/usr/bin/env node
// AD-010 acceptance check 5 (Base Sepolia, test tokens): a STOS demo buyer pays EURC through the live
// CrossCurrencySettler with the AGCSettlerAdapter as escrow (USDC out -> AGC minted -> JobEscrowAGC job), then a
// forced swap failure (impossible minOut) that must refund the EURC with no AGC minted. The buyer submits its own
// settle txs (no relayer). Buyer key read from .secrets, never printed. Writes deployments/base-sepolia-agc.json.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress, keccak256, encodeAbiParameters, concat, toBytes, parseAbi, parseEventLogs, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT, CHAIN_ID, RPC_URL } from "../lib/config.mjs";
import { publicClient } from "../lib/chain.mjs";

if (CHAIN_ID !== 84532) throw new Error("Base Sepolia only");
const out = path.join(ROOT, "deployments", "base-sepolia-agc.json");
const rec = JSON.parse(readFileSync(out, "utf8"));
const multi = JSON.parse(readFileSync(path.join(ROOT, "deployments", "base-sepolia-multiasset.json"), "utf8"));
const SETTLER = getAddress("0x6258D112bf27006287253424a1fa877C607B564a");
const EURC = getAddress("0x808456652fdb597867f38412077A9182bf77359F");
const USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const AGC = getAddress(rec.contracts.AGC.address), ADAPTER = getAddress(rec.contracts.AGCSettlerAdapter.address), ESCROW = getAddress(rec.contracts.JobEscrowAGC.address);
const PROVIDER = getAddress("0x745528C4E0CBdA5759175A660da06d0aaA72db7F");
const EVALUATOR = getAddress("0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a");
const SPEC = "0x6b4542f5b8f5c0e6a332f4fed6c1f840db2e26fa2840a194664bee75c49504db";
const settlerAbi = JSON.parse(readFileSync(path.join(ROOT, "out/CrossCurrencySettler.sol/CrossCurrencySettler.json"), "utf8")).abi;
const escrowAbi = JSON.parse(readFileSync(path.join(ROOT, "out/JobEscrow.sol/JobEscrow.json"), "utf8")).abi;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function DOMAIN_SEPARATOR() view returns (bytes32)", "function totalSupply() view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"]);
const buyer = privateKeyToAccount(readFileSync(path.join(ROOT, ".secrets", "testnet-stos-demo-buyer-1.key"), "utf8").trim());
const wal = createWalletClient({ account: buyer, transport: http(RPC_URL) });
const RECEIVE_TH = keccak256(toBytes("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"));
const bal = (t, a) => publicClient.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [a] });
const log = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
rec.check5 ??= { buyer: `stos-demo-buyer-1 ${buyer.address}`, txs: [] };

async function run(label, amountIn, minOut) {
  const now = Number((await publicClient.getBlock()).timestamp);
  const q = { buyer: buyer.address, tokenIn: EURC, tokenOut: USDC, amountIn, minOut, poolFee: 500, expiry: BigInt(now + 600), quoteId: keccak256(toBytes(`AD-010 check5 ${label} ${now}`)), recipient: PROVIDER, escrow: ADAPTER, evaluator: EVALUATOR, deadlineSeconds: 3600n, specHash: SPEC };
  const qh = await publicClient.readContract({ address: SETTLER, abi: settlerAbi, functionName: "quoteHash", args: [q] });
  const vb = BigInt(now + 900);
  const sh = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [RECEIVE_TH, buyer.address, SETTLER, amountIn, 0n, vb, qh]));
  const ds = await publicClient.readContract({ address: EURC, abi: erc20, functionName: "DOMAIN_SEPARATOR" });
  const sig = await buyer.sign({ hash: keccak256(concat(["0x1901", ds, sh])) });
  const r = sig.slice(0, 66), s = "0x" + sig.slice(66, 130), v = parseInt(sig.slice(130, 132), 16);
  const auth = { validAfter: 0n, validBefore: vb, v, r, s };
  const sim = await publicClient.simulateContract({ address: SETTLER, abi: settlerAbi, functionName: "settle", args: [q, auth], account: buyer });
  const before = { eurc: await bal(EURC, buyer.address), agcSupply: await publicClient.readContract({ address: AGC, abi: erc20, functionName: "totalSupply" }) };
  const hash = await wal.writeContract(sim.request);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  const settlerEv = parseEventLogs({ abi: settlerAbi, logs: rc.logs }).map((e) => ({ event: e.eventName, args: e.args }));
  const escrowEv = parseEventLogs({ abi: escrowAbi, logs: rc.logs.filter((l) => getAddress(l.address) === ESCROW) }).map((e) => ({ event: e.eventName, args: e.args }));
  const transfers = parseEventLogs({ abi: erc20, logs: rc.logs, eventName: "Transfer" }).map((e) => ({ token: getAddress(e.address) === USDC ? "USDC" : getAddress(e.address) === AGC ? "AGC" : getAddress(e.address) === EURC ? "EURC" : e.address, from: e.args.from, to: e.args.to, value: e.args.value }));
  const after = { eurc: await bal(EURC, buyer.address), agcSupply: await publicClient.readContract({ address: AGC, abi: erc20, functionName: "totalSupply" }) };
  const t = { label, hash, block: rc.blockNumber.toString(), status: rc.status, simulated: sim.result, settlerEvents: settlerEv, escrowEvents: escrowEv, transfers, before, after };
  rec.check5.txs.push(JSON.parse(JSON.stringify(t, (k, v) => (typeof v === "bigint" ? v.toString() : v))));
  writeFileSync(out, JSON.stringify(rec, null, 2) + "\n");
  log(t);
}
log({ buyer: buyer.address, eurc: await bal(EURC, buyer.address), eth: await publicClient.getBalance({ address: buyer.address }) });
await run("EURC->AGC escrow job", 10000n, 10000n);
await run("forced swap failure (minOut 1 USDC)", 10000n, 1000000n);
