// HTTP surface of the AgentKoin Exchange: /exchange/v1/*, /.well-known/agentcoin-exchange.json, /exchange (page) and the
// discovery documents (llms.txt, openapi.json, A2A card, MCP registry entry, x402 discovery), the open-jobs board and the
// earn guide. Buyer fee 0.8% (min 0.05 test USDC; configurable) on Exchange hires; testnet only.

import { TESTNET } from "../lib/network.mjs";
import { assertNotSanctioned } from "../lib/ofac.mjs";
import { ExchangeError, EXCHANGE_VERSION, UNTRUSTED_FIELDS, PROBE_OK, FREE_JUDGING_THROUGH } from "./exchange.mjs";
import { earnGuide } from "./earn.mjs";
import { exchangeLlms, exchangeOpenapi, exchangeAgentCard, exchangeMcpRegistry, exchangeX402Discovery, exchangeWellKnown } from "./discovery.mjs";
import { exchangePageHtml } from "./page.mjs";

export const EXCHANGE_PATH = /^\/exchange(\/|$)|^\/\.well-known\/agent(coin|koin)-exchange\.json$/;

/**
 * deps: { exchange, json(res,status,body,headers), send(res,status,body,type,headers), readBody(req,max)->Buffer, hireX402({...}) -> {status, body, headers},
 *         afterFunding(orderId), afterDeliverable(orderId), stats, mcpTools() -> [{name, config}], version, links }
 */
