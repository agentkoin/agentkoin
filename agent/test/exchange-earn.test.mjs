// Earn MVP (testnet): Exchange buyer fee (0.5%, min 0.01 USDC, buyer pays, seller gets 100%), beta opt-in (EIP-712),
// fee waiver window, off-chain fee credits (grant idempotency, apply capped at fee, no cash path), beta-tester badge,
// open-jobs board (post / claim / exclusivity / lapse / fund / deliver / verdict) and find_earning_opportunities.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { decodeFunctionData, erc20Abi, getAddress, keccak256, toBytes } from "viem";
import { Exchange, ExchangeError, exchangeFee, feeQuote, sha256Hex, EXCHANGE_FEE_MIN } from "../exchange/exchange.mjs";
import { OpenJobs } from "../exchange/openjobs.mjs";
import { Beta, BETA_TYPES } from "../exchange/beta.mjs";
import { earnGuide } from "../exchange/earn.mjs";
import { exchangeLlms, exchangeOpenapi, exchangeWellKnown, exchangeAgentCard } from "../exchange/discovery.mjs";
import { ABI } from "../lib/config.mjs";
import { jcs } from "../lib/canonical.mjs";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ESCROW = "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D";
const FACTORY = "0x32174eFD01e600E621Cf3f0D19Ff694483B19b95";
const acct = () => privateKeyToAccount(generatePrivateKey());
const seller = acct(), buyer = acct(), buyer2 = acct(), claimer = acct(), claimer2 = acct(), REF = acct(), internal = acct(), FEE = acct();

function mk({ fee = true, betaEnd = "2027-01-01T04:59:59Z", betaStart = null, credit = null, maxBal = null, feeTxOk = () => true, feeBps = undefined, feeMin = undefined } = {}) {
  const jobs = new Map();
  const db = new Database(":memory:");
  let t = Date.parse("2026-11-23T12:00:00Z");
  const ex = new Exchange({
    db, publicUrl: "https://ex.test", now: () => t, signerKey: generatePrivateKey(), internalAddresses: () => [internal.address, REF.address], referenceEvaluator: REF.address,
    feeRecipient: fee ? FEE.address : null, feeBps, feeMin, limits: { maxJobAmount: 100_000_000n },
    chain: { usdc: USDC, escrow: ESCROW, escrowAbi: ABI.escrow, routeFactory: FACTORY, readJob: async (id) => jobs.get(String(id)) ?? null, routeFor: async (o) => getAddress("0x" + keccak256(toBytes(jcs({ ...o, amount: String(o.amount), deadlineSeconds: String(o.deadlineSeconds) }))).slice(26)), verifyFeeTransfer: async (h, a) => feeTxOk(h, a) },
    evaluators: async () => [{ address: REF.address, active: true, stake: "2000000", availableExposure: "20000000", default: true }],
    probe: async () => ({ status: 200, latencyMs: 1 }),
    fetchBytes: async () => Buffer.from("{}"),
  });
  const beta = new Beta(ex, { start: betaStart, end: betaEnd, creditPerJob: credit, maxCreditBalance: maxBal });
  const oj = new OpenJobs(ex, { evaluatorOnboarding: async () => ({ minStake: "1000000", steps: [{ step: "stake" }] }) });
  ex.jobs = oj;
  return { ex, beta, oj, jobs, tick: (ms) => (t += ms), now: () => t, setNow: (ms) => (t = ms) };
}
async function makeListing(ex, now, price = "20000") {
  const l = { title: "Summarize", endpoint: "https://seller.example/api", protocols: ["http"], labels: ["summarize"], skills: [{ skill_id: "summarize", name: "Summarize", price, sla_seconds: 3600, deliverable_schema: { type: "object", required: ["summary"] } }] };
  const e = await ex.createListing({ listing: l, seller: seller.address }).catch((x) => x);
  const exp = String(Math.floor(now() / 1000) + 600);
  const td = ex.typedData(seller.address, e.extra.normalisedListing, exp);
  const signature = await seller.signTypedData({ ...td, message: { ...td.message, expiresAt: BigInt(exp) } });
  return (await ex.createListing({ listing: l, seller: seller.address, expiresAt: exp, signature })).listing;
}
async function optIn(beta, who, now, optInFlag = true) {
  const ia = String(Math.floor(now() / 1000));
  const td = beta.typedData(who.address, optInFlag, ia);
  const signature = await who.signTypedData({ ...td, message: { ...td.message, issuedAt: BigInt(ia) } });
  return beta.optIn({ agent: who.address, optIn: optInFlag, issuedAt: ia, signature });
}
const job = (o, extra = {}) => ({ state: "Funded", outcome: "None", client: o.buyer, provider: o.seller, evaluator: o.evaluator, amount: o.amount, payoutBps: 0, deadline: "9999999999", submittedAt: "0", verdictAt: "0", disputedAt: "0", specHash: o.spec_hash, deliverableHash: "0x" + "00".repeat(32), ...extra });

