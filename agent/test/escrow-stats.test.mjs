// Offline tests for escrow-direct job stats (/v1/stats escrowDirect): mocked escrow reader, no RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EscrowJobIndex, knownInternalAddresses, INTERNAL_WALLETS, BUILDER_SELF_TESTS } from "../service/escrow-stats.mjs";

const DEPLOYER = "0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e";
const REF_EVAL = "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a";
const OUT_CLIENT = "0x319f000000000000000000000000000000000c7e";
const X402TOLL = "0x3E8B7382fd85dbad659B2887D88D020C05ca5f93";
const OTHER_CLIENT = "0x4444444444444444444444444444444444444444";
const lc = (a) => a.toLowerCase();
const ESCROWS = [{ label: "v0.5", address: "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D", primary: true }, { label: "v0.6", address: "0xd6E00d3419C16a3bEE1B8CC030A7062bf2014b2c" }];
const job = (client, evaluator, state = "Funded", slashBase = 2_000_000n) => ({ client, evaluator, state, slashBase });

function mkReader(data, calls = { n: 0 }) {
  return { calls, jobCount: async (e) => (data[e.label] ?? []).length, getJob: async (e, id) => { calls.n++; return data[e.label][id - 1]; } };
}
const internal = knownInternalAddresses({ internalAddrs: [DEPLOYER], knownEvaluators: [{ address: REF_EVAL, role: "reference", operator: "STOS Technologies LLC" }, { address: "0xB87b0d6AD3B17A8a1795d6640317c7997140d140", role: "independent", operator: "babyblueviper1" }] });

test("outside client + outside evaluator counted; known wallets excluded; v0.5 and v0.6 both included", async () => {
  const idx = new EscrowJobIndex({ escrows: ESCROWS, reader: mkReader({
    "v0.5": [job(DEPLOYER, REF_EVAL), job(OTHER_CLIENT, REF_EVAL, "Settled")],
    "v0.6": [job(DEPLOYER, REF_EVAL), job(DEPLOYER, REF_EVAL, "Open", 0n), job(OUT_CLIENT, X402TOLL, "Submitted")],
  }) });
  await idx.refresh();
  const s = idx.snapshot({ internal });
  assert.equal(s.jobsFundedTotal, 4); // the Open (unfunded) job is not counted
  assert.deepEqual(s.escrows.map((e) => [e.label, e.jobsFunded]), [["v0.5", 2], ["v0.6", 2]]);
  assert.equal(s.uniqueOutsideClientAddresses, 2);
  assert.deepEqual(s.outsideClients.map((c) => c.address), [lc(OUT_CLIENT), lc(OTHER_CLIENT)].sort());
  assert.equal(s.uniqueOutsideEvaluatorAddresses, 1);
  assert.deepEqual(s.outsideEvaluators, [lc(X402TOLL)]);
  assert.equal(s.uniqueInternalClientAddresses, 1);
  assert.equal(s.uniqueInternalEvaluatorAddresses, 1);
  assert.equal(s.freshness.source, "live");
  assert.equal(s.freshness.complete, true);
});

test("independent evaluators (not STOS) are not treated as internal", () => {
  assert.equal(internal.has(lc("0xB87b0d6AD3B17A8a1795d6640317c7997140d140")), false);
  assert.equal(internal.has(lc(REF_EVAL)), true);
});

test("jobs opened by /v1/notarize are deduplicated against escrow-direct counts; cancelled unfunded job ignored", async () => {
  const idx = new EscrowJobIndex({ escrows: ESCROWS, reader: mkReader({
    "v0.5": [job(OTHER_CLIENT, REF_EVAL), job(OUT_CLIENT, X402TOLL), job(OUT_CLIENT, X402TOLL, "Cancelled", 0n)],
    "v0.6": [],
  }) });
  await idx.refresh();
  const s = idx.snapshot({ internal, notarizeJobIds: ["1"], notarizePayers: [OTHER_CLIENT, DEPLOYER] });
  assert.equal(s.jobsFundedTotal, 2);
  assert.equal(s.jobsFundedViaNotarize, 1);
  assert.equal(s.jobsFundedEscrowDirect, 1);
  assert.deepEqual(s.outsideClients.map((c) => c.address), [lc(OUT_CLIENT)]); // job 1's client is the notarize job, not escrow-direct
  assert.equal(s.uniqueOutsideClientAddressesCombined, 2); // union of notarize payer and escrow-direct client, no double count
  // a notarize job id only dedupes on the primary (v0.5) escrow, never on v0.6
  const idx2 = new EscrowJobIndex({ escrows: ESCROWS, reader: mkReader({ "v0.5": [], "v0.6": [job(OUT_CLIENT, X402TOLL)] }) });
  await idx2.refresh();
  assert.equal(idx2.snapshot({ internal, notarizeJobIds: ["1"] }).jobsFundedEscrowDirect, 1);
});

