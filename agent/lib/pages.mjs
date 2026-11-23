import { JUDGE_KIT_REF } from "./network.mjs";
// /free (offer description) and /trust (job table) pages. Facts only. Testnet only. HTML or JSON on Accept, like "/".
import { TESTNET, EXPLORER, PUBLIC_CHAIN_ID } from "./network.mjs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { page, pageHeader, shortHash } from "../service/landing.mjs";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function freeOffer({ baseUrl }) {
  return {
    v: "agentkoin-free-offer/v1",
    testnet: TESTNET,
    realValue: false,
    network: "base-sepolia",
    chainId: PUBLIC_CHAIN_ID,
    offer: {
      asset: "Circle test USDC on Base Sepolia (no monetary value)",
      amountPerClaim: { human: "0.05", atomic: "50000", decimals: 6 },
      equivalentJobs: "5 notarize jobs at 0.01 test USDC",
      maxClaims: 50,
      limits: { perAddress: 1, perGithubOrXAccount: 1 },
      eligibleRecipients: "externally owned Base Sepolia addresses (a throwaway test key is sufficient)",
      ethRequiredByClaimant: false,
      gasNote: "the x402 exact payment path needs test USDC only; the relayer pays gas",
      feeBps: 0,
    },
    request: {
      method: "manual",
      channel: "GitHub issue",
      url: "https://github.com/agentkoin/agentkoin/issues/2",
      provide: "a Base Sepolia address",
      automated: false,
    },
    fulfilment: {
      sender: "STOS Technologies testnet wallet",
      automated: false,
      endpointThatSendsFunds: null,
      responseTime: "not specified",
      claimsFulfilled: "not published on this page",
    },
    accounting: "jobs paid from sponsored test USDC are labeled 'sponsored outside payer' on the trust page, separate from organic outside payers",
    afterFunding: {
      quickstarts: "https://github.com/agentkoin/agentkoin/tree/main/examples/quickstarts",
      service: baseUrl + "/",
      verifyJob: "npx @agentkoin/judge-kit@testnet verify <jobId>",
      trust: baseUrl + "/trust",
    },
    caveats: ["Base Sepolia testnet only", "contracts are unaudited", "test USDC has no value"],
  };
}