test("fee math: 0.05 USDC minimum below $6.25, 0.8% above, ceil in atomic units, no cap; configurable", () => {
  assert.equal(EXCHANGE_FEE_MIN, 50_000n);
  assert.equal(exchangeFee(1n), 50_000n);
  assert.equal(exchangeFee(1_000_000n), 50_000n); // $1: 8000 -> min
  assert.equal(exchangeFee(6_249_999n), 50_000n); // 49999.992 -> ceil 50000
  assert.equal(exchangeFee(6_250_000n), 50_000n); // exactly $6.25: 0.8% == min
  assert.equal(exchangeFee(6_250_001n), 50_001n); // 50000.008 -> ceil 50001 (atomic unit)
  assert.equal(exchangeFee(6_250_126n), 50_002n); // 50001.008 -> 50002
  assert.equal(exchangeFee(50_000_000n), 400_000n); // $50 -> $0.40
  assert.equal(exchangeFee(1_000_000_000_000n), 8_000_000_000n); // no cap
  assert.deepEqual(feeQuote("6250001"), { price: "6250001", fee: "50001", total: "6300002", unit: "USDC base units (6 decimals)" });
  assert.equal(exchangeFee(1_000_000n, 50n, 10_000n), 10_000n, "rate and minimum are parameters");
  assert.throws(() => exchangeFee(0n));
  const { ex } = mk({ feeBps: 100n, feeMin: 20_000n });
  assert.equal(ex.quote("5000000", buyer.address).fee, "50000");
  assert.equal(ex.fees().exchangeFee.minAppliesBelow, "2000000");
});

test("hire with fee: quote price/fee/total; escrow amount = price (seller gets 100%); fee leg tx; receipt needs feeTx", async () => {
  const { ex, jobs, now } = mk({ fee: true });
  const l = await makeListing(ex, now, "10000000");
  assert.deepEqual([l.skills[0].quote.price, l.skills[0].quote.fee, l.skills[0].quote.total], ["10000000", "80000", "10080000"]);
  const s = ex.search({});
  assert.equal(s.results[0].skills[0].fee, "80000");
  const ord = await ex.hire({ listing_id: l.listing_id, buyer: buyer.address });
  assert.deepEqual([ord.quote.price, ord.quote.list_fee, ord.quote.fee, ord.quote.total, ord.quote.seller_receives], ["10000000", "80000", "80000", "10080000", "10000000"]);
  assert.equal(ord.amount, "10000000");
  const fund = decodeFunctionData({ abi: ABI.escrow, data: ord.payment.transactions[1].data });
  assert.equal(fund.args[3], 10_000_000n, "escrow job amount is the full price (seller receives 100%)");
  const feeTx = ord.payment.transactions[2];
  assert.equal(feeTx.to, USDC);
  const ft = decodeFunctionData({ abi: erc20Abi, data: feeTx.data });
  assert.deepEqual([ft.functionName, getAddress(ft.args[0]), ft.args[1]], ["transfer", FEE.address, 80_000n]);
  const acc = ord.payment.x402.accepts[0];
  assert.equal(acc.amount, "10000000");
  assert.equal(acc.extra.agentcoin.exchangeFee.requirement.payTo, FEE.address);
  assert.equal(acc.extra.agentcoin.exchangeFee.requirement.amount, "80000");
  // funding without feeTx -> 402; with feeTx -> funded, fee recorded
  jobs.set("5", job({ ...ord, seller: seller.address }));
  const e = await ex.recordFunding(ord.order_id, { jobId: "5" }).catch((x) => x);
  assert.equal(e.status, 402);
  const v = await ex.recordFunding(ord.order_id, { jobId: "5", feeTx: "0x" + "ab".repeat(32) });
  assert.equal(v.status, "funded");
  assert.deepEqual([v.txs.fee, v.txs.feeAmount, v.quote.total], ["0x" + "ab".repeat(32), "80000", "10080000"]);
  // the same feeTx cannot pay a second order
  const ord2 = await ex.hire({ listing_id: l.listing_id, buyer: buyer.address });
  jobs.set("6", job({ ...ord2, seller: seller.address }));
  assert.equal((await ex.recordFunding(ord2.order_id, { jobId: "6", feeTx: "0x" + "ab".repeat(32) }).catch((x) => x)).status, 409);
  assert.equal(ex.fees().exchangeFeeBps, 80);
  assert.equal(ex.fees().protocolFeeBps, 0);
  assert.equal(ex.fees().evaluatorFeeBps, 0);
});

