// Network profile. Default comes from the package version: "-mainnet" builds default to Base mainnet (8453),
// everything else to Base Sepolia (84532). Override with --network base|base-sepolia or JUDGE_NETWORK.
import { readFileSync } from "node:fs";

export const NETWORKS = {
  "base-sepolia": {
    name: "Base Sepolia", caip2: "eip155:84532", chainId: 84532, testnet: true,
    rpc: "https://sepolia.base.org", rpcs: ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"],
    escrow: "0xd6E00d3419C16a3bEE1B8CC030A7062bf2014b2c", verifyEscrow: "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D",
    registry: "0x30576DE005df028D1947C56dEcc85a2a5612036a", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  base: {
    name: "Base", caip2: "eip155:8453", chainId: 8453, testnet: false,
    rpc: "https://mainnet.base.org", rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    escrow: "0xB647158dE59588e1070d616BDB31459d610CE885", verifyEscrow: "0xB647158dE59588e1070d616BDB31459d610CE885",
    registry: "0x180278C990d65a1301fE311623FEeC808d5768E0", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    deployBlock: 61301651,
  },
};

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "";
  } catch {
    return "";
  }
}

function pick() {
  const i = process.argv.indexOf("--network");
  if (i > 0 && process.argv[i + 1]) {
    const v = process.argv[i + 1];
    process.argv.splice(i, 2);
    return v;
  }
  return process.env.JUDGE_NETWORK ?? (/-mainnet$/.test(pkgVersion()) ? "base" : "base-sepolia");
}

export const NETWORK = pick();
if (!NETWORKS[NETWORK]) throw new Error(`unknown network ${NETWORK} (base | base-sepolia)`);
export const NET = NETWORKS[NETWORK];
/** USDC address per chain id (payment-path checks). */
export const USDC_BY_CHAIN = Object.fromEntries(Object.values(NETWORKS).map((n) => [n.chainId, n.usdc]));
