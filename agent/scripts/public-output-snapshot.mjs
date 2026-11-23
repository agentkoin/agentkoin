// Snapshot the service's key public JSON/text outputs for the active AGENTCOIN_NETWORK (default base-sepolia),
// for before/after byte comparisons. Uses the public Anvil dev keys as stand-in role keys (never funded), an
// in-memory listen on 127.0.0.1 and a temp state dir. Read-only RPC only. Usage:
//   AGENTCOIN_NETWORK=base-sepolia node scripts/public-output-snapshot.mjs <outdir>
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENTCOIN_NETWORK ??= "base-sepolia";
const out = process.argv[2] ?? path.join(os.tmpdir(), `agk-snap-${process.env.AGENTCOIN_NETWORK}`);
const c = await import("../lib/config.mjs");
for (const [k, v] of Object.entries({ RELAYER: c.ANVIL_KEYS.relayer, PROVIDER: c.ANVIL_KEYS.provider, EVALUATOR: c.ANVIL_KEYS.evaluator, DEPLOYER: c.ANVIL_KEYS.deployer, OPERATOR: c.ANVIL_KEYS.keeper0 })) process.env[`AGENTCOIN_${k}_KEY`] ??= v;
const { createApp } = await import("../service/app.mjs");
const app = createApp({ stateDir: mkdtempSync(path.join(os.tmpdir(), "agk-snap-state-")), publicUrl: "https://agentcoinhq.com", trustProxy: true });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const GET = ["/", "/llms.txt", "/openapi.json", "/.well-known/x402", "/v1/faucets", "/healthz", "/.well-known/agent-card.json", "/.well-known/mcp/server-card.json", "/v1/notarize", "/exchange/llms.txt", "/exchange/openapi.json", "/exchange/server.json", "/exchange/.well-known/agent-card.json", "/v1/caps", "/privacy", "/EVALUATORS.md", "/QUICKSTART-AGENTS.md", ...(process.env.SNAP_EXTRA ? process.env.SNAP_EXTRA.split(",") : [])];
const norm = (s) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<T>").replace(/"(uptimeSeconds|startedAt|now|generatedAt|ts)":\s*[0-9.]+/g, '"$1":<N>');
mkdirSync(out, { recursive: true });
const save = (name, res, body) => writeFileSync(path.join(out, name.replace(/[^a-z0-9.]+/gi, "_") + ".txt"), `${res.status}\n${["content-type", "x-agentcoin-testnet", "x-agentcoin-real-value", "payment-required"].map((h) => `${h}: ${res.headers.get(h) ?? ""}`).join("\n")}\n\n${norm(body)}`);
for (const p of GET) {
  const r = await fetch(base + p, { headers: { accept: "application/json" } });
  save(`GET${p}`, r, await r.text());
}
for (const [label, body] of [["initialize", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "snap", version: "0" } } }], ["tools-list", { jsonrpc: "2.0", id: 2, method: "tools/list" }]]) {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
  save(`POST_mcp_${label}`, r, await r.text());
}
app.server.close();
console.log(out);
process.exit(0);
