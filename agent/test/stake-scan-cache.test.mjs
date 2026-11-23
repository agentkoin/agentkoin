// Cold-start fix: persisted stake-scan cache for GET /v1/evaluators (offline; the slow RPC is a mocked stakeScanner).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { loadStakeScanCache, saveStakeScanCache } from "../lib/stake-scan-cache.mjs";
import { foldStakeEvents } from "../lib/evaluator-onboarding.mjs";
import { createApp } from "../service/app.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(path.join(HERE, "fixtures", "evaluators-base-sepolia.json"), "utf8"));
const snap = (stake, active) => ({ active, stake: String(stake), unbondingEndsAt: "0", slashedTotal: "0", openJobs: 0 });
const NEWCOMER = "0x3E8B7382fd85dbad659B2887D88D020C05ca5f93";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = () => foldStakeEvents(new Map(), FX.events);
const registryReader = { minStake: async () => FX.minStake, snapshot: async (a) => FX.snapshots[getAddress(a)] ?? snap(0, false) };

function seed(dir, scannedAtMs = Date.now() - 5 * 60_000) {
  const file = path.join(dir, "stake-scan-cache.json");
  assert.ok(saveStakeScanCache(file, { scannedAtMs, cursor: 60000000n, stakers: [...events().keys()], events: events(), rep: new Map() }));
  return file;
}
async function boot(dir, extra = {}) {
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true, registryReader, activeEvaluators: async () => [], caps: { freePerIpPerHour: 100 }, ...extra });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}
const get = async (base) => {
  const t = Date.now();
  const r = await fetch(base + "/v1/evaluators");
  return { status: r.status, body: await r.json(), ms: Date.now() - t };
};

test("cache file: atomic write round-trips, leaves no temp file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssc-"));
  const file = seed(dir, 1795100000000);
  assert.deepEqual(readdirSync(dir), ["stake-scan-cache.json"]);
  const c = loadStakeScanCache(file);
  assert.equal(c.scannedAtMs, 1795100000000);
  assert.equal(c.cursor, "60000000");
  assert.equal(c.events.size, events().size);
});

test("corrupt / wrong-version / missing cache file is ignored", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssc-"));
  const file = path.join(dir, "stake-scan-cache.json");
  assert.equal(loadStakeScanCache(file), null);
  for (const junk of ["{not json", "", "null", '{"version":99}', '{"version":1,"scannedAt":"nope","events":[],"stakers":[],"rep":[]}', '{"version":1,"scannedAt":"2026-11-19T00:00:00Z","events":[["0x1",{"block":5}]],"stakers":[],"rep":[]}']) {
    writeFileSync(file, junk);
    assert.equal(loadStakeScanCache(file), null, junk);
  }
});

test("corrupt cache at boot: service starts, falls back to the live scan (source live)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssc-"));
  writeFileSync(path.join(dir, "stake-scan-cache.json"), "{corrupt");
  let scans = 0;
  const { app, base } = await boot(dir, { stakeScanner: async (s) => { scans++; foldStakeEvents(s.stakeEvents, FX.events); for (const a of s.stakeEvents.keys()) s.stakers.add(a); } });
  try {
    const r = await get(base);
    assert.equal(r.status, 200);
    assert.equal(r.body.source, "live");
    assert.equal(r.body.stale, false);
    assert.equal(scans, 1);
    assert.equal(r.body.all.find((x) => x.address === NEWCOMER).status, "active");
    assert.ok(loadStakeScanCache(path.join(dir, "stake-scan-cache.json")), "a good cache replaces the corrupt one");
  } finally { await app.stop(); }
});

test("cold boot with a cache answers < 1 s while the (mocked) RPC takes 3 s; background refresh then updates the cache", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssc-"));
  const file = seed(dir, Date.now() - 5 * 60_000);
  const before = loadStakeScanCache(file).scannedAtMs;
  let scans = 0;
  const { app, base } = await boot(dir, { stakeScanner: async (s) => { scans++; await sleep(3000); s.stakeEvents.get(NEWCOMER).count = 99; } });
  try {
    const t0 = Date.now();
    const r = await get(base);
    const ms = Date.now() - t0;
    console.log(`measured cold /v1/evaluators with cache (mock scan 3000 ms): ${ms} ms`);
    assert.ok(ms < 1000, `cold response took ${ms} ms`);
    assert.equal(r.status, 200);
    assert.equal(r.body.source, "cache");
    assert.equal(r.body.stale, true); // 5 min old > 60 s TTL
    assert.equal(r.body.scannedAt, new Date(before).toISOString());
    assert.equal(r.body.all.find((x) => x.address === NEWCOMER).status, "active"); // existing shape intact
    assert.equal(scans, 1); // boot kicked off the refresh
    await sleep(3300); // refresh completes
    const after = loadStakeScanCache(file);
    assert.ok(after.scannedAtMs > before, "cache file rewritten by the background refresh");
    assert.equal(after.events.get(NEWCOMER).count, 99);
    const r2 = await get(base);
    assert.equal(r2.body.source, "live");
    assert.equal(r2.body.stale, false);
    assert.ok(r2.ms < 1000);
  } finally { await app.stop(); }
});

test("single-flight: concurrent requests and boot share one refresh", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssc-"));
  seed(dir);
  let scans = 0;
  const { app, base } = await boot(dir, { stakeScanner: async () => { scans++; await sleep(800); } });
  try {
    await Promise.all(Array.from({ length: 8 }, () => get(base)));
    await sleep(1000);
    assert.equal(scans, 1);
  } finally { await app.stop(); }
});

test("refresh failure keeps serving the cache with stale: true", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssc-"));
  const file = seed(dir, Date.now() - 1000); // fresh by TTL, so only the failure makes it stale
  const raw = readFileSync(file, "utf8");
  const { app, base } = await boot(dir, { stakeScanTtlMs: 60_000, stakeScanner: async () => { throw new Error("rpc down"); } });
  try {
    await sleep(100); // boot refresh has failed
    const r = await get(base);
    assert.equal(r.status, 200);
    assert.equal(r.body.source, "cache");
    assert.equal(r.body.stale, true);
    assert.equal(r.body.all.find((x) => x.address === NEWCOMER).status, "active");
    assert.equal(readFileSync(file, "utf8"), raw, "failed refresh does not overwrite the cache");
  } finally { await app.stop(); }
});

test("no cache: old behaviour (first request awaits the live scan), then persists", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssc-"));
  const { app, base } = await boot(dir, { stakeScanner: async (s) => { await sleep(300); foldStakeEvents(s.stakeEvents, FX.events); } });
  try {
    const r = await get(base);
    assert.equal(r.status, 200);
    assert.ok(r.ms >= 250);
    assert.equal(r.body.source, "live");
    assert.ok(existsSync(path.join(dir, "stake-scan-cache.json")));
  } finally { await app.stop(); }
});
