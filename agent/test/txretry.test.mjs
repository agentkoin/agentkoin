// Idempotent notary tx retry (lib/txretry.mjs) against a mocked chain: no network, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpRequestError, TimeoutError, ContractFunctionRevertedError, ContractFunctionExecutionError, InsufficientFundsError } from "viem";
import { retryTx, classifyError, backoffMs, RetryExhaustedError, DEFAULT_POLICY } from "../lib/txretry.mjs";

const httpErr = () => new HttpRequestError({ url: "https://rpc.example/", details: "fetch failed" });
const revertErr = () => new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: [], functionName: "submit", message: "WrongState(3)" }), { abi: [], functionName: "submit", contractAddress: "0x0000000000000000000000000000000000000001", args: [] });

/** Mocked chain: one job, a mempool and mined receipts. `script` injects failures per op call. */
function mockChain({ state = "Funded", script = {}, mineAfterPolls = 0 } = {}) {
  const m = { state, signed: 0, broadcasts: [], mempool: new Set(), mined: new Map(), calls: { prepare: 0, broadcast: 0, receipt: 0, known: 0, isDone: 0 }, resets: 0, polls: 0 };
  const fail = (op) => {
    const f = script[op]?.shift?.();
    if (f) throw f();
  };
  m.ops = {
    async isDone() {
      m.calls.isDone++;
      fail("isDone");
      return { done: m.state !== "Funded", state: m.state, ours: m.state === "Submitted" && m.ourHashMined };
    },
    async prepare() {
      m.calls.prepare++;
      fail("prepare");
      m.signed++;
      return { hash: `0xh${m.signed}`, raw: `0xraw${m.signed}` };
    },
    async broadcast(raw) {
      m.calls.broadcast++;
      fail("broadcast");
      m.broadcasts.push(raw);
      m.mempool.add(raw.replace("raw", "h"));
    },
    async receipt(hash, timeoutMs) {
      m.calls.receipt++;
      if (timeoutMs) fail("receipt");
      if (timeoutMs && m.mempool.has(hash) && ++m.polls > mineAfterPolls) {
        m.mempool.delete(hash);
        m.mined.set(hash, { status: "success", gasUsed: 70000n, effectiveGasPrice: 1n, transactionHash: hash });
        m.state = "Submitted";
        m.ourHashMined = true;
      }
      return m.mined.get(hash) ?? null;
    },
    async known(hash) {
      m.calls.known++;
      fail("known");
      return m.mempool.has(hash) || m.mined.has(hash);
    },
    resetNonce: () => m.resets++,
  };
  return m;
}
const fast = { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 4, maxTotalMs: 10_000, receiptTimeoutMs: 5, deadlineMarginS: 30 };
const run = (m, o = {}) => {
  const log = [];
  const sleeps = [];
  return { log, sleeps, p: retryTx(m.ops, { label: "submit job 1", policy: fast, log: (e) => log.push(e), sleep: async (ms) => sleeps.push(ms), ...o }) };
};

test("classifies viem errors: HTTP/timeout transient, revert not, unknown fatal", () => {
  assert.equal(classifyError(httpErr()), "transient");
  assert.equal(classifyError(new TimeoutError({ body: {}, url: "https://rpc.example/" })), "transient");
  assert.equal(classifyError(revertErr()), "revert");
  assert.equal(classifyError(new Error("execution reverted: DeadlinePassed()")), "revert");
  assert.equal(classifyError(new InsufficientFundsError()), "fatal");
  assert.equal(classifyError(new Error("Unexpected")), "fatal");
  for (let n = 1; n <= 8; n++) {
    const d = Math.min(DEFAULT_POLICY.maxDelayMs, DEFAULT_POLICY.baseDelayMs * 2 ** (n - 1));
    assert.equal(backoffMs(n, DEFAULT_POLICY, () => 0), d / 2);
    assert.equal(backoffMs(n, DEFAULT_POLICY, () => 1), d);
  }
});

test("transient broadcast error, then success: signs once, state re-read before retry, attempts logged", async () => {
  const m = mockChain({ script: { broadcast: [httpErr] } });
  const r = run(m);
  const out = await r.p;
  assert.equal(out.skipped, false);
  assert.equal(out.hash, "0xh1");
  assert.equal(out.attempts, 2);
  assert.equal(m.signed, 1, "signed exactly once");
  assert.deepEqual(m.broadcasts, ["0xraw1"], "only the identical signed tx was broadcast");
  assert.equal(m.calls.isDone, 1, "job state read before the retry");
  assert.equal(r.sleeps.length, 1);
  assert.deepEqual(r.log.map((e) => e.outcome), ["error", "retry", "mined"]);
  assert.equal(r.log[0].kind, "transient");
});

test("transient error before signing, then success", async () => {
  const m = mockChain({ script: { prepare: [httpErr, httpErr] } });
  const out = await run(m).p;
  assert.equal(out.attempts, 3);
  assert.equal(m.signed, 1);
  assert.equal(m.broadcasts.length, 1);
});

test("job already Submitted at retry time: skipped, nothing (re)sent", async () => {
  const m = mockChain({ script: { prepare: [httpErr] } });
  m.ops.prepare = new Proxy(m.ops.prepare, {
    apply(t, self, a) {
      m.state = "Submitted"; // someone (an earlier process) submitted while we backed off
      m.ourHashMined = true;
      return Reflect.apply(t, self, a);
    },
  });
  const r = run(m);
  const out = await r.p;
  assert.equal(out.skipped, true);
  assert.equal(out.ours, true);
  assert.equal(out.state, "Submitted");
  assert.equal(m.broadcasts.length, 0, "no broadcast after the job was seen Submitted");
  assert.equal(r.log.at(-1).outcome, "skipped");
});