test("beta opt-in: EIP-712 verify, wrong signer and stale issuedAt rejected, idempotent, opt-out", async () => {
  const { beta, now } = mk();
  const e = await beta.optIn({ agent: buyer.address }).catch((x) => x);
  assert.ok(e instanceof ExchangeError && e.status === 400 && e.extra.eip712.types === BETA_TYPES);
  const ia = String(Math.floor(now() / 1000));
  const td = beta.typedData(buyer.address, true, ia);
  const bad = await buyer2.signTypedData({ ...td, message: { ...td.message, issuedAt: BigInt(ia) } });
  assert.equal((await beta.optIn({ agent: buyer.address, optIn: true, issuedAt: ia, signature: bad }).catch((x) => x)).status, 403);
  const old = String(Math.floor(now() / 1000) - 7200);
  const td2 = beta.typedData(buyer.address, true, old);
  const sOld = await buyer.signTypedData({ ...td2, message: { ...td2.message, issuedAt: BigInt(old) } });
  assert.equal((await beta.optIn({ agent: buyer.address, optIn: true, issuedAt: old, signature: sOld }).catch((x) => x)).status, 400);
  const r = await optIn(beta, buyer, now);
  assert.equal(r.result, "opted-in");
  assert.equal(r.badge, "beta-tester");
  assert.equal(r.beta.claim.signature.length, 132);
  assert.ok(r.beta.opted_in_at);
  assert.equal((await optIn(beta, buyer, now)).result, "unchanged");
  const out = await optIn(beta, buyer, () => now() + 1000);
  assert.equal(out.result, "unchanged");
  const o2 = await optIn(beta, buyer, () => now() + 2000, false);
  assert.equal(o2.result, "opted-out");
  assert.equal(beta.isIn(buyer.address), false);
});

test("fee waiver: opted-in buyer pays 0 inside the window, list fee outside it; quote says why", async () => {
  const { ex, beta, now, setNow } = mk({ betaStart: "2026-11-01T00:00:00Z", betaEnd: "2026-12-31T23:59:59Z" });
  await optIn(beta, buyer, now);
  const q = ex.quote("20000", buyer.address);
  assert.deepEqual([q.list_fee, q.fee, q.total, q.fee_waived], ["50000", "0", "20000", true]);
  assert.match(q.waiver_reason, /beta tester/);
  assert.equal(ex.feeRequirement("20000", buyer.address), null, "no fee leg when waived");
  assert.equal(ex.quote("20000", buyer2.address).fee, "50000", "not opted in: list fee");
  setNow(Date.parse("2027-01-02T00:00:00Z"));
  const q2 = ex.quote("20000", buyer.address);
  assert.deepEqual([q2.fee, q2.fee_waived, q2.waiver_reason], ["50000", false, "beta window not active"]);
  setNow(Date.parse("2026-10-15T00:00:00Z"));
  assert.equal(ex.quote("20000", buyer.address).fee_waived, false, "before the window start");
});

