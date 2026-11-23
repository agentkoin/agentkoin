// Evaluator onboarding v1 (daily spec 2026-11-19): signed profiles, complete listing, queue-only canary, judge-kit profile.
// Offline: registry state comes from test/fixtures/evaluators-base-sepolia.json (recorded read-only from Base Sepolia).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import {
  PROFILE_TYPE, CANARY_TYPE, signedDigest, verifySignedRequest, handleProfile, handleCanary, ProfileStore, CanaryQueue,
  stakeStatus, topUpPlan, fullRow, foldStakeEvents, onboardingBlock,
} from "../lib/evaluator-onboarding.mjs";
import { createApp } from "../service/app.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(path.join(HERE, "fixtures", "evaluators-base-sepolia.json"), "utf8"));
const REG = FX.registry;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NEWCOMER = "0x3E8B7382fd85dbad659B2887D88D020C05ca5f93";
const BBV = "0xB87b0d6AD3B17A8a1795d6640317c7997140d140";
const NOW = 1795100000;
const links = { evaluators: "https://x/v1/evaluators", evaluatorProfile: "https://x/v1/evaluators/profile", evaluatorCanary: "https://x/v1/evaluators/canary", evaluatorDocs: "https://x/EVALUATORS.md", judgeKit: "https://x/EVALUATORS.md#3", notarize: "https://x/v1/notarize" };

async function signed(key, doc) {
  const a = privateKeyToAccount(key);
  const d = { chainId: 84532, registry: REG, address: a.address, issuedAt: NOW, ...doc };
  return { ...d, signature: await a.signMessage({ message: { raw: signedDigest(d) } }) };
}
const snap = (stake, active) => ({ active, stake: String(stake), unbondingEndsAt: "0", slashedTotal: "0", openJobs: 0 });
function deps(dir, statusByAddr) {
  return {
    chainId: 84532,
    registry: REG,
    now: () => NOW,
    status: async (a) => statusByAddr[getAddress(a)] ?? { everStaked: false, stake: "0", minStake: "2000000", status: "unstaked", shortfall: "2000000" },
    profiles: new ProfileStore(path.join(dir, "profiles.json")),
    queue: new CanaryQueue(path.join(dir, "canary-queue.jsonl")),
  };
}
const ACTIVE = { everStaked: true, stake: "2000000", minStake: "2000000", status: "active", shortfall: "0" };
const BELOW = { everStaked: true, stake: "1800000", minStake: "2000000", status: "below_min_stake", shortfall: "200000" };

test("profile: valid EIP-191 signature from an active staker is stored (201), digest = keccak256(JCS(body - signature))", async () => {
  const k = generatePrivateKey();
  const a = privateKeyToAccount(k).address;
  const d = deps(mkdtempSync(path.join(tmpdir(), "evp-")), { [a]: ACTIVE });
  const body = await signed(k, { type: PROFILE_TYPE, name: "judge-1", url: "https://judge.example", contact: "x: @judge", criteriaKinds: ["http-200", "body-sha256"] });
  const r = await handleProfile(body, d);
  assert.equal(r.ok, true);
  assert.equal(r.status, 201);
  assert.equal(r.body.result, "stored");
  assert.equal(r.body.digest, signedDigest(body));
  assert.equal(d.profiles.get(a).name, "judge-1");
  assert.equal(d.profiles.get(a).signer, a);
});

