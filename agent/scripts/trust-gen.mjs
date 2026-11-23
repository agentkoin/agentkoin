// Builds a static AgentKoin trust page from the LIVE public proofs. No keys, read-only GETs.
// usage: node gen.mjs [baseUrl]   -> dist/index.html, dist/jobs.json
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
const BASE = process.argv[2] || "https://agentcoinhq.com";
const ESCROWS = [
  { version: "v0.5", address: "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D", path: (id) => `/v1/jobs/${id}/proof` },
  { version: "v0.6", address: "0xd6E00d3419C16a3bEE1B8CC030A7062bf2014b2c", path: (id) => `/v1/escrows/0xd6E00d3419C16a3bEE1B8CC030A7062bf2014b2c/jobs/${id}/proof` },
];
const STOS = { "0x78e2c0164a80f3e337ae17e3ba4b8ea2c0fa488e": "STOS deployer", "0xbcc3df647a88af9ff82df31d74a38f26ddd90e3b": "STOS test buyer", "0x600d4d4a0feef7877accb91351ffe2aa66cf18cb": "STOS demo buyer 1", "0x0b47dc4d735d37f38cb74b74a52927dafdedf388": "STOS demo buyer 2", "0xa6400cce36c97ad47f65047fb3dfcbc345c114bc": "STOS demo buyer 3" };
const OUTSIDE_CLIENTS = { "0xeca497857b58cf72b741f926053cde54f486ffef": "outside payer (zambodotdev, per their public statement on x402 #4324)" };
const EVAL = { "0xfb0159725fb6169f676ebfd2fa0ac2c3a184509a": ["STOS reference evaluator", "stos"], "0x000f3e27eaf5d2c1a30f4fe50ff1bcc4a78f124a": ["STOS test evaluator A", "stos"], "0x1164586d557a45e5234ed882506e205b2c00c298": ["STOS test evaluator B", "stos"], "0xb87b0d6ad3b17a8a1795d6640317c7997140d140": ["babyblueviper1 (independent)", "outside"], "0x3e8b7382fd85dbad659b2887d88d020c05ca5f93": ["x402toll / SolomonisBlack (independent, self-identified)", "outside"] };
import { statSync } from "node:fs";
const require_mtime = () => statSync("verify-summary.txt").mtimeMs;
const BASESCAN = "https://sepolia.basescan.org";
const CCD = (h) => `https://ccdexplorer.io/testnet/transaction/${h}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (h) => (h && h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h ?? "");

async function get(url) { for (let i = 0; i < 3; i++) { try { const r = await fetch(url); if (r.status === 404) return null; if (r.ok) return r.json(); } catch {} await new Promise((r) => setTimeout(r, 1000)); } throw new Error("fetch failed " + url); }


// Honest labels for jobs that do not pass every check, with the cause found in the 0.5.30 investigation. Results shown next to them are the real verify output.
const LEGACY_TXS = {"1": {"fundTx": "0xcd87a26639dddbec1158a1a5b68c9217def880dbc1180c2fe13259e442719a18", "submitTx": "0xbcb9292234c1e24c870168871d9dc6534c1bad1a5094071a79be335c47a20b20", "verdictTx": "0xb7cb367d625110f1590fbd2cb81dc2cea24fd819a0a72e05ff82b405377a8982", "settleTx": "0x0f12ef62812419708362588128da9efd77bd59ed95e842cc2bac0c5a05de6d03"}, "2": {"fundTx": "0xdf55b217a41701a19bb629f436c68efcf0ff7491a3a6e2c941d0d654e9cb8d4e", "submitTx": "0x74d4d47bd605facc419fc05b97a89f4255ca3b4594d66eca577fa891218fef51", "verdictTx": "0x017a93a803c18788c7ee5bfbd2477dd8609dc4de7d5103090ead5c33e9131dc3", "settleTx": "0x063498af8fdd49d192f6b79f1231a6fdc7eb94b6fb8218fee55af532cfaf760d"}, "3": {"fundTx": "0x2c9d844000bb9276cdf05f6c1de1555670bde5dc78e822c5d03858979193e116", "submitTx": "0xf6f644a044be648aeeae7327451c6b1ea397b0ac14e58d21dbf349f82171cefa", "verdictTx": "0x886b1ac8d7ecc1d22dd5d6d56a0fe7439a450e8bcf6b84591339078d4381681f", "settleTx": "0xf1bdceec23fe2d4f93b73e8a285c95972166d10fc5f83fbe53d43304b74b0617"}, "4": {"fundTx": "0x23cbc6ccc24143a4d5bbdb872d96c56a51332fa4e46a1ef970648ca5ceedc2e2", "submitTx": "0x2ab9d8648a111fc0e69391ef91bb9fe10b7d4c44e4b13ea3fa289167f44bab1f", "verdictTx": "0x87c436792ad6c9bfe5780df0aabdf81d2f151497af350cd1208f8cec1c3a5c1e", "settleTx": "0x52e3cdd1129564cdaa671d07c8771519c30577255d0e17b434483c3d39dee77d"}}; // found by scanning JobCreated/JobSubmitted/Verdict/Settled logs from the escrow's deployment block
const LEGACY = {
  "v0.5:1": "legacy, now verifies: this job predates the service's job state and its Concordium-anchored proof core has no transaction hashes, so the verifier finds the on-chain events by scanning logs from the escrow's deployment block (judge-kit 0.1.3-testnet or later; earlier versions started the scan too late and failed). Its spec and deliverable commitments are the literal smoke-test strings used by STOS scripts, published in the verifier and recomputed by keccak256, since no criteria or receipt document was ever published.",
  "v0.5:2": "legacy, now verifies: this job predates the service's job state and its Concordium-anchored proof core has no transaction hashes, so the verifier finds the on-chain events by scanning logs from the escrow's deployment block (judge-kit 0.1.3-testnet or later; earlier versions started the scan too late and failed). Its spec and deliverable commitments are the literal smoke-test strings used by STOS scripts, published in the verifier and recomputed by keccak256, since no criteria or receipt document was ever published.",
  "v0.5:3": "legacy, now verifies (challenged and ruled by the arbitrator): this job predates the service's job state and its Concordium-anchored proof core has no transaction hashes, so the verifier finds the on-chain events by scanning logs from the escrow's deployment block (judge-kit 0.1.3-testnet or later; earlier versions started the scan too late and failed). Its spec and deliverable commitments are the literal smoke-test strings used by STOS scripts, published in the verifier and recomputed by keccak256, since no criteria or receipt document was ever published. The verdict was Reject (0 bps) and was challenged; the arbitrator's Ruled event set the final payout to 10000 bps, which the verifier checks against the Verdict and Ruled events.",
  "v0.5:4": "legacy, now verifies: this job predates the service's job state and its Concordium-anchored proof core has no transaction hashes, so the verifier finds the on-chain events by scanning logs from the escrow's deployment block (judge-kit 0.1.3-testnet or later; earlier versions started the scan too late and failed). Its spec and deliverable commitments are the literal smoke-test strings used by STOS scripts, published in the verifier and recomputed by keccak256, since no criteria or receipt document was ever published.",
  "v0.5:26": "verifies with judge-kit 0.1.3-testnet or later: this job was funded through the CrossCurrencySettler (AD-009, 0x6258D112bf27006287253424a1fa877C607B564a). The client paid in another test token, the settler swapped it and sent the USDC into the escrow; the verifier accepts that path only for the listed settler and only if the client's token transfer to the settler is in the same fund tx and the USDC amount covers the job.",
  "v0.5:29": "no criteria or deliverable bytes hashing to the on-chain values were found at any URL the verifier checks.",
  "v0.6:1": "no criteria or deliverable bytes hashing to the on-chain values were found at any URL the verifier checks; the job expired without a verdict, and the evaluator-stake check fails.",
  "v0.6:2": "no deliverable bytes hashing to the on-chain deliverable hash were found at any URL the verifier checks.",
};

const jobs = [];
for (const e of ESCROWS) {
  let misses = 0;
  for (let id = 1; misses < 3; id++) {
    const p = await get(BASE + e.path(id));
    if (!p) { misses++; continue; } misses = 0;
    const j = p.job || {}, a = p.anchors?.concordium, ev = (j.evaluator || "").toLowerCase(), cl = (j.client || "").toLowerCase();
    jobs.push({
      escrowVersion: e.version, escrow: e.address, jobId: String(p.jobId), state: j.state, outcome: j.outcome, amount: j.amount,
      client: j.client, clientLabel: STOS[cl] || OUTSIDE_CLIENTS[cl] || "unlabeled", clientKind: STOS[cl] ? "stos" : OUTSIDE_CLIENTS[cl] ? "outside" : "unknown",
      evaluator: j.evaluator, evaluatorLabel: EVAL[ev]?.[0] || "unlabeled", evaluatorKind: EVAL[ev]?.[1] || "unknown",
      proofHash: p.signature?.signedDigest, proofSigner: p.signature?.signer, proofUrl: p.links?.proofUrl || BASE + e.path(id),
      fundTx: p.txs?.fund?.hash, verdictTx: p.txs?.verdict?.hash, settleTx: p.txs?.settle?.hash,
      concordium: a ? { status: a.status, txHash: a.txHash || null, coreSha256: a.coreSha256, explorer: a.txHash ? CCD(a.txHash) : null } : null,
      badge: p.badges?.concordium?.[j.evaluator] || null,
      ...(LEGACY_TXS[p.jobId] && e.version === "v0.5" && !p.txs?.fund ? { fundTx: LEGACY_TXS[p.jobId].fundTx, verdictTx: LEGACY_TXS[p.jobId].verdictTx, settleTx: LEGACY_TXS[p.jobId].settleTx, submitTx: LEGACY_TXS[p.jobId].submitTx, txSource: "event scan by STOS, not from the proof" } : {}),
      legacyNote: LEGACY[e.version + ":" + p.jobId] || null,
      verifyCommand: p.links?.verifyCommand || `npx @agentkoin/judge-kit@testnet verify ${p.jobId}`,
    });
  }
}
// Attach results of our own verify run (verify-all.sh), if present. Shown as-is, failures included.
if (existsSync("verify-summary.txt")) {
  const vt = readFileSync("verify-summary.txt", "utf8").split("\n").filter(Boolean).map((l) => l.split(" "));
  const at = existsSync("verify-summary.txt") ? new Date(Number(require_mtime())).toISOString() : null;
  for (const j of jobs) {
    const line = vt.find((x) => x[0] === j.escrowVersion && x[1] === j.jobId); if (!line) continue;
    const txt = line.slice(2).join(" "), m = txt.match(/(\d+) passed, (\d+) failed, (\d+) skipped/);
    const log = existsSync(`verify-logs/${j.escrowVersion}_${j.jobId}.log`) ? readFileSync(`verify-logs/${j.escrowVersion}_${j.jobId}.log`, "utf8") : "";
    const failed = [...log.matchAll(/^\s*FAIL\s+(\S+)/gm)].map((x) => x[1]);
    j.ourVerify = m ? { ok: txt.startsWith("OK"), passed: +m[1], failed: +m[2], skipped: +m[3], failedChecks: failed, ranAt: at } : null;
  }
}
const generatedAt = new Date().toISOString();
mkdirSync("dist", { recursive: true });
writeFileSync("dist/jobs.json", JSON.stringify({ v: "agentkoin-trust-page/v1", generatedAt, source: BASE, testnet: true, realValue: false, jobs }, null, 2) + "\n");

const n = (f) => jobs.filter(f).length;
const stats = { verifiedOk: n((j) => j.ourVerify?.ok), verifyFailed: n((j) => j.ourVerify && !j.ourVerify.ok), total: jobs.length, settled: n((j) => j.state === "Settled"), outsideClients: n((j) => j.clientKind === "outside"), outsideJudged: n((j) => j.evaluatorKind === "outside"), anchored: n((j) => j.concordium?.status === "finalized") };
const row = (j) => `<tr class="${j.clientKind === "outside" || j.evaluatorKind === "outside" ? "ext" : ""}">
<td>${esc(j.escrowVersion)}<br><a href="${BASESCAN}/address/${esc(j.escrow)}">${esc(short(j.escrow))}</a></td>
<td><b>${esc(j.jobId)}</b></td>
<td>${esc(j.state)}<br><small>${esc(j.outcome)}</small></td>
<td>${(Number(j.amount) / 1e6).toFixed(2)}</td>
<td><span class="tag ${j.clientKind}">${esc(j.clientLabel)}</span><br><code>${esc(short(j.client))}</code></td>
<td><span class="tag ${j.evaluatorKind}">${esc(j.evaluatorLabel)}</span><br><code>${esc(short(j.evaluator))}</code>${j.badge ? `<br><span class="tag badge" title="Concordium testnet Agent Registry badge ${esc(j.badge)} (token 1341). Owner account uses a testnet identity: shows a registered, accountable agent entry, not a verified human.">Concordium registry badge (testnet)</span>` : ""}</td>
<td><a href="${esc(j.proofUrl)}"><code>${esc(short(j.proofHash))}</code></a><br><small>${[["fund", j.fundTx], ["submit", j.submitTx], ["verdict", j.verdictTx], ["settle", j.settleTx]].filter((x) => x[1]).map(([k, h]) => `<a href="${BASESCAN}/tx/${esc(h)}">${k}</a>`).join(" · ")}</small></td>
<td>${j.concordium ? (j.concordium.explorer ? `<a href="${esc(j.concordium.explorer)}"><code>${esc(short(j.concordium.txHash))}</code></a><br><small>${esc(j.concordium.status)}</small>` : `<small>${esc(j.concordium.status)}</small>`) : `<small class="muted">not anchored</small>`}</td>
<td><code class="cmd">${esc(j.verifyCommand)}</code>${j.ourVerify ? `<br><small class="${j.ourVerify.ok ? "ok" : "bad"}">our last run: ${j.ourVerify.ok ? "OK" : "FAILED"} ${j.ourVerify.passed}/${j.ourVerify.failed}/${j.ourVerify.skipped}${j.ourVerify.failedChecks.length ? " (failed: " + esc(j.ourVerify.failedChecks.join(", ")) + ")" : ""}</small>` : ""}${j.legacyNote ? `<br><small class="muted">${esc(j.legacyNote)}</small>` : ""}</td></tr>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentKoin trust page: every job, every proof (Base Sepolia testnet)</title>
<link rel="alternate" type="application/json" href="/trust/jobs.json"><meta name="description" content="Every AgentKoin escrow job with its signed proof, Concordium anchor and a one-line command to verify it yourself. Testnet only.">
<style>
:root{--fg:#111;--mut:#666;--bd:#e3e3e3;--acc:#0a5;--bg:#fff}
body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px;max-width:1400px;margin:auto}
h1{font-size:24px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 16px}
.banner{background:#fff7e0;border:1px solid #f0d58a;padding:8px 12px;border-radius:6px;margin:12px 0}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.stat{border:1px solid var(--bd);border-radius:8px;padding:10px 14px;min-width:120px}.stat b{font-size:22px;display:block}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--bd);padding:6px 8px;text-align:left;vertical-align:top}th{position:sticky;top:0;background:#fafafa}
tr.ext{background:#f2fbf6}code{font-family:ui-monospace,Menlo,monospace;font-size:12px}.cmd{white-space:nowrap;user-select:all}
.tag{display:inline-block;padding:1px 6px;border-radius:10px;font-size:11px;border:1px solid var(--bd)}.tag.outside{background:#dff5e8;border-color:#9bd8b4}.tag.stos{background:#eef}.tag.badge{background:#ece4ff;border-color:#c8b6ff}
.muted{color:var(--mut)}.ok{color:#0a7a3d}.bad{color:#b00020}a{color:#0645ad}details{margin:16px 0}footer{color:var(--mut);margin-top:24px;font-size:12px}
</style></head><body>
<h1>AgentKoin trust page</h1>
<p class="sub">Every escrow job we can enumerate, with its signed proof, its Concordium anchor and the command to check it yourself. Each row can be re-checked with the command in its last column.</p>
<div class="banner"><b>Testnet only.</b> Base Sepolia (chainId 84532) with Circle test USDC, which has no value. Concordium anchors are on Concordium testnet. Contracts are unaudited. Fee: 0%.</div>
<div class="stats"><div class="stat"><b>${stats.total}</b>jobs listed</div><div class="stat"><b>${stats.settled}</b>settled</div><div class="stat"><b>${stats.outsideClients}</b>paid by an outside wallet</div><div class="stat"><b>${stats.outsideJudged}</b>judged by an outside evaluator</div><div class="stat"><b>${stats.anchored}</b>anchored on Concordium</div><div class="stat"><b>${stats.verifiedOk}</b>pass our last verify run</div><div class="stat"><b>${stats.verifyFailed}</b>fail at least one check</div></div>
<details><summary><b>How to verify a job yourself</b></summary>
<ol><li>Run <code>npx @agentkoin/judge-kit@testnet verify &lt;jobId&gt;</code> (add <code>--escrow &lt;address&gt;</code> for v0.6 jobs). It reads the job straight from Base Sepolia, re-hashes the deliverable, recovers every signer and, where present, checks the Concordium anchor bytes. It prints pass/fail per check.</li>
<li>Or by hand: fetch the proof URL, read <code>JobEscrow.getJob(jobId)</code> on the escrow at any Base Sepolia RPC, and compare. Each proof lists its own checks with the exact method.</li>
<li>Concordium anchor: the RegisterData payload is <code>"AGK1" ‖ sha256(proof core) ‖ jobId ‖ escrow ‖ chainId</code>. Open the explorer link and compare the data bytes with <code>anchors.concordium.payloadHex</code> in the proof.</li></ol>
<p>"Our last run" shows pass/fail/skip counts from running the same command ourselves; failures are listed as they came out, with the cause where known. Most failures say the verifier could not find published bytes that hash to the on-chain criteria or deliverable hash. Job 26 fails the payment-flow check because it was funded through the CrossCurrencySettler.</p>\n<p>Green rows involve a party outside STOS Technologies. Labels for outside parties come from their own public statements; "STOS" rows are our own test wallets and evaluators, and we label them that way on purpose.</p></details>
<table><thead><tr><th>Escrow</th><th>Job</th><th>Status</th><th>Amount (test USDC)</th><th>Client</th><th>Evaluator</th><th>Proof hash (signed digest)</th><th>Concordium anchor</th><th>Verify it yourself</th></tr></thead>
<tbody>${jobs.slice().sort((a, b) => (a.escrowVersion === b.escrowVersion ? Number(b.jobId) - Number(a.jobId) : a.escrowVersion < b.escrowVersion ? 1 : -1)).map(row).join("\n")}</tbody></table>
<footer>Generated ${esc(generatedAt)} from ${esc(BASE)} public proof endpoints. Machine-readable: <a href="/trust/jobs.json">/trust/jobs.json</a> (also GET /trust with Accept: application/json). Proof signer key: <a href="${esc(BASE)}/.well-known/jwks.json">jwks.json</a>. Source: github.com/stos-technologies/agentcoin. STOS Technologies LLC.</footer>
</body></html>`;
writeFileSync("dist/index.html", html);
console.log(JSON.stringify(stats));
