// Persisted stake-scan cache for GET /v1/evaluators (cold-start fix, v0.5.26 candidate).
// The last completed on-chain stake scan (Staked-event index + per-evaluator track records) is written atomically
// to <stateDir>/stake-scan-cache.json and loaded at boot, so the first request after a restart is served from the
// cache while a single-flight background refresh runs. Pure file/state logic; no chain access here.
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

export const STAKE_SCAN_CACHE_VERSION = 1;
export const DEFAULT_STAKE_SCAN_TTL_MS = 60_000;

/** Load the cache; returns null for a missing, unreadable, corrupt or wrong-version file (never throws). */
export function loadStakeScanCache(file) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!j || j.version !== STAKE_SCAN_CACHE_VERSION) return null;
    const at = Date.parse(j.scannedAt);
    if (!Number.isFinite(at) || !Array.isArray(j.events) || !Array.isArray(j.stakers) || !Array.isArray(j.rep)) return null;
    for (const [a, e] of j.events) if (typeof a !== "string" || !e || typeof e.block !== "string") return null;
    return { scannedAtMs: at, cursor: j.cursor ?? null, stakers: j.stakers, events: new Map(j.events), rep: new Map(j.rep) };
  } catch {
    return null;
  }
}

/** Atomic write: temp file in the same dir, then rename. Returns true on success (a failed save never breaks serving). */
export function saveStakeScanCache(file, { scannedAtMs, cursor, stakers, events, rep }) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const doc = { version: STAKE_SCAN_CACHE_VERSION, scannedAt: new Date(scannedAtMs).toISOString(), cursor: cursor == null ? null : String(cursor), stakers: [...stakers], events: [...events], rep: [...rep] };
    writeFileSync(tmp, JSON.stringify(doc));
    renameSync(tmp, file);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}

/** Freshness fields added to the /v1/evaluators response. */
export function freshness({ scannedAtMs, ttlMs, now, lastRefreshFailed, source }) {
  const age = scannedAtMs ? now - scannedAtMs : Infinity;
  return { scannedAt: scannedAtMs ? new Date(scannedAtMs).toISOString() : null, stale: !!lastRefreshFailed || age > ttlMs, source };
}
