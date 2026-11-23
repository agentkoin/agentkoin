// AD-011 legal hardening (docs/AD-011_LEGAL_HARDENING_SPEC.md): evaluator choice, forward-only relayer, AGC wording.
// Pure tests always run; the end-to-end part needs Anvil on 127.0.0.1:8545 with script/DeployLocal.s.sol deployed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, parseEventLogs, keccak256, toBytes } from "viem";
import { headerCopy, HEADER_LIMIT_BYTES } from "../lib/header402.mjs";
import { evaluatorCandidates, evaluatorRow, knownEvaluators } from "../lib/evaluators.mjs";
import { checkReceipt, receiptHash } from "../evaluator/run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.resolve(HERE, "..");
const ROOT = path.resolve(HERE, "../..");
const A = "0x000000000000000000000000000000000000000A";
const B = "0x000000000000000000000000000000000000000b";
const REF = "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a";

test("evaluator listing: labels win, reference always present and labeled, indexed stakers listed unlabeled", () => {
  const known = [
    { address: getAddress(A), role: "test", label: "test evaluator A (testnet demo)", operator: "STOS Technologies LLC" },
    { address: getAddress(B), role: "test", label: "test evaluator B (testnet demo)", operator: "STOS Technologies LLC" },
  ];
  const other = "0x00000000000000000000000000000000000000C0";
  const c = evaluatorCandidates({ known, reference: REF, referenceLabel: "reference evaluator (operated by STOS Technologies, testnet demo)", stakers: [A, other] });
  assert.equal(c.length, 4);
  assert.equal(c.find((k) => k.address === REF).role, "reference");
  assert.match(c.find((k) => k.address === REF).label, /^reference evaluator \(operated by STOS Technologies, testnet demo\)$/);
  assert.equal(c.find((k) => k.address === getAddress(other)).role, "registered");
  const row = evaluatorRow(c[0], { snapshot: { active: true, stake: "2000000", availableExposure: "10000000", openJobs: 0, slashedTotal: "0" }, exactPayTo: other, trackRecord: null, links: { evaluators: "https://x/v1/evaluators", notarize: "https://x/v1/notarize" }, isDefault: false });
  assert.deepEqual(Object.keys(row).sort(), ["active", "address", "availableExposure", "default", "exactPayTo", "label", "openJobs", "operator", "process", "processStatus", "role", "select", "slashedTotal", "stake", "trackRecord", "trackRecordUrl"].sort());
  assert.equal(row.select, `https://x/v1/notarize?evaluator=${getAddress(A)}`);
});

test("bundled labels (84532): reference + 2 test evaluators + 1 independent with distinct addresses, none equal to service role addresses", () => {
  const k = knownEvaluators({ agentDir: AGENT, chainId: 84532, env: {} });
  assert.equal(k.filter((e) => e.role === "test").length, 2);
  assert.equal(k.find((e) => e.role === "reference").address, REF);
  assert.equal(new Set(k.map((e) => e.address)).size, 4);
  const ind = k.filter((e) => e.independent === true);
  assert.equal(ind.length, 1);
  assert.equal(ind[0].address, getAddress("0xB87b0d6AD3B17A8a1795d6640317c7997140d140"));
  assert.notEqual(ind[0].operator, "STOS Technologies LLC");
  assert.ok(ind[0].funding.every((f) => /^0x[0-9a-f]{64}$/.test(f.tx)));
  const row = evaluatorRow(ind[0], { snapshot: { active: true, stake: "2000000", availableExposure: "0", openJobs: 0, slashedTotal: "0" }, exactPayTo: REF, trackRecord: null, links: { evaluators: "e", notarize: "n" }, isDefault: false });
  assert.equal(row.independent, true);
  assert.equal(row.source.keysFile, "https://api.babyblueviper.com/.well-known/invinoveritas-checker-keys.json");
  const roles = JSON.parse(readFileSync(path.join(ROOT, "deployments/base-sepolia.json"), "utf8"));
  for (const e of k.filter((x) => x.role === "test")) assert.notEqual(e.address, getAddress(roles.deployer));
});

