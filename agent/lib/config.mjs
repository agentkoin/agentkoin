// Network configuration. AGENTCOIN_NETWORK selects the target:
//   "local" (default): Anvil, chainId 31337, loopback RPC only, deployments/local.json.
//   "base-sepolia":    Base Sepolia TESTNET, chainId 84532, deployments/base-sepolia.json.
//                      RPC default https://sepolia.base.org (public, rate-limited, eth_getLogs <= 200 blocks);
//                      a loopback RPC is accepted for a local fork rehearsal.
//   "base":            Base MAINNET, chainId 8453, Circle USDC, deployments/8453.json (written by
//                      script/DeployMainnet.s.sol) with per-address env overrides; keys from env only;
//                      requires AGENTCOIN_EXCHANGE_FEE_RECIPIENT (see lib/network.mjs). Other mainnets are refused.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BASE_MAINNET_USDC } from "./network.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AGENT_DIR = path.join(ROOT, "agent");

export const NETWORKS = {
  local: { chainId: 31337, name: "Anvil (local)", rpc: "http://127.0.0.1:8545", deployment: "local.json", maxLogRange: 0, token: { name: "Mock USDC (test only)", version: "2" }, testnet: true },
  "base-sepolia": { chainId: 84532, name: "Base Sepolia (testnet)", rpc: "https://sepolia.base.org", deployment: "base-sepolia.json", maxLogRange: 200, token: { name: "USDC", version: "2" }, testnet: true },
  // USDC name() "USD Coin", version() "2" (read on Base mainnet 2026-11-23).
  base: { chainId: 8453, name: "Base", rpc: "https://mainnet.base.org", deployment: "8453.json", maxLogRange: 200, token: { name: "USD Coin", version: "2" }, testnet: false, usdc: BASE_MAINNET_USDC },
};
export const NETWORK = process.env.AGENTCOIN_NETWORK ?? "local";
if (!NETWORKS[NETWORK]) throw new Error(`unknown AGENTCOIN_NETWORK ${NETWORK}; expected ${Object.keys(NETWORKS).join(" | ")}`);
export const NET = NETWORKS[NETWORK];
export const CHAIN_ID = NET.chainId;
/** @deprecated kept for older imports; equals the active network's chainId */
export const LOCAL_CHAIN_ID = CHAIN_ID;
export const RPC_URL = process.env.RPC_URL ?? NET.rpc;
export const MAX_LOG_RANGE = Number(process.env.AGENTCOIN_MAX_LOG_RANGE ?? NET.maxLogRange);

const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];
export const isLoopback = (url) => LOOPBACK.includes(new URL(url).hostname);

export function assertAllowedRpc(url = RPC_URL) {
  if (NETWORK === "local" && !isLoopback(url)) throw new Error(`LOCAL ONLY: refusing non-loopback RPC ${url}`);
  if (NETWORK !== "local" && !isLoopback(url) && new URL(url).protocol !== "https:") throw new Error(`refusing non-https RPC ${url}`);
}
/** @deprecated use assertAllowedRpc */
export const assertLocalRpc = assertAllowedRpc;
assertAllowedRpc();

/** Normalised deployment: flat addresses regardless of the JSON layout (local.json flat, base-sepolia.json nested). */
export function loadDeployment() {
  const p = path.join(ROOT, "deployments", NET.deployment);
  if (NETWORK === "base") return loadBaseDeployment(process.env.AGENTCOIN_DEPLOYMENT_FILE ?? p); // file optional (AGENTCOIN_DEPLOYMENT_FILE overrides the path); env per address
  if (!existsSync(p)) throw new Error(`missing ${p}: run the deploy for ${NETWORK} first (see README)`);
  const d = JSON.parse(readFileSync(p, "utf8"));
  if (Number(d.chainId) !== CHAIN_ID) throw new Error(`deployment chainId ${d.chainId} != ${CHAIN_ID} (${NETWORK})`);
  if (!d.contracts) return d;
  const a = (n) => d.contracts[n]?.address ?? null;
  return {
    ...d,
    usdc: d.usdc?.address ?? d.usdc,
    escrow: a("JobEscrow"),
    registry: a("EvaluatorRegistry"),
    arbitrator: a("MockArbitrator"),
    adapter: a("ERC8183EvaluatorAdapter"),
    depositRouteFactory: a("EscrowDepositRouteFactory"),
    recoveryVault: a("RecoveryVault"),
    externalKernel: a("MockERC8183Kernel"),
    identityRegistry: d.identityRegistry ?? d.erc8004?.identityRegistry ?? null,
    deployBlock: d.deployBlockFirst ?? d.deployBlock,
  };
}

