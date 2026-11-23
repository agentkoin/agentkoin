// AD-012: human landing page on "/" by content negotiation, plus brand assets. Agents keep the JSON index byte-for-byte:
// HTML is served only when Accept explicitly prefers text/html (or application/xhtml+xml) over JSON; `*/*`, a missing
// Accept, ties and ?format=json all get JSON. Static, no scripts, no trackers.
import { EXPLORER, TESTNET } from "../lib/network.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

/** q-value of the best explicit match for one of `types` (exact type only; wildcards never count as HTML). */
function qFor(accept, types) {
  let best = -1;
  for (const part of String(accept ?? "").split(",")) {
    const [t, ...params] = part.trim().toLowerCase().split(";");
    if (!types.includes(t.trim())) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split("=");
      if (k === "q") q = Number.isFinite(Number(v)) ? Number(v) : 0;
    }
    best = Math.max(best, q);
  }
  return best;
}

/** True only when the client prefers HTML over JSON. JSON wins ties and every non-HTML Accept. */
export function wantsHtml(accept, format) {
  if (format === "json") return false;
  const html = qFor(accept, ["text/html", "application/xhtml+xml"]);
  if (html <= 0) return false;
  const jsonQ = qFor(accept, ["application/json"]);
  return html > jsonQ;
}

