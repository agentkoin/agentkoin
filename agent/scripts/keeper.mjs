#!/usr/bin/env node
// Keeper CLI (A-1b, A-1e, v0.1.2 k-of-n); local by default, --network base for mainnet (docs/mainnet/KEEPERS.md). Run one process per keeper key: DeployLocal
// allowlists Anvil #7, #8, #9 with threshold 2, so a deposit is credited once two of them voted the same
// values. It verifies each Transfer log into a watched route off-chain (finality depth, canonical block
// hash, token/route/from/value) and votes factory.attestDeposit(offer, txHash, logIndex, from, value, refundOnly).
// Usage:
//   node scripts/keeper.mjs [--keeper 0|1|2] [--once] [--interval-ms 2000] [--from-block N]
//        [--confirmations N] [--finalized-tag] [--offers offers.json] [--start-sweep] [--sweep] [--refund]
// Key: --keeper i selects Anvil keeper key #(7+i); AGENTCOIN_KEEPER_KEY overrides. Default offer set =
// the x402 demo offer (agent/x402/server.mjs). --refund attests in refund mode only. --confirmations
// defaults to AGENTCOIN_KEEPER_CONFIRMATIONS or 2; --finalized-tag also bounds by the RPC `finalized`
// block (default off on Anvil 31337, where it falls back to depth).
// Off-box / mainnet: --network base|base-sepolia (or AGENTCOIN_NETWORK) and a key from --key-file <path>
// (or AGENTCOIN_KEEPER_KEY_FILE / AGENTCOIN_KEEPER_KEY). Anvil keys are used on local only. The key is never printed;
// only the keeper address is logged. --state <file> persists the scan cursor (nextFromBlock) across restarts.
import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
if (opt("--network", null)) process.env.AGENTCOIN_NETWORK = opt("--network");

const { contracts, wallet, assertChain } = await import("../lib/chain.mjs");
const { KEEPER_KEYS, NETWORK } = await import("../lib/config.mjs");
const { keeperPass, DEFAULT_CONFIRMATIONS } = await import("../lib/keeper.mjs");
const offer = async () => (await import("../x402/server.mjs")).offer(); // local default only (needs the provider key)

function keeperKey() {
  const file = opt("--key-file", process.env.AGENTCOIN_KEEPER_KEY_FILE ?? null);
  if (file) {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) throw new Error(`keeper key file ${file} has mode ${mode.toString(8)}; chmod 600 it`);
    return readFileSync(file, "utf8").trim();
  }
  if (process.env.AGENTCOIN_KEEPER_KEY) return process.env.AGENTCOIN_KEEPER_KEY.trim();
  if (NETWORK !== "local") throw new Error(`${NETWORK}: pass --key-file <path> or set AGENTCOIN_KEEPER_KEY_FILE (Anvil keys are local only)`);
  const idx = Number(opt("--keeper", 0));
  if (!(idx in KEEPER_KEYS)) throw new Error(`--keeper must be 0..${KEEPER_KEYS.length - 1}`);
  return KEEPER_KEYS[idx];
}

await assertChain();
const c = contracts();
const key = keeperKey();
const signer = wallet(key);
const keeperAddress = privateKeyToAccount(key).address;
if (NETWORK !== "local") {
  const { publicClient } = await import("../lib/chain.mjs");
  const ok = await publicClient.readContract({ ...c.routeFactory, functionName: "isKeeper", args: [keeperAddress] });
  if (!ok) throw new Error(`${keeperAddress} is not an allowlisted keeper on ${c.routeFactory.address}`);
}
console.error(JSON.stringify({ keeper: keeperAddress, network: NETWORK, factory: c.routeFactory.address }));
const stateFile = opt("--state", null);
const offers = flag("--offers")
  ? JSON.parse(readFileSync(opt("--offers"), "utf8")).map((o) => ({ ...o, amount: BigInt(o.amount), deadlineSeconds: BigInt(o.deadlineSeconds) }))
  : NETWORK === "local"
    ? [await offer()]
    : (() => {
        throw new Error(`${NETWORK}: pass --offers <file> (JSON array of the service's route offers: GET /v1/notarize -> accepts[].extra.agentcoin.offer)`);
      })();
let fromBlock = BigInt(opt("--from-block", stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")).nextFromBlock : c.d.deployBlock ?? 0));
const confirmations = BigInt(opt("--confirmations", DEFAULT_CONFIRMATIONS));
const intervalMs = Number(opt("--interval-ms", 2000));
const ser = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

do {
  const out = await keeperPass({
    c,
    offers,
    signer,
    fromBlock,
    confirmations,
    useFinalizedTag: flag("--finalized-tag") || NETWORK === "base" ? true : undefined,
    startSweep: flag("--start-sweep"),
    sweep: flag("--sweep"),
    refund: flag("--refund"),
  });
  console.log(ser(out));
  fromBlock = BigInt(out.nextFromBlock);
  if (stateFile) writeFileSync(stateFile + ".tmp", JSON.stringify({ nextFromBlock: String(out.nextFromBlock), at: new Date().toISOString() }) + "\n"), renameSync(stateFile + ".tmp", stateFile);
  if (flag("--once")) break;
  await new Promise((r) => setTimeout(r, intervalMs));
} while (true);
