// Informational human site: routes return 200 HTML, testnet notice present, no scripts, fee text matches live config, local links resolve.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { feeFacts, sitePageHtml, SITE_ROUTES } from "../service/site.mjs";

async function withApp(fn) {
  const { createApp } = await import("../service/app.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "site-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", loopMs: 1e9 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${app.server.address().port}`, app); } finally { await app.stop(); }
}
const HTML = { accept: "text/html" };
const text = (h) => h.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");

test("each site route returns 200 HTML with testnet notice, logo, alt text, no scripts", async () => {
  await withApp(async (base) => {
    for (const p of Object.keys(SITE_ROUTES)) {
      for (const url of [p, p + "/"]) {
        const r = await fetch(base + url, { headers: HTML });
        assert.equal(r.status, 200, url);
        assert.match(r.headers.get("content-type"), /text\/html/);
        const h = await r.text();
        assert.match(h, /<h1>/); assert.match(h, /Testnet only\./); assert.match(h, /no monetary value|no real value/);
        assert.match(h, /STOS Technologies LLC/);
        assert.doesNotMatch(h, /<script|<iframe/i);
        for (const img of h.match(/<img [^>]*>/g) ?? []) assert.match(img, /alt="[^"]+"/);
      }
      assert.equal((await fetch(base + p, { method: "HEAD", headers: HTML })).status, 200);
    }
  });
});

test("site pages do not claim hiring, human services or real money; fee text follows the running config", async () => {
  await withApp(async (base, app) => {
    const fees = app.exchange?.fees?.();
    const ff = feeFacts(fees);
    for (const p of Object.keys(SITE_ROUTES)) {
      const t = text(await (await fetch(base + p, { headers: HTML })).text());
      assert.doesNotMatch(t, /guarantee(d)? (profit|income|return)|passive income|get rich|\bAPY\b|(?<!no )revenue share(?! and)/i, p);
    }
    const how = text(await (await fetch(base + "/how-it-works", { headers: HTML })).text());
    if (ff.bps > 0) { assert.ok(how.includes(ff.percent), "percent from config"); if (ff.minUsdc) assert.ok(how.includes(ff.minUsdc + " USDC")); }
    else assert.match(how, /no Exchange fee|none in the running version/);
    assert.match(how, /Escrow \(protocol\)\s+0%/);
  });
});

test("fee rendering from config shapes (0.8% / 0.05 min / beta) and 0% fallback", () => {
  const ctx = (fees) => ({ base: "https://x.test", fees, links: {}, version: "t", alt: "alt" });
  const fees = { exchangeFeeBps: 80, exchangeFee: { bps: 80, percent: "0.8%", min: "50000" }, beta: { window: { end: "2027-01-01T04:59:59Z" }, creditPerJob: "10000", maxCreditBalance: "1000000" } };
  const how = text(sitePageHtml("/how-it-works", ctx(fees)));
  assert.match(how, /0\.8% of the job price, minimum 0\.05 USDC/);
  assert.match(how, /0% through December 31, 2026/);
  assert.match(how, /0\.01 USDC/); assert.match(how, /not cash/);
  assert.match(text(sitePageHtml("/how-it-works", ctx({ exchangeFeeBps: 0 }))), /none in the running version/);
  assert.equal(sitePageHtml("/nope", ctx(fees)), null);
});

test("every local link on every site page resolves (earn-mvp-only paths tolerated until merged)", async () => {
  await withApp(async (base) => {
    const earnMerged = (await fetch(base + "/exchange/earn.md")).status === 200;
    const EARN_ONLY = new Set(["/exchange/earn.md", "/exchange/v1/earn", "/exchange/v1/jobs", "/exchange/v1/beta"]);
    const seen = new Set(); const bad = [];
    for (const p of Object.keys(SITE_ROUTES)) {
      const h = await (await fetch(base + p, { headers: HTML })).text();
      for (const m of h.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const u = m[1];
        if (/^(mailto:|https?:|#)/.test(u)) { assert.ok(!u.startsWith("http:"), u); continue; }
        const [pp] = u.split("#"); if (!pp || seen.has(pp)) continue; seen.add(pp);
        const r = await fetch(base + pp, { headers: pp === "/" ? HTML : { accept: "*/*" } });
        if (r.status === 200) continue;
        if (r.status === 404 && !earnMerged && EARN_ONLY.has(pp.split("?")[0])) continue;
        if (pp === "/openapi.json" && r.status === 500) continue; // builds from live chain reads; the test app has no RPC (verified 200 on the live site)
        if (pp === "/trust" || pp === "/trust/jobs.json") continue; // served from the state dir once the trust page is generated
        bad.push(`${p} -> ${pp}: ${r.status}`);
      }
    }
    assert.deepEqual(bad, []);
    assert.ok(seen.size > 15);
  });
});