export function freeHtml(o) {
  const row = (k, v) => `<tr><th scope="row">${esc(k)}</th><td>${esc(typeof v === "string" ? v : JSON.stringify(v))}</td></tr>`;
  const rows = (obj) => Object.entries(obj).map(([k, v]) => row(k, v)).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentKoin free test USDC offer (Base Sepolia testnet)</title>
<meta name="description" content="Terms of the testnet test-USDC offer: amount, limits, how a request is made, who fulfils it. JSON on Accept: application/json.">
<style>body{font:14px/1.45 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#111}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e3e3e3;padding:6px 8px;text-align:left;vertical-align:top}th{width:30%;font-weight:600}h2{font-size:16px;margin:20px 0 6px}code{font-family:ui-monospace,monospace}.t{background:#fff7e0;border:1px solid #f0d58a;padding:6px 10px;border-radius:6px}</style></head><body>
<h1>Test USDC offer (testnet)</h1>
<p class="t">Base Sepolia testnet (chainId 84532). Test USDC has no value. Contracts are unaudited.</p>
<h2>Offer</h2><table>${rows({ asset: o.offer.asset, amountPerClaim: `${o.offer.amountPerClaim.human} test USDC (${o.offer.amountPerClaim.atomic} atomic, ${o.offer.amountPerClaim.decimals} decimals)`, equivalentJobs: o.offer.equivalentJobs, maxClaims: String(o.offer.maxClaims), perAddressLimit: String(o.offer.limits.perAddress), perAccountLimit: `${o.offer.limits.perGithubOrXAccount} per GitHub or X account`, eligibleRecipients: o.offer.eligibleRecipients, ethRequiredByClaimant: "no", gasNote: o.offer.gasNote, feeBps: String(o.offer.feeBps) })}</table>
<h2>Request</h2><table>${row("method", "manual")}${row("channel", "GitHub issue")}<tr><th scope="row">url</th><td><a href="${esc(o.request.url)}">${esc(o.request.url)}</a></td></tr>${row("provide", o.request.provide)}${row("automated", "no")}</table>
<h2>Fulfilment</h2><table>${row("sender", o.fulfilment.sender)}${row("automated", "no")}${row("endpoint that sends funds", "none")}${row("response time", o.fulfilment.responseTime)}${row("claims fulfilled", o.fulfilment.claimsFulfilled)}</table>
<h2>Accounting</h2><p>${esc(o.accounting)}.</p>
<h2>After funding</h2><table><tr><th scope="row">quickstarts</th><td><a href="${esc(o.afterFunding.quickstarts)}">${esc(o.afterFunding.quickstarts)}</a></td></tr>${row("verify a job", o.afterFunding.verifyJob)}<tr><th scope="row">trust page</th><td><a href="${esc(o.afterFunding.trust)}">${esc(o.afterFunding.trust)}</a></td></tr></table>
<p><small>Machine-readable: send <code>Accept: application/json</code> to this URL. Schema id: ${esc(o.v)}.</small></p></body></html>`;
}

/** /trust files live in the state dir (trust/index.html + trust/jobs.json) so they can be refreshed without a rebuild. null when absent. */
export function readTrust(stateDir, kind) {
  const f = path.join(stateDir, "trust", kind === "json" ? "jobs.json" : "index.html");
  return existsSync(f) ? readFileSync(f) : null;
}

// ---- /trust HTML in the shared site template (v3). Rendered per request from the same document /trust/jobs.json serves. ----
const BASESCAN = EXPLORER;
const TRUST_CSS = `.jobs td{font-size:14px}.jobs td small{display:block;color:var(--mut);font-size:12.5px;line-height:1.45}.jobs code{font-size:12.5px}
.jobs .who{display:block;font-weight:500}.jobs .k{font:500 11px/1 var(--m);text-transform:uppercase;letter-spacing:.05em;padding:3px 6px;border-radius:4px;border:1px solid var(--line);color:var(--mut);display:inline-block;margin-top:4px}
.jobs .k.outside{color:var(--okt);border-color:rgba(47,191,113,.45)}
.jobs details summary{cursor:pointer;font:500 12.5px var(--m);color:var(--mut);margin-top:6px}.jobs details[open] summary{color:var(--fg)}
.jobs details code{display:block;white-space:normal;overflow-wrap:anywhere;margin:6px 0}
.jobs .txs a{font:12.5px var(--m);margin-right:8px}.jobs td small a,.jobs td.mono{white-space:nowrap}
.howv{margin:0 0 28px;border:1px solid var(--line);border-radius:16px;background:var(--bg2);padding:4px 22px}.howv summary{cursor:pointer;font-weight:560;padding:14px 0}.howv ol{padding-left:22px}.howv li{margin:8px 0}
.tmeta{font:13px/1.6 var(--m);color:var(--mut);margin-top:20px}
.tbody{padding-top:48px;padding-bottom:96px}
@media (max-width:860px){.jobs thead{display:none}.jobs,.jobs tbody,.jobs tr,.jobs td{display:block;width:100%}.jobs tr{border-top:1px solid var(--line);padding:14px 4px;display:grid;grid-template-columns:1fr 1fr}.jobs td:nth-child(n+4){grid-column:1/-1}.jobs tr:first-child{border-top:0}.jobs td{border:0;padding:5px 16px}.jobs td:before{content:attr(data-l);display:block;font:500 11px/1.6 var(--m);text-transform:uppercase;letter-spacing:.05em;color:var(--mut)}.jobs td:empty{display:none}}`;

const statusPill = (j) => {
  const s = String(j.state ?? "unknown");
  const cls = /^(Settled|Complete|settled)$/.test(s) ? "ok" : "";
  return `<span class="pill ${cls}">${esc(s)}</span>${j.outcome ? `<small>${esc(j.outcome)}</small>` : ""}`;
};
const party = (label, kind, addr) => `<span class="who">${esc(label ?? "unlabeled")}</span>${kind ? `<span class="k ${kind === "outside" ? "outside" : ""}">${esc(kind === "stos" ? "STOS" : kind)}</span>` : ""}${addr ? `<small><code>${esc(shortHash(addr))}</code></small>` : ""}`;

/** Headline counters from the jobs list. A counter whose input field is absent from every job is left out (null). */
export function trustCounters(jobs) {
  const n = (f) => jobs.filter(f).length;
  const has = (k) => jobs.some((j) => j && j[k] != null);
  return [
    ["jobs listed", jobs.length],
    ["settled", has("state") ? n((j) => j.state === "Settled") : null],
    ["paid by an outside wallet", has("clientKind") ? n((j) => j.clientKind === "outside") : null],
    ["judged by an outside evaluator", has("evaluatorKind") ? n((j) => j.evaluatorKind === "outside") : null],
    ["anchored on Concordium", has("concordium") ? n((j) => j.concordium?.status === "finalized") : null],
    ["pass our last verify run", has("ourVerify") ? n((j) => j.ourVerify?.ok) : null],
    ["fail at least one check", has("ourVerify") ? n((j) => j.ourVerify && !j.ourVerify.ok) : null],
  ].filter(([, v]) => v != null);
}

function trustRow(j) {
  const v = j.ourVerify;
  const txs = [["fund", j.fundTx], ["submit", j.submitTx], ["verdict", j.verdictTx], ["settle", j.settleTx]].filter((x) => x[1]);
  const amt = Number(j.amount);
  return `<tr id="job-${esc(j.escrowVersion ?? "x")}-${esc(j.jobId)}">
<td data-l="Job"><b class="mono">#${esc(j.jobId)}</b><small>escrow ${esc(j.escrowVersion ?? "")} ${j.escrow ? `<a href="${BASESCAN}/address/${esc(j.escrow)}">${esc(shortHash(j.escrow))}</a>` : ""}</small>${j.source ? `<small>${esc(j.source)}</small>` : ""}</td>
<td data-l="Status">${statusPill(j)}</td>
<td data-l="Amount" class="mono">${Number.isFinite(amt) && j.amount != null ? `${(amt / 1e6).toFixed(2)}<small>test USDC</small>` : ""}</td>
<td data-l="Client">${j.client || j.clientLabel ? party(j.clientLabel, j.clientKind, j.client) : ""}</td>
<td data-l="Evaluator">${j.evaluator || j.evaluatorLabel ? party(j.evaluatorLabel, j.evaluatorKind, j.evaluator) : ""}${j.badge ? `<small><a class="tag badge" href="#badge-note" title="Concordium testnet Agent Registry badge ${esc(j.badge)} (token 1341)">Concordium registry badge (testnet)</a></small>` : ""}</td>
<td data-l="Proof">${j.proofUrl ? `<a href="${esc(j.proofUrl)}"><code>${esc(shortHash(j.proofHash) || "proof")}</code></a>` : ""}${txs.length ? `<small class="txs">${txs.map(([k, h]) => `<a href="${BASESCAN}/tx/${esc(h)}">${k}</a>`).join("")}</small>` : ""}${j.concordium ? `<small>Concordium: ${j.concordium.explorer ? `<a href="${esc(j.concordium.explorer)}"><code>${esc(shortHash(j.concordium.txHash))}</code></a> ` : ""}${esc(j.concordium.status)}</small>` : `<small>not anchored</small>`}</td>
<td data-l="Verify">${v ? `<span class="pill ${v.ok ? "ok" : "bad"}">our last run: ${v.ok ? "OK" : "FAILED"} ${esc(v.passed)}/${esc(v.failed)}/${esc(v.skipped)}</span>${v.failedChecks?.length ? `<small>failed: ${esc(v.failedChecks.join(", "))}</small>` : ""}` : `<small>no run attached</small>`}
<details><summary>Command${j.legacyNote ? " and note" : ""}</summary><code>${esc(j.verifyCommand ?? "")}</code>${j.legacyNote ? `<small>${esc(j.legacyNote)}</small>` : ""}</details></td></tr>`;
}

/** /trust page HTML from a trust document ({ generatedAt, source, jobs[] }). */
export const TRUST_PAGE_SIZE = 12;
export function trustPageHtml(doc, { version, alt, page: pg = 1 }) {
  const jobs = (Array.isArray(doc?.jobs) ? doc.jobs : []).filter((j) => j && typeof j === "object");
  const sorted = jobs.slice().sort((a, b) => (a.escrowVersion === b.escrowVersion ? Number(b.jobId) - Number(a.jobId) : String(a.escrowVersion ?? "") < String(b.escrowVersion ?? "") ? 1 : -1));
  const counters = trustCounters(jobs);
  const pages = Math.max(1, Math.ceil(sorted.length / TRUST_PAGE_SIZE));
  const cur = Math.min(pages, Math.max(1, Number.isInteger(Number(pg)) ? Number(pg) : 1));
  const shown = sorted.slice((cur - 1) * TRUST_PAGE_SIZE, cur * TRUST_PAGE_SIZE);
  const pager = pages > 1 ? `<nav class="tmeta" aria-label="Receipt pages">Showing jobs ${(cur - 1) * TRUST_PAGE_SIZE + 1}-${Math.min(sorted.length, cur * TRUST_PAGE_SIZE)} of ${sorted.length}. ${cur > 1 ? `<a href="/trust${cur - 1 > 1 ? `?page=${cur - 1}` : ""}">Newer</a> ` : ""}${Array.from({ length: pages }, (_, i) => i + 1).map((n) => n === cur ? `<b aria-current="page">${n}</b>` : `<a href="/trust${n > 1 ? `?page=${n}` : ""}">${n}</a>`).join(" ")} ${cur < pages ? `<a href="/trust?page=${cur + 1}">Older</a>` : ""} The full list is <a href="/trust/jobs.json">/trust/jobs.json</a>.</nav>` : "";
  const base = String(doc?.source ?? "https://agentcoinhq.com");
  const strip = `<div class="stats" role="list" aria-label="Counts from /trust/jobs.json" style="margin-top:32px;border-top:1px solid var(--i8)">${counters.map(([l, v]) => `<div class="stat" role="listitem"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("")}</div>`;
  const notice = `<p class="notice" role="note"><span><strong>Testnet only.</strong> Base Sepolia (chainId 84532) with Circle test USDC, which has no value. Concordium anchors are on Concordium testnet. Contracts are unaudited. Fee: 0%.</span></p>`;
  const main = `${pageHeader({ crumb: "Receipts", h1: "<h1>Public receipts</h1>", lede: "Every escrow job we can enumerate, with its signed proof, its Concordium anchor and the command to check it yourself. Each row can be re-checked with the command in its last column.", extra: strip + notice })}
<div class="wrap tbody">
<details class="howv"><summary>How to verify a job yourself</summary>
<ol><li>Run <code>npx ${JUDGE_KIT_REF} verify &lt;jobId&gt;</code> (add <code>--escrow &lt;address&gt;</code> for v0.6 jobs). It reads the job straight from Base Sepolia, re-hashes the deliverable, recovers every signer and, where present, checks the Concordium anchor bytes. It prints pass/fail per check.</li>
<li>Or by hand: fetch the proof URL, read <code>JobEscrow.getJob(jobId)</code> on the escrow at any Base Sepolia RPC, and compare. Each proof lists its own checks with the exact method.</li>
<li>Concordium anchor: the RegisterData payload is <code>"AGK1" ‖ sha256(proof core) ‖ jobId ‖ escrow ‖ chainId</code>. Open the explorer link and compare the data bytes with <code>anchors.concordium.payloadHex</code> in the proof.</li></ol>
<p>"Our last run" shows pass/fail/skip counts from running the same command ourselves; failures are listed as they came out, with the cause where known. Most failures say the verifier could not find published bytes that hash to the on-chain criteria or deliverable hash. Job 26 fails the payment-flow check because it was funded through the CrossCurrencySettler.</p>
<p>Parties marked "outside" are not STOS Technologies. Labels for outside parties come from their own public statements; "STOS" rows are our own test wallets and evaluators, and we label them that way on purpose.</p></details>
<div class="tw"><table class="jobs"><thead><tr><th scope="col">Job</th><th scope="col">Status</th><th scope="col">Amount</th><th scope="col">Client</th><th scope="col">Evaluator</th><th scope="col">Proof</th><th scope="col">Verify</th></tr></thead>
<tbody>${shown.map(trustRow).join("\n")}</tbody></table></div>
${pager}
${jobs.some((j) => j.badge) ? `<p class="tmeta" id="badge-note">Concordium registry badge (testnet): a Concordium testnet Agent Registry badge (token 1341) held by the evaluator. Owner account uses a testnet identity: shows a registered, accountable agent entry, not a verified human.</p>` : ""}
<p class="tmeta">${doc?.generatedAt ? `Generated ${esc(doc.generatedAt)} from ${esc(base)} public proof endpoints. ` : ""}Machine-readable: <a href="/trust/jobs.json">/trust/jobs.json</a> (also GET /trust with Accept: application/json). Proof signer key: <a href="/.well-known/jwks.json">jwks.json</a>. Source: <a href="https://github.com/agentkoin/agentkoin">github.com/agentkoin/agentkoin</a>. STOS Technologies LLC.</p>
</div>`;
  return page({ title: "AgentKoin trust page: every job, every proof (Base Sepolia testnet)", description: "Every AgentKoin escrow job with its signed proof, Concordium anchor and a one-line command to verify it yourself. Testnet only.", css: TRUST_CSS, headExtra: `<link rel="alternate" type="application/json" href="/trust/jobs.json">\n`, cur: "/trust", main, version, alt });
}
