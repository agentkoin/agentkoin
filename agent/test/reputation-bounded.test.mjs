// verify {evaluator} / get_evaluator_reputation must not hang on a slow log rescan: bounded wait, cache, clear error.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluatorReputation, ReputationPendingError, _reputationCache } from "../lib/indexer.mjs";

const EV = "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a";

test("evaluatorReputation: slow scan -> clear pending error within the timeout, then cached answer; one scan in flight", async () => {
  _reputationCache.clear();
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const scan = async (e) => { calls++; await gate; return { evaluator: e, counts: { jobsAssigned: 1 } }; };
  const t0 = Date.now();
  await assert.rejects(evaluatorReputation(EV, { timeoutMs: 50, scan }), (e) => e instanceof ReputationPendingError && e.code === "reputation_index_pending" && /retry/.test(e.message));
  assert.ok(Date.now() - t0 < 1000, "bounded");
  await assert.rejects(evaluatorReputation(EV, { timeoutMs: 20, scan }), ReputationPendingError);
  assert.equal(calls, 1, "the background scan is shared, not restarted");
  release();
  await new Promise((r) => setTimeout(r, 10));
  const r = await evaluatorReputation(EV, { timeoutMs: 20, scan });
  assert.equal(r.counts.jobsAssigned, 1);
  assert.equal(calls, 1, "served from cache");
  // stale: served immediately with a cache note while one refresh runs
  let n = 0;
  const later = () => Date.now() + 3_600_000;
  const r2 = await evaluatorReputation(EV, { timeoutMs: 20, ttlMs: 1000, now: later, scan: async (e) => { n++; return { evaluator: e, counts: { jobsAssigned: 2 } }; } });
  assert.equal(r2.cache.stale, true);
  assert.equal(r2.counts.jobsAssigned, 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(n, 1);
});

test("evaluatorReputation: fast scan answers directly; scan errors surface", async () => {
  _reputationCache.clear();
  assert.equal((await evaluatorReputation(EV, { scan: async () => ({ ok: 1 }) })).ok, 1);
  _reputationCache.clear();
  await assert.rejects(evaluatorReputation(EV, { scan: async () => { throw new Error("rpc down"); } }), /rpc down/);
});