test("header copy: evaluators listing is body-only; USDC exact entry unchanged; total <= 5,888 B on live v0.5.14 headers", () => {
  const body = JSON.parse(readFileSync(path.join(HERE, "fixtures", "v0.5.14-notarize-402.json"), "utf8"));
  const withEv = { ...body, evaluators: { registry: A, list: [{ address: REF }, { address: A }, { address: B }] } };
  const h0 = headerCopy(body);
  const h1 = headerCopy(withEv);
  assert.equal(h1.evaluators, undefined);
  assert.ok(h1.bodyOnly.includes("evaluators"));
  assert.deepEqual(h1.accepts, h0.accepts);
  const raw = readFileSync(path.join(HERE, "fixtures", "v0.5.14-notarize-402.headers.txt"), "utf8").split(/\r?\n/).filter((l) => l.includes(":") && !/^payment-required:/i.test(l) && !/^HTTP\//.test(l));
  const others = raw.reduce((n, l) => n + Buffer.byteLength(l) + 2, 0);
  const pr = Buffer.from(JSON.stringify(h1)).toString("base64");
  const total = others + "payment-required".length + 2 + pr.length + 2;
  assert.ok(total <= HEADER_LIMIT_BYTES, `headers ${total} B`);
});

test("test evaluator receipt check: hash, jobId, chain, escrow, client and the settle tx's JobCreated must all match", () => {
  const escrow = "0x00000000000000000000000000000000000000E5";
  const client = "0x00000000000000000000000000000000000000C1";
  const receipt = { v: "agentcoin-notary/v1", chainId: 31337, escrow, jobId: "7", client, digest: "0x" + "ab".repeat(32) };
  const job = { deliverableHash: receiptHash(receipt), client };
  // JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, ...) log for job 7
  const topic0 = keccak256(toBytes("JobCreated(uint256,address,address,address,uint256,uint64,bytes32,uint32)"));
  const pad = (x) => "0x" + BigInt(x).toString(16).padStart(64, "0");
  const data = "0x" + [A, 1, 2, "0x" + "00".repeat(32), 1].map((x) => (typeof x === "string" ? x.slice(2).padStart(64, "0") : BigInt(x).toString(16).padStart(64, "0"))).join("");
  const log = { address: escrow, topics: [topic0, pad(7), pad(client), pad(B)], data, blockNumber: 1n, transactionHash: "0x" + "11".repeat(32), logIndex: 0, blockHash: "0x" + "22".repeat(32), transactionIndex: 0, removed: false };
  assert.deepEqual(checkReceipt({ receipt, job, jobId: 7n, escrow, chainId: 31337, settleLogs: [log] }), { ok: true, reason: "receipt hash verified" });
  assert.equal(checkReceipt({ receipt: { ...receipt, note: "x" }, job, jobId: 7n, escrow, chainId: 31337, settleLogs: [log] }).ok, false);
  assert.equal(checkReceipt({ receipt, job: { ...job, client: A }, jobId: 7n, escrow, chainId: 31337, settleLogs: [log] }).ok, false);
  assert.equal(checkReceipt({ receipt, job, jobId: 7n, escrow, chainId: 31337, settleLogs: [] }).reason, "settleTx did not create this job");
  assert.equal(checkReceipt({ receipt: null, job, jobId: 7n, escrow, chainId: 31337 }).reason, "no receipt");
});

test("F: no 'dollar' / 'stablecoin' wording for AGC in token source, service copy, served docs or the AGC deploy plan", () => {
  const files = ["src/AGC.sol", "src/AGCSettlerAdapter.sol", "script/DeployAGC.s.sol", "agent/lib/agc.mjs", "agent/service/app.mjs", "agent/lib/header402.mjs", "agent/lib/evaluators.mjs", "agent/static/evaluators.json", "docs/AGC_DEPLOY_PLAN.md", "docs/QUICKSTART-AGENTS.md", "docs/SECURITY-NOTES.md"];
  for (const f of files) assert.doesNotMatch(readFileSync(path.join(ROOT, f), "utf8"), /dollar|stablecoin/i, f);
  const agc = readFileSync(path.join(ROOT, "src/AGC.sol"), "utf8");
  assert.match(agc, /ERC20\("AgentCoin", "AGC"\)/);
});

// ---- local end-to-end (Anvil) ----
async function anvilUp() {
  try {
    const d = JSON.parse(readFileSync(path.join(ROOT, "deployments/local.json"), "utf8"));
    const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [d.contracts?.JobEscrow ?? d.JobEscrow ?? d.escrow, "latest"] }) });
    return (await r.json()).result?.length > 2;
  } catch {
    return false;
  }
}
const localReady = (process.env.AGENTCOIN_NETWORK ?? "local") === "local" && existsSync(path.join(ROOT, "deployments/local.json")) && (await anvilUp());