export function makeExchangeHttp(d) {
  const ex = d.exchange;
  const J = (res, s, b, h) => d.json(res, s, b, h);
  const parse = (buf) => {
    if (!buf?.length) return {};
    let b;
    try {
      b = JSON.parse(buf.toString("utf8"));
    } catch {
      throw new ExchangeError(400, "body must be JSON");
    }
    if (typeof b !== "object" || b === null || Array.isArray(b)) throw new ExchangeError(400, "body must be a JSON object");
    return b;
  };
  const ctx = () => ({ exchange: ex, publicUrl: ex.publicUrl, version: d.version, tools: d.mcpTools(), contracts: ex.contracts(), fees: ex.fees(), probeRule: PROBE_OK, freeJudgingThrough: FREE_JUDGING_THROUGH, untrustedFields: UNTRUSTED_FIELDS, links: d.links });
  const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-AgentCoin-Testnet" };

  async function hireOut(res, r) {
    const h = { ...cors, ...(r.headers ?? {}) };
    if (r.status === 402) h["PAYMENT-REQUIRED"] = Buffer.from(JSON.stringify({ ...r.body, testnet: TESTNET, realValue: !TESTNET })).toString("base64");
    return J(res, r.status, r.body, h);
  }

  return async function handle(req, res, { u, p, ip }) {
    if (!EXCHANGE_PATH.test(p)) return false;
    try {
      const g = (k) => u.searchParams.get(k) ?? undefined;
      let m;
      if (req.method === "GET" || req.method === "HEAD") {
        if (p === "/exchange" || p === "/exchange/") {
          d.stats?.inc("exchangePage");
          const wantsJson = /application\/json/.test(req.headers.accept ?? "") && !/text\/html/.test(req.headers.accept ?? "");
          if (wantsJson || g("format") === "json") return J(res, 200, await exchangeWellKnown(ctx(), { cursor: g("cursor"), limit: g("limit") }), cors), true;
          return d.send(res, 200, await exchangePageHtml({ ...ctx(), escrowMode: ex.escrowMode }, { listing: g("listing"), agent: g("agent"), q: g("q"), escrow: g("escrow") }), "text/html; charset=utf-8", { "cache-control": "no-store", vary: "Accept" }), true;
        }
        if (/^\/\.well-known\/agent(coin|koin)-exchange\.json$/.test(p) || p === "/exchange/.well-known/agentcoin-exchange.json") return J(res, 200, await exchangeWellKnown(ctx(), { cursor: g("cursor"), limit: g("limit") }), { ...cors, "cache-control": "public, max-age=60" }), true;
        if (p === "/exchange/llms.txt") return d.send(res, 200, exchangeLlms(ctx()), "text/plain; charset=utf-8", cors), true;
        if (p === "/exchange/earn.md" || p === "/exchange/earn") return d.send(res, 200, earnGuide(ctx()), "text/markdown; charset=utf-8", cors), true;
        if (p === "/exchange/v1/earn") {
          d.stats?.inc("exchangeEarn");
          return J(res, 200, await ex.jobs.earn({ category: g("category"), address: g("address"), limit: g("limit") }), cors), true;
        }
        if ((m = p.match(/^\/exchange\/v1\/beta\/(0x[0-9a-fA-F]{40})$/))) return J(res, 200, ex.beta.view(m[1]), cors), true;
        if ((m = p.match(/^\/exchange\/v1\/beta\/(0x[0-9a-fA-F]{40})\/credits$/))) return J(res, 200, { ...ex.beta.credits(m[1]), testnet: TESTNET, realValue: !TESTNET }, cors), true;
        if (p === "/exchange/v1/beta") return J(res, 200, { terms: ex.beta.terms(), optIn: { method: "POST", url: ex.url("/exchange/v1/beta"), body: { agent: "<address>", optIn: true, issuedAt: "<unix s>", signature: "<EIP-712 BetaOptIn>" } }, testnet: TESTNET, realValue: !TESTNET }, cors), true;
        if (p === "/exchange/v1/jobs") return J(res, 200, ex.jobs.list({ category: g("category"), minBudget: g("minBudget"), maxBudget: g("maxBudget"), status: g("status") ?? "open", limit: g("limit"), cursor: g("cursor") }), cors), true;
        if ((m = p.match(/^\/exchange\/v1\/jobs\/(oj_[0-9a-f]{16})$/))) return J(res, 200, await ex.jobs.get(m[1]), cors), true;
        if (p === "/exchange/openapi.json") return J(res, 200, exchangeOpenapi(ctx()), cors), true;
        if (p === "/exchange/.well-known/agent-card.json" || p === "/exchange/.well-known/agent.json") return J(res, 200, exchangeAgentCard(ctx()), cors), true;
        if (p === "/exchange/server.json" || p === "/exchange/.well-known/mcp-registry.json") return J(res, 200, exchangeMcpRegistry(ctx()), cors), true;
        if (p === "/exchange/discovery/resources") return J(res, 200, await exchangeX402Discovery(ctx()), cors), true;
        if (p === "/exchange/v1/listings") {
          d.stats?.inc("exchangeSearch");
          return J(res, 200, { ...ex.search({ q: g("q"), skill: g("skill"), maxPrice: g("maxPrice"), minScore: g("minScore"), badge: g("badge"), evaluator: g("evaluator"), protocol: g("protocol"), seller: g("seller"), origin: g("origin"), sort: g("sort"), cursor: g("cursor"), limit: g("limit") }), contracts: ex.contracts(), fees: ex.fees() }, cors), true;
        }
        if ((m = p.match(/^\/exchange\/v1\/listings\/(lst_[0-9a-f]{16})$/))) return J(res, 200, await ex.getListing(m[1]), cors), true;
        if ((m = p.match(/^\/exchange\/v1\/listings\/(lst_[0-9a-f]{16})\/hire$/))) return await hireOut(res, await d.hireX402({ listingId: m[1], skillId: g("skill"), evaluator: g("evaluator"), paymentSignature: req.headers["payment-signature"] ?? null, buyer: g("buyer"), ip })), true;
        if ((m = p.match(/^\/exchange\/v1\/agents\/(0x[0-9a-fA-F]{40})$/))) return J(res, 200, await ex.agentProfile(m[1]), cors), true;
        if (p === "/exchange/v1/evaluators") return J(res, 200, await ex.evaluatorsView(), cors), true;
        if (p === "/exchange/v1/stats") return J(res, 200, ex.stats(), cors), true;
        if (p === "/exchange/v1/jobs.json") return J(res, 200, { v: EXCHANGE_VERSION, jobs: ex.trustRows() }, cors), true;
        if ((m = p.match(/^\/exchange\/v1\/orders\/(xo_[0-9a-f]{16})$/))) return J(res, 200, await ex.getOrder(m[1]), cors), true;
        if ((m = p.match(/^\/exchange\/v1\/orders\/(xo_[0-9a-f]{16})\/deliverable$/))) {
          const b = ex.deliverableBytes(m[1]);
          if (!b) return J(res, 404, { error: "no deliverable published for this order" }), true;
          return d.send(res, 200, Buffer.from(b), "application/json", { ...cors, "cache-control": "public, max-age=31536000, immutable", "x-deliverable-sha256": (await import("./exchange.mjs")).sha256Hex(b) }), true;
        }
        if ((m = p.match(/^\/exchange\/v1\/criteria\/([0-9a-f]{64})$/))) {
          const c = ex.criteria(m[1]);
          if (!c) return J(res, 404, { error: "unknown criteria hash" }), true;
          return d.send(res, 200, Buffer.from(c.bytes), "application/json", { ...cors, "cache-control": "public, max-age=31536000, immutable", "x-criteria-sha256": m[1] }), true;
        }
        return J(res, 404, { error: "not found", see: ex.url("/.well-known/agentcoin-exchange.json") }), true;
      }
      if (req.method === "POST") {
        const isDeliv = /^\/exchange\/v1\/orders\/xo_[0-9a-f]{16}\/deliverable$/.test(p);
        const buf = await d.readBody(req, isDeliv ? ex.limits.maxDeliverableBytes + 1 : 65_536);
        if (p === "/exchange/v1/listings") {
          d.stats?.inc("exchangeListingWrites");
          const r = await ex.createListing(parse(buf), { ip });
          return J(res, r.status === "created" ? 201 : 200, r, cors), true;
        }
        if (p === "/exchange/v1/beta") {
          d.stats?.inc("exchangeBetaWrites");
          return J(res, 200, await ex.beta.optIn(parse(buf)), cors), true;
        }
        if (p === "/exchange/v1/jobs") {
          d.stats?.inc("exchangeJobPosts");
          const r = await ex.jobs.post(parse(buf), { ip });
          return J(res, r.result === "posted" ? 201 : 200, r, cors), true;
        }
        if ((m = p.match(/^\/exchange\/v1\/jobs\/(oj_[0-9a-f]{16})\/claim$/))) {
          d.stats?.inc("exchangeJobClaims");
          return J(res, 201, await ex.jobs.claim(m[1], parse(buf)), cors), true;
        }
        if ((m = p.match(/^\/exchange\/v1\/listings\/(lst_[0-9a-f]{16})\/status$/))) return J(res, 200, await ex.setStatus(m[1], parse(buf)), cors), true;
        if ((m = p.match(/^\/exchange\/v1\/listings\/(lst_[0-9a-f]{16})\/hire$/))) {
          const b = parse(buf);
          d.stats?.inc("exchangeHireX402");
          // opt-in mode: an x402 hire opens an escrow job, so a paid request must opt in explicitly (escrow:true or ?escrow=true)
          if (ex.escrowMode === "optin" && req.headers["payment-signature"] && !(b.escrow === true || g("escrow") === "true")) throw new ExchangeError(400, "escrow_opt_in_required", { code: "ESCROW_OPT_IN_REQUIRED", detail: "x402 hires open an escrow job; repeat with escrow:true after reading the risks, or use POST /exchange/v1/orders for direct pay", risks_url: ex.risksUrl });
          return await hireOut(res, await d.hireX402({ listingId: m[1], skillId: g("skill") ?? b.skill_id, evaluator: g("evaluator") ?? b.evaluator, input: b.input ?? null, paymentSignature: req.headers["payment-signature"] ?? null, buyer: g("buyer"), ip })), true;
        }
        if (p === "/exchange/v1/orders") {
          d.stats?.inc("exchangeOrders");
          const b = parse(buf);
          assertNotSanctioned([b?.buyer, b?.evaluator]); // OFAC SDN screen at order intake (403 OFAC_SDN_MATCH)
          return J(res, 201, await (ex.intents ?? { hire: (a) => ex.hire(a) }).hire({ listing_id: b.listing_id, skill_id: b.skill_id, buyer: b.buyer, evaluator: b.evaluator, input: b.input ?? null, ...(b.escrow !== undefined ? { escrow: b.escrow } : {}), channel: "http", signature: b.signature, expiresAt: b.expiresAt, nonce: b.nonce, erc8004_id: b.erc8004_id }), cors), true;
        }
        if ((m = p.match(/^\/exchange\/v1\/orders\/(xo_[0-9a-f]{16})\/pay$/))) return await hireOut(res, await d.hireX402({ orderId: m[1], paymentSignature: req.headers["payment-signature"] ?? null, buyer: g("buyer"), ip })), true;
        if ((m = p.match(/^\/exchange\/v1\/orders\/(xo_[0-9a-f]{16})\/receipt$/))) {
          const b = parse(buf);
          const v = await ex.recordFunding(m[1], { jobId: b.jobId, paymentTx: b.paymentTx ?? null, feeTx: b.feeTx ?? null });
          d.afterFunding?.(m[1]);
          return J(res, 200, v, cors), true;
        }
        if (isDeliv) {
          const id = p.split("/")[4];
          const v = await ex.putDeliverable(id, buf);
          d.afterDeliverable?.(id);
          return J(res, 200, v, cors), true;
        }
        return J(res, 404, { error: "not found" }), true;
      }
      return J(res, 405, { error: "method not allowed" }), true;
    } catch (e) {
      if (e instanceof ExchangeError) return J(res, e.status, { error: e.message, ...e.extra }, cors), true;
      throw e;
    }
  };
}

