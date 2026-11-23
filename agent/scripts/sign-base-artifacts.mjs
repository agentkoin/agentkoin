#!/usr/bin/env node
// One command to sign the Base mainnet artifacts (ERC-8004 registration + sidecar, A2A agent card + JWKS, trust
// manifest) from the deploy output. Signing reads live chain state (escrow/registry config, code hashes), so it
// needs the deployed contracts and must run AFTER the deploy.
//
//   node scripts/sign-base-artifacts.mjs --deploy ../deployments/8453.json [--out artifacts/base] [--rpc <url>]
//        [--evaluator <reference evaluator address>] [--not-hosted]
//   --deploy also accepts the forge broadcast file broadcast/DeployMainnet.s.sol/8453/run-latest.json.
// Keys: AGENTCOIN_OPERATOR_KEY or AGENTCOIN_OPERATOR_KEY_FILE (artifact signer). Never printed.
// Reference evaluator: --evaluator <addr>, or AGENTCOIN_EVALUATOR_KEY (address derived, key not used to sign).
import { readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const deployFile = opt("--deploy", path.join(AGENT, "..", "deployments", "8453.json"));
const out = path.resolve(opt("--out", path.join(AGENT, "artifacts", "base")));

/** Addresses from deployments/<chain>.json (DeployMainnet output) or a forge broadcast run JSON. */
export function addressesFrom(doc) {
  if (Array.isArray(doc.transactions)) {
    const by = (name) => doc.transactions.find((t) => t.contractName === name && t.transactionType === "CREATE")?.contractAddress ?? null;
    const blocks = (doc.receipts ?? []).map((r) => Number(BigInt(r.blockNumber)));
    return { chainId: Number(doc.chain), escrow: by("JobEscrow"), registry: by("EvaluatorRegistry"), depositRouteFactory: by("EscrowDepositRouteFactory"), recoveryVault: null, deployBlock: blocks.length ? Math.min(...blocks) : null };
  }
  return { chainId: Number(doc.chainId), escrow: doc.escrow, registry: doc.registry, depositRouteFactory: doc.depositRouteFactory, recoveryVault: doc.recoveryVault ?? null, deployBlock: doc.deployBlock ?? null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = addressesFrom(JSON.parse(readFileSync(deployFile, "utf8")));
  for (const k of ["escrow", "registry", "depositRouteFactory"]) if (!/^0x[0-9a-fA-F]{40}$/.test(String(a[k]))) throw new Error(`${deployFile}: missing ${k}`);
  const env = { ...process.env, AGENTCOIN_NETWORK: "base", AGENTCOIN_ESCROW: a.escrow, AGENTCOIN_REGISTRY: a.registry, AGENTCOIN_ROUTE_FACTORY: a.depositRouteFactory, AGENTCOIN_ARTIFACTS_DIR: out };
  if (a.recoveryVault) env.AGENTCOIN_RECOVERY_VAULT = a.recoveryVault;
  if (a.deployBlock != null) env.AGENTCOIN_DEPLOY_BLOCK = String(a.deployBlock);
  if (opt("--rpc", null)) env.RPC_URL = opt("--rpc");
  if (!argv.includes("--not-hosted")) env.AGENTCOIN_HOSTED = "1";
  env.AGENTCOIN_BASE_URL ??= "https://agentcoinhq.com";
  if (opt("--evaluator", null)) env.AGENTCOIN_REFERENCE_EVALUATOR = getAddress(opt("--evaluator"));
  if (!env.AGENTCOIN_OPERATOR_KEY && env.AGENTCOIN_OPERATOR_KEY_FILE) env.AGENTCOIN_OPERATOR_KEY = readFileSync(env.AGENTCOIN_OPERATOR_KEY_FILE, "utf8").trim();
  if (!env.AGENTCOIN_OPERATOR_KEY) throw new Error("set AGENTCOIN_OPERATOR_KEY or AGENTCOIN_OPERATOR_KEY_FILE (artifact signer)");
  if (!env.AGENTCOIN_REFERENCE_EVALUATOR && !env.AGENTCOIN_EVALUATOR_KEY) throw new Error("pass --evaluator <address> (reference evaluator)");
  mkdirSync(out, { recursive: true });
  console.error(JSON.stringify({ network: "base", deploy: deployFile, out, escrow: a.escrow, registry: a.registry, depositRouteFactory: a.depositRouteFactory }));
  const r = spawnSync(process.execPath, [path.join(AGENT, "scripts", "sign-artifacts.mjs")], { cwd: AGENT, env, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