test("job past Submitted (e.g. Expired) at retry: skipped, not ours", async () => {
  const m = mockChain({ script: { broadcast: [httpErr] } });
  m.ops.broadcast = new Proxy(m.ops.broadcast, { apply(t, s, a) { m.state = "Expired"; return Reflect.apply(t, s, a); } });
  const out = await run(m).p;
  assert.equal(out.skipped, true);
  assert.equal(out.ours, false);
  assert.equal(out.state, "Expired");
});

test("revert is not retried and frees the unused nonce", async () => {
  const m = mockChain({ script: { prepare: [revertErr] } });
  const r = run(m);
  await assert.rejects(r.p, (e) => classifyError(e) === "revert");
  assert.equal(m.calls.prepare, 1);
  assert.equal(r.sleeps.length, 0);
  assert.equal(m.resets, 1);
  assert.equal(r.log.length, 1);
  assert.equal(r.log[0].kind, "revert");
});

test("mined-but-reverted receipt is not retried", async () => {
  const m = mockChain();
  m.ops.receipt = async (h, t) => (t ? { status: "reverted", transactionHash: h } : null);
  const r = run(m);
  await assert.rejects(r.p, /reverted/);
  assert.equal(m.broadcasts.length, 1);
  assert.equal(r.sleeps.length, 0);
});

test("non-transient unknown error (insufficient funds) is not retried", async () => {
  const m = mockChain({ script: { broadcast: [() => new InsufficientFundsError()] } });
  const r = run(m);
  await assert.rejects(r.p, (e) => e instanceof InsufficientFundsError);
  assert.equal(r.sleeps.length, 0);
  assert.equal(m.resets, 0, "signed tx exists: nonce cache untouched");
});

test("attempts hit the cap: RetryExhaustedError after maxAttempts, nonce freed when nothing is in flight", async () => {
  const m = mockChain({ script: { broadcast: Array(10).fill(httpErr), known: [] } });
  const r = run(m);
  await assert.rejects(r.p, (e) => e instanceof RetryExhaustedError && e.attempts === 5 && e.hash === null);
  assert.equal(m.calls.broadcast, 5);
  assert.equal(m.signed, 1);
  assert.equal(r.sleeps.length, 4);
  assert.ok(r.sleeps.every((ms, i) => ms >= Math.min(fast.maxDelayMs, fast.baseDelayMs * 2 ** i) / 2 && ms <= Math.min(fast.maxDelayMs, fast.baseDelayMs * 2 ** i)));
  assert.equal(m.resets, 1);
  assert.equal(r.log.at(-1).outcome, "gave-up");
});

test("total-time cap and job deadline stop retries early", async () => {
  let t = 0;
  const m1 = mockChain({ script: { prepare: Array(10).fill(httpErr) } });
  const r1 = run(m1, { now: () => t, sleep: async (ms) => (t += ms), policy: { ...fast, baseDelayMs: 400, maxDelayMs: 400, maxTotalMs: 700 } });
  await assert.rejects(r1.p, RetryExhaustedError);
  assert.ok(m1.calls.prepare < 5);
  assert.ok(r1.log.some((e) => e.reason === "maxTotalMs"));

  const m2 = mockChain({ script: { prepare: Array(10).fill(httpErr) } });
  const r2 = run(m2, { now: () => 1_000_000_000, deadline: 1_000_000 + 20 }); // inside the 30 s margin
  await assert.rejects(r2.p, RetryExhaustedError);
  assert.equal(m2.calls.prepare, 1);
  assert.ok(r2.log.some((e) => e.reason === "deadline"));
});

test("broadcast but unconfirmed: never re-signed or resent while the node knows it; mined later", async () => {
  const m = mockChain({ script: { receipt: [httpErr] }, mineAfterPolls: 1 });
  const r = run(m);
  const out = await r.p;
  assert.equal(out.hash, "0xh1");
  assert.equal(m.signed, 1);
  assert.equal(m.calls.broadcast, 1, "pending tx was not resent");
  assert.ok(m.calls.known >= 1);
});

test("broadcast tx dropped from the mempool: rebroadcast byte-identical (same nonce/hash)", async () => {
  const m = mockChain({ script: { receipt: [httpErr] } });
  m.ops.broadcast = new Proxy(m.ops.broadcast, {
    apply(t, s, a) {
      const p = Reflect.apply(t, s, a);
      if (m.calls.broadcast === 1) p.then(() => m.mempool.clear()); // dropped after the first send
      return p;
    },
  });
  const out = await run(m).p;
  assert.equal(out.hash, "0xh1");
  assert.equal(m.signed, 1);
  assert.deepEqual(m.broadcasts, ["0xraw1", "0xraw1"]);
});

test("cap reached with a tx still pending: error carries the hash, nonce not freed", async () => {
  const m = mockChain({ mineAfterPolls: 99 });
  const r = run(m, { policy: { ...fast, maxAttempts: 3 } });
  await assert.rejects(r.p, (e) => e instanceof RetryExhaustedError && e.hash === "0xh1");
  assert.equal(m.calls.broadcast, 1);
  assert.equal(m.resets, 0);
});