test("profile: wrong signer, stale issuedAt, future issuedAt, never-staked and unstaked addresses are rejected", async () => {
  const k = generatePrivateKey();
  const other = generatePrivateKey();
  const a = privateKeyToAccount(k).address;
  const dir = mkdtempSync(path.join(tmpdir(), "evp-"));
  const d = deps(dir, { [a]: ACTIVE });
  // signed by `other` but claiming address a
  const forged = await signed(other, { type: PROFILE_TYPE, name: "x", address: a });
  const r1 = await handleProfile(forged, d);
  assert.equal(r1.status, 401);
  assert.match(r1.error, /does not recover/);
  const stale = await signed(k, { type: PROFILE_TYPE, name: "x", issuedAt: NOW - 601 });
  assert.equal((await handleProfile(stale, d)).status, 401);
  const edge = await signed(k, { type: PROFILE_TYPE, name: "x", issuedAt: NOW - 600 });
  assert.equal((await handleProfile(edge, d)).status, 201); // exactly 10 min old is accepted
  const future = await signed(k, { type: PROFILE_TYPE, name: "x", issuedAt: NOW + 121 });
  assert.equal((await handleProfile(future, d)).status, 401);
  const stranger = generatePrivateKey();
  const r4 = await handleProfile(await signed(stranger, { type: PROFILE_TYPE, name: "x" }), d);
  assert.equal(r4.status, 403);
  assert.match(r4.error, /never staked/);
  const gone = generatePrivateKey();
  const dg = deps(dir, { [privateKeyToAccount(gone).address]: { everStaked: true, stake: "0", minStake: "2000000", status: "unstaked", shortfall: "2000000" } });
  assert.equal((await handleProfile(await signed(gone, { type: PROFILE_TYPE, name: "x" }), dg)).status, 403);
  // tampering after signing breaks the signature
  const ok = await signed(k, { type: PROFILE_TYPE, name: "x", issuedAt: NOW - 1 });
  assert.equal((await handleProfile({ ...ok, name: "y" }, d)).status, 401);
  // a canary request signature is not a profile signature (type is signed)
  const can = await signed(k, { type: CANARY_TYPE });
  assert.equal((await handleProfile({ ...can, type: PROFILE_TYPE, name: "x" }, d)).status, 401);
});

test("profile: below_min_stake stakers may sign; overwrite only by the same signer with a newer issuedAt", async () => {
  const k = generatePrivateKey();
  const a = privateKeyToAccount(k).address;
  const d = deps(mkdtempSync(path.join(tmpdir(), "evp-")), { [a]: BELOW });
  assert.equal((await handleProfile(await signed(k, { type: PROFILE_TYPE, name: "v1", issuedAt: NOW - 10 }), d)).status, 201);
  const again = await handleProfile(await signed(k, { type: PROFILE_TYPE, name: "v0", issuedAt: NOW - 10 }), d);
  assert.equal(again.status, 409); // same issuedAt (replay) refused
  const newer = await handleProfile(await signed(k, { type: PROFILE_TYPE, name: "v2", issuedAt: NOW }), d);
  assert.equal(newer.status, 200);
  assert.equal(newer.body.result, "replaced");
  assert.equal(d.profiles.get(a).name, "v2");
  // someone else cannot overwrite: a different signer cannot produce a valid signature for address a ...
  const other = generatePrivateKey();
  assert.equal((await handleProfile(await signed(other, { type: PROFILE_TYPE, name: "evil", address: a, issuedAt: NOW }), d)).status, 401);
  // ... and the store refuses a record whose signer differs from the stored signer
  const put = d.profiles.put(a, { signer: privateKeyToAccount(other).address, issuedAt: NOW + 5, name: "evil" });
  assert.equal(put.ok, false);
  assert.equal(put.status, 403);
  assert.equal(d.profiles.get(a).name, "v2");
  // stored on disk and reloaded
  assert.equal(new ProfileStore(d.profiles.file).get(a).name, "v2");
});

