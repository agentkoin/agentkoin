// v3 site template: live receipt card, live-only strip/preview, /trust and /exchange in the shared template, self-hosted fonts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { landingHtml, receiptJob, receiptHtml, FONT_FILES, FONTS } from "../service/landing.mjs";
import { trustPageHtml, trustCounters } from "../lib/pages.mjs";
import { sitePageMachine, sitePageHtml } from "../service/site.mjs";

const AGENT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const H = (n) => "0x" + String(n).repeat(64).slice(0, 64);
const job = (o) => ({ escrowVersion: "v0.5", escrow: "0x" + "4".repeat(40), jobId: "1", state: "Settled", outcome: "Complete", amount: "1000000", clientLabel: "STOS demo buyer 1", clientKind: "stos", evaluatorLabel: "babyblueviper1 (independent)", evaluatorKind: "outside", proofUrl: "https://agentcoinhq.com/v1/jobs/1/proof", fundTx: H(1), verdictTx: H(2), settleTx: H(3), verifyCommand: "npx @agentkoin/judge-kit@testnet verify 1", ourVerify: { ok: true, passed: 21, failed: 0, skipped: 0, failedChecks: [] }, ...o });
const LINKS = { llms: "/llms.txt", quickstart: "/q", openapi: "/o", evaluators: "/e", agentCard: "/.well-known/agent-card.json", mcpServerCard: "/m" };

