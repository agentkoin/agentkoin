// Cold-start trackRecord: the 402 listing served null for every evaluator after a deploy
// because startLoop waited loopMs to index, then cached that empty snapshot for 60s.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateTrackRecords,
  evaluatorRow,
  shouldAwaitJobIndex,
  shouldCacheEvaluatorList,
} from "../lib/evaluators.mjs";

const REF = "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a";
const BBV = "0xB87b0d6AD3B17A8a1795d6640317c7997140d140";
const links = { evaluators: "https://x/v1/evaluators", notarize: "https://x/v1/notarize" };
const snap = { active: true, stake: "2000000", availableExposure: "9000000", openJobs: 1, slashedTotal: "0" };

test("an evaluator with no jobs is absent from the map, so the row's trackRecord is null", () => {
  const rep = accumulateTrackRecords([], 28);
  assert.equal(rep.size, 0);
  const row = evaluatorRow(
    { address: BBV, role: "independent", label: "bbv" },
    { snapshot: snap, exactPayTo: REF, trackRecord: rep.get(BBV), links, isDefault: false },
  );
  assert.equal(row.trackRecord, null);
});

test("a funded open job is counted; other evaluators stay absent", () => {
  const rep = accumulateTrackRecords(
    [
      {
        evaluator: BBV,
        state: "Funded",
        outcome: "None",
        submittedAt: 0,
        verdictAt: 0,
        instant: false,
      },
    ],
    29,
  );
  assert.equal(rep.has(REF), false);
  assert.deepEqual(rep.get(BBV), {
    jobsAssigned: 1,
    verdicts: 0,
    verdictsByOutcome: { Complete: 0, Reject: 0, Partial: 0 },
    settled: 0,
    disputed: 0,
    missedVerdicts: 0,
    refundedBeforeSubmission: 0,
    open: 1,
    indexedJobs: 29,
  });
  const row = evaluatorRow(
    { address: BBV, role: "independent", label: "bbv" },
    { snapshot: snap, exactPayTo: REF, trackRecord: rep.get(BBV), links, isDefault: false },
  );
  assert.equal(row.trackRecord.jobsAssigned, 1);
  assert.equal(row.trackRecord.open, 1);
});

test("do not cache or hit the 60s evaluator list until the first job index succeeds", () => {
  assert.equal(shouldCacheEvaluatorList(false), false);
  assert.equal(shouldCacheEvaluatorList(true), true);
});

test("await an in-flight first index; do not wait once ready or when nothing is in flight", () => {
  const inflight = Promise.resolve();
  assert.equal(shouldAwaitJobIndex(false, inflight), true);
  assert.equal(shouldAwaitJobIndex(false, null), false);
  assert.equal(shouldAwaitJobIndex(true, inflight), false);
  assert.equal(shouldAwaitJobIndex(true, null), false);
});