test("profile: field validation (https URLs, lengths, criteriaKinds pattern, unknown fields)", async () => {
  const k = generatePrivateKey();
  const a = privateKeyToAccount(k).address;
  const d = deps(mkdtempSync(path.join(tmpdir(), "evp-")), { [a]: ACTIVE });
  for (const extra of [{ url: "http://plain.example" }, { verdictEndpoint: "ftp://x" }, { name: "" }, { name: "n".repeat(65) }, { contact: "c".repeat(201) }, { criteriaKinds: ["UPPER"] }, { email: "a@b.c" }]) {
    const r = await handleProfile(await signed(k, { type: PROFILE_TYPE, name: "ok", ...extra }), d);
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  assert.equal((await handleProfile(await signed(k, { type: PROFILE_TYPE, name: "ok", chainId: 1 }), d)).status, 400);
  assert.equal((await handleProfile(await signed(k, { type: PROFILE_TYPE, name: "ok", registry: USDC }), d)).status, 400);
});

test("status + topUp: below-minimum stake yields the exact approve + stake calls for the shortfall", () => {
  assert.deepEqual(stakeStatus(snap(2000000, true), "2000000"), { status: "active", shortfall: "0" });
  assert.deepEqual(stakeStatus(snap(0, false), "2000000"), { status: "unstaked", shortfall: "2000000" });
  const b = stakeStatus(snap(1800000, false), "2000000");
  assert.equal(b.status, "below_min_stake");
  assert.equal(b.shortfall, "200000");
  const t = topUpPlan({ shortfall: "200000", registry: REG, token: USDC, unbonding: false });
  assert.deepEqual(t.calls, [
    { to: USDC, function: "approve(address,uint256)", args: [REG, "200000"] },
    { to: REG, function: "stake(uint256)", args: ["200000"] },
  ]);
  assert.equal(topUpPlan({ shortfall: "1", registry: REG, token: USDC, unbonding: true }).possible, false);
});

test("listing (recorded Base Sepolia registry state): 0x3E8B…5f93 active, stake 2000000, stakeTx 0xd3a5…94a2; 0xB87b…d140 below_min_stake, shortfall 200000", () => {
  const events = foldStakeEvents(new Map(), FX.events);
  const row = (a) => fullRow({ candidate: { address: a, role: "registered" }, snapshot: FX.snapshots[a], minStake: FX.minStake, stakeEvent: events.get(a), profile: null, links, registry: REG, token: USDC });
  const n = row(NEWCOMER);
  assert.equal(n.status, "active");
  assert.equal(n.stake, "2000000");
  assert.equal(n.stakeTx, "0xd3a500194f28133953444ce0426d2f59faa4a44fa8a1bb17f78da53bf4a194a2");
  assert.equal(n.stakedAt, "2026-11-19T01:10:04.000Z"); // Nov 18 8:10:04 PM ET
  assert.equal(n.topUp, undefined);
  assert.deepEqual(n.nextSteps.map((s) => s.step), ["sign profile", "run judge-kit watcher", "request canary job"]);
  assert.ok(n.nextSteps.every((s) => typeof s.url === "string"));
  const b = row(BBV);
  assert.equal(b.status, "below_min_stake"); // verified on chain at the recorded block: stake 1800000 < minStake 2000000 after a 200000 slash
  assert.equal(b.stake, "1800000");
  assert.equal(b.shortfall, "200000");
  assert.equal(b.slashedTotal, "200000");
  assert.equal(b.stakeTx, "0x45d2d0ea9779861f21d846359cd98877457679b94a636cc0df1ed57e52274fca");
  assert.equal(b.topUp.amount, "200000");
  assert.equal(b.topUp.calls[1].function, "stake(uint256)");
  // with a profile, nextSteps is omitted and the profile is attached
  const p = fullRow({ candidate: { address: NEWCOMER }, snapshot: FX.snapshots[NEWCOMER], minStake: FX.minStake, stakeEvent: events.get(NEWCOMER), profile: { name: "n", signer: NEWCOMER, issuedAt: 1, digest: "0x", signature: "0x" }, links, registry: REG, token: USDC });
  assert.equal(p.nextSteps, undefined);
  assert.equal(p.profile.name, "n");
});

test("canary: default handler only appends a queue entry; no signer or chain module is reachable", async () => {
  const k = generatePrivateKey();
  const a = privateKeyToAccount(k).address;
  const dir = mkdtempSync(path.join(tmpdir(), "evc-"));
  // deps is frozen and holds no wallet/key; any other property access throws
  const base = deps(dir, { [a]: ACTIVE, [privateKeyToAccount(generatePrivateKey()).address]: BELOW });
  const accessed = new Set();
  const d = new Proxy(Object.freeze(base), { get(t, p) { accessed.add(p); if (!(p in t)) throw new Error(`unexpected dependency ${String(p)}`); return t[p]; } });
  const r = await handleCanary(await signed(k, { type: CANARY_TYPE }), d);
  assert.equal(r.status, 202);
  assert.equal(r.body.result, "queued");
  assert.equal(r.body.mode, "queue-only");
  assert.equal(r.body.onchain, null);
  assert.equal(r.body.request.amount, "100000");
  assert.deepEqual([...accessed].sort(), ["chainId", "now", "queue", "registry", "status"]);
  const again = await handleCanary(await signed(k, { type: CANARY_TYPE, issuedAt: NOW - 5 }), d);
  assert.equal(again.body.result, "already_queued");
  assert.equal(base.queue.entries().length, 1);
  // below-minimum stakers are refused (EvaluatorRegistry.lockExposure needs isActive)
  const kb = generatePrivateKey();
  const db = deps(dir, { [privateKeyToAccount(kb).address]: BELOW });
  assert.equal((await handleCanary(await signed(kb, { type: CANARY_TYPE }), db)).status, 409);
  // module graph: the onboarding module imports no chain, key or wallet code
  const src = readFileSync(path.join(HERE, "..", "lib", "evaluator-onboarding.mjs"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["./canonical.mjs", "node:fs", "node:path", "viem"]);
  assert.ok(!/privateKeyToAccount|createWalletClient|sendTransaction|writeContract/.test(src));
});

test("run-canary.mjs without --live prints a plan, loads no key and leaves the queue unchanged (network disabled)", async () => {
  const k = generatePrivateKey();
  const a = privateKeyToAccount(k).address;
  const dir = mkdtempSync(path.join(tmpdir(), "evr-"));
  const d = deps(dir, { [a]: ACTIVE });
  await handleCanary(await signed(k, { type: CANARY_TYPE }), d);
  const before = readFileSync(d.queue.file, "utf8");
  const r = spawnSync(process.execPath, ["--import", path.join(HERE, "..", "doorknock", "no-net.mjs"), path.join(HERE, "..", "scripts", "run-canary.mjs"), "--queue", d.queue.file], { encoding: "utf8", env: { ...process.env, AGENTCOIN_DEPLOYER_KEY: "", AGENTCOIN_PROVIDER_KEY: "" } });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout.trim().split("\n")[0]);
  assert.equal(plan.mode, "plan");
  assert.equal(plan.count, 1);
  assert.equal(plan.requests[0].evaluator, a);
  assert.match(plan.batchHash, /^0x[0-9a-f]{64}$/);
  assert.equal(readFileSync(d.queue.file, "utf8"), before);
  // --live refuses without the matching batch confirmation (before any key or chain module is loaded)
  const live = spawnSync(process.execPath, ["--import", path.join(HERE, "..", "doorknock", "no-net.mjs"), path.join(HERE, "..", "scripts", "run-canary.mjs"), "--queue", d.queue.file, "--live"], { encoding: "utf8", env: { ...process.env, CONFIRM_BATCH: "0xwrong" } });
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /CONFIRM_BATCH/);
  assert.equal(readFileSync(d.queue.file, "utf8"), before);
});

