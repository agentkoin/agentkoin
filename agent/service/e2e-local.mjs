#!/usr/bin/env node
// LOCAL end-to-end check of the public service against Anvil (run by demo/run.sh after deploy + seed):
// 402 -> exact payment -> relayed settle -> receipt anchored as deliverableHash -> background verdict -> finalize,
// hosted facilitator verify/settle, remote MCP over streamable HTTP, per-address cap (429), stats counters.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { NETWORK, STATES, CHAIN_ID, ANVIL_KEYS } from "../lib/config.mjs";
import { contracts, read, send, wallet, publicClient, increaseTime } from "../lib/chain.mjs";
import { createApp, receiptHash } from "./app.mjs";
import { payExact } from "../x402/pay-client.mjs";

if (NETWORK !== "local") throw new Error("e2e-local runs on the local Anvil network only");
const dir = mkdtempSync(path.join(tmpdir(), "acsvc-e2e-"));
const app = createApp({ stateDir: dir, publicUrl: "http://127.0.0.1:0", caps: { perAddressPerDay: 2, globalGasWeiPerDay: 10n ** 20n } /* Anvil gas price ~1 gwei */, loopMs: 1e9 });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const c = contracts();
const out = {};
try {
  // 1. paid notarize via x402 exact
  const r = await payExact(base + "/v1/notarize", { method: "POST", body: { data: "hello agents", note: "e2e" } });
  assert.equal(r.status, 200);
  const res = r.resource;
  assert.equal(res.realValue, false);
  assert.equal(receiptHash(res.receipt), res.deliverableHash);
  const jobId = BigInt(res.jobId);
  let j = await read(c.escrow, "getJob", [jobId]);
  assert.equal(STATES[j.state], "Submitted");
  assert.equal(j.deliverableHash, res.deliverableHash);
  out.notarize = { jobId: res.jobId, settleTx: res.settleTx, submitTx: res.submitTx };
  // 2. background evaluator verdict, then finalize after the challenge window
  await app.tick();
  j = await read(c.escrow, "getJob", [jobId]);
  assert.equal(STATES[j.state], "Completed", `tick error: ${app.lastTickError}`);
  const cfg = await read(c.escrow, "config", [j.configVersion]);
  await increaseTime(Number(cfg.challengeWindow) + 1);
  await app.tick();
  j = await read(c.escrow, "getJob", [jobId]);
  assert.equal(STATES[j.state], "Settled");
  const status = await (await fetch(`${base}/v1/notarize/${jobId}`)).json();
  assert.equal(status.status, "settled");
  assert.ok(status.verdictTx && status.finalizeTx);
  // 3. per-address cap: 2/day -> second paid call ok, third 429
  await payExact(base + "/v1/notarize", { method: "POST", body: { sha256: "0x" + "cd".repeat(32) } });
  await assert.rejects(payExact(base + "/v1/notarize", { method: "POST", body: { sha256: "0x" + "ef".repeat(32) } }), /429/);
  // 4. hosted facilitator: verify + settle a payment from a different payer to the notary route
  const pr = await (await fetch(base + "/v1/notarize", { method: "POST", body: '{"sha256":"0x' + "11".repeat(32) + '"}' })).json();
  const req = pr.accepts.find((a) => a.scheme === "exact");
  const payer = privateKeyToAccount(ANVIL_KEYS.keeper0); // a non-party local account; MockUSDC mint is public on Anvil
  await send(wallet(ANVIL_KEYS.keeper0), c.usdc, "mint", [payer.address, 1_000_000n]);
  {
    const now = (await publicClient.getBlock()).timestamp;
    const authorization = { from: payer.address, to: req.payTo, value: req.amount, validAfter: String(now - 60n), validBefore: String(now + 300n), nonce: toHex(randomBytes(32)) };
    const signature = await payer.signTypedData({ domain: { name: req.extra.name, version: req.extra.version, chainId: CHAIN_ID, verifyingContract: req.asset }, types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] }, primaryType: "TransferWithAuthorization", message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) } });
    const paymentPayload = { x402Version: 2, accepted: req, payload: { signature, authorization } };
    const v = await (await fetch(base + "/facilitator/verify", { method: "POST", body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: req }) })).json();
    assert.equal(v.isValid, true, JSON.stringify(v));
    const bad = await (await fetch(base + "/facilitator/verify", { method: "POST", body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: { ...req, payTo: payer.address } }) })).json();
    assert.equal(bad.isValid, false);
    const s = await (await fetch(base + "/facilitator/settle", { method: "POST", body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: req }) })).json();
    assert.equal(s.success, true, JSON.stringify(s));
    out.facilitator = { jobId: s.jobId, transaction: s.transaction };
  }
  // 5. remote MCP over streamable HTTP
  const mcp = async (body) => {
    const r2 = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    assert.equal(r2.status, 200, await r2.clone().text());
    return r2.json();
  };
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } });
  assert.ok(init.result?.serverInfo);
  const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(list.result.tools.length >= 5);
  const q = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "quote", arguments: { amount: "10000" } } });
  const qd = q.result.structuredContent ?? JSON.parse(q.result.content[0].text);
  assert.equal(qd.realValue, false);
  out.mcp = { tools: list.result.tools.length, quoteFeeBps: qd.feeBps ?? qd.fees?.feeBps ?? null };
  // 5b. MCP server card + opt-out
  const card = await (await fetch(base + "/.well-known/mcp/server-card.json")).json();
  assert.equal(card.tools.length, list.result.tools.length);
  assert.equal(card.realValue, false);
  const oo = await (await fetch(base + "/v1/optout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ match: "https://agent.example/a2a" }) })).json();
  assert.equal(oo.ok, true);
  out.mcpServerCard = { tools: card.tools.length };
  // 6. stats
  const st = await (await fetch(base + "/v1/stats")).json();
  assert.ok(st.counters.paymentRequired402 >= 3);
  assert.ok(st.counters.paidCalls >= 2);
  assert.ok(st.counters.jobsSettled >= 1);
  assert.ok(st.counters.mcpSessions >= 1);
  assert.ok(st.uniquePayerAddresses >= 1);
  out.stats = st.counters;
  console.log(JSON.stringify({ serviceE2E: "OK", ...out }, null, 2));
} finally {
  await app.stop();
}
process.exit(0);