test("receipt card: most recent settled job that passed our re-check; none qualifies -> flow card, no job number", () => {
  const jobs = [job({ jobId: "1" }), job({ jobId: "7", amount: "2500000" }), job({ jobId: "9", ourVerify: { ok: false, passed: 1, failed: 1, skipped: 0 } }), job({ jobId: "10", state: "Expired" }), job({ escrowVersion: "v0.4", jobId: "99" })];
  assert.equal(receiptJob(jobs).jobId, "7");
  assert.equal(receiptJob([job({ escrowVersion: "v0.6", jobId: "2" }), job({ jobId: "30" })]).escrowVersion, "v0.6");
  for (const bad of [null, "x", [], [job({ ourVerify: null })], [job({ state: "Funded" })]]) assert.equal(receiptJob(bad), null);
  const h = landingHtml({ links: LINKS, version: "x", alt: "a", receipt: receiptJob(jobs) });
  assert.match(h, /Job <span class="mono">#7<\/span> · escrow v0\.5/);
  assert.match(h, /2\.50<small>test USDC<\/small>/);
  assert.match(h, /21 passed, 0 failed, 0 skipped/);
  assert.ok(h.includes(`href="https://sepolia.basescan.org/tx/${H(1)}"`));
  assert.match(h, /href="\/v1\/jobs\/1\/proof">in proof/); // no submit tx in the data -> points at the signed proof
  assert.match(h, /Judged by babyblueviper1 \(independent\)/);
  const none = landingHtml({ links: LINKS, version: "x", alt: "a", receipt: null });
  assert.doesNotMatch(none, /Job <span class="mono">#|passed, \d+ failed|test USDC<\/small>/);
  assert.match(none, /How a job settles/);
  assert.equal(receiptHtml(null), "");
});

test("landing: strip and Exchange preview only from live inputs; hidden when empty", () => {
  const empty = landingHtml({ links: LINKS, version: "x", alt: "a" });
  assert.doesNotMatch(empty, /class="proof|class="stats|id="h-ex"/);
  const h = landingHtml({ links: LINKS, version: "x", alt: "a", tiles: [{ label: "job receipts published", value: "12", href: "/trust" }], listings: [{ listing_id: "lst_0123456789abcdef", title: "Seller title <b>", seller: "0x" + "a".repeat(40), origin: "external", skills: [{ skill_id: "notarize", price: "10000" }], jobs_settled: 4, score: 0.5 }] });
  assert.match(h, /<b>12<\/b>/); assert.match(h, /Live · Base Sepolia/);
  assert.match(h, /id="h-ex"/); assert.match(h, /Seller title &lt;b&gt;/); assert.match(h, /0\.01 test USDC/); assert.match(h, />4</);
  assert.doesNotMatch(landingHtml({ links: LINKS, version: "x", alt: "a", listings: [{ title: "no skills", skills: [] }] }), /id="h-ex"/);
});

test("trust page: counters come from the rows; absent fields drop their counter; one h1, no scripts, pills not tinted rows", () => {
  const jobs = [job({ jobId: "1", concordium: { status: "finalized", txHash: "ab".repeat(32), explorer: "https://ccdexplorer.io/testnet/transaction/x" } }), job({ jobId: "2", clientKind: "outside", ourVerify: { ok: false, passed: 18, failed: 1, skipped: 2, failedChecks: ["deliverable-hash"] }, legacyNote: "note <x>" }), job({ jobId: "3", state: "Expired", outcome: "None" })];
  const c = Object.fromEntries(trustCounters(jobs));
  assert.deepEqual(c, { "jobs listed": 3, settled: 2, "paid by an outside wallet": 1, "judged by an outside evaluator": 3, "anchored on Concordium": 1, "pass our last verify run": 2, "fail at least one check": 1 });
  assert.deepEqual(trustCounters([{ jobId: "1", state: "Settled" }]).map((x) => x[0]), ["jobs listed", "settled"]);
  const h = trustPageHtml({ generatedAt: "2026-11-22T00:00:00Z", source: "https://agentcoinhq.com", jobs }, { version: "x", alt: "a" });
  assert.equal((h.match(/<h1[ >]/g) ?? []).length, 1);
  assert.doesNotMatch(h, /<script|class="ext"|class="banner"/);
  assert.match(h, /<header class="top">/); assert.match(h, /aria-current="page">Receipts/);
  assert.equal((h.match(/<tr id="job-/g) ?? []).length, 3);
  assert.match(h, /our last run: FAILED 18\/1\/2/); assert.match(h, /failed: deliverable-hash/); assert.match(h, /note &lt;x&gt;/);
  assert.match(h, /Testnet only\./); assert.match(h, /href="\/trust\/jobs\.json"/);
});

async function withApp(fn) {
  const { createApp } = await import("../service/app.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "v3-"));
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", loopMs: 1e9 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${app.server.address().port}`, dir); } finally { await app.stop(); }
}

test("HTTP: /trust HTML is rendered from jobs.json in the site template while JSON stays the file; fonts are self-hosted and immutable", async () => {
  await withApp(async (base, dir) => {
    mkdirSync(path.join(dir, "trust"));
    const doc = { v: "agentkoin-trust-page/v1", generatedAt: "2026-11-22T00:00:00Z", testnet: true, realValue: false, jobs: [job({ jobId: "5" })] };
    writeFileSync(path.join(dir, "trust", "jobs.json"), JSON.stringify(doc));
    writeFileSync(path.join(dir, "trust", "index.html"), "<!doctype html><title>old</title>");
    const h = await fetch(base + "/trust", { headers: { accept: "text/html" } });
    assert.equal(h.status, 200); assert.match(h.headers.get("content-type"), /text\/html/); assert.equal(h.headers.get("vary"), "Accept");
    const t = await h.text(); assert.match(t, /<h1>Public receipts<\/h1>/); assert.match(t, /#5/); assert.doesNotMatch(t, /<title>old/);
    assert.deepEqual(await (await fetch(base + "/trust", { headers: { accept: "application/json" } })).json(), doc);
    assert.equal((await fetch(base + "/trust", { method: "HEAD", headers: { accept: "text/html" } })).status, 200);
    for (const [p, [f, type]] of Object.entries(FONT_FILES)) {
      const r = await fetch(base + p); assert.equal(r.status, 200, p); assert.equal(r.headers.get("content-type"), type);
      const buf = Buffer.from(await r.arrayBuffer()); assert.equal(Buffer.compare(buf, readFileSync(path.join(AGENT, "static", f))), 0, p);
      if (p.endsWith(".woff2")) assert.match(r.headers.get("cache-control"), /immutable/);
    }
    assert.ok(FONT_FILES[FONTS.sans] && FONT_FILES[FONTS.mono]);
    assert.match(await (await fetch(base + "/fonts/OFL.txt")).text(), /SIL OPEN FONT LICENSE Version 1\.1/);
    const x = await (await fetch(base + "/exchange", { headers: { accept: "text/html" } })).text();
    for (const re of [/<header class="top">/, /<main id="content"/, /<a class="skip" href="#content">/, /aria-current="page">Exchange/, /role="search"/, /Testnet|testnet/]) assert.match(x, re);
    assert.equal((x.match(/<h1[ >]/g) ?? []).length, 1); assert.doesNotMatch(x, /<script/);
  });
});

test("machine versions are built from the page text only (no v3 template markup leaks into JSON/markdown)", () => {
  const ctx = { base: "https://x.test", fees: {}, links: {}, version: "t", alt: "a" };
  for (const p of ["/agents", "/how-it-works", "/security", "/about"]) {
    const md = sitePageMachine(p, ctx, "md").body;
    assert.doesNotMatch(md, /For agents: this page|On this page|Give your agent a way to earn|class=/, p);
    const html = sitePageHtml(p, ctx);
    assert.match(html, /class="agentbar"/); assert.match(html, new RegExp(`href="${p}\\?format=json"`));
  }
});

test("trust page is paged: 39 rows stay under 45 KB, counters cover all rows, page links and clamping work, the full list stays in JSON", () => {
  const jobs = Array.from({ length: 39 }, (_, i) => job({ jobId: String(i + 1), ourVerify: { ok: true, passed: 10, failed: 0, skipped: 1 }, verifyCommand: "npx @agentkoin/judge-kit@testnet verify " + (i + 1) }));
  const doc = { generatedAt: "2026-11-22T00:00:00Z", source: "https://agentcoinhq.com", jobs };
  const p1 = trustPageHtml(doc, { version: "x", alt: "a" });
  assert.ok(Buffer.byteLength(p1) < 45_000, `page 1 is ${Buffer.byteLength(p1)} bytes`);
  assert.equal((p1.match(/<tr id="job-/g) ?? []).length, 12);
  assert.match(p1, /Showing jobs 1-12 of 39/); assert.match(p1, /href="\/trust\?page=2"/); assert.match(p1, /\/trust\/jobs\.json/);
  assert.match(p1, /<b>39<\/b><span>jobs listed/);
  const p4 = trustPageHtml(doc, { version: "x", alt: "a", page: "4" });
  assert.equal((p4.match(/<tr id="job-/g) ?? []).length, 3); assert.match(p4, /Showing jobs 37-39 of 39/);
  for (const bad of ["99", "0", "-2", "abc", "1.5"]) { const h = trustPageHtml(doc, { version: "x", alt: "a", page: bad }); assert.ok((h.match(/<tr id="job-/g) ?? []).length > 0 && Buffer.byteLength(h) < 45_000, bad); }
});
