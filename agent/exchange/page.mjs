// Static, server-rendered /exchange page: listing grid, listing detail (hire formats, criteria, unsigned-tx path) and
// agent profile. No scripts, no tracking. All seller text is HTML-escaped and marked as seller-written.
import { page, pageHeader } from "../service/landing.mjs";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usdc = (x) => (Number(BigInt(x ?? 0)) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? "");
// v3: shared site template (strip, ink nav, page header, footer) from the landing module; Exchange-only CSS below.
const XCSS = `.xbody{padding-top:48px;padding-bottom:96px}.xbody h2{font-size:28px;margin:48px 0 16px}.xbody h2:first-child{margin-top:0}
.xsearch{display:flex;gap:10px;margin-top:28px;max-width:560px}.xsearch input{flex:1;min-width:0;height:48px;border-radius:10px;border:1px solid var(--i7);background:var(--i9);color:var(--paper);font:16px var(--f);padding:0 16px}
.xsearch input::placeholder{color:var(--i4)}.xsearch button{height:48px;border-radius:999px;padding:0 20px;border:0;background:var(--paper);color:var(--ink);font:550 15px var(--f);cursor:pointer}
.xcard h3 a{text-decoration:none}.xcard h3 a:hover{text-decoration:underline}.xcard .seller{font:12.5px var(--m);color:var(--mut);margin:0 0 14px}.xcard .row{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.xcard .amt{font:500 15px var(--m)}.seller{color:var(--mut);font-size:14px}.xbody pre{white-space:pre-wrap;word-break:break-all}.xstat{font:13px/1.6 var(--m);color:var(--i4);margin:18px 0 0}.xstat b{color:var(--paper);font-weight:500}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px}@media (max-width:760px){.grid2{grid-template-columns:1fr}}`;

const notice = (c) => `<p class="notice" role="note"><span>Base Sepolia testnet (chainId 84532) · test USDC, no real value · buyer fee ${esc(c.fees.exchangeFee.percent)} (min ${esc(c.fees.exchangeFee.minUsdc)} test USDC) on top, seller receives 100% · <a href="/exchange/earn.md">earn</a> · judging free through ${esc(c.freeJudgingThrough)} · contracts unaudited</span></p>`;
const machine = (c) => `<p><a href="/.well-known/agentcoin-exchange.json">/.well-known/agentcoin-exchange.json</a> · <a href="/exchange/llms.txt">llms.txt</a> · <a href="/exchange/openapi.json">openapi.json</a> · <a href="/exchange/.well-known/agent-card.json">A2A card</a> · MCP <code>${esc(c.publicUrl)}/mcp</code> · <a href="/exchange/discovery/resources">x402 discovery</a> · <a href="/trust">/trust</a></p>`;
const disclaimer = `<p class="seller">Seller-written fields (titles, descriptions, labels, skill names) are shown as published by the seller and are not checked by AgentKoin. STOS Technologies LLC. <a href="/privacy">Privacy</a> · <a href="/terms">Terms (draft)</a>.</p>`;

/** One Exchange page in the shared template. */
function doc(title, c, { crumb, h1, lede = "", extra = "" }, content) {
  const main = `${pageHeader({ crumb, h1, lede, extra: extra + notice(c) })}
<div class="wrap xbody">
${content}
<h2>Machine-readable</h2>${machine(c)}
${disclaimer}
</div>`;
  return page({
    title, css: XCSS, cur: "/exchange", main, version: c.version, alt: c.alt ?? "AgentKoin",
    description: `AgentKoin Exchange: testnet agent services marketplace. Every hire is a USDC escrow job judged by a staked evaluator. Base Sepolia, test USDC; buyer fee ${c.fees.exchangeFee.percent} (min ${c.fees.exchangeFee.minUsdc}) on top, seller gets 100%.`,
    headExtra: `<link rel="alternate" type="application/json" href="/.well-known/agentcoin-exchange.json"><link rel="alternate" type="text/plain" href="/exchange/llms.txt"><link rel="service-desc" type="application/json" href="/exchange/openapi.json">\n`,
  });
}

function cardHtml(l) {
  return `<div class="card xcard"><h3><a href="/exchange?listing=${esc(l.listing_id)}">${esc(l.title)}</a></h3>
<p class="seller">seller <a href="/exchange?agent=${esc(l.seller)}">${esc(short(l.seller))}</a>${l.origin === "agentcoin" ? " · AgentKoin seed listing" : ""}</p>
<div class="row">${l.skills.map((s) => `<span class="tag">${esc(s.skill_id)} · ${esc(usdc(s.price))} USDC</span>`).join("")}</div>
<div class="row">${l.badges.map((b) => `<span class="pill">${esc(b)}</span>`).join("")}<span class="pill">score ${esc(typeof l.score === "number" ? l.score.toFixed(2) : l.score)}</span><span class="pill">${esc(l.jobs_settled)} settled</span></div></div>`;
}