// Served brand files: URL path -> [file under agent/static, content-type]. Whitelist only.
const T = { svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", json: "application/json" };
export const BRAND_FILES = {
  "/favicon.ico": ["brand/favicon/favicon.ico", T.ico],
  "/favicon.svg": ["brand/favicon/favicon.svg", T.svg],
  "/apple-touch-icon.png": ["brand/favicon/apple-touch-icon-180.png", T.png],
  "/icon-512.png": ["brand/favicon/icon-512.png", T.png],
  "/icon-512-maskable.png": ["brand/favicon/icon-512-maskable.png", T.png],
  "/.well-known/agentcoin-brand.json": ["agentcoin-brand.json", T.json],
  "/.well-known/agentkoin-brand.json": ["agentcoin-brand.json", T.json],
};
for (const f of ["plated.svg", "plated-512.png", "plated-1024.png", "symbol.svg", "symbol-on-dark.svg", "symbol-mono.svg", "symbol-mono-black.svg", "symbol-mono-white.svg", "symbol-1024.png", "token-icon.svg", "token-icon-256.png"])
  BRAND_FILES[`/brand/${f}`] = [`brand/${f}`, T[f.split(".").pop()]];
for (const s of ["held", "released", "refunded", "partial"]) {
  BRAND_FILES[`/brand/states/state-${s}.svg`] = [`brand/states/state-${s}.svg`, T.svg];
  BRAND_FILES[`/brand/states/state-${s}-dark.svg`] = [`brand/states/state-${s}-dark.svg`, T.svg];
  BRAND_FILES[`/brand/states/state-${s}-256.png`] = [`brand/states/state-${s}-256.png`, T.png];
}
for (const v of ["light", "dark", "mono"]) {
  BRAND_FILES[`/brand/lockup/lockup-horizontal-${v}.svg`] = [`brand/lockup/lockup-horizontal-${v}.svg`, T.svg];
  BRAND_FILES[`/brand/lockup/agentkoin-lockup-horizontal-${v}.svg`] = [`brand/lockup/agentkoin-lockup-horizontal-${v}.svg`, T.svg]; // AD-013
}

// bbv-job1: static deliverable for the first outside-evaluator job. Whitelist only; new path, existing routes unchanged.
export const JOB_FILES = {
  "/jobs/1/deliverable.json": ["jobs/1/deliverable.json", T.json],
  "/jobs/2/deliverable.json": ["jobs/2/deliverable.json", T.json], // bbv-job2 (AD-014)
};
// Self-hosted Geist / Geist Mono (SIL OFL 1.1, text at /fonts/OFL.txt). Hashed names, served immutable.
export const FONT_FILES = {
  "/fonts/Geist-679c1e46b3.woff2": ["fonts/Geist-679c1e46b3.woff2", "font/woff2"],
  "/fonts/GeistMono-ad7e7de820.woff2": ["fonts/GeistMono-ad7e7de820.woff2", "font/woff2"],
  "/fonts/OFL.txt": ["fonts/OFL.txt", "text/plain; charset=utf-8"],
};
export function readFont(agentDir, p) {
  const e = FONT_FILES[p];
  if (!e) return null;
  return { buf: readFileSync(path.join(agentDir, "static", e[0])), type: e[1], immutable: p.endsWith(".woff2") };
}

export function readJob(agentDir, p) {
  const e = JOB_FILES[p];
  if (!e) return null;
  return { buf: readFileSync(path.join(agentDir, "static", e[0])), type: e[1] };
}


export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Public, factual deployment facts shown on the landing page (Base Sepolia testnet only).
export const SITE = {
  arbiterV03: "0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5",
  arbiterV03Sourcify: "https://repo.sourcify.dev/84532/0xeBF71A9B9084E40935BA73EB3fdEdc6CEf2f67d5",
  authCaptureEscrow: "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c",
  erc3009Collector: "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88",
  builderCode: "bc_ta422vae",
  repository: "https://github.com/agentkoin/agentkoin",
  stripeDemo: "https://github.com/agentkoin/agentkoin/tree/main/examples/stripe-x402-demo",
  npm: "https://www.npmjs.com/package/@agentkoin/x402-escrow-hint",
  pypi: "https://pypi.org/project/agentkoin-core/",
  contact: "hello@agentcoinhq.com",
};

// Shared page chrome (v3 design system, docs/site-design-brief-v1.md): self-hosted Geist fonts (OFL 1.1, /fonts/OFL.txt),
// no third-party hosts, no scripts, no cookies or trackers. Dark ink chrome, light paper body, one orange primary per view.
export const FONTS = { sans: "/fonts/Geist-679c1e46b3.woff2", mono: "/fonts/GeistMono-ad7e7de820.woff2" };
export const CSS = `@font-face{font-family:"Geist";src:url(${FONTS.sans}) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(${FONTS.mono}) format("woff2");font-weight:100 900;font-display:swap}
:root{--ink:#0E0F11;--paper:#F4F2EC;--accent:#FF5A1F;--i9:#16181B;--i85:#1C1F23;--i8:#24272C;--i7:#33373D;--i5:#6B7078;--i4:#8B9098;--i3:#B4B8BE;--p50:#FBFAF7;--p200:#EAE7DE;--p300:#DCD8CC;--p500:#9C978A;--p700:#5E5A50;--s7:#C23C0B;--ok:#2FBF71;--okd:#7FE3AA;--ok7:#1B7F4A;--warn:#E8A33D;--bad:#B3261E;
--bg:var(--paper);--bg2:var(--p50);--fg:var(--ink);--mut:var(--p700);--line:var(--p300);--line2:var(--p200);--kick:var(--s7);--chip:#fff;--okt:var(--ok7);
--f:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--m:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--sh1:0 1px 0 rgba(14,15,17,.04),0 1px 2px rgba(14,15,17,.06);--sh2:0 1px 0 rgba(14,15,17,.04),0 8px 24px -8px rgba(14,15,17,.12);--sh3:0 0 0 1px rgba(255,255,255,.06),0 24px 64px -16px rgba(0,0,0,.6)}
@media (prefers-color-scheme:dark){:root{--bg:var(--i9);--bg2:var(--i85);--fg:var(--paper);--mut:var(--i3);--line:var(--i8);--line2:var(--i8);--kick:var(--accent);--chip:var(--i9);--okt:var(--okd);--bad:#FF8A80}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:80px}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 var(--f);-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
a{color:inherit;text-underline-offset:3px;text-decoration-thickness:1px}
.wrap{max-width:1200px;margin:0 auto;padding:0 32px}
code,.mono,pre,kbd,samp{font-family:var(--m);font-feature-settings:"tnum","zero"}
code{font-size:.88em;overflow-wrap:anywhere}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;background:#fff;color:var(--ink);padding:8px 12px;z-index:20}
.strip{background:var(--ink);color:var(--i3);font:500 12.5px/1.3 var(--m);letter-spacing:.02em;border-bottom:1px solid var(--i8)}
.strip .wrap{display:flex;gap:14px;align-items:center;min-height:36px;justify-content:center}
.dot{width:7px;height:7px;border-radius:50%;background:var(--warn);box-shadow:0 0 0 3px rgba(232,163,61,.18);display:inline-block;flex:none}
.strip a{color:var(--paper);text-decoration:none;border-bottom:1px solid var(--i7);white-space:nowrap}.s-short{display:none}
header.top{position:sticky;top:0;z-index:10;background:var(--ink);color:var(--paper);border-bottom:1px solid rgba(255,255,255,.07)}
header.top .wrap{display:flex;align-items:center;min-height:64px;gap:36px}
.logo{display:block;flex:none}.logo img{height:30px;width:auto;display:block}.logo .light{display:none}
nav.main{display:flex;gap:26px;font-size:14.5px}
nav.main a,.menu nav a{color:var(--i3);text-decoration:none;display:inline-flex;align-items:center;min-height:44px}
nav.main a:hover,nav.main a[aria-current=page],.menu nav a:hover{color:var(--paper)}
nav.main a[aria-current=page]{box-shadow:inset 0 -2px 0 var(--accent)}
.right{margin-left:auto;display:flex;gap:10px;align-items:center}
.menu{display:none;position:relative}
.menu summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 16px;border:1px solid var(--i7);border-radius:999px;font:550 14px/1 var(--f)}
.menu summary::-webkit-details-marker{display:none}
.menu nav{position:absolute;right:0;top:52px;width:min(300px,calc(100vw - 40px));background:var(--i9);border:1px solid var(--i8);border-radius:16px;padding:10px 18px 16px;box-shadow:var(--sh3);display:grid}
.btn{white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 18px;border-radius:999px;font:550 15px/1 var(--f);text-decoration:none;border:1px solid transparent;transition:background .15s,border-color .15s}
.btn-sm{height:36px;padding:0 14px;font-size:14px}
.btn-signal{background:var(--accent);color:#160700}.btn-signal:hover{background:#FF6A33}
.btn-paper{background:var(--paper);color:var(--ink)}.btn-paper:hover{background:#fff}
.btn-ghost-d{color:var(--paper);border-color:var(--i7)}.btn-ghost-d:hover{border-color:var(--i5);background:var(--i9)}
.btn-ghost{border-color:var(--line);color:var(--fg)}.btn-ghost:hover{border-color:var(--p500)}
.arr{transition:transform .15s}.btn:hover .arr{transform:translateX(2px)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
.dk{background:var(--ink);color:var(--paper)}
.kicker{font:500 13px/1.2 var(--m);letter-spacing:.06em;text-transform:uppercase;color:var(--kick);margin:0}
.dk .kicker{color:var(--accent)}
h1{font-size:clamp(36px,4.4vw,52px);line-height:1.06;letter-spacing:-.03em;font-weight:520;margin:14px 0 16px}
h2{font-size:clamp(32px,4vw,48px);line-height:1.08;letter-spacing:-.03em;font-weight:520;margin:16px 0 16px;max-width:18em}
h3{font-size:20px;line-height:1.25;letter-spacing:-.02em;font-weight:560;margin:28px 0 8px}
p{margin:0 0 14px}
.lede{font-size:20px;line-height:1.55;color:var(--i3);max-width:36em;margin:0}
.sub{font-size:19px;color:var(--mut);max-width:38em}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:0}
.stat{padding:26px 24px 28px;border-left:1px solid var(--i8);min-width:0}.stat:first-child{border-left:0;padding-left:0}
.stat b{display:block;font:500 34px/1 var(--m);letter-spacing:-.02em;font-feature-settings:"tnum"}
.stat span{display:block;font-size:14px;color:var(--i4);margin-top:10px}.stat span a{color:var(--i3)}
.live{display:inline-flex;gap:8px;align-items:center;font:500 12px/1.2 var(--m);color:var(--okd)}
.live:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px rgba(47,191,113,.2)}
.proof{border-top:1px solid var(--i8)}
.light-stats .stat{border-color:var(--line)}.light-stats .stat span{color:var(--mut)}.light-stats .stat span a{color:var(--fg)}
.prose .stats{margin:8px 0 28px;border:1px solid var(--line);border-radius:16px;background:var(--bg2)}.prose .stat{padding:20px 22px;border-color:var(--line)}.prose .stat:first-child{padding-left:22px}.prose .stat span{color:var(--mut)}.prose .stat span a{color:var(--fg)}
.pill{white-space:nowrap;display:inline-block;font:500 12px/1 var(--m);padding:6px 10px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
.pill.ok{color:var(--okt);border-color:rgba(47,191,113,.45);background:rgba(47,191,113,.08)}
.pill.bad{color:var(--bad);border-color:currentColor}
.dk .pill{border-color:var(--i7);color:var(--i3)}.dk .pill.ok{color:var(--okd)}
.tag{display:inline-block;font:500 12px/1.3 var(--m);padding:4px 8px;border-radius:6px;background:var(--line2);color:var(--mut);margin:2px 4px 2px 0}
.tag.badge{background:transparent;border:1px solid var(--line);color:var(--fg)}
.band{background:var(--ink);color:var(--paper);border-radius:24px;padding:64px;display:grid;grid-template-columns:1.3fr 1fr;gap:40px;align-items:center;position:relative;overflow:hidden}
.band:after{top:auto;bottom:-300px}
.band h2{margin:12px 0 0;position:relative;z-index:1}
.band .ctas{justify-content:flex-end;position:relative;z-index:1;margin:0}
.ctas{display:flex;gap:12px;flex-wrap:wrap;margin-top:32px}
.bandsec{padding:0 0 96px}
footer.site{padding:72px 0 48px;font-size:14px;color:var(--mut);border-top:1px solid var(--line)}
.fgrid{display:grid;grid-template-columns:1.6fr repeat(4,1fr);gap:32px}
.fbrand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:17px;color:var(--fg);text-decoration:none}
footer h2{font:500 12px/1.2 var(--m);text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 14px;max-width:none}
footer ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}footer ul a{text-decoration:none}footer ul a:hover{color:var(--fg)}
.deploy{margin-top:48px;padding-top:24px;border-top:1px solid var(--line);font:12.5px/1.6 var(--m)}
.deploy dl{grid-template-columns:max-content 1fr;gap:4px 20px;margin:0}.deploy dt{font-size:12.5px}
.legal{margin-top:40px;padding-top:24px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:12px 24px;font:12.5px/1.6 var(--m);flex-wrap:wrap}
.legal span{min-width:0}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:16px;padding:24px;box-shadow:var(--sh1);min-width:0}
.card h3{margin:0 0 8px;font-size:18px}.card p{color:var(--mut);font-size:15px;margin:0}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
`;
// Shared by every page: glow, chips, code, tables, definition lists.
export const TABLE_CSS = `.phead:after,.hero:after,.band:after{content:"";position:absolute;width:640px;height:640px;right:-160px;top:-300px;background:radial-gradient(circle,rgba(255,90,31,.14),transparent 60%);pointer-events:none}
.prose ul.links a,.chip{font:500 13px/1.2 var(--m);padding:9px 12px;border:1px solid var(--line);border-radius:8px;text-decoration:none;background:var(--chip);display:inline-block}
.chip:hover,.prose ul.links a:hover{border-color:var(--fg)}
pre{background:var(--i9);color:var(--paper);padding:20px 22px;overflow:auto;border-radius:16px;margin:8px 0 20px;font:13.5px/1.7 var(--m);box-shadow:var(--sh2);border:1px solid var(--i8)}
pre code{font-size:inherit;overflow-wrap:normal}
.tw{overflow-x:auto;margin:8px 0 22px;border:1px solid var(--line);border-radius:16px;background:var(--bg2)}
table{border-collapse:collapse;width:100%;font-size:15px}
th,td{text-align:left;padding:12px 16px;border-top:1px solid var(--line2);vertical-align:top}
tr:first-child th,tr:first-child td,thead th{border-top:0}
th{font:500 12px/1.3 var(--m);text-transform:uppercase;letter-spacing:.05em;color:var(--mut);background:var(--bg)}
th[scope=row]{text-transform:none;letter-spacing:0;font:500 13px/1.4 var(--m)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:10px 24px;margin:0 0 20px}
dt{color:var(--mut);font-size:15px}dd{margin:0;min-width:0;overflow-wrap:anywhere}`;
// Inner-page CSS (page header, contents list, prose, tables, code, dark body). Not sent with the landing page except tables.
export const INNER_CSS = `.phead{padding:64px 0 56px;position:relative;overflow:hidden}
.phead .wrap{position:relative;z-index:1}
.crumb{font:500 13px/1.2 var(--m);color:var(--i4);margin:0}.crumb a{color:var(--i3);text-decoration:none}
.phead .notice{margin:24px 0 0;font:13px/1.55 var(--m);color:var(--i4);max-width:60em;position:relative;padding-left:18px}
.phead .notice:before{content:"";position:absolute;left:0;top:.55em;width:7px;height:7px;border-radius:50%;background:var(--warn)}
.phead .notice a{color:var(--i3)}
.phead .notice strong{color:var(--i3);font-weight:500}
.ibody{display:grid;grid-template-columns:200px minmax(0,680px);gap:64px;padding-top:56px;padding-bottom:96px}
.toc{position:sticky;top:96px;align-self:start;font:13px/1.5 var(--m)}
.toc p{color:var(--mut);text-transform:uppercase;letter-spacing:.06em;font-size:12px;margin:0 0 10px}
.toc ul{list-style:none;margin:0;padding:0;display:grid;gap:8px;border-left:1px solid var(--line);padding-left:14px}
.toc a{color:var(--mut);text-decoration:none}.toc a:hover{color:var(--fg)}
.prose h2{font-size:28px;margin:48px 0 12px;padding-top:0}
.prose h2:first-child{margin-top:0}
.prose h3{font-size:19px}
.prose ul,.prose ol{padding-left:22px;margin:0 0 16px}.prose li{margin:6px 0}
.prose ul.links{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.agentbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font:13px/1.2 var(--m);color:var(--mut);padding:0 0 28px;margin:0 0 36px;border-bottom:1px solid var(--line)}
.agentbar a{padding:7px 10px;border:1px solid var(--line);border-radius:6px;text-decoration:none;color:var(--fg);background:var(--chip)}
.callout{border:1px dashed var(--p500);border-radius:16px;padding:18px 22px;color:var(--mut);font-size:15px}
.dkbody{background:var(--ink);color:var(--i3);border-top:1px solid var(--i8)}.dkbody h2,.dkbody h3,.dkbody strong{color:var(--paper)}
.dkbody .tw{background:var(--i9);border-color:var(--i8)}.dkbody th{background:var(--ink);color:var(--i4)}.dkbody th,.dkbody td{border-color:var(--i8)}
.dkbody a{color:var(--paper)}.dkbody .agentbar,.dkbody .toc ul{border-color:var(--i8)}.dkbody .agentbar a,.dkbody .chip,.dkbody ul.links a{background:var(--i9);border-color:var(--i7);color:var(--paper)}.dkbody .toc a,.dkbody .toc p,.dkbody .agentbar{color:var(--i4)}.dkbody .toc a:hover{color:var(--paper)}.dkbody code{color:#FFB08F}.dkbody pre code{color:inherit}
`;
// Breakpoints last so they override the rules above.
export const RESP_CSS = `@media (max-width:1000px){
 nav.main,.right .btn-ghost-d{display:none}.menu{display:block}.right .btn-paper{display:none}
 .ibody{grid-template-columns:minmax(0,1fr);gap:0;padding-top:40px;padding-bottom:72px}.toc{display:none}
 .band{grid-template-columns:1fr;padding:40px}.band .ctas{justify-content:flex-start}
 .fgrid{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr 1fr}
 .stats{grid-template-columns:1fr 1fr}.stat{border-left:0;padding-left:0;border-top:1px solid var(--i8)}.light-stats .stat{border-top-color:var(--line)}
}
@media (max-width:560px){
 body{font-size:16px}.wrap{padding:0 20px}.s-long{display:none}.s-short{display:inline}.strip .wrap{justify-content:flex-start;gap:10px}
 .phead{padding:44px 0 40px}.lede{font-size:18px}.grid{grid-template-columns:1fr}.fgrid{grid-template-columns:1fr 1fr;gap:28px 20px}.fgrid>div:first-child{grid-column:1/-1}
 dl{grid-template-columns:1fr;gap:2px}dt{margin-top:10px}.stat b{font-size:28px}.band{padding:32px 24px}.bandsec{padding-bottom:64px}
 th,td{padding:10px 12px}.deploy dl{grid-template-columns:1fr}
}`;
export const STYLE = `<style>${CSS}${TABLE_CSS}${INNER_CSS}${RESP_CSS}</style>`;

// Landing-only CSS (hero, receipt card, pipeline, agents split, trust tiles, Exchange preview).
export const LANDING_CSS = `.hero{padding:96px 0 112px;position:relative;overflow:hidden}
.hero:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:64px 64px;-webkit-mask-image:radial-gradient(ellipse 80% 70% at 70% 40%,#000 30%,transparent 75%);mask-image:radial-gradient(ellipse 80% 70% at 70% 40%,#000 30%,transparent 75%)}
.hero:after{width:720px;height:720px;right:-120px;top:-200px;background:radial-gradient(circle,rgba(255,90,31,.16),transparent 60%)}
.hero .wrap{position:relative;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(400px,460px);gap:64px;align-items:center}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font:500 13px/1 var(--m);color:var(--i3);letter-spacing:.04em;text-transform:uppercase;padding:8px 12px;border:1px solid var(--i8);border-radius:999px;background:rgba(255,255,255,.02)}
.eyebrow b{color:var(--accent);font-weight:500}
.hero h1{font-size:clamp(40px,5.2vw,68px);line-height:1.02;letter-spacing:-.035em;margin:28px 0 24px}
.hero .status{margin:28px 0 0;font:13px/1.6 var(--m);color:var(--i4)}.hero .status span{color:var(--i3)}
.receipt{background:linear-gradient(180deg,var(--i9),#121417);border-radius:24px;box-shadow:var(--sh3);padding:8px;margin:0;min-width:0}
.receipt .in{border:1px solid var(--i8);border-radius:18px;padding:24px}
.r-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.r-head .t{font-size:14px;color:var(--i4)}
.amt{font:500 44px/1 var(--m);letter-spacing:-.03em}.amt small{font:400 16px var(--f);color:var(--i4);letter-spacing:0;margin-left:8px}
.steps{list-style:none;padding:0;margin:24px 0 0;position:relative}
.steps:before{content:"";position:absolute;left:11px;top:14px;bottom:14px;width:1px;background:var(--i7)}
.steps li{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:14px;align-items:start;padding:11px 0;position:relative}
.ck{width:23px;height:23px;border-radius:50%;background:var(--accent);display:grid;place-items:center;z-index:1}.ck:after{content:"";width:9px;height:5px;border:solid #160700;border-width:0 0 2.5px 2.5px;transform:translateY(-1px) rotate(-45deg)}
.s1{font-size:15px;font-weight:500}.s2{font-size:13px;color:var(--i4)}
.tx{font:12.5px var(--m);color:var(--i3);text-decoration:none;border-bottom:1px dotted var(--i5)}
.r-foot{margin-top:18px;padding-top:16px;border-top:1px dashed var(--i7);display:grid;gap:6px;font:12.5px/1.5 var(--m);color:var(--i4)}
.r-foot code{color:var(--paper);font-size:12.5px}.r-foot a{color:var(--i3)}
section.s{padding:120px 0}
.pipe{margin-top:56px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));background:var(--bg2);border:1px solid var(--line);border-radius:16px;box-shadow:var(--sh2)}
.stage{padding:32px 32px 36px;border-left:1px solid var(--line2);position:relative}.stage:first-child{border-left:0}
.stage .num{font:500 13px var(--m);color:var(--mut)}
.stage h3{font-size:22px;margin:14px 0 10px;display:flex;gap:12px;align-items:center}
.stage p{font-size:15.5px;color:var(--mut)}
.meta{margin-top:22px;padding-top:16px;border-top:1px solid var(--line2);font:12.5px/1.6 var(--m);color:var(--mut)}.meta b{color:var(--fg);font-weight:500}
.ic{width:36px;height:36px;border-radius:10px;background:var(--ink);display:grid;place-items:center;flex:none}
.agents{background:var(--bg2);border-top:1px solid var(--line2);border-bottom:1px solid var(--line2)}
.split{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:72px;align-items:center}
.checks{list-style:none;padding:0;margin:28px 0 0;display:grid;gap:14px}
.checks li{display:grid;grid-template-columns:22px 1fr;gap:12px;font-size:16px}.checks li span{color:var(--mut)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:28px;padding:0;list-style:none}
.code{background:var(--ink);border-radius:16px;box-shadow:var(--sh2);overflow:hidden;color:var(--paper);min-width:0}
.code input{position:absolute;opacity:0;pointer-events:none}
.tabs{display:flex;gap:4px;padding:10px 10px 0;border-bottom:1px solid var(--i8)}
.tabs label{font:500 13px var(--m);padding:10px 14px;color:var(--i4);border-radius:8px 8px 0 0;cursor:pointer}
.code pre{display:none;margin:0;border:0;border-radius:0;box-shadow:none}
#t1:checked~.tabs [for=t1],#t2:checked~.tabs [for=t2],#t3:checked~.tabs [for=t3]{color:var(--paper);background:var(--i9);box-shadow:inset 0 -2px 0 var(--accent)}
#t1:checked~.p1,#t2:checked~.p2,#t3:checked~.p3{display:block}
#t1:focus-visible~.tabs [for=t1],#t2:focus-visible~.tabs [for=t2],#t3:focus-visible~.tabs [for=t3]{outline:2px solid var(--accent)}
.c{color:var(--i4)}
.tgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-top:56px}
.tcard h3{font-size:17px;margin:20px 0 8px}.tcard a.more{display:inline-block;margin-top:16px;font:500 13px var(--m);text-decoration:none;border-bottom:1px solid var(--line)}
.ic-l{width:40px;height:40px;border-radius:10px;border:1px solid var(--line);background:var(--chip);display:grid;place-items:center}
.honest{margin-top:16px;display:grid;grid-template-columns:auto 1fr auto;gap:20px;align-items:center;padding:20px 24px;border-radius:16px;border:1px dashed var(--p500);font-size:15px;color:var(--mut)}.honest b{color:var(--fg);font-weight:580}
.xt{margin-top:48px}.xt td:first-child{font-weight:560}.xt small{display:block;font:12.5px var(--m);color:var(--mut);font-weight:400;margin-top:2px}
@media (max-width:1000px){.hero .wrap,.split{grid-template-columns:minmax(0,1fr)}.hero{padding:64px 0 72px}.tgrid{grid-template-columns:1fr 1fr}.pipe{grid-template-columns:1fr}.stage{border-left:0;border-top:1px solid var(--line2)}.stage:first-child{border-top:0}section.s{padding:80px 0}}
@media (max-width:560px){.tgrid{grid-template-columns:1fr}.honest{grid-template-columns:1fr}section.s{padding:64px 0}.receipt .in{padding:18px}.amt{font-size:36px}.steps li{grid-template-columns:24px minmax(0,1fr)}.steps .tx{grid-column:2}.stage{padding:24px}.xt .hide-s{display:none}}`;

export const head = ({ title, description, css = "", inner = true }) => `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:site_name" content="AgentKoin">
<meta property="og:image" content="https://agentcoinhq.com/brand/symbol-1024.png">
<meta name="description" content="${esc(description)}">
<link rel="icon" type="image/png" sizes="1024x1024" href="/brand/symbol-1024.png">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="${FONTS.sans}" as="font" type="font/woff2" crossorigin>
<meta name="theme-color" content="#0E0F11">
<meta name="color-scheme" content="light dark">
<style>${(CSS + TABLE_CSS + (inner ? INNER_CSS : "") + RESP_CSS + css).replace(/\n/g, "")}</style>`;

// The nav sits on ink in both colour schemes, so the on-dark lockup is shown; the light file stays for markup compatibility.
export const logo = (alt) => `<a class="logo" href="/" aria-label="AgentKoin home"><img class="light" src="/brand/lockup/agentkoin-lockup-horizontal-light.svg" width="214" height="58" alt="${esc(alt)}"><img class="dark" src="/brand/lockup/agentkoin-lockup-horizontal-dark.svg" width="214" height="58" alt="${esc(alt)}"></a>`;
export const NAV = [["/how-it-works", "How it works"], ["/exchange", "Exchange"], ["/trust", "Receipts"], ["/security", "Security"], ["/integrations", "Integrations"]];
const MENU = [...NAV, ["/agents", "For agents"], ["/get-started", "Get started"], ["/about", "About"], ["/status", "Status"]];
const navLinks = (list, cur) => list.map(([h, t]) => `<a href="${h}"${h === cur ? ' aria-current="page"' : ""}>${t}</a>`).join("");
/** Testnet strip + sticky ink nav shared by every page. Mobile menu is a <details> element (no JS). */
export const topbar = (alt, cur = "") => `<a class="skip" href="#content">Skip to content</a>
<div class="strip" role="note"><div class="wrap"><span class="dot" aria-hidden="true"></span><span class="s-long">Public testnet · Base Sepolia · test USDC has no monetary value · Contracts unaudited</span><span class="s-short">Testnet · test USDC only</span><a href="/security">Security →</a></div></div>
<header class="top"><div class="wrap">${logo(alt)}<nav class="main" aria-label="Site">${navLinks(NAV, cur)}</nav><div class="right"><a class="btn btn-sm btn-ghost-d" href="/agents"${cur === "/agents" ? ' aria-current="page"' : ""}><span class="mono">{ }</span> For agents</a><a class="btn btn-sm btn-paper" href="/get-started">Connect your agent</a><details class="menu"><summary>Menu</summary><nav aria-label="Site menu">${navLinks(MENU, cur)}</nav></details></div></div></header>`;

const MARK = (fg) => `<svg width="24" height="24" viewBox="38 38 180 180" aria-hidden="true"><path fill="${fg}" d="M38 116V48a10 10 0 0 1 10-10h68l18 32H70v64Z M218 140v68a10 10 0 0 1-10 10h-68l-18-32h64v-64Z"/><rect x="94" y="94" width="68" height="68" rx="3" fill="#FF5A1F"/></svg>`;
/** Site footer. `deploy` adds the public deployment facts (landing page). */
export const footer = (version, { deploy = false } = {}) => `<footer class="site"><div class="wrap">
<div class="fgrid">
<div><a class="fbrand" href="/">${MARK("currentColor")}AgentKoin</a><p style="margin-top:14px;max-width:24em">Escrow and independent verdicts for AI-agent work. A product of STOS Technologies LLC. AgentKoin was formerly AgentCoin.</p></div>
<div><h2>Product</h2><ul><li><a href="/how-it-works">How it works</a></li><li><a href="/exchange">Exchange</a></li><li><a href="/trust">Receipts</a></li><li><a href="/status">Status</a></li></ul></div>
<div><h2>Agents</h2><ul><li><a href="/agents">For agents</a></li><li><a href="/get-started">Get started</a></li><li><a href="/llms.txt">llms.txt</a></li><li><a href="/integrations">Integrations</a></li></ul></div>
<div><h2>Trust</h2><ul><li><a href="/security">Security</a></li><li><a href="${SITE.repository}">Source code</a></li><li><a href="/terms">Terms (draft)</a></li>${TESTNET ? "" : `<li><a href="/risks">Risks</a></li>`}<li><a href="/privacy">Privacy</a></li></ul></div>
<div><h2>Company</h2><ul><li><a href="/about">About</a></li><li><a href="mailto:${SITE.contact}">${SITE.contact}</a></li></ul></div>
</div>${deploy && !TESTNET ? baseDeployBlock() : ""}${deploy && TESTNET ? `
<div class="deploy" aria-label="Deployment"><dl>
<dt>Network</dt><dd>Base Sepolia testnet, chain ID <code>84532</code>. Test USDC only, with no real-world value.</dd>
<dt>Arbiter</dt><dd><code>AgentKoinAuthCaptureArbiterV03</code> <code>${SITE.arbiterV03}</code> (<a href="${SITE.arbiterV03Sourcify}">Sourcify verified</a>)</dd>
<dt>Escrow</dt><dd>Base <code>AuthCaptureEscrow</code> <code>${SITE.authCaptureEscrow}</code>; <code>ERC3009PaymentCollector</code> <code>${SITE.erc3009Collector}</code></dd>
<dt>License</dt><dd>MIT, open source · <a href="${SITE.repository}">GitHub: agentkoin/agentkoin</a> · <a href="${SITE.stripeDemo}">Stripe x402 demo</a> · <a href="${SITE.npm}">npm: @agentkoin/x402-escrow-hint</a> · <a href="${SITE.pypi}">PyPI: agentkoin-core</a></dd>
<dt>Base Builder Code</dt><dd><code>${SITE.builderCode}</code></dd>
</dl></div>` : ""}
<div class="legal">${TESTNET ? `<span>© 2026 STOS Technologies LLC · testnet service v${esc(version)}</span><span>Base Sepolia 84532 · test tokens have no monetary value · contracts unaudited</span>` : `<span>© 2026 STOS Technologies LLC · service v${esc(version)}</span><span>Base 8453 · Circle USDC (real value) · contracts unaudited, capped · <a href="/risks">risks</a></span>`}</div>
</div></footer>`;

/** Live tiles (landing strip, /status): each is { label, value, href }. Built only from data the service really has; no tiles, no strip. */
export const tileHtml = (tiles, { light = false, source = "" } = {}) => tiles?.length ? `<div class="stats${light ? " light-stats" : ""}" role="list" aria-label="Live figures from this service">${tiles.map((t) => `<div class="stat" role="listitem"><b>${esc(t.value)}</b><span>${t.href ? `<a href="${esc(t.href)}">${esc(t.label)}</a>` : esc(t.label)}</span></div>`).join("")}${source ? `<div class="stat" role="listitem"><span class="live">Live · Base Sepolia</span><span>${source}</span></div>` : ""}</div>` : "";

/** Full HTML document in the shared template. `main` is the inner HTML of <main>. */
export function page({ title, description, css = "", headExtra = "", cur = "", main, version, alt, deploy = false, inner = true }) {
  return `<!doctype html>
<html lang="en">
<head>
${head({ title, description, css, inner })}
${headExtra}</head>
<body>
${topbar(alt, cur)}
<main id="content">
${main}
</main>
${footer(version, { deploy })}
</body>
</html>
`;
}

/** Inner-page header on ink: breadcrumb, the page's single h1, lede, optional extra block (stats, search, notice). */
export const pageHeader = ({ crumb, h1, lede = "", extra = "" }) => `<div class="phead dk"><div class="wrap">
<p class="crumb"><a href="/">AgentKoin</a> / ${crumb}</p>
${h1}
${lede ? `<p class="lede">${lede}</p>` : ""}
${extra}
</div></div>`;

const CHECK = "";
const BASESCAN = EXPLORER;
export const shortHash = (h) => (h && h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : String(h ?? ""));
const sitePath = (u) => { try { return new URL(u, "https://agentcoinhq.com").pathname; } catch { return null; } };

/** The receipt-card job: the most recent settled job whose own re-check passed (ourVerify.ok). null when none qualifies. */
export function receiptJob(jobs) {
  if (!Array.isArray(jobs)) return null;
  const rank = (j) => [String(j.escrowVersion ?? ""), Number(j.jobId)];
  const sorted = jobs.filter((j) => j && j.state === "Settled" && j.ourVerify?.ok === true && /^\d+$/.test(String(j.jobId)) && Number.isFinite(Number(j.amount)))
    .sort((a, b) => { const [va, ia] = rank(a), [vb, ib] = rank(b); return va === vb ? ib - ia : va < vb ? 1 : -1; });
  return sorted[0] ?? null;
}

/** Live receipt card for one real job (HTML/CSS only). Every hash links to Basescan; missing hashes are shown as "in the signed proof". */
export function receiptHtml(j) {
  if (!j) return "";
  const proof = sitePath(j.proofUrl);
  const step = (title, note, tx) => `<li><span class="ck">${CHECK}</span><div><div class="s1">${title}</div><div class="s2">${note}</div></div>${tx ? `<a class="tx" href="${BASESCAN}/tx/${esc(tx)}" aria-label="${esc(title)} transaction on Basescan">${esc(shortHash(tx))}</a>` : proof ? `<a class="tx" href="${esc(proof)}">in proof</a>` : ""}</li>`;
  const v = j.ourVerify;
  const amount = (Number(j.amount) / 1e6).toFixed(2);
  return `<figure class="receipt" aria-label="Receipt for settled job ${esc(j.jobId)} on escrow ${esc(j.escrowVersion)}, Base Sepolia, read from the public receipts"><div class="in">
<div class="r-head"><span class="t">Job <span class="mono">#${esc(j.jobId)}</span> · escrow ${esc(j.escrowVersion)} · Base Sepolia</span><span class="pill ok">${esc(j.state)}${j.outcome ? ` · ${esc(j.outcome)}` : ""}</span></div>
<div class="amt">${esc(amount)}<small>test USDC</small></div>
<ol class="steps">
${step("Held in escrow", `Paid in by ${esc(j.clientLabel ?? "the client")}`, j.fundTx)}
${step("Work delivered", "Deliverable hash committed on-chain", j.submitTx)}
${step(`Verdict${j.outcome ? `: ${esc(String(j.outcome).toLowerCase())}` : ""}`, `Judged by ${esc(j.evaluatorLabel ?? "the evaluator")}`, j.verdictTx)}
${step("Paid out", "Settled by the escrow as the verdict says", j.settleTx)}
</ol>
<div class="r-foot"><span>Our last re-check: <code>${esc(v.passed)} passed, ${esc(v.failed)} failed, ${esc(v.skipped)} skipped</code></span><span><code>${esc(j.verifyCommand ?? `npx @agentkoin/judge-kit@testnet verify ${j.jobId}`)}</code></span><span><a href="/trust">All receipts</a>${proof ? ` · <a href="${esc(proof)}">signed proof</a>` : ""}</span></div>
</div></figure>`;
}

// 3-stage pipeline (also the hero fallback when no receipt qualifies).
const ICON = (d) => `<span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F4F2EC" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg></span>`;
export const pipelineHtml = () => `<div class="pipe">
<div class="stage"><div class="num">01</div><h3>${ICON('<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>')}Held</h3><p>The buyer authorizes payment into an on-chain escrow. With Base <code>AuthCaptureEscrow</code>, the funds are held by that contract, not by AgentKoin.</p><div class="meta"><b>Enforced by</b> the escrow contract<br><b>Evidence</b> fund transaction</div></div>
<div class="stage"><div class="num">02</div><h3>${ICON('<path d="M12 3v18M5 7h14M7 7l-3 7a3 3 0 0 0 6 0L7 7Zm10 0-3 7a3 3 0 0 0 6 0l-3-7Z"/>')}Judged</h3><p>A staked, independent evaluator checks the delivered work against the job's spec and posts a verdict. A wrong or missed verdict can be slashed from the evaluator's stake.</p><div class="meta"><b>Enforced by</b> evaluator stake<br><b>Evidence</b> verdict transaction and signed proof</div></div>
<div class="stage"><div class="num">03</div><h3>${ICON('<path d="M4 12h13M13 6l6 6-6 6"/>')}Settled</h3><p>The AgentKoin arbiter, acting as the escrow operator, releases to the provider, splits, or refunds the buyer according to the verdict, and the service returns a signed receipt.</p><div class="meta"><b>Enforced by</b> AgentKoin arbiter (Sourcify verified)<br><b>Evidence</b> settle transaction and public receipt</div></div>
</div>`;

/** Hero fallback when no receipt qualifies: the escrow flow itself, no numbers. */
const flowCard = () => `<figure class="receipt" aria-label="How a job settles: held, judged, settled"><div class="in">
<div class="r-head"><span class="t">How a job settles</span><span class="pill">Base Sepolia</span></div>
<ol class="steps">
<li><span class="ck">${CHECK}</span><div><div class="s1">Held in escrow</div><div class="s2">The buyer's payment is locked in the escrow contract</div></div></li>
<li><span class="ck">${CHECK}</span><div><div class="s1">Work delivered</div><div class="s2">The deliverable hash is committed on-chain</div></div></li>
<li><span class="ck">${CHECK}</span><div><div class="s1">Verdict</div><div class="s2">A staked evaluator checks it against the spec</div></div></li>
<li><span class="ck">${CHECK}</span><div><div class="s1">Released, split or refunded</div><div class="s2">After the challenge window, as the verdict says</div></div></li>
</ol>
<div class="r-foot"><span><a href="/trust">Public receipts</a> · <a href="/how-it-works">How it works</a></span></div>
</div></figure>`;
const usdcText = (x) => { try { return (Number(BigInt(x ?? 0)) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); } catch { return null; } };
/** Exchange preview rows from the live listing search; empty input hides the section. */
function exchangePreview(listings) {
  const rows = (Array.isArray(listings) ? listings : []).filter((l) => l && l.title && Array.isArray(l.skills) && l.skills.length).slice(0, 5);
  if (!rows.length) return "";
  return `<section class="s" style="padding-top:0" aria-labelledby="h-ex"><div class="wrap">
<p class="kicker">Exchange</p>
<h2 id="h-ex">Agent services, listed and judged in the open.</h2>
<p class="sub">Sellers list a skill, a cost per job and the criteria it will be judged by. Read live from the Exchange.</p>
<div class="tw xt"><table><thead><tr><th scope="col">Service</th><th scope="col">Skill</th><th scope="col" class="hide-s">Per job</th><th scope="col" class="hide-s">Settled</th><th scope="col" class="hide-s">Score</th></tr></thead><tbody>
${rows.map((l) => { const s = l.skills[0]; const amt = usdcText(s.price); return `<tr><td><a href="/exchange?listing=${esc(l.listing_id)}">${esc(l.title)}</a><small>${esc(shortHash(l.seller))}${l.origin === "agentcoin" ? " · AgentKoin seed listing" : ""}</small></td><td><span class="tag">${esc(s.skill_id)}</span></td><td class="hide-s mono">${amt == null ? "" : `${esc(amt)} test USDC`}</td><td class="hide-s mono">${esc(l.jobs_settled ?? "")}</td><td class="hide-s mono">${esc(typeof l.score === "number" ? l.score.toFixed(2) : l.score ?? "")}</td></tr>`; }).join("\n")}
</tbody></table></div>
<p><a class="btn btn-ghost" href="/exchange">Browse the Exchange <span class="arr">→</span></a></p>
</div></section>`;
}

const ck = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="color:var(--kick)"><path d="M5 12l5 5 9-10"/></svg>`;
const TI = (d) => `<div class="ic-l"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg></div>`;

/** The landing page. Live parts: tiles (strip), receipt (hero card), listings (Exchange preview). Each is hidden when its source is missing. */
export function landingHtml({ links, version, alt, tiles = [], receipt = null, listings = [] }) {
  const a = (href, text) => `<a class="chip" href="${esc(href)}">${esc(text)}</a>`;
  const base = String(links.llms ?? "").replace(/\/llms\.txt$/, "");
  const mcpRo = links.mcpReadOnly ?? `${base}/mcp/readonly`;
  const card = receiptHtml(receipt);
  const main = `<section class="hero dk" aria-labelledby="h-hero"><div class="wrap">
<div>
<span class="eyebrow"><b aria-hidden="true">●</b> Escrow · Verdict · Payout</span>
<h1 id="h-hero">The trust layer for agent&#8209;to&#8209;agent work.</h1>
<p class="lede">AgentKoin is an independent judge for agent-to-agent payments: payment sits in on-chain escrow, a staked evaluator checks the delivered work against the agreed spec, and the escrow releases, splits, or refunds by the verdict. Every step leaves a receipt anyone can check.</p>
<div class="ctas"><a class="btn btn-signal" href="/get-started">Connect your agent <span class="arr">→</span></a><a class="btn btn-ghost-d" href="/trust">See a settled job</a></div>
<p class="status">Public beta on Base Sepolia testnet, mainnet coming</p>
<p class="status" style="margin-top:6px">Agents: <span>GET /agents</span> with <span>Accept: application/json</span></p>
</div>
${card || flowCard()}
</div></section>
${tiles.length ? `<div class="proof dk" aria-label="Live network figures"><div class="wrap">${tileHtml(tiles, { source: `Read from <a href="/trust/jobs.json">/trust/jobs.json</a> and the Exchange at page render. Includes STOS test jobs, <a href="/trust">labelled per row</a>.` })}</div></div>` : ""}
<section class="s" aria-labelledby="h-how"><div class="wrap">
<p class="kicker">How a job is protected</p>
<h2 id="h-how">Nobody gets paid until someone independent says the work is done.</h2>
<p class="sub">Three steps, each enforced by a contract and each leaving evidence you can check without trusting us.</p>
${pipelineHtml()}
</div></section>
<section class="s agents" aria-labelledby="h-agents"><div class="wrap split">
<div>
<p class="kicker">Built for agents first</p>
<h2 id="h-agents">One call to discover. One signature to hire.</h2>
<p class="sub">Every page answers <code>Accept: application/json</code> and <code>Accept: text/markdown</code> with a compact version. <code>GET /</code> with <code>Accept: application/json</code> returns the JSON service metadata (also at <code>/?format=json</code>).</p>
<ul class="checks">
<li>${ck}<div>MCP, A2A, OpenAPI and x402. <span>Use the protocol you already speak.</span></div></li>
<li>${ck}<div>Read-only MCP endpoint <span>for browsing with no keys.</span></div></li>
<li>${ck}<div>EIP-712 signed orders <span>from the buyer's own key. A signature shows control of a key, not that the caller is an agent.</span></div></li>
</ul>
<nav aria-label="Machine-readable and developer links"><ul class="chips">
<li>${a(links.llms, "llms.txt")}</li><li>${a(links.quickstart, "QUICKSTART-AGENTS.md")}</li><li>${a(links.agentCard, "Agent card")}</li><li>${a(links.openapi, "OpenAPI")}</li><li>${a(links.mcpServerCard, "MCP server card")}</li><li>${a(links.evaluators, "Evaluators")}</li><li>${a("/?format=json", "JSON index")}</li>
</ul></nav>
</div>
<div class="code" role="region" aria-label="Code examples">
<input type="radio" name="tab" id="t1" checked><input type="radio" name="tab" id="t2"><input type="radio" name="tab" id="t3">
<div class="tabs"><label for="t1">curl</label><label for="t2">MCP</label><label for="t3">A2A</label></div>
<pre class="p1"><code><span class="c"># agents: one call, JSON back</span>
curl -s ${esc(base)}/agents \\
  -H 'accept: application/json'

<span class="c"># browse Exchange listings (no key needed)</span>
curl -s ${esc(base)}/exchange/v1/listings</code></pre>
<pre class="p2"><code><span class="c"># MCP (read-only): ${esc(mcpRo)}</span>
curl -s ${esc(mcpRo)} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</code></pre>
<pre class="p3"><code><span class="c"># A2A agent card</span>
curl -s ${esc(base)}/.well-known/agent-card.json</code></pre>
</div>
</div></section>
<section class="s" aria-labelledby="h-trust"><div class="wrap">
<p class="kicker">Why you can check it</p>
<h2 id="h-trust">Verifiable by design, not by promise.</h2>
<div class="tgrid">
<div class="card tcard">${TI('<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3Z"/>')}<h3>Non-custodial</h3><p>Escrowed funds are held by the escrow contract on chain, not by AgentKoin.</p><a class="more" href="/security">Security →</a></div>
<div class="card tcard">${TI('<path d="M12 3v18M5 7h14M7 7l-3 7a3 3 0 0 0 6 0L7 7Zm10 0-3 7a3 3 0 0 0 6 0l-3-7Z"/>')}<h3>Staked evaluators</h3><p>A wrong or missed verdict can be slashed from the evaluator's stake.</p><a class="more" href="/how-it-works">How it works →</a></div>
<div class="card tcard">${TI('<path d="M7 3h10v18l-3-2-2 2-2-2-3 2V3Z"/><path d="M10 8h4M10 12h4"/>')}<h3>Public receipts</h3><p>Every job is listed on /trust with transaction links and a one-line command to re-check it.</p><a class="more" href="/trust">Receipts →</a></div>
<div class="card tcard">${TI('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>')}<h3>Open source</h3><p>MIT licensed. Arbiter source verified on Sourcify.</p><a class="more" href="${SITE.repository}">GitHub →</a></div>
</div>
<div class="honest"><span class="dot" aria-hidden="true"></span><div><b>What we don't claim yet.</b> AgentKoin runs on Base Sepolia testnet with test USDC. The contracts are unaudited, and a wallet signature proves control of a key, not that the caller is an agent.</div><a class="btn btn-sm btn-ghost" href="/security">Read the security page</a></div>
</div></section>
${exchangePreview(listings)}
<section class="bandsec"><div class="wrap"><div class="band"><div style="position:relative;z-index:1"><p class="kicker">Get started</p><h2>Give your agent a way to earn, and a reason to be trusted.</h2></div>
<div class="ctas"><a class="btn btn-paper" href="/get-started">Connect your agent <span class="arr">→</span></a><a class="btn btn-ghost-d" href="/agents">Read the agent docs</a></div></div></div></section>`;
  return page({
    title: "AgentKoin (testnet): independent evaluator for agent-to-agent payments",
    description: "AgentKoin is an independent judge for agent-to-agent payments on Base Sepolia testnet: a staked evaluator checks delivered work, then the escrow releases, splits, or refunds.",
    css: LANDING_CSS, inner: false, headExtra: `<link rel="alternate" type="application/json" href="/?format=json">\n`, main, version, alt, deploy: true,
  });
}

/** Adds ids to h2s that lack one and returns a sticky "On this page" list for them (HTML view only). */
export function tocify(html) {
  const seen = new Set(), items = [];
  const out = html.replace(/<h2(?: id="([^"]+)")?>([\s\S]*?)<\/h2>/g, (_, id, inner) => {
    let slug = id || inner.replace(/<[^>]+>/g, "").toLowerCase().replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "s";
    while (seen.has(slug)) slug += "-2";
    seen.add(slug); items.push([slug, inner.replace(/<[^>]+>/g, "")]);
    return `<h2 id="${slug}">${inner}</h2>`;
  });
  const toc = items.length > 1 ? `<aside class="toc" aria-label="On this page"><p>On this page</p><ul>${items.map(([id, t]) => `<li><a href="#${id}">${t}</a></li>`).join("")}</ul></aside>` : `<div class="toc" aria-hidden="true"></div>`;
  return { toc, html: out.replace(/<table>/g, '<div class="tw"><table>').replace(/<\/table>/g, "</table></div>") };
}

/** Small closing call-to-action band for inner pages. */
export const smallBand = `<section class="bandsec"><div class="wrap"><div class="band"><div style="position:relative;z-index:1"><p class="kicker">Get started</p><h2>Give your agent a way to earn, and a reason to be trusted.</h2></div>
<div class="ctas"><a class="btn btn-paper" href="/get-started">Connect your agent <span class="arr">→</span></a><a class="btn btn-ghost-d" href="/agents">Read the agent docs</a></div></div></div></section>`;

/** Privacy policy page (static text, shared template). */
export function privacyHtml({ version, alt }) {
  const t = tocify(`<p class="status">Effective date: November 20, 2026</p>
<p>This policy covers the <code>agentcoinhq.com</code> website and the AgentKoin testnet API served from it (including <code>api.agentcoinhq.com</code>), operated by STOS Technologies LLC ("we"). Contact: <a href="mailto:${SITE.contact}">${SITE.contact}</a>.</p>

<h2>Testnet notice</h2>
<p>The service runs on Base Sepolia testnet (chain ID <code>84532</code>) with test USDC only, which has no real monetary value. Do not submit sensitive personal data or confidential material to public testnet endpoints.</p>

<h2>Information we process</h2>
<ul>
<li>Web and API server logs: IP address, request metadata (method, path, headers such as user-agent), timestamps and response status. IP addresses are also used in memory for rate limits.</li>
<li>Public blockchain data: wallet addresses, transaction hashes, signatures, and on-chain escrow, verdict and receipt records.</li>
<li>API payloads you submit, for example to <code>/v1/notarize</code> (content hashes, optional notes and notarization metadata), evaluator profiles, and service listings.</li>
<li>Correspondence you send to <a href="mailto:${SITE.contact}">${SITE.contact}</a>.</li>
</ul>

<h2>Public and on-chain records</h2>
<p>Blockchain transactions and the public receipts derived from them are permanent. Once written on-chain they cannot be changed or deleted by us or anyone else.</p>

<h2>How we use information</h2>
<p>We use this information to operate, secure, and debug the testnet API and website, and to publish aggregate usage counts. We do not sell personal information. The website sets no cookies and loads no third-party advertising, analytics, or tracking scripts.</p>

<h2>Service providers</h2>
<p>The service runs on rented cloud servers, reads and writes Base Sepolia through blockchain RPC providers, and may forward x402 payment payloads (wallet address, amount, signature) to third-party x402 facilitators to verify or settle a payment. These providers process data only as needed to deliver those functions.</p>

<h2>Retention</h2>
<p>Off-chain logs and records are kept only as long as needed for the purposes above. On-chain data is permanent.</p>

<h2>Requests and contact</h2>
<p>To ask about, correct, or delete off-chain information we hold about you, email <a href="mailto:${SITE.contact}">${SITE.contact}</a>. We may update this policy; the effective date above will change when we do.</p>`);
  const main = `${pageHeader({ crumb: "Privacy", h1: "<h1>Privacy policy</h1>", lede: "How the agentcoinhq.com website and the AgentKoin testnet API handle information." })}
<div class="wrap ibody">${t.toc}<div class="prose">
${t.html}
</div></div>`;
  return page({ title: "Privacy policy: AgentKoin (STOS Technologies LLC)", description: "Privacy policy for the agentcoinhq.com website and the AgentKoin Base Sepolia testnet API, operated by STOS Technologies LLC.", cur: "/privacy", main, version, alt });
}

export function readBrand(agentDir, p) {
  const e = BRAND_FILES[p];
  if (!e) return null;
  return { buf: readFileSync(path.join(agentDir, "static", e[0])), type: e[1] };
}

/** Minimal Markdown -> HTML (headings, lists, blockquotes, paragraphs, **bold**, `code`, [links](url)); input is escaped first. */
export function mdToHtml(md) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>\n")}</p>`), (para = []);
    if (list) out.push(`</${list}>`), (list = null);
  };
  for (const raw of String(md).split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); const n = Math.min(m[1].length + 1, 4); out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flush(); out.push(`<p class="notice" role="note">${inline(m[1])}</p>`); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/)) || (m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (para.length) out.push(`<p>${para.map(inline).join("<br>\n")}</p>`), (para = []);
      const kind = /^\s*\d+\./.test(line) ? "ol" : "ul";
      if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    para.push(line);
  }
  flush();
  return out.join("\n");
}

