// Idempotent retry for on-chain writes (notary submit / verdict). Pure: all chain access is injected (see
// sendIdempotent in chain.mjs), so the policy is unit-tested against a mocked chain.
//
// Per attempt:
//   1. if a tx was already signed + broadcast: look up its receipt (mined -> done / revert -> stop)
//   2. (retries only) read the job on chain: already past the target state -> skip, never send
//   3. broadcast-but-unconfirmed tx still known to the node -> just wait again (never re-signed / resent)
//      tx unknown to the node (dropped / never accepted) -> rebroadcast the SAME signed tx (same nonce, same hash)
//      nothing signed yet -> simulate + sign once, broadcast
//   4. wait for the receipt (bounded)
// Only transient errors (HTTP / RPC transport / timeouts / rate limits) are retried; reverts and anything
// unrecognised are thrown at once. Attempts, total time and the on-chain deadline cap the loop.

export const DEFAULT_POLICY = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 15_000, maxTotalMs: 90_000, receiptTimeoutMs: 30_000, deadlineMarginS: 30 };

const TRANSIENT_NAMES = new Set([
  "HttpRequestError", "TimeoutError", "WebSocketRequestError", "SocketClosedError",
  "WaitForTransactionReceiptTimeoutError", "TransactionReceiptNotFoundError",
  "LimitExceededRpcError", "InternalRpcError", "ResourceUnavailableRpcError",
]);
const REVERT_NAMES = new Set(["ContractFunctionRevertedError", "ExecutionRevertedError", "RawContractError"]);
const TRANSIENT_MSG = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|timed? ?out|HTTP request failed|status: (429|5\d\d)|\b(429|502|503|504)\b|rate limit|too many requests|header not found|missing trie node/i;
const REVERT_MSG = /revert|WrongState|DeadlinePassed|Unauthorized|execution reverted/i;

function chainOf(e) {
  const out = [];
  for (let x = e, i = 0; x && i < 10; x = x.cause, i++) out.push(x);
  return out;
}

/** "revert" | "transient" | "fatal". Revert wins over transient when both appear in the cause chain. */
export function classifyError(e) {
  const chain = chainOf(e);
  if (chain.some((x) => x?.isRevert || REVERT_NAMES.has(x?.name))) return "revert";
  if (chain.some((x) => x?.isTransient || TRANSIENT_NAMES.has(x?.name))) return "transient";
  const msg = chain.map((x) => `${x?.shortMessage ?? ""} ${x?.message ?? ""} ${x?.details ?? ""}`).join(" | ");
  if (REVERT_MSG.test(msg)) return "revert";
  if (TRANSIENT_MSG.test(msg)) return "transient";
  return "fatal";
}

/** Exponential backoff with "equal jitter": delay in [d/2, d], d = min(max, base * 2^(n-1)). */
export function backoffMs(attempt, p = DEFAULT_POLICY, random = Math.random) {
  const d = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(d / 2 + random() * (d / 2));
}

export class RetryExhaustedError extends Error {
  constructor(label, attempts, last, hash) {
    super(`${label}: gave up after ${attempts} attempt(s)${hash ? ` (broadcast tx ${hash} unconfirmed)` : ""}: ${String(last?.shortMessage ?? last?.message ?? last).slice(0, 160)}`);
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.hash = hash ?? null;
    this.cause = last;
  }
}

const ALREADY_SENT = /already known|known transaction|nonce too low|replacement transaction underpriced|already imported/i;

/**
 * @param {object} ops injected chain access
 *   isDone(): Promise<{done:boolean, ours?:boolean, state?:string}>  on-chain job read
 *   prepare(): Promise<{hash, raw}>   simulate + sign once (consumes a nonce)
 *   broadcast(raw): Promise<hash>
 *   receipt(hash, timeoutMs): Promise<receipt|null>  null = not mined within timeout
 *   known(hash): Promise<boolean>     tx is pending or mined at the node
 *   resetNonce(): void                drop the local nonce cache (only when nothing of ours is in flight)
 * @param {object} o {label, deadline (unix s, optional), policy, log, sleep, now (ms), random}
 */
export async function retryTx(ops, o = {}) {
  const p = { ...DEFAULT_POLICY, ...(o.policy ?? {}) };
  const label = o.label ?? "tx";
  const log = o.log ?? (() => {});
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  const t0 = now();
  let tx = null; // {hash, raw}, signed exactly once
  let last = null;
  let n = 0;
  for (let attempt = 1; attempt <= p.maxAttempts; attempt++) {
    n = attempt;
    let step = "start";
    try {
      if (tx) {
        step = "receipt-check";
        const r0 = await ops.receipt(tx.hash, 0);
        if (r0) return finish(r0, attempt);
      }
      if (attempt > 1) {
        step = "state-check";
        const d = await ops.isDone();
        if (d.done) {
          log({ label, attempt, outcome: "skipped", state: d.state, ours: !!d.ours, hash: tx?.hash ?? null });
          return { skipped: true, ours: !!d.ours, state: d.state, hash: tx?.hash ?? null, receipt: null, attempts: attempt };
        }
      }
      let mustSend = true;
      if (tx) {
        step = "known-check";
        if (await ops.known(tx.hash)) mustSend = false;
      } else {
        step = "prepare";
        tx = await ops.prepare();
      }
      if (mustSend) {
        step = "broadcast";
        try {
          await ops.broadcast(tx.raw);
        } catch (e) {
          if (!ALREADY_SENT.test(`${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.details ?? ""}`)) throw e;
        }
      }
      step = "wait";
      const r = await ops.receipt(tx.hash, p.receiptTimeoutMs);
      if (!r) throw Object.assign(new Error(`receipt not seen within ${p.receiptTimeoutMs} ms`), { isTransient: true });
      return finish(r, attempt);
    } catch (e) {
      const kind = e?.name === "RetryRevert" ? "revert" : classifyError(e);
      last = e;
      log({ label, attempt, step, outcome: "error", kind, hash: tx?.hash ?? null, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) });
      if (kind !== "transient") {
        if (!tx) ops.resetNonce?.(); // nothing signed: the local nonce cache must not keep a gap
        throw e;
      }
      if (attempt >= p.maxAttempts) break;
      const delay = backoffMs(attempt, p, random);
      if (now() - t0 + delay > p.maxTotalMs) {
        log({ label, attempt, outcome: "stop", reason: "maxTotalMs" });
        break;
      }
      if (o.deadline && Math.floor((now() + delay) / 1000) >= o.deadline - p.deadlineMarginS) {
        log({ label, attempt, outcome: "stop", reason: "deadline" });
        break;
      }
      log({ label, attempt, outcome: "retry", delayMs: delay });
      await sleep(delay);
    }
  }
  // Free the nonce only when nothing of ours can still land: never signed, or the node says it does not know it.
  let inFlight = !!tx;
  if (tx) inFlight = await ops.known(tx.hash).catch(() => true);
  if (!inFlight) ops.resetNonce?.();
  log({ label, attempts: n, outcome: "gave-up", hash: tx?.hash ?? null, inFlight });
  throw new RetryExhaustedError(label, n, last, inFlight ? tx.hash : null);
  function finish(r, attempt) {
    if (r.status !== "success") {
      const err = Object.assign(new Error(`${label} reverted: ${tx.hash}`), { name: "RetryRevert", isRevert: true });
      log({ label, attempt, outcome: "reverted", hash: tx.hash });
      throw err;
    }
    log({ label, attempt, outcome: "mined", hash: tx.hash });
    return { skipped: false, ours: true, hash: tx.hash, receipt: r, attempts: attempt };
  }
}