/**
 * Base mainnet deployment: deployments/8453.json (flat, from DeployMainnet.s.sol) and/or env per address
 * (env wins): AGENTCOIN_ESCROW, AGENTCOIN_REGISTRY, AGENTCOIN_ROUTE_FACTORY, AGENTCOIN_RECOVERY_VAULT,
 * AGENTCOIN_ARBITRATOR, AGENTCOIN_IDENTITY_REGISTRY, AGENTCOIN_DEPLOY_BLOCK. No hardcoded addresses; USDC must be Circle's.
 */
export function loadBaseDeployment(p, env = process.env) {
  const d = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  if (d.chainId !== undefined && Number(d.chainId) !== 8453) throw new Error(`deployment chainId ${d.chainId} != 8453 (base)`);
  const pick = (k, j) => env[k] ?? d[j] ?? null;
  const out = {
    ...d,
    chainId: 8453,
    usdc: d.usdc ?? BASE_MAINNET_USDC,
    escrow: pick("AGENTCOIN_ESCROW", "escrow"),
    registry: pick("AGENTCOIN_REGISTRY", "registry"),
    depositRouteFactory: pick("AGENTCOIN_ROUTE_FACTORY", "depositRouteFactory"),
    recoveryVault: pick("AGENTCOIN_RECOVERY_VAULT", "recoveryVault"),
    arbitrator: pick("AGENTCOIN_ARBITRATOR", "escrowArbitrator"),
    adapter: null,
    externalKernel: null,
    identityRegistry: pick("AGENTCOIN_IDENTITY_REGISTRY", "identityRegistry"),
    deployBlock: env.AGENTCOIN_DEPLOY_BLOCK !== undefined ? Number(env.AGENTCOIN_DEPLOY_BLOCK) : d.deployBlock,
  };
  if (String(out.usdc).toLowerCase() !== BASE_MAINNET_USDC.toLowerCase()) throw new Error(`base: usdc ${out.usdc} is not Circle USDC ${BASE_MAINNET_USDC}`);
  for (const k of ["escrow", "registry", "depositRouteFactory"]) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(out[k] ?? ""))) throw new Error(`base: missing ${k} address (deployments/8453.json or env)`);
  }
  return out;
}

