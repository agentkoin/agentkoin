// Writes agent/mcp/tools.manifest.json: the MCP tool list exactly as served (tools/list over stdio), plus the
// launch command and the network/contract context for AGENTCOIN_NETWORK. Usage:
//   AGENTCOIN_NETWORK=base-sepolia node scripts/gen-mcp-manifest.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { connectMcp } from "../mcp/client-smoke.mjs";
import { AGENT_DIR, NETWORK, CHAIN_ID, NET, loadDeployment } from "../lib/config.mjs";

const client = await connectMcp();
const { tools } = await client.listTools();
const info = client.getServerVersion();
await client.close();
const d = loadDeployment();
const manifest = {
  v: "agentcoin-mcp-tools/0.3",
  server: { name: info.name, version: info.version, transport: "stdio", command: "node", args: ["agent/mcp/server.mjs"], cwd: "<repo root>", env: { AGENTCOIN_NETWORK: NETWORK }, hosted: false },
  network: { name: NETWORK, chainId: CHAIN_ID, caip2: `eip155:${CHAIN_ID}`, testnet: NET.testnet, defaultRpc: NET.rpc },
  contracts: { escrow: d.escrow, evaluatorRegistry: d.registry, token: d.usdc, arbitrator: d.arbitrator, evaluatorAdapter: d.adapter, depositRouteFactory: d.depositRouteFactory, recoveryVault: d.recoveryVault, identityRegistry: d.identityRegistry ?? null },
  units: { token: "USDC base units (6 decimals), decimal strings", time: "seconds" },
  signing: "open_job returns unsigned EIP-1559 transactions (approve, createAndFund); the caller signs and broadcasts. Server-side signing (demoSign) is disabled outside the local network.",
  tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, annotations: t.annotations, inputSchema: t.inputSchema, outputSchema: t.outputSchema })),
};
const out = path.join(AGENT_DIR, "mcp", NETWORK === "local" ? "tools.manifest.local.json" : `tools.manifest.${NETWORK}.json`);
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ wrote: path.relative(path.dirname(AGENT_DIR), out), tools: tools.map((t) => t.name) }));
