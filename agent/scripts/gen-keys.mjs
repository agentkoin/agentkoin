// Generates a THROWAWAY operator key for signing local artifacts. Stored in agent/.keys (gitignored).
// This key must never hold real funds and is not used on any public network.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { AGENT_DIR } from "../lib/config.mjs";

const dir = path.join(AGENT_DIR, ".keys");
const file = path.join(dir, "operator.json");
if (existsSync(file) && !process.argv.includes("--force")) {
  console.log(`exists: ${file} (use --force to rotate)`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
const privateKey = generatePrivateKey();
const address = privateKeyToAccount(privateKey).address;
writeFileSync(file, JSON.stringify({ purpose: "THROWAWAY local operator key for AgentCoin prototype (Anvil 31337 only)", address, privateKey }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ file, address }));
