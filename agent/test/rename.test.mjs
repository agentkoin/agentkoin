// AD-015: AgentKoin rename of JSON, llms.txt, OpenAPI, MCP card, brand; aliases; 402 and signed files unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("AD-015: JSON/llms/OpenAPI/MCP/brand use AgentKoin; old paths and 402 identifiers stay", async () => {
  const { createApp, VERSION } = await import("../service/app.mjs");
  assert.equal(VERSION, "0.5.40");

  const app = createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "acrename-")), publicUrl: "http://127.0.0.1:0", caps: { freePerIpPerHour: 1000 }, loopMs: 1e9 });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers });
  try {
    const index = await (await get("/", { accept: "application/json" })).json();
    assert.equal(index.service, "AgentKoin testnet service");
    assert.equal(index.formerly, "AgentCoin");
    assert.equal(index.version, "0.5.40");
    assert.ok(index.links.trustManifest.endsWith("/.well-known/agentcoin-trust.json"));
    assert.ok(index.links.index.endsWith("/.well-known/agentcoin-index.json"));
    const firstKeys = Object.keys(index).slice(0, 7);
    assert.deepEqual(firstKeys, ["service", "version", "network", "chainId", "links", "index", "paidEndpoints"]);

    const llms = await (await get("/llms.txt")).text();
    assert.match(llms, /^# AgentKoin \(Base Sepolia testnet\)/);
    assert.match(llms, /Formerly AgentCoin/);
    assert.doesNotMatch(llms, /AGK/);

    const openapi = await (await get("/openapi.json")).json();
    assert.equal(openapi.info.title, "AgentKoin testnet service: index, router, escrow");
    assert.equal(openapi.info["x-logo"].altText, "AgentKoin");
    assert.match(openapi.info.description, /Formerly AgentCoin/);

    const card = await (await get("/.well-known/mcp/server-card.json")).json();
    assert.equal(card.serverInfo.name, "agentkoin-local"); // NETWORK defaults to local in tests; on base-sepolia it is agentkoin-base-sepolia
    assert.equal(card.serverInfo.version, VERSION);
    assert.equal(card.serverInfo.title, "AgentKoin router + escrow (Base Sepolia testnet)");
    assert.equal(card.serverInfo.formerly, "AgentCoin");
    assert.deepEqual(card.serverInfo.aliases, ["agentcoin-local"]); // former name kept as alias

    const brandPath = path.join(AGENT, "static", "agentcoin-brand.json");
    const brandFile = JSON.parse(readFileSync(brandPath, "utf8"));
    assert.equal(brandFile.name, "AgentKoin");
    assert.equal(brandFile.ticker, undefined);
    assert.equal(brandFile.formerly, "AgentCoin");
    assert.equal(brandFile.v, "agentcoin-brand/v1");
    const oldBrand = await (await get("/.well-known/agentcoin-brand.json")).text();
    const newBrand = await (await get("/.well-known/agentkoin-brand.json")).text();
    assert.equal(oldBrand, newBrand);
    assert.equal(oldBrand, readFileSync(brandPath, "utf8"));
    assert.match(oldBrand, /"name": "AgentKoin"/);

    const trustOld = await (await get("/.well-known/agentcoin-trust.json")).text();
    const trustNew = await (await get("/.well-known/agentkoin-trust.json")).text();
    assert.equal(trustOld, trustNew);
    const idxOld = await (await get("/.well-known/agentcoin-index.json")).json();
    const idxNew = await (await get("/.well-known/agentkoin-index.json")).json();
    assert.equal(idxOld.v, "agentcoin-index/0.1");
    delete idxOld.generatedAt; delete idxNew.generatedAt;
    assert.deepEqual(idxOld, idxNew);

    // 402 identifiers frozen
    const r402 = await fetch(base + "/v1/notarize", { method: "POST", headers: { "content-type": "application/json" }, body: '{"data":"x"}' });
    assert.equal(r402.status, 402);
    assert.notEqual(r402.headers.get("x-agentcoin-testnet"), null);
    assert.equal(r402.headers.get("x-agentcoin-real-value"), "false");
    assert.equal(r402.headers.get("x-agentkoin-testnet"), null);
    assert.equal(r402.headers.get("x-agentkoin-real-value"), null);
    const body = await r402.json();
    const names = [];
    const walk = (o) => {
      if (o && typeof o === "object") {
        if (o.serviceName) names.push(o.serviceName);
        for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
      }
    };
    walk(body);
    // Bazaar listing (Nov 20): the 402 resource serviceName is AgentKoin; protocol ids and headers keep agentcoin
    assert.ok(names.includes("AgentKoin"), `serviceName in 402: ${names}`);
    assert.equal(names.every((n) => n === "AgentKoin"), true);

    const x402 = await (await get("/.well-known/x402")).arrayBuffer();
    const live = readFileSync(path.join(AGENT, "static", "well-known-x402.json"));
    assert.equal(Buffer.from(x402).equals(live), true);
    assert.equal(createHash("sha256").update(live).digest("hex"), "e592bf9530f539ea1f8909fbe60d246bf6c3394ebe00aee2ab54ae86c89aa3bb");
  } finally {
    app.close?.();
    app.server.close();
  }
});
