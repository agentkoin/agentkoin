// x402 #4324: a freshly staked evaluator must appear in GET /v1/evaluators `list`, not only in `all`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { listNeedsFreshScan, evaluatorListCacheValid } from "../lib/evaluators.mjs";

test("a scan older than the TTL must be refreshed before the list is built", () => {
  assert.equal(listNeedsFreshScan({ indexReady: true, scanAtMs: 0, ttlMs: 60_000, now: 61_000 }), true);
  assert.equal(listNeedsFreshScan({ indexReady: true, scanAtMs: 0, ttlMs: 60_000, now: 30_000 }), false);
  assert.equal(listNeedsFreshScan({ indexReady: false, scanAtMs: 0, ttlMs: 60_000, now: 99_000 }), false);
});

test("a list built before a refresh finished is not reused (generation changed)", () => {
  const cached = { at: 1000, generation: 3, v: [] };
  assert.equal(evaluatorListCacheValid({ indexReady: true, cached, now: 2000, generation: 3 }), true);
  assert.equal(evaluatorListCacheValid({ indexReady: true, cached, now: 2000, generation: 4 }), false);
  assert.equal(evaluatorListCacheValid({ indexReady: true, cached, now: 62_000, generation: 3 }), false);
  assert.equal(evaluatorListCacheValid({ indexReady: false, cached, now: 2000, generation: 3 }), false);
  assert.equal(evaluatorListCacheValid({ indexReady: true, cached: null, now: 2000, generation: 3 }), false);
});