test("judge-kit `profile --dry-run` output verifies with the endpoint's verifier", { skip: Number(process.versions.node.split(".")[0]) < 22 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "evk-"));
  const keyFile = path.join(dir, "test.key");
  const k = generatePrivateKey(); // throwaway test key, never funded
  writeFileSync(keyFile, k + "\n", { mode: 0o600 });
  const kit = path.join(HERE, "..", "..", "judge-kit", "src", "profile.ts");
  const r = spawnSync(process.execPath, [kit, "profile", "--key", keyFile, "--name", "kit-judge", "--url", "https://judge.example", "--criteria-kinds", "http-200,body-sha256", "--issued-at", String(NOW), "--dry-run"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(k.slice(2)), "key must not be printed");
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.action, "dry-run");
  assert.equal(out.endpoint, "https://agentcoinhq.com/v1/evaluators/profile");
  const v = await verifySignedRequest(out.payload, { type: PROFILE_TYPE, chainId: 84532, registry: REG, now: NOW });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.address, privateKeyToAccount(k).address);
  assert.equal(v.digest, out.digest);
  const stored = await handleProfile(out.payload, deps(dir, { [v.address]: ACTIVE }));
  assert.equal(stored.status, 201);
});

test("HTTP: /v1/evaluators all[] from recorded registry state, POST profile + canary, onboarding, llms.txt, trust Link header", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "evh-"));
  const k = generatePrivateKey();
  const me = privateKeyToAccount(k).address;
  const snaps = { ...FX.snapshots, [me]: snap(2000000, true) };
  const evs = foldStakeEvents(new Map(), [...FX.events, { evaluator: me, txHash: "0x" + "11".repeat(32), blockNumber: "60881000", timestamp: NOW - 100 }]);
  const registryReader = { minStake: async () => FX.minStake, snapshot: async (a) => snaps[getAddress(a)] ?? snap(0, false), stakeEvents: async () => evs };
  const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", trustProxy: true, registryReader, now: () => NOW, caps: { freePerIpPerHour: 100 } });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const ev = await (await fetch(base + "/v1/evaluators")).json();
    const by = Object.fromEntries(ev.all.map((r) => [r.address, r]));
    assert.equal(by[NEWCOMER].status, "active");
    assert.equal(by[NEWCOMER].stake, "2000000");
    assert.equal(by[NEWCOMER].stakeTx, "0xd3a500194f28133953444ce0426d2f59faa4a44fa8a1bb17f78da53bf4a194a2");
    assert.equal(by[BBV].status, "below_min_stake");
    assert.equal(by[BBV].shortfall, "200000");
    assert.equal(by[BBV].topUp.calls[1].to, ev.registry);
    assert.equal(ev.minStake, "2000000");
    assert.ok(ev.statusCounts.active >= 1 && ev.statusCounts.below_min_stake === 1);
    assert.ok(Array.isArray(ev.list)); // selectable list keeps its old meaning
    assert.equal(ev.onboarding.v, "agentkoin-evaluator-onboarding/v1");

    const reg = ev.registry;
    const sign = async (doc) => {
      const d = { chainId: 31337, registry: reg, address: me, issuedAt: NOW, ...doc };
      return { ...d, signature: await privateKeyToAccount(k).signMessage({ message: { raw: signedDigest(d) } }) };
    };
    const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const pr = await post("/v1/evaluators/profile", await sign({ type: PROFILE_TYPE, name: "http-judge" }));
    assert.equal(pr.status, 201);
    const prb = await pr.json();
    assert.equal(prb.result, "stored");
    assert.equal(prb.realValue, false);
    const bad = await post("/v1/evaluators/profile", { ...(await sign({ type: PROFILE_TYPE, name: "x" })), name: "tampered" });
    assert.equal(bad.status, 401);
    const ev2 = await (await fetch(base + "/v1/evaluators")).json();
    const mine = ev2.all.find((r) => r.address === me);
    assert.equal(mine.profile.name, "http-judge");
    assert.equal(mine.nextSteps, undefined);

    const cr = await post("/v1/evaluators/canary", await sign({ type: CANARY_TYPE }));
    assert.equal(cr.status, 202);
    assert.equal((await cr.json()).result, "queued");
    const q = readFileSync(path.join(dir, "canary-queue.jsonl"), "utf8").trim().split("\n");
    assert.equal(q.length, 1);
    assert.equal(JSON.parse(q[0]).status, "queued");
    assert.ok(existsSync(path.join(dir, "evaluator-profiles.json")));

    const ob = await (await fetch(base + "/v1/evaluators/onboarding")).json();
    assert.deepEqual(ob.steps.map((s) => s.step), ["stake", "sign profile", "run judge-kit watcher", "request canary job", "first real job"]);
    const llms = await (await fetch(base + "/llms.txt")).text();
    assert.match(llms, /## Become an evaluator \(judge\)/);
    assert.match(llms, /\/v1\/evaluators\/profile/);
    const md = await fetch(base + "/EVALUATORS.md");
    assert.equal(md.status, 200);
    const tr = await fetch(base + "/.well-known/agentkoin-trust.json");
    assert.match(tr.headers.get("link") ?? "", /\/v1\/evaluators\/onboarding>; rel="https:\/\/agentcoinhq.com\/rel\/evaluator-onboarding"/);
    const signedBody = JSON.parse(readFileSync(path.join(HERE, "..", "artifacts", "trust-manifest.json"), "utf8"));
    assert.deepEqual(await tr.json(), signedBody); // signed body unchanged
  } finally {
    await app.stop();
  }
});

test("onboarding block: factual fields only", () => {
  const ob = onboardingBlock({ links, registry: REG, token: USDC, minStake: "2000000", chainId: 84532 });
  assert.equal(ob.steps[0].calls[1].args[0], "2000000");
  assert.match(ob.signing, /EIP-191/);
});