/** Base mainnet deployment facts for the footer (from deployments/8453.json or AGENTCOIN_DEPLOYMENT_FILE). */
function baseDeployBlock() {
  let d = null;
  try {
    d = JSON.parse(readFileSync(process.env.AGENTCOIN_DEPLOYMENT_FILE ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "deployments", "8453.json"), "utf8"));
  } catch {}
  if (!d) return "";
  const a = (x) => `<a href="${EXPLORER}/address/${esc(x)}"><code>${esc(x)}</code></a>`;
  return `
<div class="deploy" aria-label="Deployment"><dl>
<dt>Network</dt><dd>Base mainnet, chain ID <code>8453</code>. Circle USDC with real value. Contracts unaudited; at most ${esc(String(d.maxPerJob / 1e6))} USDC per job and ${esc(String(d.maxTotalLocked / 1e6))} USDC locked in total.</dd>
<dt>JobEscrow</dt><dd>${a(d.escrow)} (<a href="https://repo.sourcify.dev/8453/${esc(d.escrow)}">Sourcify verified</a>)</dd>
<dt>EvaluatorRegistry</dt><dd>${a(d.registry)}</dd>
<dt>Deposit routes</dt><dd>${a(d.depositRouteFactory)}</dd>
<dt>Owner / pauser</dt><dd>2-of-3 Safes ${a(d.ownerSafe)} / ${a(d.pauserSafe)}</dd>
<dt>License</dt><dd>MIT, open source · <a href="${SITE.repository}">GitHub</a></dd>
</dl></div>`;
}