test("fee credits: grant per completed judged job, idempotent; apply after waiver, capped at the fee; no cash path", async () => {
  const { ex, beta, jobs, now, setNow } = mk({ betaEnd: "2026-11-30T00:00:00Z", credit: 25_000n });
  const l = await makeListing(ex, now, "20000");
  await optIn(beta, buyer, now);
  await optIn(beta, seller, now);
  const settle = async (jobId) => {
    const ord = await ex.hire({ listing_id: l.listing_id, buyer: buyer.address });
    jobs.set(jobId, job({ ...ord, seller: seller.address }));
    await ex.recordFunding(ord.order_id, { jobId }); // waived: no feeTx needed
    jobs.set(jobId, job({ ...ord, seller: seller.address }, { state: "Settled", outcome: "Complete", payoutBps: 10000 }));
    await ex.refresh(ord.order_id);
    return ord;
  };
  const o1 = await settle("11");
  assert.equal(beta.balance(buyer.address), 25_000n);
  assert.equal(beta.balance(seller.address), 25_000n);
  // idempotent: re-refresh and direct re-grant do nothing
  await ex.refresh(o1.order_id);
  assert.deepEqual(beta.grantForOrder(ex._order(o1.order_id)), []);
  assert.equal(beta.balance(buyer.address), 25_000n);
  // rejected job: no grant
  const ord = await ex.hire({ listing_id: l.listing_id, buyer: buyer.address });
  jobs.set("12", job({ ...ord, seller: seller.address }));
  await ex.recordFunding(ord.order_id, { jobId: "12" });
  jobs.set("12", job({ ...ord, seller: seller.address }, { state: "Settled", outcome: "Reject" }));
  await ex.refresh(ord.order_id);
  assert.equal(beta.balance(buyer.address), 25_000n);
  await settle("13");
  assert.equal(beta.balance(buyer.address), 50_000n);
  // one more grant (credit 25000 each in this test) -> balance 75000 > fee 50000
  beta.grantForOrder({ id: "xo_extra", job_id: "99", escrow: ESCROW, status: "settled", evaluator: REF.address, created_at: now() + 1, buyer: buyer.address, seller: seller.address, job: { outcome: "Complete" } });
  assert.equal(beta.balance(buyer.address), 75_000n);
  // after the window: no waiver; credits apply, capped at the fee (fee 50000, balance 75000 -> 50000 used, fee 0)
  setNow(Date.parse("2026-12-05T00:00:00Z"));
  const q = ex.quote("20000", buyer.address);
  assert.deepEqual([q.fee_waived, q.list_fee, q.credit_applied, q.fee], [false, "50000", "50000", "0"]);
  const ord3 = await ex.hire({ listing_id: l.listing_id, buyer: buyer.address });
  assert.equal(ord3.payment.transactions.length, 2, "no fee tx when credits cover the fee");
  jobs.set("14", job({ ...ord3, seller: seller.address }));
  const f = await ex.recordFunding(ord3.order_id, { jobId: "14" });
  assert.deepEqual([f.txs.feeAmount, f.txs.creditApplied], ["0", "50000"]);
  assert.equal(beta.balance(buyer.address), 25_000n);
  assert.deepEqual(beta.debit(buyer.address, 50_000n, ord3.order_id).existing, true);
  assert.equal(beta.balance(buyer.address), 25_000n, "re-recording does not debit twice");
  // partial cover: fee 50000, balance 25000 -> fee 25000 left
  const q3 = ex.quote("20000", buyer.address);
  assert.deepEqual([q3.credit_applied, q3.fee], ["25000", "25000"]);
  // no cash path: read-only view says so; there is no withdraw/transfer method
  const c = beta.credits(buyer.address);
  assert.deepEqual([c.cash, c.withdrawable, c.transferable], [false, false, false]);
  for (const m of ["withdraw", "transfer", "payout", "redeem", "cashOut"]) assert.equal(typeof beta[m], "undefined");
  assert.ok(c.history.some((h) => h.kind === "apply"));
  // badge
  assert.ok(ex.trackRecord(seller.address).badges.includes("beta-tester"));
  assert.ok((await ex.getListing(l.listing_id, { withX402: false })).badges.includes("beta-tester"));
});

test("credits: cap on balance; non-opted-in, self and AgentKoin jobs earn nothing", async () => {
  const { ex, beta, now } = mk({ credit: 10_000n, maxBal: 15_000n });
  await optIn(beta, buyer, now);
  const base = { escrow: ESCROW, status: "settled", evaluator: REF.address, created_at: now() + 1, job: { outcome: "Complete" } };
  beta.grantForOrder({ ...base, id: "xo_1", job_id: "1", buyer: buyer.address, seller: seller.address });
  beta.grantForOrder({ ...base, id: "xo_2", job_id: "2", buyer: buyer.address, seller: seller.address });
  assert.equal(beta.balance(buyer.address), 15_000n, "capped at maxCreditBalance");
  assert.equal(beta.balance(seller.address), 0n, "seller not opted in");
  assert.deepEqual(beta.grantForOrder({ ...base, id: "xo_3", job_id: "3", buyer: buyer.address, seller: buyer.address }), [], "self-dealing");
  await optIn(beta, internal, now);
  assert.deepEqual(beta.grantForOrder({ ...base, id: "xo_4", job_id: "4", buyer: internal.address, seller: seller.address }), [], "AgentKoin wallets");
});

