import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { AGENT_DIR } from "./config.mjs";

/** Operator (artifact signer) key: AGENTCOIN_OPERATOR_KEY (hosted secret) or agent/.keys/operator.json. Never logged. */
export function operatorKey() {
  const env = process.env.AGENTCOIN_OPERATOR_KEY?.trim();
  if (env) return { privateKey: env, address: privateKeyToAccount(env).address };
  const file = path.join(AGENT_DIR, ".keys", "operator.json");
  if (!existsSync(file)) throw new Error(`missing ${file}: run "npm run keys" in agent/`);
  return JSON.parse(readFileSync(file, "utf8"));
}
