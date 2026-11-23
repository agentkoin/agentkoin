// AD-010 (AGC) service and client tests. Pure tests always run; the local end-to-end part runs only when Anvil is up
// on 127.0.0.1:8545 with script/DeployLocal.s.sol + script/DeployAGCLocal.s.sol deployed (deployments/local-agc.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { agcConfig, agcExactRequirements, slimAgcForHeader, orderAccepts, agcSwapEntry, agcQuoteParams, AGC_EIP712 } from "../lib/agc.mjs";
import { headerCopy, HEADER_LIMIT_BYTES } from "../lib/header402.mjs";
import { selectPayableExact, balanceAwareSelector } from "../x402/select.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const fx = (f) => path.join(HERE, "fixtures", f);
const AGC = "0x2222222222222222222222222222222222222222";
const ENV = { AGC_ADDRESS: AGC, AGC_ESCROW: "0x3333333333333333333333333333333333333333", AGC_ROUTE_FACTORY: "0x4444444444444444444444444444444444444444", AGC_ADAPTER: "0x5555555555555555555555555555555555555555" };
const body = JSON.parse(readFileSync(fx("v0.5.14-notarize-402.json"), "utf8"));
const raw = readFileSync(fx("v0.5.14-notarize-402.headers.txt"), "utf8");
const oldB64 = raw.match(/^payment-required: (\S+)\r?$/im)[1];
const oldHdr = JSON.parse(Buffer.from(oldB64, "base64").toString("utf8"));
const [usdcExact, escrowEntry, swapEntry] = body.accepts;
const agcEntry = (cfg) => agcExactRequirements(usdcExact, { cfg, payTo: "0x6666666666666666666666666666666666666666", feeBps: 0, evaluatorFeeBps: 0, evaluatorStake: "2000000", evaluatorActive: true, reserveUrl: "https://agentcoinhq.com/v1/agc" });
const pr0 = (() => { const p = { ...body }; delete p.testnet; delete p.realValue; return p; })();
const headerTotal = (hdr) => Buffer.byteLength(raw) - oldB64.length + Buffer.from(JSON.stringify({ ...hdr, testnet: true, realValue: false })).toString("base64").length;

test("agcConfig: off unless all four addresses are set; AGC_FIRST default off; AGC_SWAP_OUT default on", () => {
  assert.equal(agcConfig({}).enabled, false);
  assert.equal(agcConfig({ AGC_ADDRESS: AGC }).enabled, false);
  const c = agcConfig(ENV);
  assert.deepEqual([c.enabled, c.first, c.swapOut], [true, false, true]);
  assert.equal(agcConfig({ ...ENV, AGC_FIRST: "1" }).first, true);
  assert.equal(agcConfig({ ...ENV, AGC_SWAP_OUT: "0" }).swapOut, false);
});

test("rollback: AGC unset -> accepts order and header copy are exactly v0.5.15", () => {
  const off = agcConfig({});
  assert.deepEqual(orderAccepts({ usdcExact, agcExact: null, escrow: escrowEntry, swap: [swapEntry] }, off), [usdcExact, escrowEntry, swapEntry]);
  assert.equal(JSON.stringify(headerCopy(pr0, off)), JSON.stringify(headerCopy(pr0)));
  assert.equal(JSON.stringify(headerCopy(pr0, off).accepts), JSON.stringify(oldHdr.accepts.slice(0, 2)));
});

test("6.1: AGC exact entry = USDC exact shape with AGC asset/payTo/domain/escrow; USDC exact unchanged; AGC_FIRST orders", () => {
  const cfg = agcConfig(ENV);
  const usdcBefore = JSON.stringify(usdcExact);
  const e = agcEntry(cfg);
  assert.equal(JSON.stringify(usdcExact), usdcBefore, "USDC entry not mutated");
  assert.deepEqual([e.scheme, e.network, e.amount, e.asset, e.extra.name, e.extra.version], ["exact", "eip155:84532", "10000", AGC, AGC_EIP712.name, "1"]);
  assert.deepEqual([e.extra.agentcoin.escrowContract, e.extra.agentcoin.depositRouteFactory, e.extra.agentcoin.feeBps], [cfg.escrow, cfg.routeFactory, 0]);
  assert.deepEqual(e.extra.agentcoin.backing, { asset: "USDC", ratio: "1:1", reserveUrl: "https://agentcoinhq.com/v1/agc" });
  assert.equal(e.extra.responseSchemaHash, usdcExact.extra.responseSchemaHash);
  assert.deepEqual(orderAccepts({ usdcExact, agcExact: e, escrow: escrowEntry, swap: [swapEntry] }, cfg).map((a) => a.asset), [usdcExact.asset, AGC, escrowEntry.asset, swapEntry.asset]);
  assert.equal(orderAccepts({ usdcExact, agcExact: e, escrow: escrowEntry, swap: [] }, agcConfig({ ...ENV, AGC_FIRST: "1" }))[0].asset, AGC);
});

