#!/usr/bin/env node
// MCP client smoke run against the Base Sepolia TESTNET deployment (read-only: no transactions are sent).
// Spawns agent/mcp/server.mjs over stdio with AGENTCOIN_NETWORK=base-sepolia and calls all 5 tools:
//   quote, open_job (unsigned txs only), get_job_status, get_evaluator_reputation, verify_attestation (trust manifest).
// Writes agent/artifacts/base-sepolia/mcp-smoke.json and exits non-zero on any failed expectation.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(here, "..", "artifacts", "base-sepolia");
const CLIENT = "0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e";
const PROVIDER = "0x745528C4E0CBdA5759175A660da06d0aaA72db7F";
const EVALUATOR = "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a";
const JOBS = (process.env.SMOKE_JOBS ?? "1,2,3,4").split(",");

const env = { ...process.env, AGENTCOIN_NETWORK: "base-sepolia" };
delete env.AGENTCOIN_DEMO_SIGN;
const client = new Client({ name: "agentcoin-sepolia-smoke", version: "0.3.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "server.mjs")], env }));
const results = { network: "base-sepolia", chainId: 84532, startedAt: new Date().toISOString(), calls: [], failures: [] };
const expect = (label, got, want) => { const ok = String(got) === String(want); if (!ok) results.failures.push({ label, got, want }); console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : ` (want ${want})`}`); };
async function call(name, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const rec = { tool: name, args, ms: Date.now() - t0, isError: !!r.isError, result: r.isError ? r.content?.[0]?.text : r.structuredContent };
  results.calls.push(rec);
  if (r.isError) results.failures.push({ label: `${name} error`, got: rec.result });
  return rec.result;
}

const { tools } = await client.listTools();
expect("tools/list", tools.map((t) => t.name).join(","), "quote,open_job,get_job_status,get_evaluator_reputation,verify_attestation");

const q = await call("quote", { amount: "1000000", evaluator: EVALUATOR });
expect("quote chainId", q.chainId, 84532);
expect("quote token", q.contracts.token, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
console.log(`     fee ${q.feeAtFullPayout} challengeBond ${q.challengeBond} arbitrationFee ${q.arbitrationFee} evaluatorCanTake ${q.evaluatorCanTakeAmount}`);

const o = await call("open_job", { client: CLIENT, provider: PROVIDER, evaluator: EVALUATOR, amount: "1000000", deadlineSeconds: 3600, spec: "smoke: unsigned open_job on base-sepolia" });
expect("open_job mode", o.mode, "unsigned");
expect("open_job tx count", o.transactions?.length, 2);
expect("open_job tx chainId", o.transactions?.[0]?.chainId, 84532);
const demo = await client.callTool({ name: "open_job", arguments: { provider: PROVIDER, evaluator: EVALUATOR, amount: "1000000", deadlineSeconds: 3600, spec: "x", demoSign: true } });
expect("open_job demoSign refused on base-sepolia", !!demo.isError, true);

for (const id of JOBS) {
  const s = await call("get_job_status", { jobId: id });
  console.log(`     job ${id}: ${s.state} ${s.outcome ?? ""} payoutBps ${s.payoutBps} evidence ${s.evidence?.length} dispute ${s.dispute ? "yes" : "no"}`);
}
const r = await call("get_evaluator_reputation", { evaluator: EVALUATOR });
console.log(`     reputation: ${JSON.stringify(r.counts)}`);
expect("reputation chainId", r.chainId, 84532);

const manifest = JSON.parse(readFileSync(path.join(ART, "trust-manifest.json"), "utf8"));
const v = await call("verify_attestation", { document: manifest });
expect("verify trust manifest valid", v.valid, true);
console.log(`     ${v.checks?.filter((c) => c.pass).length}/${v.checks?.length} checks passed`);

await client.close();
results.finishedAt = new Date().toISOString();
writeFileSync(path.join(ART, "mcp-smoke.json"), JSON.stringify(results, null, 2) + "\n");
console.log(results.failures.length ? `FAILURES: ${results.failures.length}` : "MCP Sepolia smoke: all expectations passed");
process.exit(results.failures.length ? 1 : 0);