test("local e2e (Anvil): buyer picks a non-reference evaluator (separate processes) -> settled; self-submit without relayer; relayer holds 0; timeout refund", { skip: !localReady && "needs Anvil with DeployLocal" }, async () => {
  const { createApp, REFERENCE_EVALUATOR_LABEL, referenceEvaluator } = await import("../service/app.mjs");
  const { payExact } = await import("../x402/pay-client.mjs");
  const { selfSubmitExact } = await import("../scripts/self-submit.mjs");
  const { contracts, read, send, wallet, publicClient, increaseTime } = await import("../lib/chain.mjs");
  const { ANVIL_KEYS, ABI } = await import("../lib/config.mjs");
  const c = contracts();
  const rpc = (method, params) => fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const minStake = await read(c.registry, "minStake", []);
  const keeper = wallet(ANVIL_KEYS.keeper0);
  const stake = async (pk) => {
    const a = privateKeyToAccount(pk).address;
    if (await read(c.registry, "isActive", [a])) return;
    await send(keeper, c.usdc, "mint", [a, minStake]);
    await send(wallet(pk), c.usdc, "approve", [c.registry.address, minStake]);
    await send(wallet(pk), c.registry, "stake", [minStake]);
  };
  await stake(ANVIL_KEYS.evaluator); // reference evaluator (demo/run.sh seeds this; DeployLocal does not)
  const dir = mkdtempSync(path.join(tmpdir(), "acev-"));
  const evs = [];
  for (const n of ["A", "B"]) {
    const pk = generatePrivateKey();
    const file = path.join(dir, `ev-${n}.key`);
    writeFileSync(file, pk + "\n", { mode: 0o600 });
    const address = privateKeyToAccount(pk).address;
    await rpc("anvil_setBalance", [address, "0x56BC75E2D63100000"]);
    await stake(pk);
    evs.push({ n, pk, file, address });
  }
  const fresh = async () => {
    const pk = generatePrivateKey();
    const a = privateKeyToAccount(pk);
    await rpc("anvil_setBalance", [a.address, "0x56BC75E2D63100000"]);
    await send(keeper, c.usdc, "mint", [a.address, 100_000n]);
    return { pk, a };
  };
  const relayer = privateKeyToAccount(ANVIL_KEYS.relayer).address;
  const tokenBal = async (who) => (await read(c.usdc, "balanceOf", [who])) + 0n;
  assert.equal(await tokenBal(relayer), 0n, "relayer USDC before");

  const prevEv = process.env.AGENTCOIN_EVALUATORS;
  process.env.AGENTCOIN_EVALUATORS = JSON.stringify(evs.map((e) => ({ address: e.address, role: "test", label: `test evaluator ${e.n} (testnet demo)`, operator: "STOS Technologies LLC", process: "separate process and key" })));
  const app = createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "acad011-")), publicUrl: "http://127.0.0.1:0", caps: { perAddressPerDay: 10, globalGasWeiPerDay: 10n ** 20n }, loopMs: 1e9 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const start = await publicClient.getBlockNumber();
  const spawnEv = (e) => spawn(process.execPath, [path.join(AGENT, "evaluator/run.mjs")], { env: { ...process.env, EVALUATOR_KEY_FILE: e.file, ESCROW: c.escrow.address, SERVICE_URL: base, RPC_URL: "http://127.0.0.1:8545", POLL_MS: "300", START_BLOCK: String(start) }, stdio: ["ignore", "pipe", "pipe"] });
  const procs = evs.map((e) => ({ e, p: spawnEv(e), out: [] }));
  for (const x of procs) x.p.stdout.on("data", (d) => x.out.push(String(d)));
  const prevPayer = process.env.AGENTCOIN_PAYER_KEY;
  const waitState = async (id, want, ms = 30_000) => {
    const t0 = Date.now();
    for (;;) {
      const j = await read(c.escrow, "getJob", [BigInt(id)]);
      if (want.includes(Number(j.state))) return j;
      if (Date.now() - t0 > ms) throw new Error(`job ${id} state ${j.state}, want ${want}; evaluator logs: ${procs.map((x) => x.out.join("")).join(" | ").slice(-800)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  try {
    // A. listing: >= 2 test evaluators besides the labeled reference evaluator; default entry unchanged (reference)
    const r402 = await fetch(base + "/v1/notarize");
    assert.equal(r402.status, 402);
    const pr = await r402.json();
    const list = pr.evaluators.list;
    assert.ok(list.filter((e) => e.role === "test" && e.active).length >= 2, JSON.stringify(list));
    const ref = list.find((e) => e.role === "reference");
    assert.equal(ref.address, referenceEvaluator());
    assert.equal(ref.label, REFERENCE_EVALUATOR_LABEL);
    for (const e of evs) assert.notEqual(e.address, ref.address);
    const usdcExact = pr.accepts.find((a) => a.scheme === "exact");
    assert.equal(usdcExact.extra.agentcoin.offer.evaluator, referenceEvaluator());
    const hdr = JSON.parse(Buffer.from(r402.headers.get("payment-required"), "base64").toString("utf8"));
    assert.ok(hdr.bodyOnly.includes("evaluators") && hdr.evaluators === undefined);
    let total = 0;
    r402.headers.forEach((v, k) => (total += k.length + 2 + v.length + 2));
    assert.ok(total <= HEADER_LIMIT_BYTES, `local headers ${total} B`);
    const lv = await (await fetch(base + "/v1/evaluators")).json();
    assert.equal(lv.reference.label, REFERENCE_EVALUATOR_LABEL);
    // invalid choice is rejected, not rewritten
    assert.equal((await fetch(base + "/v1/notarize?evaluator=0x00000000000000000000000000000000000000c3")).status, 400);
    // chosen evaluator is bound into payTo
    const prA = await (await fetch(`${base}/v1/notarize?evaluator=${evs[0].address}`)).json();
    const exA = prA.accepts.find((a) => a.scheme === "exact");
    assert.equal(exA.extra.agentcoin.offer.evaluator, evs[0].address);
    assert.notEqual(exA.payTo, usdcExact.payTo);
    assert.equal(exA.payTo, await read(c.routeFactory, "routeFor", [{ ...exA.extra.agentcoin.offer, amount: BigInt(exA.extra.agentcoin.offer.amount), deadlineSeconds: BigInt(exA.extra.agentcoin.offer.deadlineSeconds) }]));
    assert.match(prA.resource.url, new RegExp(`evaluator=${evs[0].address}$`));

    // B. relayed x402 exact payment naming evaluator A; A (separate process) issues the verdict; permissionless finalize
    const b1 = await fresh();
    process.env.AGENTCOIN_PAYER_KEY = b1.pk;
    const p1 = await payExact(`${base}/v1/notarize?evaluator=${evs[0].address}`, { method: "POST", body: { sha256: "0x" + "b1".repeat(32) } });
    const id1 = p1.resource.jobId;
    const j1 = await read(c.escrow, "getJob", [BigInt(id1)]);
    assert.equal(j1.evaluator, evs[0].address);
    assert.equal(j1.client, b1.a.address);
    await app.tick(); // the reference evaluator must not decide a job that named A
    const j1v = await waitState(id1, [4, 5, 6]);
    const vlog = parseEventLogs({ abi: ABI.escrow, logs: await publicClient.getLogs({ address: c.escrow.address, fromBlock: start }), eventName: "Verdict" }).filter((l) => String(l.args.jobId) === String(id1));
    assert.equal(vlog.length, 1);
    assert.equal(getAddress(vlog[0].args.evaluator), evs[0].address);
    assert.equal((await publicClient.getTransaction({ hash: vlog[0].transactionHash })).from.toLowerCase(), evs[0].address.toLowerCase());
    assert.equal(Number(j1v.state), 4, "Completed");

    // C. self-submit: the payer settles on chain itself (no relayer), names evaluator B, then redeems {jobId, txHash}
    const b2 = await fresh();
    const s2 = await selfSubmitExact(`${base}/v1/notarize`, { payerKey: b2.pk, evaluator: evs[1].address, body: { sha256: "0x" + "b2".repeat(32) } });
    assert.equal(s2.status, 200, JSON.stringify(s2.response));
    assert.equal(getAddress((await publicClient.getTransaction({ hash: s2.settleTx })).from), b2.a.address, "settled by the payer");
    const j2 = await read(c.escrow, "getJob", [BigInt(s2.jobId)]);
    assert.equal(j2.evaluator, evs[1].address);
    assert.equal(j2.client, b2.a.address);
    assert.equal(s2.response.receipt.client, b2.a.address);
    await waitState(s2.jobId, [4, 5, 6]);

    // finalize both after the challenge window (anyone may call; the service's relayer does)
    const ecfg = await read(c.escrow, "currentConfig", []);
    await increaseTime(Number(ecfg.challengeWindow) + 1);
    await app.tick();
    assert.equal(Number((await read(c.escrow, "getJob", [BigInt(id1)])).state), 8, `Settled ${app.lastTickError}`);
    assert.equal(Number((await read(c.escrow, "getJob", [BigInt(s2.jobId)])).state), 8, `Settled ${app.lastTickError}`);

    // evaluator B goes dark: after evalWindow the service only triggers the permissionless timeoutRelease (refund)
    procs[1].p.kill();
    const b3 = await fresh();
    process.env.AGENTCOIN_PAYER_KEY = b3.pk;
    const p3 = await payExact(`${base}/v1/notarize?evaluator=${evs[1].address}`, { method: "POST", body: { sha256: "0x" + "b3".repeat(32) } });
    const before3 = await tokenBal(b3.a.address);
    await app.tick();
    assert.equal(Number((await read(c.escrow, "getJob", [BigInt(p3.resource.jobId)])).state), 3, "still Submitted: reference evaluator did not step in");
    await increaseTime(Number(ecfg.evalWindow) + 1);
    await app.tick();
    assert.equal(Number((await read(c.escrow, "getJob", [BigInt(p3.resource.jobId)])).state), 9, `Expired ${app.lastTickError}`);
    assert.equal((await tokenBal(b3.a.address)) - before3, 10_000n, "client refunded by contract rule");

    // D. relayer never held tokens and was never a Transfer party in any of these txs
    assert.equal(await tokenBal(relayer), 0n, "relayer USDC after");
    const all = await publicClient.getLogs({ address: c.usdc.address, fromBlock: start });
    const tr = parseEventLogs({ abi: ABI.usdc, logs: all, eventName: "Transfer" });
    assert.ok(tr.length > 0);
    for (const l of tr) assert.ok(getAddress(l.args.from) !== relayer && getAddress(l.args.to) !== relayer, `relayer in transfer ${l.transactionHash}`);
  } finally {
    for (const x of procs) x.p.kill();
    if (prevPayer === undefined) delete process.env.AGENTCOIN_PAYER_KEY;
    else process.env.AGENTCOIN_PAYER_KEY = prevPayer;
    if (prevEv === undefined) delete process.env.AGENTCOIN_EVALUATORS;
    else process.env.AGENTCOIN_EVALUATORS = prevEv;
    await app.stop();
  }
});