async function postJob(oj, who, job, now) {
  const e = await oj.post({ job, buyer: who.address }).catch((x) => x);
  assert.ok(e instanceof ExchangeError && e.status === 400 && e.extra.eip712);
  const exp = String(Math.floor(now() / 1000) + 600);
  const td = oj.typedData(who.address, e.extra.normalisedJob, exp);
  const signature = await who.signTypedData({ ...td, message: { ...td.message, expiresAt: BigInt(exp) } });
  return oj.post({ job, buyer: who.address, expiresAt: exp, signature }, { ip: "1.1.1.1" });
}
async function claim(oj, id, who, now) {
  const exp = String(Math.floor(now() / 1000) + 600);
  const td = oj.claimTypedData(who.address, id, exp);
  const signature = await who.signTypedData({ ...td, message: { ...td.message, expiresAt: BigInt(exp) } });
  return oj.claim(id, { claimer: who.address, expiresAt: exp, signature });
}

test("open jobs: post (EIP-712), claim exclusive, lapse reopens, fund with provider = claimer, deliver, verdict, trust row", async () => {
  const { ex, oj, jobs, now, tick } = mk();
  const spec = { title: "Summarize a page", category: "Summarize", budget: "500000", sla_seconds: 3600, deliverable_schema: { type: "object", required: ["summary"] }, input: { url: "https://example.com" } };
  const p = await postJob(oj, buyer, spec, now);
  assert.equal(p.result, "posted");
  assert.equal(p.status, "open");
  assert.match(p.open_job_id, /^oj_[0-9a-f]{16}$/);
  assert.equal(p.category, "summarize");
  assert.deepEqual([p.quote.price, p.quote.fee, p.quote.total], ["500000", "50000", "550000"]);
  assert.equal(sha256Hex(ex.criteria(p.criteria_hash.slice(2)).bytes), p.criteria_hash);
  assert.equal((await postJob(oj, buyer, spec, now)).result, "exists");
  // wrong signer
  const e = await oj.post({ job: spec, buyer: buyer.address }).catch((x) => x);
  const exp = String(Math.floor(now() / 1000) + 600);
  const td = oj.typedData(buyer.address, e.extra.normalisedJob, exp);
  const sig = await buyer2.signTypedData({ ...td, message: { ...td.message, expiresAt: BigInt(exp) } });
  assert.equal((await oj.post({ job: spec, buyer: buyer.address, expiresAt: exp, signature: sig }).catch((x) => x)).status, 403);
  // budget cap
  assert.equal((await oj.post({ job: { ...spec, budget: "5000001" }, buyer: buyer.address }).catch((x) => x)).status, 400);
  assert.equal(oj.list({}).total, 1);
  // buyer cannot claim own job
  assert.equal((await claim(oj, p.open_job_id, buyer, now).catch((x) => x)).status, 422);
  const c = await claim(oj, p.open_job_id, claimer, now);
  assert.equal(c.status, "claimed");
  assert.equal(c.buyer_funds.x402.accepts[0].extra.agentcoin.offer.provider, claimer.address);
  assert.equal(c.buyer_funds.x402.accepts[0].amount, "500000");
  const fa = decodeFunctionData({ abi: ABI.escrow, data: c.buyer_funds.transactions[1].data });
  assert.deepEqual([getAddress(fa.args[1]), fa.args[3]], [claimer.address, 500_000n]);
  // exclusive
  assert.equal((await claim(oj, p.open_job_id, claimer2, now).catch((x) => x)).status, 409);
  assert.equal(oj.list({}).total, 0);
  // lapse: unfunded past claimTtl -> reopens; claimer2 can claim
  tick(2 * 3600 * 1000 + 1000);
  assert.equal((await oj.get(p.open_job_id)).status, "open");
  assert.equal(ex._order(c.order_id).status, "claim-lapsed");
  const c2 = await claim(oj, p.open_job_id, claimer2, now);
  // fund (unsigned path) -> funded; provider check uses the claimer
  jobs.set("21", job({ ...ex._order(c2.order_id), seller: claimer2.address }));
  const f = await ex.recordFunding(c2.order_id, { jobId: "21", feeTx: "0x" + "cd".repeat(32) });
  assert.equal(f.status, "funded");
  assert.equal(f.open_job_id, p.open_job_id);
  assert.equal((await oj.get(p.open_job_id)).status, "funded");
  // a job with the wrong provider is rejected
  const p2 = await postJob(oj, buyer, { ...spec, title: "Other", nonce: "2" }, now);
  const c3 = await claim(oj, p2.open_job_id, claimer, now);
  jobs.set("22", job({ ...ex._order(c3.order_id), seller: claimer2.address }));
  assert.equal((await ex.recordFunding(c3.order_id, { jobId: "22", feeTx: "0x" + "ce".repeat(32) }).catch((x) => x)).status, 422);
  // deliver + machine-check verdict
  const bytes = Buffer.from(jcs({ jobId: "21", output: { summary: "ok" } }));
  jobs.set("21", job({ ...ex._order(c2.order_id), seller: claimer2.address }, { state: "Submitted", deliverableHash: sha256Hex(bytes) }));
  await ex.putDeliverable(c2.order_id, bytes);
  const ev = await ex.evaluate(c2.order_id);
  assert.deepEqual([ev.judgeable, ev.pass, ev.payoutBps], [true, true, 10000]);
  const row = ex.trustRows().find((r) => r.jobId === "21");
  assert.deepEqual([row.exchange_open_job_id, row.exchange_listing_id, row.agent_ids.seller], [p.open_job_id, null, claimer2.address]);
  assert.equal(ex.trackRecord(claimer2.address).jobs_total, 1);
});

