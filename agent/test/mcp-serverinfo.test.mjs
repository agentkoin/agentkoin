// MCP initialize serverInfo: AgentKoin name, real service version (not the old hard-coded 0.5.0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VERSION, mcpServerName, mcpServerAlias } from "../lib/version.mjs";
import { VERSION as APP_VERSION } from "../service/app.mjs";

test("version/name helpers: single version source shared with the service; agentkoin- name, agentcoin- alias", () => {
  assert.equal(APP_VERSION, VERSION);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.notEqual(VERSION, "0.5.0");
  assert.equal(mcpServerName("base-sepolia"), "agentkoin-base-sepolia");
  assert.equal(mcpServerAlias("base-sepolia"), "agentcoin-base-sepolia");
});

test("HTTP: POST /mcp initialize reports agentkoin-<network> and the service VERSION; server card agrees", async () => {
  const { createApp } = await import("../service/app.mjs");
  const { NETWORK } = await import("../lib/config.mjs");
  const app = createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "acmcp-")), publicUrl: "http://127.0.0.1:0", caps: { freePerIpPerHour: 1000 }, loopMs: 1e9 });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const res = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) });
    const init = await res.json();
    assert.equal(init.result.serverInfo.name, `agentkoin-${NETWORK}`);
    assert.equal(init.result.serverInfo.version, VERSION);
    const card = await (await fetch(base + "/.well-known/mcp/server-card.json")).json();
    assert.equal(card.serverInfo.name, init.result.serverInfo.name);
    assert.equal(card.serverInfo.version, VERSION);
    assert.deepEqual(card.serverInfo.aliases, [`agentcoin-${NETWORK}`]);
  } finally {
    await app.stop();
  }
});