test("6.1: swap entry with AGC out keeps on-chain tokenOut = USDC (quoteHash input) and routes the escrow slot to the adapter", () => {
  const cfg = agcConfig(ENV);
  const s = agcSwapEntry(swapEntry, cfg);
  assert.equal(s.extra.quote.tokenOut, swapEntry.extra.quote.tokenOut);
  assert.equal(s.extra.quote.minOut, "10000");
  assert.equal(s.extra.settlement.escrowContract, cfg.adapter);
  assert.deepEqual([s.extra.settlement.receivedAs.symbol, s.extra.settlement.receivedAs.asset, s.extra.settlement.receivedAs.escrow], ["AGC", AGC, cfg.escrow]);
  assert.equal(JSON.stringify(s.extra.nonce), JSON.stringify(swapEntry.extra.nonce));
});

test("6.2: header with AGC (both orders) <= 6,144 - 256 B on live v0.5.14 headers; USDC exact byte-identical; escrow body-only", () => {
  for (const env of [ENV, { ...ENV, AGC_FIRST: "1" }]) {
    const cfg = agcConfig(env);
    const pr = { ...pr0, accepts: orderAccepts({ usdcExact, agcExact: agcEntry(cfg), escrow: escrowEntry, swap: [agcSwapEntry(swapEntry, cfg)] }, cfg) };
    const hdr = headerCopy(pr, cfg);
    const total = headerTotal(hdr);
    assert.ok(total <= HEADER_LIMIT_BYTES, `all headers ${total} B`);
    const u = hdr.accepts.find((a) => a.asset === usdcExact.asset);
    assert.equal(JSON.stringify(u), JSON.stringify(oldHdr.accepts[0]));
    assert.deepEqual(hdr.accepts.map((a) => a.scheme), ["exact", "exact"]);
    assert.ok(hdr.bodyOnly.includes("accepts.agentcoin-escrow") && hdr.bodyOnly.includes("accepts.agentcoin-swap"));
    const slim = hdr.accepts.find((a) => a.asset === AGC);
    assert.deepEqual(slim, slimAgcForHeader(pr.accepts.find((a) => a.asset === AGC)));
    for (const k of ["spec", "payToKind", "trustManifestUrl", "evaluatorStake", "evaluatorActive", "evaluatorFeeBps"]) assert.equal(slim.extra.agentcoin[k], undefined, k);
    assert.equal(slim.extra.responseSchemaUrl, undefined);
    test.diagnostic?.(`AGC_FIRST=${env.AGC_FIRST ?? 0}: all headers ${total} B`);
  }
});

test("/v1/quote?to=AGC rewrites to USDC and decorates the identity wrap step; other params untouched", () => {
  const cfg = agcConfig(ENV);
  const usdc = usdcExact.asset;
  assert.equal(agcQuoteParams(new URLSearchParams({ from: "EURC", to: "USDC" }), cfg, usdc), null);
  assert.equal(agcQuoteParams(new URLSearchParams({ from: "EURC", to: "AGC" }), agcConfig({}), usdc), null);
  const r = agcQuoteParams(new URLSearchParams({ from: "EURC", to: "agc", amount: "10000" }), cfg, usdc);
  assert.equal(r.params.get("to"), usdc);
  assert.equal(r.params.get("amount"), "10000");
  const d = r.decorate({ to: { symbol: "USDC", asset: usdc, amount: "1" }, rateSource: { kind: "uniswap-v3-quoterv2" } });
  assert.deepEqual([d.to.symbol, d.to.asset, d.to.via.symbol, d.rateSource.kind], ["AGC", AGC, "USDC", "uniswap-v3-quoterv2+agc-wrap-1:1"]);
});

