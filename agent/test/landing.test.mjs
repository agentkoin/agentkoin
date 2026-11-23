// AD-012: "/" content negotiation (JSON for agents, byte-identical across non-HTML Accepts), HEAD /, brand assets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wantsHtml, landingHtml, BRAND_FILES } from "../service/landing.mjs";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

test("negotiation: HTML only when Accept prefers text/html; JSON for */*, none, JSON, ties and ?format=json", () => {
  assert.equal(wantsHtml(BROWSER), true);
  assert.equal(wantsHtml("text/html"), true);
  for (const a of [undefined, "", "*/*", "application/json", "application/json, text/html", "text/html;q=0.5, application/json", "text/*", "text/html;q=0", "application/json, */*;q=0.1"]) assert.equal(wantsHtml(a), false, String(a));
  assert.equal(wantsHtml(BROWSER, "json"), false);
});

test("brand assets exist; brand.json URLs resolve to served paths; page copy rules", () => {
  for (const [p, [f]] of Object.entries(BRAND_FILES)) assert.ok(existsSync(path.join(AGENT, "static", f)), p);
  const brand = readFileSync(path.join(AGENT, "static", "agentcoin-brand.json"), "utf8");
  for (const u of brand.match(/https:\/\/agentcoinhq\.com[^",]*/g)) assert.ok(BRAND_FILES[new URL(u).pathname], u);
  const html = landingHtml({ links: { quickstart: "/q", llms: "/llms.txt", openapi: "/o", evaluators: "/e", agentCard: "/.well-known/agent-card.json", mcpServerCard: "/m" }, version: "x", alt: "AgentCoin mark" });
  assert.match(html, /<link rel="alternate" type="application\/json" href="\/\?format=json">/);
  assert.match(html, /href="\/llms\.txt"/);
  assert.match(html, /href="\/\.well-known\/agent-card\.json"/);
  assert.match(html, /<p class="status">Public beta on Base Sepolia testnet, mainnet coming<\/p>/);
  assert.doesNotMatch(html, /class="banner"|TESTNET|no real value/);
  assert.match(html, /contracts unaudited/);
  assert.match(html, /test tokens have no monetary value/);
  assert.match(html, /© 2026 STOS Technologies LLC/);
  assert.doesNotMatch(html, /<script|dollar|yield|invest|price/i);
  for (const img of html.match(/<img [^>]*>/g)) assert.match(img, /alt="[^"]+"/);
});

test("AD-013 rename: page says AgentKoin; AgentCoin only in 'formerly AgentCoin'; lockups are the AgentKoin files", async () => {
  const { BRAND_ALT } = await import("../service/app.mjs");
  const html = landingHtml({ links: { quickstart: "/q", llms: "/llms.txt", openapi: "/o", evaluators: "/e", agentCard: "/.well-known/agent-card.json", mcpServerCard: "/m" }, version: "x", alt: BRAND_ALT });
  // visible text + title + alt + meta content, without tags or URL attributes
  const alts = [...html.matchAll(/(?:alt|content)="([^"]*)"/g)].map((m) => m[1]).join(" ");
  const text = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ") + " " + alts;
  assert.match(text, /AgentKoin/);
  assert.equal(text.replace("formerly AgentCoin", "").includes("AgentCoin"), false);
  assert.equal((html.match(/AgentCoin/g) ?? []).length, 1);
  const srcs = [...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["/brand/lockup/agentkoin-lockup-horizontal-light.svg", "/brand/lockup/agentkoin-lockup-horizontal-dark.svg"]);
  for (const s of srcs) assert.ok(BRAND_FILES[s], s);
  for (const img of html.match(/<img [^>]*>/g)) assert.match(img, /width="214" height="58"/);
});

test("HTTP: / JSON identical for every non-HTML Accept, HTML for browsers, Vary: Accept, HEAD / 200, favicon 200", async () => {
  const { createApp } = await import("../service/app.mjs");
  const app = createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "aclanding-")), publicUrl: "http://127.0.0.1:0", caps: { freePerIpPerHour: 1000 }, loopMs: 1e9 });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const bodies = [];
    for (const accept of [null, "*/*", "application/json", "application/json, text/html"]) {
      const r = await fetch(base + "/", { headers: accept ? { accept } : {} });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /^application\/json/);
      assert.equal(r.headers.get("vary"), "Accept");
      bodies.push(await r.text());
    }
    bodies.push(await (await fetch(base + "/?format=json", { headers: { accept: BROWSER } })).text());
    assert.equal(new Set(bodies).size, 1);
    assert.deepEqual(Object.keys(JSON.parse(bodies[0])).slice(0, 7), ["service", "version", "network", "chainId", "links", "index", "paidEndpoints"]);
    const h = await fetch(base + "/", { headers: { accept: BROWSER } });
    assert.equal(h.status, 200);
    assert.match(h.headers.get("content-type"), /^text\/html/);
    assert.equal(h.headers.get("vary"), "Accept");
    assert.match(await h.text(), /<!doctype html>/);
    const hd = await fetch(base + "/", { method: "HEAD" });
    assert.equal(hd.status, 200);
    assert.match(hd.headers.get("content-type"), /^application\/json/);
    for (const p of ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png", "/icon-512.png", "/.well-known/agentcoin-brand.json", "/.well-known/agentkoin-brand.json", "/brand/symbol.svg"]) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.equal(Number(r.headers.get("content-length")), readFileSync(path.join(AGENT, "static", BRAND_FILES[p][0])).length, p);
      await r.arrayBuffer();
    }
    assert.equal((await fetch(base + "/favicon.ico", { method: "HEAD" })).status, 200);
  } finally {
    app.close?.();
    app.server.close();
  }
});