test("open jobs caps: active claims per claimer; open jobs expire", async () => {
  const { oj, now, tick } = mk();
  oj.limits.maxActiveClaimsPerClaimer = 1;
  const a = await postJob(oj, buyer, { title: "A", budget: "20000", open_seconds: 3600 }, now);
  const b = await postJob(oj, buyer, { title: "B", budget: "20000" }, now);
  await claim(oj, a.open_job_id, claimer, now);
  assert.equal((await claim(oj, b.open_job_id, claimer, now).catch((x) => x)).status, 429);
  const c = await postJob(oj, buyer2, { title: "C", budget: "20000", open_seconds: 600 }, now);
  tick(601_000);
  assert.equal((await oj.get(c.open_job_id)).status, "expired");
});

test("find_earning_opportunities: open jobs, underserved categories from real data, evaluator openings; testnet labels; docs show fee + beta", async () => {
  const { ex, oj, now } = mk();
  await makeListing(ex, now, "20000"); // supply: summarize
  await postJob(oj, buyer, { title: "Translate this", category: "translate", budget: "300000" }, now);
  await postJob(oj, buyer, { title: "Translate that", category: "translate", budget: "100000" }, now);
  await postJob(oj, buyer2, { title: "Summarize", category: "summarize", budget: "100000" }, now);
  const r = await oj.earn({});
  assert.equal(r.open_jobs.length, 3);
  assert.equal(r.open_jobs[0].budget, "300000");
  assert.equal(r.open_jobs[0].next_step.mcp.tool, "claim_job");
  assert.deepEqual(r.underserved_categories.map((c) => [c.category, c.demand, c.supply]), [["translate", 2, 0]]);
  assert.equal(r.underserved_categories[0].next_step.mcp.tool, "create_listing");
  assert.equal(r.evaluator_openings.min_stake, "1000000");
  assert.equal(r.evaluator_openings.active_evaluators, 1);
  assert.equal(r.testnet, true);
  assert.equal(r.realValue, false);
  assert.doesNotMatch(JSON.stringify(r), /guarantee|passive income|profit/i);
  const ctx = { exchange: ex, publicUrl: ex.publicUrl, version: "t", tools: [{ name: "find_earning_opportunities", config: {} }], contracts: ex.contracts(), fees: ex.fees(), probeRule: "", freeJudgingThrough: "2026-12-31", untrustedFields: [], links: {} };
  const g = earnGuide(ctx);
  for (const s of ["testnet", "no real value", "80 bps", "100% of the price", "find_earning_opportunities", "claim_job", "not withdrawable", "0% Exchange buyer fee"]) assert.ok(g.includes(s) || g.toLowerCase().includes(s.toLowerCase()), `guide mentions ${s}`);
  assert.doesNotMatch(g, /guaranteed|passive income|share of (the )?fees|revenue share (of|for|to)/i);
  assert.match(g, /no revenue share/);
  const llms = exchangeLlms(ctx);
  assert.match(llms, /buyer fee 80 bps \(0\.8%\)/);
  assert.match(llms, /0\.05 test USDC/);
  assert.doesNotMatch(llms + g, /0\.5%|min 0\.01|minimum 10000 /);
  assert.match(llms, /earn\.md/);
  assert.match(llms, /beta/i);
  const wk = await exchangeWellKnown(ctx);
  assert.equal(wk.fees.exchangeFeeBps, 80);
  assert.equal(wk.fees.exchangeFee.min, "50000");
  assert.equal(wk.fees.exchangeFee.minAppliesBelow, "6250000");
  assert.match(exchangeAgentCard(ctx).description, /0\.8%, min 0\.05 USDC/);
  assert.ok(wk.fees.beta);
  const oa = exchangeOpenapi(ctx);
  for (const k of ["/exchange/v1/earn", "/exchange/v1/jobs", "/exchange/v1/jobs/{open_job_id}/claim", "/exchange/v1/beta", "/exchange/v1/beta/{address}/credits"]) assert.ok(oa.paths[k], k);
});