test("terminal jobs are cached (not re-read), reads are bounded, and the cache persists across restarts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "escstats-"));
  const file = path.join(dir, "c.json");
  const calls = { n: 0 };
  const data = { "v0.5": [job(OTHER_CLIENT, REF_EVAL, "Settled"), job(OUT_CLIENT, X402TOLL, "Funded")], "v0.6": [job(OUT_CLIENT, X402TOLL, "Settled")] };
  let t = 0;
  const idx = new EscrowJobIndex({ escrows: ESCROWS, reader: mkReader(data, calls), file, ttlMs: 1000, now: () => t });
  await idx.refresh();
  assert.equal(calls.n, 3);
  t = 500;
  await idx.refresh(); // within ttl: no RPC at all
  assert.equal(calls.n, 3);
  t = 5000;
  await idx.refresh(); // only the non-terminal job is re-read
  assert.equal(calls.n, 4);
  const idx2 = new EscrowJobIndex({ escrows: ESCROWS, reader: mkReader(data, calls), file, now: () => t });
  assert.equal(idx2.snapshot({ internal }).jobsFundedTotal, 3);
  assert.equal(idx2.snapshot({ internal }).freshness.source, "cache");
  const small = new EscrowJobIndex({ escrows: ESCROWS, reader: mkReader(data, { n: 0 }), maxReads: 2 });
  await small.refresh();
  assert.equal(small.snapshot({ internal }).freshness.complete, false);
  assert.equal(small.snapshot({ internal }).jobsFundedTotal, 2);
});

test("RPC failure never throws and reports lastError while serving what is indexed", async () => {
  const reader = mkReader({ "v0.5": [job(OUT_CLIENT, X402TOLL)], "v0.6": [] });
  const idx = new EscrowJobIndex({ escrows: ESCROWS, reader, ttlMs: 0 });
  await idx.refresh();
  reader.jobCount = async () => { throw new Error("rpc down"); };
  await idx.refresh(true);
  const s = idx.snapshot({ internal });
  assert.equal(s.jobsFundedTotal, 1);
  assert.match(s.freshness.lastError, /rpc down/);
  assert.equal(s.freshness.complete, false);
});

test("HTTP: /v1/stats keeps existing fields and adds escrowDirect", async () => {
  const { createApp } = await import("../service/app.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "escstats-http-"));
  const idx = new EscrowJobIndex({ escrows: ESCROWS, reader: mkReader({ "v0.5": [], "v0.6": [job(OUT_CLIENT, X402TOLL)] }) });
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true, escrowStatsIndex: idx });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    const st = await (await fetch(`http://127.0.0.1:${app.server.address().port}/v1/stats`)).json();
    assert.ok("uniquePayerAddresses" in st && "uniqueOutsidePayerAddresses" in st && "counters" in st);
    assert.equal(st.escrowDirect.jobsFundedEscrowDirect, 1);
    assert.deepEqual(st.escrowDirect.outsideEvaluators, [lc(X402TOLL)]);
  } finally {
    await app.stop();
  }
});

test("labeled internal wallets (demo buyers 1-3, relayer, deployer-funded 0xbcc3) are excluded as clients", async () => {
  const known = knownInternalAddresses({});
  for (const w of INTERNAL_WALLETS) assert.equal(known.has(lc(w.address)), true, w.label);
  assert.deepEqual(INTERNAL_WALLETS.filter((w) => w.label.startsWith("stos-demo-buyer")).map((w) => w.address), ["0x600D4d4A0FeeF7877ACCb91351fFe2AA66CF18cb", "0x0b47dc4d735d37f38Cb74b74A52927DafdeDF388", "0xA6400ccE36C97Ad47f65047fB3DfCBc345c114bc"]);
  const idx = new EscrowJobIndex({ escrows: ESCROWS, reader: mkReader({ "v0.5": [job("0x600D4d4A0FeeF7877ACCb91351fFe2AA66CF18cb", REF_EVAL), job("0xbCc3df647a88aF9FF82Df31D74A38F26DDD90E3b", REF_EVAL), job(OTHER_CLIENT, REF_EVAL)], "v0.6": [] }) });
  await idx.refresh();
  const s = idx.snapshot({ internal: known });
  assert.equal(s.uniqueOutsideClientAddresses, 1);
  assert.equal(s.uniqueInternalClientAddresses, 2);
});

test("builder self-test client stays outside but is tagged and excluded from customer counts", async () => {
  assert.equal(BUILDER_SELF_TESTS[0].address, lc("0x319f6837c6e7b1a7f1703fd909cdd85416d48c7e"));
  const self = BUILDER_SELF_TESTS[0].address;
  const idx = new EscrowJobIndex({ escrows: ESCROWS, reader: mkReader({ "v0.5": [job(OTHER_CLIENT, REF_EVAL)], "v0.6": [job(self, X402TOLL), job(self, X402TOLL, "Settled")] }) });
  await idx.refresh();
  const s = idx.snapshot({ internal, notarizePayers: [self, OTHER_CLIENT] });
  assert.equal(s.uniqueOutsideClientAddresses, 2); // still counted as outside
  assert.equal(s.uniqueOutsideCustomerAddresses, 1);
  assert.equal(s.builderSelfTestClientAddresses, 1);
  assert.equal(s.uniqueOutsideClientAddressesCombined, 2);
  assert.equal(s.uniqueOutsideCustomerAddressesCombined, 1);
  const tagged = s.outsideClients.find((c) => c.address === self);
  assert.equal(tagged.builderSelfTest, true);
  assert.equal(tagged.label, "x402toll self-test");
  assert.equal(s.outsideClients.find((c) => c.address === lc(OTHER_CLIENT)).builderSelfTest, false);
});