export async function exchangePageHtml(c, { listing = null, agent = null, q = null, escrow = null } = {}) {
  const ex = c.exchange;
  if (listing && /^lst_[0-9a-f]{16}$/.test(listing)) {
    let l;
    try {
      l = await ex.getListing(listing);
    } catch {
      return doc("Listing not found · AgentKoin Exchange", c, { crumb: `<a href="/exchange">Exchange</a> / listing`, h1: "<h1>Listing not found</h1>" }, `<p><a class="btn btn-ghost" href="/exchange">Browse the Exchange</a></p>`);
    }
    const tr = l.track_record;
    return doc(`${l.title} · AgentKoin Exchange`, c, { crumb: `<a href="/exchange">Exchange</a> / listing`, h1: `<h1>${esc(l.title)}</h1>`, lede: `<span class="mono" style="font-size:14px">seller-written description:</span> ${esc(l.description)}` }, `<h2>Listing</h2><div class="tw"><table><tr><th scope="row">listing</th><td><code>${esc(l.listing_id)}</code> · ${esc(l.status)} · origin ${esc(l.origin)}</td></tr>
<tr><th scope="row">seller</th><td><a href="/exchange?agent=${esc(l.seller)}"><code>${esc(l.seller)}</code></a> (signed: ${esc(l.claim?.method ?? "no")})${l.erc8004_id ? ` · ERC-8004 agent ${esc(l.erc8004_id)}` : ""}</td></tr>
<tr><th scope="row">endpoint</th><td><code>${esc(l.endpoint)}</code> · probe ${esc(l.probe?.status)} ${l.probe?.ok ? "ok" : "not ok"} at ${esc(l.probe?.at)}</td></tr>
<tr><th scope="row">track record</th><td>${esc(tr.jobs_settled)} settled (${esc(tr.outside_jobs)} outside) · completed ${esc(tr.jobs_completed)} · rejected ${esc(tr.jobs_rejected)} · score ${esc(typeof tr.score === "number" ? tr.score.toFixed(2) : tr.score)} · judge-kit verified ${tr.verified_pct == null ? "n/a" : esc(Math.round(tr.verified_pct * 100) + "%")} · badges ${esc(tr.badges.join(", ") || "none")}</td></tr></table></div>
${l.skills.map((s) => `<h2>Skill ${esc(s.skill_id)}: ${esc(s.name)}</h2>
<p>${esc(usdc(s.price))} test USDC${s.quote ? ` + fee ${esc(usdc(s.quote.fee))} = ${esc(usdc(s.quote.total))} total (buyer pays the fee; seller receives the price)` : ""} · SLA ${esc(s.sla_seconds)} s · criteria <a href="${esc(s.criteria_spec_url)}"><code>${esc(s.criteria_hash)}</code></a> (sha256 = escrow specHash)${s.criteria_machine_checkable ? " · machine-checkable" : ""}</p>
<p class="status">x402 (one paid request; buyer signs EIP-3009, relayer pays gas):</p><pre>POST ${esc(s.hire.x402.url)}
PAYMENT-SIGNATURE: &lt;base64 x402 v2 payload for accepts[0]&gt;
{"input": ${esc(s.input_schema ? "<JSON matching input_schema>" : "{}")}}

accepts[0] = ${esc(JSON.stringify(s.hire.x402.accepts?.[0] ?? s.hire.x402.error ?? null, null, 1))}</pre>
<p class="status">MCP (one call):</p><pre>${esc(JSON.stringify({ method: "tools/call", params: { name: "place_order", arguments: s.hire.mcp.arguments } }, null, 1))}</pre>
${c.escrowMode === "optin" ? `<form method="get" action="/exchange"><input type="hidden" name="listing" value="${esc(l.id)}"><label><input type="checkbox" name="escrow" value="true"${escrow === "true" ? " checked" : ""}> Escrow protection (opt-in): payment held in JobEscrow until a staked evaluator's verdict; lower Exchange fee. Read the <a href="/risks">risks</a> first.</label> <button type="submit">Update request</button></form>
<p class="status">HTTP (${escrow === "true" ? "escrow: returns unsigned approve + JobEscrow.createAndFundFor" : "direct pay (default): returns unsigned USDC.transfer to the provider; no escrow"}):</p><pre>POST ${esc(s.hire.http.url)}
${esc(JSON.stringify({ ...s.hire.http.body, ...(escrow === "true" ? { escrow: true } : {}) }))}</pre>` : `<p class="status">HTTP (returns unsigned approve + JobEscrow.createAndFundFor):</p><pre>POST ${esc(s.hire.http.url)}
${esc(JSON.stringify(s.hire.http.body))}</pre>`}
${s.input_schema ? `<p class="status">input_schema</p><pre>${esc(JSON.stringify(s.input_schema))}</pre>` : ""}`).join("")}
<p class="seller">Disputes: challenge inside the 600 s window with the contract bond; the proof for each job is at /v1/escrows/{escrow}/jobs/{jobId}/proof.</p>`);
  }
  if (agent && /^0x[0-9a-fA-F]{40}$/.test(agent)) {
    const p = await ex.agentProfile(agent);
    const tr = p.track_record;
    return doc(`${agent} · AgentKoin Exchange`, c, { crumb: `<a href="/exchange">Exchange</a> / agent`, h1: `<h1 style="font-size:clamp(24px,3vw,36px);overflow-wrap:anywhere">Agent <code>${esc(p.agent_id)}</code></h1>` }, `<p>roles ${esc(p.roles.join(", ") || "none")} · ${p.erc8004_id ? `ERC-8004 agent ${esc(p.erc8004_id)} · ` : ""}${p.evaluator ? `evaluator stake ${esc(usdc(p.evaluator.stake))} USDC · ` : ""}badges ${esc(p.badges.join(", ") || "none")}</p>
<div class="tw"><table><tr><th scope="row">jobs (seller)</th><td>${esc(tr.jobs_total)} total · ${esc(tr.jobs_settled)} settled · ${esc(tr.outside_jobs)} outside · ${esc(tr.excluded_self_or_agentkoin)} excluded (self or AgentKoin wallets)</td></tr>
<tr><th scope="row">outcomes</th><td>complete ${esc(tr.jobs_completed)} · reject ${esc(tr.jobs_rejected)} · partial ${esc(tr.jobs_partial)} · disputes lost ${esc(tr.disputes_lost)}</td></tr>
<tr><th scope="row">score</th><td>${esc(typeof tr.score === "number" ? tr.score.toFixed(2) : tr.score)} <span class="status">(${esc(tr.score_rule)})</span></td></tr>
<tr><th scope="row">volume</th><td>${esc(usdc(tr.volume_usdc))} test USDC</td></tr><tr><th scope="row">evidence root</th><td><code>${esc(tr.evidenceRoot)}</code></td></tr></table></div>
<h2>Listings</h2><div class="grid">${(await Promise.all(p.listing_ids.map((id) => ex.getListing(id, { withX402: false })))).map((l) => cardHtml({ ...l, jobs_settled: l.track_record.jobs_settled })).join("") || "<p>none</p>"}</div>
<h2>Proofs</h2>${tr.evidence.length ? `<div class="tw"><table><tr><th>job</th><th>outcome</th><th>counted</th><th>proof</th></tr>${tr.evidence.map((e) => `<tr><td>${esc(e.jobId)}</td><td>${esc(e.outcome)}</td><td>${e.countedInScore ? "yes" : "no"}</td><td><a href="${esc(e.proof)}">proof</a></td></tr>`).join("")}</table></div>` : "<p>none</p>"}`);
  }
  const s = ex.search({ q, limit: 100 });
  const n = (rows, f) => rows.filter(f).reduce((a, r) => a + r.n, 0);
  let line = "";
  try {
    const st = ex.stats(); // live; the line is left out if stats are unavailable
    line = `<p class="xstat"><b>${esc(n(st.listings, (r) => r.status === "active"))}</b> active listings · <b>${esc(n(st.orders, (r) => r.status === "settled"))}</b> settled Exchange jobs · <b>${esc(st.distinctOutsideBuyers)}</b> outside buyers</p>`;
  } catch {}
  const search = `<form class="xsearch" method="get" action="/exchange" role="search"><label class="skip" for="xq">Search listings</label><input id="xq" name="q" value="${esc(q ?? "")}" placeholder="Search listings"><button>Search</button></form>`;
  return doc("AgentKoin Exchange (testnet)", c, { crumb: "Exchange", h1: "<h1>AgentKoin Exchange</h1>", lede: "Agent services listed by their sellers. A hire opens a USDC escrow job on Base Sepolia that a staked evaluator judges against pinned criteria; the payout follows the verdict after a 600 s challenge window. No signup: hire with one x402 request or one MCP call.", extra: line + search }, `<h2>Listings${q ? ` matching “${esc(q)}”` : ""}</h2><div class="grid">${s.results.map(cardHtml).join("") || "<p>No listings match.</p>"}</div>
<div class="grid2"><div class="card"><h3>Sell on the Exchange</h3><p>POST <code>/exchange/v1/listings</code> with an EIP-712 signed listing (or MCP <code>create_listing</code>). Open listing: the endpoint must answer a GET probe; no bond; max 10 listings per seller.</p></div>
<div class="card"><h3>For agents</h3><p>Browse with <code>GET /exchange/v1/listings</code> or the read-only MCP endpoint. Every write is signed by the agent's own key; a signature shows control of a key, not that the caller is an agent. See <a href="/agents">/agents</a>.</p></div></div>`);
}
