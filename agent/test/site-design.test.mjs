// Redesign budget: size, no scripts/external fonts/trackers, a11y structure, palette contrast, live-only tiles, /security + /status.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { liveTiles, SITE_ROUTES } from "../service/site.mjs";
import { landingHtml, STYLE } from "../service/landing.mjs";

async function withApp(fn) {
  const { createApp } = await import("../service/app.mjs");
  const app = createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "sd-")), publicUrl: "http://127.0.0.1:0", loopMs: 1e9 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${app.server.address().port}`); } finally { await app.stop(); }
}
const HTML = { accept: "text/html" };

const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("palette pairs meet WCAG AA (4.5:1 text, 3:1 for the accent button label and focus ring)", () => {
  const pairs = [["#0E0F11", "#F4F2EC", 4.5], ["#3d4046", "#F4F2EC", 4.5], ["#3d4046", "#ffffff", 4.5], ["#F4F2EC", "#0E0F11", 4.5], ["#c4c1b8", "#0E0F11", 4.5], ["#c4c1b8", "#17181b", 4.5], ["#F4F2EC", "#17181b", 4.5], ["#0E0F11", "#FF5A1F", 4.5], ["#B3350A", "#F4F2EC", 4.5], ["#B3350A", "#ffffff", 4.5], ["#FF5A1F", "#0E0F11", 4.5], ["#FF5A1F", "#17181b", 4.5], ["#F4F2EC", "#0E0F11", 4.5]];
  for (const [fg, bg, min] of pairs) assert.ok(ratio(fg, bg) >= min, `${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}`);
  for (const v of ["--ink:#0E0F11", "--paper:#F4F2EC", "--accent:#FF5A1F"]) assert.ok(STYLE.includes(v), v);
  // v3 token pairs actually used for text (brief section c): body/secondary on paper and ink, kicker, status pills, primary button label
  const v3 = [["#0E0F11", "#FBFAF7", 4.5], ["#5E5A50", "#F4F2EC", 4.5], ["#5E5A50", "#FBFAF7", 4.5], ["#C23C0B", "#F4F2EC", 4.5], ["#C23C0B", "#FBFAF7", 4.5], ["#B4B8BE", "#0E0F11", 4.5], ["#8B9098", "#0E0F11", 4.5], ["#B4B8BE", "#16181B", 4.5], ["#8B9098", "#16181B", 4.5], ["#F4F2EC", "#16181B", 4.5], ["#160700", "#FF5A1F", 4.5], ["#1B7F4A", "#FBFAF7", 4.5], ["#7FE3AA", "#16181B", 4.5], ["#B3261E", "#FBFAF7", 4.5], ["#FF5A1F", "#16181B", 4.5], ["#FF8A80", "#1C1F23", 4.5], ["#0E0F11", "#F4F2EC", 4.5]];
  for (const [fg, bg, min] of v3) assert.ok(ratio(fg, bg) >= min, `v3 ${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}`);
  for (const v of ["--i3:#B4B8BE", "--i4:#8B9098", "--p700:#5E5A50", "--s7:#C23C0B", "--ok7:#1B7F4A", "--okd:#7FE3AA"]) assert.ok(STYLE.includes(v), v);
});

test("every page: under 40 KB, one h1, ordered headings, lang, skip link, landmarks, alt text, no scripts/iframes/external fonts/trackers", async () => {
  await withApp(async (base) => {
    const paths = ["/", ...Object.keys(SITE_ROUTES), "/privacy"];
    for (const p of paths) {
      const r = await fetch(base + p, { headers: HTML });
      assert.equal(r.status, 200, p);
      const h = await r.text();
      assert.ok(Buffer.byteLength(h) < 40_000, `${p} is ${Buffer.byteLength(h)} bytes`);
      assert.equal((h.match(/<h1[ >]/g) ?? []).length, 1, `${p} h1`);
      assert.match(h, /<html lang="en">/); assert.match(h, /<a class="skip" href="#content">/); assert.match(h, /<header class="top">/); assert.match(h, /<main id="content"/); assert.match(h, /<nav class="main" aria-label="Site">/);
      assert.match(h, /name="viewport"/);
      let last = 1; for (const m of h.matchAll(/<h([1-4])[ >]/g)) { assert.ok(Number(m[1]) <= last + 1, `${p}: heading jumps to h${m[1]} after h${last}`); last = Number(m[1]); }
      for (const img of h.match(/<img [^>]*>/g) ?? []) assert.match(img, /alt="[^"]+"/);
      assert.doesNotMatch(h, /<script|<iframe|<link[^>]+stylesheet|@import|googleapis|gstatic|gtag\(|plausible\.io|hotjar\.com/i, p);
      // v3: fonts are self-hosted ("no third-party font hosts"): every @font-face and preload points at /fonts/ on this origin
      for (const m of h.matchAll(/<link[^>]+preload[^>]*>/g)) assert.match(m[0], /href="\/fonts\/[\w.-]+\.woff2"/, p);
      for (const m of h.matchAll(/@font-face\{[^}]*\}/g)) assert.match(m[0], /src:url\(\/fonts\/[\w.-]+\.woff2\)/, p);
      const ext = [...h.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => new URL(m[1]).hostname).filter((x) => !/^(agentcoinhq\.com|github\.com|www\.npmjs\.com|pypi\.org|repo\.sourcify\.dev|sepolia\.basescan\.org|127\.0\.0\.1)$/.test(x)); // links only (proof links: Basescan), nothing loaded
      assert.deepEqual(ext, [], `${p} external hosts`);
      assert.match(h, /[Tt]estnet/);
    }
  });
});

test("liveTiles: values are exactly the counts in the source data; missing or broken sources hide their tile", () => {
  assert.deepEqual(liveTiles(null), []);
  assert.deepEqual(liveTiles({ trustJobs: [], exchangeStats: null }), []);
  assert.deepEqual(liveTiles({ trustJobs: "bad", exchangeStats: { listings: "bad" } }), []);
  const t = liveTiles({ trustJobs: [{ state: "Settled" }, { state: "Settled" }, { state: "Funded" }], exchangeStats: { listings: [{ status: "active", n: 3 }, { status: "paused", n: 2 }] } });
  assert.deepEqual(t.map((x) => [x.label, x.value]), [["job receipts published", "3"], ["settled on-chain", "2"], ["active Exchange listings", "3"]]);
  const h = landingHtml({ links: { llms: "/llms.txt" }, version: "x", alt: "a", tiles: t });
  assert.match(h, /<b>3<\/b>/); assert.match(h, /<b>2<\/b>/);
  assert.doesNotMatch(landingHtml({ links: { llms: "/llms.txt" }, version: "x", alt: "a", tiles: [] }), /class="stats"/);
});

test("no invented numbers or partner logos on the landing page", () => {
  const h = landingHtml({ links: { llms: "/llms.txt" }, version: "x", alt: "a", tiles: [] });
  const text = h.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(text, /trusted by|as seen|customers|partners|testimonial|\d+\+|\b\d{2,3}%|million|billion/i);
  assert.equal((h.match(/<img /g) ?? []).length, 2); // only the two logo variants
});

test("/security and /status: 200, JSON/markdown versions, status shows real service facts", async () => {
  await withApp(async (base) => {
    const s = await (await fetch(base + "/security", { headers: HTML })).text();
    for (const x of ["unaudited", "does not show that the caller is not a human", "hello@agentcoinhq.com", "never holds"]) assert.ok(s.includes(x), x);
    const st = await fetch(base + "/status", { headers: HTML }); assert.equal(st.status, 200);
    const t = await st.text(); assert.match(t, /responding/); assert.match(t, /chain ID <code>84532/); assert.match(t, /\/healthz/);
    const j = await (await fetch(base + "/status", { headers: { accept: "application/json" } })).json();
    assert.equal(j.path, "/status"); assert.equal(j.testnet, true);
    assert.match(await (await fetch(base + "/security?format=md")).text(), /^Testnet only/);
  });
});