// ---- 6.3 client selection ----
const accAgcFirst = [agcEntry(agcConfig(ENV)), usdcExact, escrowEntry];
const bal = (m) => async (a) => m[a.toLowerCase()] ?? 0n;

test("6.3 reference @x402/core x402Client default selector returns accepts[0] (no balance check)", () => {
  const c = new x402Client();
  assert.equal(c.paymentRequirementsSelector(2, accAgcFirst), accAgcFirst[0]);
});

test("6.3 selectPayableExact: USDC-only wallet picks USDC even with AGC first; AGC-only picks AGC; empty wallet gets none", async () => {
  const usdcOnly = await selectPayableExact(accAgcFirst, bal({ [usdcExact.asset.toLowerCase()]: 10_000n }), { network: "eip155:84532" });
  assert.equal(usdcOnly.entry.asset, usdcExact.asset);
  const agcOnly = await selectPayableExact([usdcExact, accAgcFirst[0]], bal({ [AGC.toLowerCase()]: 10_000n }), { network: "eip155:84532" });
  assert.equal(agcOnly.entry.asset, AGC);
  const none = await selectPayableExact(accAgcFirst, bal({}), { network: "eip155:84532" });
  assert.equal(none.entry, null);
  const wrongNet = await selectPayableExact(accAgcFirst, bal({ [usdcExact.asset.toLowerCase()]: 10_000n }), { network: "eip155:8453" });
  assert.equal(wrongNet.entry, null);
  // x402Client-compatible selector
  assert.equal(balanceAwareSelector({ [usdcExact.asset]: 10_000n })(2, accAgcFirst).asset, usdcExact.asset);
  assert.equal(balanceAwareSelector({ [AGC]: 10_000n })(2, accAgcFirst).asset, AGC);
});

// ---- local end-to-end (Anvil) ----
const AGC_LOCAL = path.join(ROOT, "deployments/local-agc.json");
async function anvilUp() {
  try {
    const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [JSON.parse(readFileSync(AGC_LOCAL, "utf8")).AGC_ADDRESS, "latest"] }) });
    return (await r.json()).result?.length > 2;
  } catch {
    return false;
  }
}
const localReady = (process.env.AGENTCOIN_NETWORK ?? "local") === "local" && existsSync(AGC_LOCAL) && (await anvilUp());