function abiOf(file, name) {
  const p = path.join(ROOT, "out", file, `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8")).abi;
}

export const ABI = {
  escrow: abiOf("JobEscrow.sol", "JobEscrow"),
  registry: abiOf("EvaluatorRegistry.sol", "EvaluatorRegistry"),
  usdc: abiOf("MockUSDC.sol", "MockUSDC"),
  arbitrator: abiOf("MockArbitrator.sol", "MockArbitrator"),
  // local: MockIdentityRegistry (ERC-8004 subset). Public testnets: the official ERC-8004 IdentityRegistry ABI
  // (agent/abis/ERC8004IdentityRegistry.json, from github.com/erc-8004/erc-8004-contracts).
  identity: NETWORK === "local" ? abiOf("MockIdentityRegistry.sol", "MockIdentityRegistry") : JSON.parse(readFileSync(path.join(AGENT_DIR, "abis", "ERC8004IdentityRegistry.json"), "utf8")),
  adapter: abiOf("ERC8183EvaluatorAdapter.sol", "ERC8183EvaluatorAdapter"),
  kernel: abiOf("MockERC8183Kernel.sol", "MockERC8183Kernel"),
  routeFactory: abiOf("EscrowDepositRoute.sol", "EscrowDepositRouteFactory"),
  route: abiOf("EscrowDepositRoute.sol", "EscrowDepositRoute"),
  vault: abiOf("RecoveryVault.sol", "RecoveryVault"),
};

// Enum orderings mirror src/JobEscrow.sol.
export const STATES = ["None", "Open", "Funded", "Submitted", "Completed", "Rejected", "Partial", "Disputed", "Settled", "Expired", "Cancelled"];
export const OUTCOMES = ["None", "Complete", "Reject", "Partial"];
// Mirror src/ERC8183EvaluatorAdapter.sol and src/interfaces/IERC8183.sol.
export const ADAPTER_STATES = ["None", "Proposed", "Active", "Held", "Disputed", "Executed", "KernelCallFailed", "Withdrawn", "KernelEnded", "ExpiryRefused"];
export const KERNEL_STATES = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

// A-6: open_job returns unsigned transactions unless this flag is set (local demo only).
export const DEMO_SIGN = process.env.AGENTCOIN_DEMO_SIGN === "1" && NETWORK === "local"; // never on a public testnet

// EIP-712 domain of the payment token (EIP-3009). local: src/mocks/MockUSDC.sol. base-sepolia: Circle test
// USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e, name() "USDC", version() "2" (read on chain 2026-10-29).
export const TOKEN_EIP712 = NET.token;

// Well-known public Anvil dev keys (deterministic mnemonic "test test ... junk"). Local only; never fund on a real network.
export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  client: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  provider: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  evaluator: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  // v0.1.2 default 2-of-3 route keepers (DeployLocal allowlists Anvil #7, #8, #9)
  keeper0: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  keeper1: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  keeper2: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  // Anvil #5: local stand-in for the public service's dedicated relayer key
  relayer: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
};
export const KEEPER_KEYS = [ANVIL_KEYS.keeper0, ANVIL_KEYS.keeper1, ANVIL_KEYS.keeper2];

/**
 * Private key for a role. local: the public Anvil dev keys above. base-sepolia: the THROWAWAY testnet keys in
 * <repo>/.secrets/testnet-<role>.key (gitignored, mode 600; client = deployer). Never logged or returned by any tool.
 */
export function roleKey(role) {
  if (NETWORK === "local") return ANVIL_KEYS[role];
  const file = { client: "deployer", deployer: "deployer", facilitator: "provider", provider: "provider", evaluator: "evaluator", relayer: "relayer" }[role];
  if (!file) throw new Error(`no ${NETWORK} key for role ${role}`);
  // hosted deployments inject keys as secrets/env instead of files (never logged)
  const fromEnv = process.env[`AGENTCOIN_${file.toUpperCase()}_KEY`];
  if (fromEnv) return fromEnv.trim();
  // mainnet: keys only from the secret store (env); never the testnet key files
  if (NETWORK === "base") throw new Error(`base: AGENTCOIN_${file.toUpperCase()}_KEY not set`);
  const p = path.join(ROOT, ".secrets", `testnet-${file}.key`);
  if (!existsSync(p)) throw new Error(`missing key file .secrets/testnet-${file}.key`);
  return readFileSync(p, "utf8").trim();
}

/** Where signed agent artifacts for the active network live (and are served from by the local x402 server). */
export const ARTIFACTS_DIR = process.env.AGENTCOIN_ARTIFACTS_DIR ? path.resolve(process.env.AGENTCOIN_ARTIFACTS_DIR) : NETWORK === "local" ? path.join(AGENT_DIR, "artifacts") : path.join(AGENT_DIR, "artifacts", NETWORK);
export const PUBLIC_BASE_URL = process.env.AGENTCOIN_BASE_URL ?? "http://127.0.0.1:4020";

/** Factual value label merged into machine-readable responses. */
export const VALUE_LABEL = NETWORK === "local" ? { testnet: false, localDevnet: true, realValue: false } : NETWORK === "base" ? { testnet: false, realValue: true } : { testnet: true, realValue: false };
