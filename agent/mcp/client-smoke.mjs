// Spawns the MCP server over stdio and calls tools/list + quote. Prints JSON.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

export async function connectMcp() {
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");
  const client = new Client({ name: "agentcoin-demo-client", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env } }));
  return client;
}

export async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = await connectMcp();
  const { tools } = await client.listTools();
  console.log(JSON.stringify(tools.map((t) => ({ name: t.name, descLen: t.description.length, readOnlyHint: t.annotations?.readOnlyHint })), null, 1));
  console.log(JSON.stringify(await call(client, "quote", { amount: "50000000", evaluator: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" }), null, 1));
  await client.close();
}
