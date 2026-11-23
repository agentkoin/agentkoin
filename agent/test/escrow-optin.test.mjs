// Escrow opt-in (base default) vs always (testnet default): direct order shape, escrow:true flag, fee discount,
// escrow-protected badge, direct receipt check, and unchanged testnet behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { decodeFunctionData, erc20Abi, getAddress, keccak256, toBytes } from "viem";
import { Exchange } from "../exchange/exchange.mjs";
import { OpenJobs } from "../exchange/openjobs.mjs";
import { Beta } from "../exchange/beta.mjs";
import { ABI } from "../lib/config.mjs";
import { jcs } from "../lib/canonical.mjs";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ESCROW = "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D";
const FACTORY = "0x32174eFD01e600E621Cf3f0D19Ff694483B19b95";
const acct = () => privateKeyToAccount(generatePrivateKey());
const seller = acct(), buyer = acct(), REF = acct(), internal = acct(), FEE = acct();
function mk({ escrowDefault = undefined, escrowFeeBps = undefined, fee = true, betaEnd = "2027-01-01T04:59:59Z", betaStart = null, credit = null, maxBal = null, feeTxOk = () => true, feeBps = undefined, feeMin = undefined } = {}) {
  const jobs = new Map();
  const db = new Database(":memory:");
  let t = Date.parse("2026-11-23T12:00:00Z");
  const ex = new Exchange({
    db, publicUrl: "https://ex.test", now: () => t, signerKey: generatePrivateKey(), internalAddresses: () => [internal.address, REF.address], referenceEvaluator: REF.address,
    feeRecipient: fee ? FEE.address : null, feeBps, feeMin, escrowDefault, escrowFeeBps, limits: { maxJobAmount: 100_000_000n },
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

test("always (testnet default): hire is an escrow order, no opt-in fields", async () => {
  const { ex, now } = mk();
  const l = await makeListing(ex, now, "20000000");
  const o = await ex.hire({ listing_id: l.listing_id, buyer: buyer.address });
  assert.equal(o.status, "awaiting-funding");
  assert.equal(o.mode, undefined);
  assert.equal(o.escrow_protected, undefined);
  assert.equal(o.quote.fee, "160000"); // 0.8%
});

test("optin: default is direct pay (USDC.transfer to provider, list fee), escrow:true opts in with badge and 0.6% fee", async () => {
  const { ex, now } = mk({ escrowDefault: "optin", escrowFeeBps: 60 });
  const l = await makeListing(ex, now, "20000000");
  const d = await ex.hire({ listing_id: l.listing_id, buyer: buyer.address });
  assert.equal(d.mode, "direct");
  assert.equal(d.escrow_protected, false);
  assert.equal(d.status, "awaiting-payment");
  assert.equal(d.quote.fee, "160000");
  const t1 = decodeFunctionData({ abi: erc20Abi, data: d.payment.transactions[0].data });
  assert.equal(t1.functionName, "transfer");
  assert.equal(getAddress(t1.args[0]), getAddress(d.provider));
  assert.equal(t1.args[1], 20000000n);
  assert.equal(d.escrow_opt_in.benefits.exchangeFeeBps, 60);
  assert.equal(d.risks_url, "https://ex.test/risks");
  for (const flag of [true, "true"]) {
    const e = await ex.hire({ listing_id: l.listing_id, buyer: buyer.address, escrow: flag });
    assert.equal(e.mode, "escrow");
    assert.equal(e.escrow_protected, true);
    assert.deepEqual(e.badges, ["escrow-protected"]);
    assert.equal(e.status, "awaiting-funding");
    assert.equal(e.quote.fee, "120000"); // 0.6%
    assert.equal(decodeFunctionData({ abi: ABI.escrow, data: e.payment.transactions[1].data }).functionName, "createAndFundFor");
  }
  const small = await makeListing(ex, now, "1000000");
  assert.equal((await ex.hire({ listing_id: small.listing_id, buyer: buyer.address, escrow: true })).quote.fee, "50000"); // min 0.05 kept
  const e2 = await ex.hire({ listing_id: l.listing_id, buyer: buyer.address, escrow: false });
  assert.equal(e2.mode, "direct");
});

test("optin: direct receipt is checked on chain; order view keeps mode and badge", async () => {
  const { ex, now } = mk({ escrowDefault: "optin", escrowFeeBps: 60, feeTxOk: (h) => h === "0x" + "a".repeat(64) });
  const l = await makeListing(ex, now, "20000000");
  const d = await ex.hire({ listing_id: l.listing_id, buyer: buyer.address });
  const r0 = await ex.recordFunding(d.order_id, { paymentTx: "0x" + "b".repeat(64) }).then((x) => ({ ok: x }), (e) => ({ e }));
  assert.ok(r0.e, JSON.stringify(r0.ok));
  assert.match(r0.e.message, /no USDC Transfer/);
  const v = await ex.recordFunding(d.order_id, { paymentTx: "0x" + "a".repeat(64), feeTx: "0x" + "a".repeat(64) });
  assert.equal(v.status, "paid");
  assert.equal(v.mode, "direct");
  assert.equal(v.escrow_protected, false);
  const e = await ex.hire({ listing_id: l.listing_id, buyer: buyer.address, escrow: true });
  const ev = await ex.getOrder(e.order_id);
  assert.equal(ev.escrow_protected, true);
  assert.deepEqual(ev.badges, ["escrow-protected"]);
});

test("ESCROW_DEFAULT: always on testnets, optin on base, env override", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = (env) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e", 'const n = await import("./lib/network.mjs"); console.log(JSON.stringify([n.ESCROW_DEFAULT, n.ESCROW_FEE_BPS]))'], { cwd: new URL("..", import.meta.url).pathname, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }).stdout.trim());
  assert.deepEqual(run({ AGENTCOIN_NETWORK: "base-sepolia" }), ["always", 60]);
  assert.deepEqual(run({ AGENTCOIN_NETWORK: "local" }), ["always", 60]);
  assert.deepEqual(run({ AGENTCOIN_NETWORK: "base" }), ["optin", 60]);
  assert.deepEqual(run({ AGENTCOIN_NETWORK: "base", AGENTCOIN_ESCROW_DEFAULT: "always", AGENTCOIN_ESCROW_FEE_BPS: "50" }), ["always", 50]);
});
