import { test } from "node:test";
import assert from "node:assert/strict";
import { jobCache, jobEvidence } from "../lib/protocol.mjs";

const c = { escrow: { address: "0x00000000000000000000000000000000000000E5", abi: [] }, d: { deployBlock: 100 } };
const spy = () => { const calls = []; const f = async (a, from, to) => { calls.push([from, to]); return []; }; f.calls = calls; return f; };

test("job cache: hint start, incremental scan, never rescans a terminal job", async () => {
  jobCache(":memory:");
  const g = spy();
  await jobEvidence(c, 14n, "Submitted", 5000n, 4000n, g);
  assert.deepEqual(g.calls, [[4000n, 5000n]]);
  await jobEvidence(c, 14n, "Submitted", 5100n, 4000n, g);
  assert.deepEqual(g.calls[1], [5001n, 5100n]);
  await jobEvidence(c, 14n, "Completed", 5200n, undefined, g);
  assert.equal(g.calls.length, 3);
  await jobEvidence(c, 14n, "Completed", 9000n, undefined, g);
  await jobEvidence(c, 14n, "Settled", 9999n, undefined, g);
  assert.equal(g.calls.length, 3, "terminal job is not rescanned");
});

test("job cache: no hint falls back to deploy block; hint below deploy is clamped", async () => {
  jobCache(":memory:");
  const g = spy();
  await jobEvidence(c, 1n, "Funded", 300n, undefined, g);
  await jobEvidence(c, 2n, "Funded", 300n, 5n, g);
  assert.deepEqual(g.calls, [[100n, 300n], [100n, 300n]]);
});

test("job cache: maxBlocks bounds a scan and the next call continues; terminal is not final until head is reached", async () => {
  jobCache(":memory:");
  const g = spy();
  const ev1 = await jobEvidence(c, 7n, "Funded", 5000n, 1000n, g, { maxBlocks: 250 });
  assert.deepEqual(g.calls, [[1000n, 1249n]]);
  assert.equal(ev1.length, 0);
  await jobEvidence(c, 7n, "Submitted", 5000n, 1000n, g, { maxBlocks: 250 });
  assert.deepEqual(g.calls[1], [1250n, 1499n]);
  await jobEvidence(c, 7n, "Completed", 5000n, undefined, g, { maxBlocks: 250 });
  assert.deepEqual(g.calls[2], [1500n, 1749n]);
  assert.equal(g.calls.length, 3, "Completed before reaching head is not treated as final");
  // finish the remaining range in larger steps
  await jobEvidence(c, 7n, "Completed", 5000n, undefined, g, { maxBlocks: 10000 });
  assert.deepEqual(g.calls[3], [1750n, 5000n]);
  await jobEvidence(c, 7n, "Completed", 8000n, undefined, g, { maxBlocks: 10000 });
  await jobEvidence(c, 7n, "Expired", 9000n, undefined, g, { maxBlocks: 10000 });
  assert.equal(g.calls.length, 4, "once a terminal state has been scanned to head, it is not rescanned");
});

test("job cache: maxBlocks 0 skips logs and still records state; a later call can scan", async () => {
  jobCache(":memory:");
  const g = spy();
  await jobEvidence(c, 3n, "Funded", 400n, 200n, g, { maxBlocks: 0 });
  assert.deepEqual(g.calls, []);
  await jobEvidence(c, 3n, "Submitted", 400n, 200n, g, { maxBlocks: 50 });
  assert.deepEqual(g.calls, [[200n, 249n]]);
});

test("job cache: explicit maxBlocks null keeps an unbounded scan (deploy to head when no hint)", async () => {
  jobCache(":memory:");
  const g = spy();
  await jobEvidence(c, 9n, "Expired", 400n, undefined, g, { maxBlocks: null });
  assert.deepEqual(g.calls, [[100n, 400n]]);
  await jobEvidence(c, 9n, "Expired", 800n, undefined, g, { maxBlocks: null });
  assert.equal(g.calls.length, 1, "Expired reached head is terminal");
});