test("Nov 20 site: landing facts/links, /privacy page, no AGC, no sslip; GET+HEAD /privacy 200 text/html", async () => {
  const { BRAND_ALT, createApp } = await import("../service/app.mjs");
  const { privacyHtml } = await import("../service/landing.mjs");
  const html = landingHtml({ links: { quickstart: "/QUICKSTART-AGENTS.md", llms: "/llms.txt", openapi: "/openapi.json", evaluators: "/v1/evaluators", agentCard: "/.well-known/agent-card.json", mcpServerCard: "/m" }, version: "x", alt: BRAND_ALT });
  for (const s of [
    "AgentKoin", "Base Sepolia testnet", "84532", "0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5",
    "https://repo.sourcify.dev/84532/0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5", "AuthCaptureEscrow", "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c",
    "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88", "bc_ta422vae", "MIT", 'href="https://github.com/agentkoin/agentkoin"',
    'href="https://github.com/agentkoin/agentkoin/tree/main/examples/stripe-x402-demo"', 'href="https://www.npmjs.com/package/@agentkoin/x402-escrow-hint"',
    'href="https://pypi.org/project/agentkoin-core/"', 'href="/llms.txt"', 'href="/QUICKSTART-AGENTS.md"', 'href="/.well-known/agent-card.json"',
    'href="/privacy"', "hello@agentcoinhq.com", 'rel="icon" type="image/png" sizes="1024x1024" href="/brand/symbol-1024.png"', "Accept: application/json",
  ]) assert.ok(html.includes(s), s);
  const p = privacyHtml({ version: "x", alt: BRAND_ALT });
  for (const s of ["STOS Technologies LLC", "hello@agentcoinhq.com", "84532", "November 20, 2026", "/v1/notarize", "cannot be changed or deleted", "do not sell personal information", "no cookies"])
    assert.ok(p.toLowerCase().includes(s.toLowerCase()), s);
  for (const doc of [html, p]) {
    assert.doesNotMatch(doc, /\bAGC\b|sslip|<script|https?:\/\/(?!agentcoinhq\.com|github\.com|www\.npmjs\.com|pypi\.org|repo\.sourcify\.dev)[a-z0-9.-]+\//i);
  }
  const app = createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "acpriv-")), publicUrl: "http://127.0.0.1:0", caps: { freePerIpPerHour: 1000 }, loopMs: 1e9 });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const method of ["GET", "HEAD"]) {
      const r = await fetch(base + "/privacy", { method });
      assert.equal(r.status, 200, method);
      assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
      const t = await r.text();
      if (method === "GET") assert.match(t, /STOS Technologies LLC/);
    }
    const llms = await (await fetch(base + "/llms.txt")).text();
    for (const s of ["0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5", "bc_ta422vae", "/privacy", "stripe-x402-demo", "@agentkoin/x402-escrow-hint"]) assert.ok(llms.includes(s), s);
    assert.doesNotMatch(llms, /sslip|\bAGC\b|@agentcoin\/x402-escrow-hint/);
    const idx = await (await fetch(base + "/")).json();
    assert.equal(idx.links.privacy, "http://127.0.0.1:0/privacy");
  } finally {
    app.close?.();
    app.server.close();
  }
});