test("local e2e (Anvil): AGC_FIRST=1 402; USDC-only and AGC-only pay-client wallets each pay a payable entry; AGC job + receipt + /v1/agc", { skip: !localReady && "needs Anvil with DeployLocal + DeployAGCLocal" }, async () => {
  const { createApp } = await import("../service/app.mjs");
  const { payExact } = await import("../x402/pay-client.mjs");
  const { contracts, read, send, wallet, publicClient } = await import("../lib/chain.mjs");
  const { ANVIL_KEYS, ABI } = await import("../lib/config.mjs");
  const { AGC_ABI } = await import("../lib/agc.mjs");
  const env = JSON.parse(readFileSync(AGC_LOCAL, "utf8"));
  const cfg = agcConfig({ ...env, AGC_FIRST: "1" });
  const c = contracts();
  const rpc = (method, params) => fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const fresh = async () => {
    const pk = generatePrivateKey();
    const a = privateKeyToAccount(pk);
    await rpc("anvil_setBalance", [a.address, "0x56BC75E2D63100000"]);
    await send(wallet(ANVIL_KEYS.keeper0), c.usdc, "mint", [a.address, 50_000n]);
    return { pk, a };
  };
  // Anvil-only: the USDC exact path needs the local evaluator staked in the USDC registry (demo/run.sh seeds this; DeployLocal does not).
  const evAddr = wallet(ANVIL_KEYS.evaluator).account.address;
  if (!(await read(c.registry, "isActive", [evAddr]))) {
    const ms = await read(c.registry, "minStake", []);
    await send(wallet(ANVIL_KEYS.keeper0), c.usdc, "mint", [evAddr, ms]);
    await send(wallet(ANVIL_KEYS.evaluator), c.usdc, "approve", [c.registry.address, ms]);
    await send(wallet(ANVIL_KEYS.evaluator), c.registry, "stake", [ms]);
  }
  const usdcOnly = await fresh();
  const agcOnly = await fresh();
  const agcRef = { address: cfg.address, abi: [...AGC_ABI, ...ABI.usdc.filter((x) => x.name === "approve"), { type: "function", name: "wrap", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] }] };
  await send(wallet(agcOnly.pk), c.usdc, "approve", [cfg.address, 50_000n]);
  await send(wallet(agcOnly.pk), agcRef, "wrap", [50_000n]);
  assert.equal(await read(c.usdc, "balanceOf", [agcOnly.a.address]), 0n);

  const app = createApp({ stateDir: mkdtempSync(path.join(tmpdir(), "acagc-")), publicUrl: "http://127.0.0.1:0", agc: cfg, caps: { perAddressPerDay: 5, globalGasWeiPerDay: 10n ** 20n }, loopMs: 1e9 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const prev = process.env.AGENTCOIN_PAYER_KEY;
  try {
    const r402 = await fetch(base + "/v1/notarize", { method: "POST", body: "{}" });
    assert.equal(r402.status, 402);
    const pr = await r402.json();
    assert.deepEqual(pr.accepts.slice(0, 2).map((a) => a.asset), [cfg.address, c.usdc.address]);
    const hdr = JSON.parse(Buffer.from(r402.headers.get("payment-required"), "base64").toString("utf8"));
    assert.ok(hdr.bodyOnly.includes("accepts.agentcoin-escrow"));
    let total = 0;
    r402.headers.forEach((v, k) => (total += k.length + 2 + v.length + 2));
    assert.ok(total <= HEADER_LIMIT_BYTES, `local headers ${total} B`);

    process.env.AGENTCOIN_PAYER_KEY = usdcOnly.pk;
    const p1 = await payExact(base + "/v1/notarize", { method: "POST", body: { sha256: "0x" + "a1".repeat(32) } });
    assert.equal(p1.asset, c.usdc.address);
    assert.equal(p1.resource.receipt.escrow, c.escrow.address);

    process.env.AGENTCOIN_PAYER_KEY = agcOnly.pk;
    const p2 = await payExact(base + "/v1/notarize", { method: "POST", body: { sha256: "0x" + "a2".repeat(32) } });
    assert.equal(p2.asset, cfg.address);
    assert.equal(p2.resource.receipt.escrow, cfg.escrow);
    assert.equal(p2.resource.agentcoin.payment.paid.symbol, "AGC");
    assert.equal(p2.resource.agentcoin.checks.onchainDeliverableHashMatches, true);
    const job = await read({ address: cfg.escrow, abi: ABI.escrow }, "getJob", [BigInt(p2.resource.jobId)]);
    assert.equal(job.client, agcOnly.a.address);
    assert.equal(job.amount, 10_000n);
    const st = await (await fetch(p2.resource.status.replace("http://127.0.0.1:0", base))).json();
    assert.equal(st.agentcoin.payment.paid.symbol, "AGC");
    assert.equal(st.receipt.escrow, cfg.escrow);
    // background verdict on the AGC escrow (evaluator staked AGC in the AGC registry)
    await app.tick();
    const j2 = await read({ address: cfg.escrow, abi: ABI.escrow }, "getJob", [BigInt(p2.resource.jobId)]);
    assert.notEqual(Number(j2.state), Number(job.state), `tick: ${app.lastTickError}`);
    // reserve proof
    const agcBody = await (await fetch(base + "/v1/agc")).json();
    const bn = BigInt(agcBody.blockNumber);
    const reserve = await publicClient.readContract({ address: c.usdc.address, abi: ABI.usdc, functionName: "balanceOf", args: [cfg.address], blockNumber: bn });
    const supply = await publicClient.readContract({ address: cfg.address, abi: AGC_ABI, functionName: "totalSupply", blockNumber: bn });
    assert.deepEqual([agcBody.reserve, agcBody.supply, agcBody.fullyBacked], [reserve.toString(), supply.toString(), true]);
  } finally {
    if (prev === undefined) delete process.env.AGENTCOIN_PAYER_KEY;
    else process.env.AGENTCOIN_PAYER_KEY = prev;
    await app.stop();
  }
});