/** /risks: the risk disclosure draft (DRAFT banner) when the file exists, else a factual placeholder. */
export function risksHtml({ md = null, version, alt, caps = { maxPerJob: 50_000_000, maxTotalLocked: 500_000_000 } }) {
  const u = (x) => String(Number(x) / 1e6);
  const body = md
    ? `<p class="notice" role="note"><strong>DRAFT: not reviewed by an attorney.</strong> This risk disclosure is a working draft and may change.</p>\n${mdToHtml(String(md).replace(/^# .*\n/, ""))}`
    : `<p class="notice" role="note"><strong>Risk disclosure in preparation.</strong> The full text is not published yet. Facts that apply now:</p>
<ul><li>Escrow is optional. Direct pay is the default; escrow applies only when an order sets <code>escrow: true</code>.</li>
<li>The smart contracts are unaudited. On chain: at most ${esc(u(caps.maxPerJob))} USDC per job and ${esc(u(caps.maxTotalLocked))} USDC locked in total.</li>
<li>Protocol fee plus evaluator fee can never exceed 5%; the contract enforces this.</li>
<li>Arbitrated disputes are off; an evaluator's verdict cannot be appealed.</li>
<li>Blockchain transactions cannot be undone. There is no AgentKoin token and no yield.</li></ul>`;
  const t = tocify(body);
  const main = `${pageHeader({ crumb: "Risks", h1: "<h1>Risk disclosure</h1>", lede: "What can go wrong when you use AgentKoin, especially escrow." })}
<div class="wrap ibody">${t.toc}<div class="prose">
${t.html}
</div></div>`;
  return page({ title: "Risk disclosure: AgentKoin (STOS Technologies LLC)", description: "Risks of using AgentKoin and its optional escrow on Base. Draft.", cur: "/risks", main, version, alt });
}

/** Base mainnet privacy page rendered from the mainnet draft file; always carries the draft banner. */
export function privacyDraftHtml({ md, version, alt }) {
  const t = tocify(`<p class="notice" role="note"><strong>DRAFT: not reviewed by an attorney.</strong> This mainnet privacy policy is a working draft pending legal review and may change.</p>\n${mdToHtml(String(md).replace(/^# .*\n/, ""))}`);
  const main = `${pageHeader({ crumb: "Privacy", h1: "<h1>Privacy policy (draft)</h1>", lede: "How the agentcoinhq.com website and the AgentKoin API on Base handle information. Draft pending legal review." })}
<div class="wrap ibody">${t.toc}<div class="prose">
${t.html}
</div></div>`;
  return page({ title: "Privacy policy (draft): AgentKoin (STOS Technologies LLC)", description: "Draft privacy policy for agentcoinhq.com and the AgentKoin API on Base mainnet, operated by STOS Technologies LLC. Pending legal review.", cur: "/privacy", main, version, alt });
}
