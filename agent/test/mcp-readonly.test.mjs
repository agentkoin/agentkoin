// /mcp/readonly: same transport as /mcp, only the nine read tools (readOnlyHint true); write-tool calls refused clearly.
// Also /terms (draft) and its links from footer, site, /exchange, llms.txt and the discovery file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const READ = ["find_service", "route_task", "get_agent_profile", "list_evaluators", "verify", "get_order", "find_earning_opportunities", "list_open_jobs", "get_fee_credits"];
const H = { accept: "application/json, text/event-stream" };

async function withApp(fn) {
  const { createApp } = await import("../service/app.mjs");
  const app = createApp({
    stateDir: mkdtempSync(path.join(tmpdir(), "acro-")), publicUrl: "http://127.0.0.1:0", caps: { freePerIpPerHour: 1000 },
    activeEvaluators: async () => [],
    exchangeChain: { readJob: async () => null, routeFor: async () => "0x000000000000000000000000000000000000dEaD", verifyFeeTransfer: async () => false },
    exchangeProbe: async () => ({ status: 200, latencyMs: 1 }),
  });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(b) });
  try {
    await fn(base, post);
  } finally {
    await app.close?.();
    app.server.close();
  }
}

test("/mcp/readonly: lists only the nine read tools, all readOnlyHint true; read call works; write calls refused", async () => {
  await withApp(async (base, post) => {
    const init = await (await post("/mcp/readonly", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })).json();
    assert.match(init.result.serverInfo.name, /-readonly$/);
    assert.match(init.result.instructions, /read-only endpoint/);
    const tl = await (await post("/mcp/readonly", { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    const tools = tl.result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [...READ].sort());
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true, t.name);
      assert.equal(t.annotations.destructiveHint, false);
      assert.equal(typeof t.annotations.title, "string");
    }
    const r = await (await post("/mcp/readonly", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_service", arguments: { q: "notary" } } })).json();
    assert.notEqual(r.result.isError, true);
    for (const name of ["place_order", "create_listing", "post_job", "claim_job", "join_beta", "record_payment", "claim_listing", "no_such_tool"]) {
      const w = await (await post("/mcp/readonly", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } })).json();
      assert.equal(w.result.isError, true, name);
      const body = JSON.parse(w.result.content[0].text);
      assert.equal(body.error, "read_only_endpoint");
      assert.match(body.message, new RegExp(`tool ${name} is not available on the read-only endpoint`));
      assert.match(body.message, /\/mcp/);
    }
    // batch with a write call is refused as a whole
    const b = await (await post("/mcp/readonly", [{ jsonrpc: "2.0", id: 4, method: "tools/list" }, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "post_job", arguments: {} } }])).json();
    assert.equal(b.length, 2);
    assert.equal(b[1].result.isError, true);
    assert.equal((await fetch(base + "/mcp/readonly")).status, 405);
    // /mcp still has the write tools
    const full = await (await post("/mcp", { jsonrpc: "2.0", id: 6, method: "tools/list" })).json();
    assert.ok(full.result.tools.some((t) => t.name === "place_order"));
    assert.ok(full.result.tools.length > tools.length);
  });
});

test("/terms: draft marked, required sections, fee from config, linked from footer/site/exchange/llms/discovery", async () => {
  await withApp(async (base) => {
    const r = await fetch(base + "/terms", { headers: { accept: "text/html" } });
    assert.equal(r.status, 200);
    const t = (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const s of ["Draft, not lawyer-reviewed", "STOS Technologies LLC", "North Carolina", "Base Sepolia", "no real monetary value", "unaudited", "No warranties", "Limitation of liability", "0.8% of the job price", "0.05 test USDC", "not cash", "cannot be withdrawn", "cannot be transferred", "change or end", "no revenue share", "Acceptable use", "operators", "privacy policy", "hello@agentcoinhq.com", "governed by the laws of the State of North Carolina"]) assert.ok(t.includes(s), s);
    assert.doesNotMatch(t, /guarantee(d)? (profit|income|return)|passive income/i);
    for (const p of ["/", "/about", "/privacy", "/exchange"]) assert.match(await (await fetch(base + p, { headers: { accept: "text/html" } })).text(), /href="\/terms"/, p);
    assert.match(await (await fetch(base + "/llms.txt")).text(), /\/terms/);
    assert.match(await (await fetch(base + "/exchange/llms.txt")).text(), /\/terms/);
    const wk = await (await fetch(base + "/.well-known/agentkoin-exchange.json")).json();
    assert.ok(wk.discovery.terms.endsWith("/terms"));
    assert.ok(wk.discovery.mcpReadOnly.endsWith("/mcp/readonly"));
  });
});