test("HTTP wiring: beta opt-in + credits, jobs board, earn, earn.md; no withdraw/transfer route; 402 shows the fee leg", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createApp } = await import("../service/app.mjs");
  const app = createApp({
    stateDir: mkdtempSync(path.join(tmpdir(), "acearn-")), publicUrl: "http://127.0.0.1:0", caps: { freePerIpPerHour: 1000 },
    exchangeChain: { readJob: async () => null, routeFor: async () => "0x000000000000000000000000000000000000dEaD" },
    exchangeProbe: async () => ({ status: 200, latencyMs: 1 }),
  });
  const refAddr = app.exchange.o.referenceEvaluator;
  app.exchange.o.evaluators = async () => [{ address: refAddr, active: true, stake: "2000000", availableExposure: "20000000", default: true }];
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    const t0 = await (await post("/exchange/v1/beta", { agent: buyer.address })).json();
    assert.ok(t0.eip712);
    const ia = String(Math.floor(Date.now() / 1000));
    const td = { ...t0.eip712, message: { ...t0.eip712.message, issuedAt: ia } };
    const signature = await buyer.signTypedData({ ...td, message: { ...td.message, issuedAt: BigInt(ia) } });
    const r = await post("/exchange/v1/beta", { agent: buyer.address, optIn: true, issuedAt: ia, signature });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).badge, "beta-tester");
    const cr = await (await fetch(`${base}/exchange/v1/beta/${buyer.address}/credits`)).json();
    assert.deepEqual([cr.balance, cr.cash, cr.withdrawable, cr.transferable], ["0", false, false, false]);
    for (const p of [`/exchange/v1/beta/${buyer.address}/credits/withdraw`, `/exchange/v1/beta/${buyer.address}/withdraw`, `/exchange/v1/beta/${buyer.address}/transfer`]) assert.equal((await post(p, { to: buyer2.address, amount: "1" })).status, 404, p);
    assert.equal((await fetch(base + "/exchange/v1/jobs")).status, 200);
    const earn = await (await fetch(base + "/exchange/v1/earn")).json();
    assert.equal(earn.v, "agentkoin-earn/v1");
    const md = await (await fetch(base + "/exchange/earn.md")).text();
    assert.match(md, /^# Earn with AgentKoin/);
    // seed listing hire 402: fee leg extension; opted-in buyer (?buyer=) sees it waived
    const ls = await (await fetch(base + "/exchange/v1/listings?origin=agentcoin")).json();
    const l = ls.results[0];
    const h = await (await post(`/exchange/v1/listings/${l.listing_id}/hire?skill=${l.skills[0].skill_id}`, {})).json();
    assert.equal(h.extensions["agentkoin-exchange-fee"].info.requirement.amount, String(exchangeFee(l.skills[0].price)));
    const hb = await (await post(`/exchange/v1/listings/${l.listing_id}/hire?skill=${l.skills[0].skill_id}&buyer=${buyer.address}`, {})).json();
    assert.equal(hb.extensions, undefined, "waived for the opted-in buyer: no fee leg");
    assert.equal(hb.accepts[0].extra.agentcoin.exchangeFee.fee_waived, true);
  } finally {
    app.server.close();
    app.stop?.();
  }
});
