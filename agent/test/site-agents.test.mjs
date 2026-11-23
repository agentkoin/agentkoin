// Agent fast-path: /agents, content negotiation (json / markdown / html), Link headers; HTML stays default; "/" JSON unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { negotiate, linkHeader, sitePageMachine, SITE_ROUTES } from "../service/site.mjs";

async function withApp(fn) {
  const { createApp } = await import("../service/app.mjs");
  const app = createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "sa-")), publicUrl: "http://127.0.0.1:0", loopMs: 1e9 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${app.server.address().port}`); } finally { await app.stop(); }
}
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

test("negotiate: html default for browsers, */*, none; json/markdown only when explicitly preferred; ?format wins", () => {
  for (const a of [undefined, "", "*/*", BROWSER, "text/html", "text/html, application/json;q=0.5"]) assert.equal(negotiate(a), "html", String(a));
  assert.equal(negotiate("application/json"), "json");
  assert.equal(negotiate("application/json, text/html;q=0.5"), "json");
  assert.equal(negotiate("text/markdown"), "md");
  assert.equal(negotiate("text/markdown, text/html;q=0.8"), "md");
  assert.equal(negotiate(BROWSER, "json"), "json");
  assert.equal(negotiate("application/json", "html"), "html");
  assert.equal(negotiate(undefined, "md"), "md");
});

test("linkHeader points at llms.txt, discovery file, openapi and agent card", () => {
  const h = linkHeader("https://x.test");
  assert.match(h, /<https:\/\/x\.test\/llms\.txt>; rel="describedby"/);
  assert.match(h, /<https:\/\/x\.test\/\.well-known\/agentkoin-exchange\.json>; rel="alternate"/);
  assert.match(h, /rel="service-desc"/); assert.match(h, /agent-card\.json/);
});

test("/agents and info pages: html, json, markdown, Link + Vary headers; testnet flagged in machine versions", async () => {
  await withApp(async (base) => {
    for (const p of Object.keys(SITE_ROUTES)) {
      const h = await fetch(base + p, { headers: { accept: BROWSER } });
      assert.equal(h.status, 200, p); assert.match(h.headers.get("content-type"), /text\/html/);
      assert.match(h.headers.get("link"), /llms\.txt/); assert.match(h.headers.get("vary"), /Accept/i);
      const j = await fetch(base + p, { headers: { accept: "application/json" } });
      assert.equal(j.status, 200); assert.match(j.headers.get("content-type"), /application\/json/);
      assert.match(j.headers.get("link"), /llms\.txt/);
      const o = await j.json();
      assert.equal(o.v, "agentkoin-page/v1"); assert.equal(o.path, p); assert.equal(o.testnet, true); assert.equal(o.realValue, false);
      assert.ok(o.title && o.markdown.includes("Testnet only")); assert.ok(o.discovery.mcpReadOnly.endsWith("/mcp/readonly"));
      assert.ok(o.markdown.length < 12_000, "compact");
      const m = await fetch(base + p, { headers: { accept: "text/markdown" } });
      assert.match(m.headers.get("content-type"), /text\/markdown/);
      const t = await m.text(); assert.match(t, /^Testnet only/); assert.match(t, /\n# /); assert.doesNotMatch(t, /<(h1|p|a|div|li)[ >]/);
      assert.equal((await fetch(base + p + "?format=json")).headers.get("content-type").includes("json"), true);
      assert.match(await (await fetch(base + p + "?format=md")).text(), /^Testnet only/);
    }
    const a = await (await fetch(base + "/agents", { headers: { accept: "text/markdown" } })).text();
    for (const s of ["/llms.txt", "/mcp/readonly", "/mcp", "agentkoin-exchange.json", "curl -s", "EIP-712", "proves|does not prove".split("|")[1]]) assert.ok(a.includes(s), s);
    const html = await (await fetch(base + "/agents", { headers: { accept: BROWSER } })).text();
    assert.doesNotMatch(html, /<script/i); assert.match(html, /<h1>For agents<\/h1>/);
  });
});

test("'/' keeps its JSON index for agents; adds Link header; browsers get html; markdown gets the agents quickstart", async () => {
  await withApp(async (base) => {
    const j = await fetch(base + "/"); const body = await j.json();
    assert.equal(body.service, "AgentKoin testnet service"); assert.match(j.headers.get("link"), /llms\.txt/);
    const j2 = await (await fetch(base + "/", { headers: { accept: "application/json" } })).json();
    assert.deepEqual(j2, body);
    const h = await fetch(base + "/", { headers: { accept: BROWSER } });
    assert.match(h.headers.get("content-type"), /html/); assert.match(h.headers.get("link"), /llms\.txt/);
    const m = await fetch(base + "/", { headers: { accept: "text/markdown" } });
    assert.match(m.headers.get("content-type"), /markdown/); assert.match(await m.text(), /For agents/);
  });
});

test("machine version is null for unknown path; nav on html pages links /agents", async () => {
  assert.equal(sitePageMachine("/nope", { base: "x" }, "json"), null);
  await withApp(async (base) => {
    const t = await (await fetch(base + "/about", { headers: { accept: "text/html" } })).text();
    assert.match(t, /href="\/agents"/);
  });
});
