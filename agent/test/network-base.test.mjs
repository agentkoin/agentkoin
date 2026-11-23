// Base mainnet ("base", chainId 8453) network entry: resolution, testnet flags, fee-recipient refusal.
// Child processes are used where the module reads AGENTCOIN_NETWORK at import time. No RPC calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNetwork, resolveExchangeFeeRecipient, NETWORK_PROFILES, BASE_MAINNET_USDC } from "../lib/network.mjs";

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFE = "0x00000000000000000000000000000000005aFE02";
const DUMMY = { AGENTCOIN_ESCROW: "0x0000000000000000000000000000000000000E01", AGENTCOIN_REGISTRY: "0x0000000000000000000000000000000000000E02", AGENTCOIN_ROUTE_FACTORY: "0x0000000000000000000000000000000000000E03" };

function child(code, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AGENTCOIN_")));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: AGENT, env: { ...clean, ...env }, encoding: "utf8", timeout: 30_000 });
  const line = r.stdout.trim().split("\n").pop();
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`child failed: ${r.stderr || r.stdout}`);
  }
}

test("network resolution: local / base-sepolia unchanged, base = 8453, unknown refused", () => {
  assert.deepEqual(resolveNetwork("local"), { name: "local", chainId: 31337, publicChainId: 84532, x402Network: "eip155:84532", explorer: "https://sepolia.basescan.org", x402V1Network: "base-sepolia", testnet: true });
  assert.deepEqual(resolveNetwork("base-sepolia"), { name: "base-sepolia", chainId: 84532, publicChainId: 84532, x402Network: "eip155:84532", explorer: "https://sepolia.basescan.org", x402V1Network: "base-sepolia", testnet: true });
  assert.deepEqual(resolveNetwork("base"), { name: "base", chainId: 8453, publicChainId: 8453, x402Network: "eip155:8453", explorer: "https://basescan.org", x402V1Network: "base", testnet: false });
  assert.throws(() => resolveNetwork("ethereum"), /unknown AGENTCOIN_NETWORK ethereum/);
  assert.equal(Object.keys(NETWORK_PROFILES).join(","), "local,base-sepolia,base");
});

test("config on base: chain 8453, mainnet RPC, Circle USDC domain, value label, deployment from env, keys env-only", () => {
  const out = child(
    `const c = await import("./lib/config.mjs");
     let keyErr = null; try { c.roleKey("relayer"); } catch (e) { keyErr = e.message; }
     let missing = null; try { c.loadBaseDeployment("/nonexistent/8453.json", {}); } catch (e) { missing = e.message; }
     let badUsdc = null; try { c.loadBaseDeployment("/nonexistent/8453.json", { ...${JSON.stringify(DUMMY)} }); } catch (e) { badUsdc = e.message; }
     const d = c.loadDeployment();
     console.log(JSON.stringify({ chainId: c.CHAIN_ID, rpc: c.RPC_URL, token: c.TOKEN_EIP712, label: c.VALUE_LABEL, usdc: c.NET.usdc, d: { escrow: d.escrow, usdc: d.usdc, registry: d.registry }, keyErr, missing, badUsdc }));`,
    { AGENTCOIN_NETWORK: "base", ...DUMMY },
  );
  assert.equal(out.chainId, 8453);
  assert.equal(out.rpc, "https://mainnet.base.org");
  assert.deepEqual(out.token, { name: "USD Coin", version: "2" });
  assert.deepEqual(out.label, { testnet: false, realValue: true });
  assert.equal(out.usdc, BASE_MAINNET_USDC);
  assert.deepEqual(out.d, { escrow: DUMMY.AGENTCOIN_ESCROW, usdc: BASE_MAINNET_USDC, registry: DUMMY.AGENTCOIN_REGISTRY });
  assert.match(out.keyErr, /base: AGENTCOIN_RELAYER_KEY not set/, "no testnet key-file fallback on mainnet");
  assert.match(out.missing, /base: missing escrow address/);
  assert.equal(out.badUsdc, null, "env-only deployment is accepted");
});

test("testnet flags: true on local and base-sepolia, false only on base (exchange, router, discovery labels)", () => {
  const code = `const n = await import("./lib/network.mjs"); const ex = await import("./exchange/exchange.mjs"); const r = await import("./router/router.mjs");
    console.log(JSON.stringify({ testnet: n.TESTNET, x402: n.X402_NETWORK, explorer: n.EXPLORER, chain: n.PUBLIC_CHAIN_ID, exNet: ex.NETWORK_ID, routerNet: r.NETWORK_ID }));`;
  for (const [net, want] of [["local", true], ["base-sepolia", true], ["base", false]]) {
    const o = child(code, { AGENTCOIN_NETWORK: net, ...(net === "base" ? DUMMY : {}) });
    assert.equal(o.testnet, want, net);
    const x = want ? "eip155:84532" : "eip155:8453";
    assert.deepEqual([o.x402, o.exNet, o.routerNet], [x, x, x], net);
    assert.equal(o.explorer, want ? "https://sepolia.basescan.org" : "https://basescan.org", net);
    assert.equal(o.chain, want ? 84532 : 8453, net);
  }
});

test("fee recipient: testnet fallback unchanged; base requires a fee Safe that is not the operator", () => {
  const op = "0x00000000000000000000000000000000000000Aa";
  // testnets: option, else valid env, else operator, else null (pre-existing behaviour)
  assert.equal(resolveExchangeFeeRecipient({ network: "base-sepolia", env: {}, operatorAddress: op }), op);
  assert.equal(resolveExchangeFeeRecipient({ network: "local", env: { AGENTCOIN_EXCHANGE_FEE_RECIPIENT: "junk" }, operatorAddress: null }), null);
  assert.equal(resolveExchangeFeeRecipient({ network: "base-sepolia", env: { AGENTCOIN_EXCHANGE_FEE_RECIPIENT: SAFE }, operatorAddress: op }), SAFE);
  // base
  assert.throws(() => resolveExchangeFeeRecipient({ network: "base", env: {}, operatorAddress: op }), /is required/);
  assert.throws(() => resolveExchangeFeeRecipient({ network: "base", env: { AGENTCOIN_EXCHANGE_FEE_RECIPIENT: "0x123" }, operatorAddress: op }), /not an address/);
  assert.throws(() => resolveExchangeFeeRecipient({ network: "base", env: { AGENTCOIN_EXCHANGE_FEE_RECIPIENT: op.toLowerCase() }, operatorAddress: op }), /must not be the operator/);
  assert.equal(resolveExchangeFeeRecipient({ network: "base", env: { AGENTCOIN_EXCHANGE_FEE_RECIPIENT: SAFE }, operatorAddress: op }), SAFE);
});

test("service refuses to start on base without the fee recipient, or with the operator as recipient", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "agk-base-"));
  const code = `const c = await import("./lib/config.mjs");
    for (const [k, v] of Object.entries({ RELAYER: c.ANVIL_KEYS.relayer, PROVIDER: c.ANVIL_KEYS.provider, EVALUATOR: c.ANVIL_KEYS.evaluator, OPERATOR: c.ANVIL_KEYS.deployer })) process.env["AGENTCOIN_" + k + "_KEY"] = v;
    const { privateKeyToAccount } = await import("viem/accounts");
    const opAddr = privateKeyToAccount(c.ANVIL_KEYS.deployer).address;
    if (process.env.USE_OPERATOR === "1") process.env.AGENTCOIN_EXCHANGE_FEE_RECIPIENT = opAddr;
    const app = await import("./service/app.mjs");
    let err = null; try { app.createApp({ stateDir: ${JSON.stringify(stateDir)} }); } catch (e) { err = e.message; }
    console.log(JSON.stringify({ err }));`;
  const none = child(code, { AGENTCOIN_NETWORK: "base", ...DUMMY });
  assert.match(String(none.err), /AGENTCOIN_EXCHANGE_FEE_RECIPIENT is required/);
  const asOp = child(code, { AGENTCOIN_NETWORK: "base", USE_OPERATOR: "1", ...DUMMY });
  assert.match(String(asOp.err), /must not be the operator signer/);
});

test("netCopy/netHide: identity on testnet, Base wording on base; JSON keys untouched", async () => {
  const { netCopy, netHide } = await import("../lib/network.mjs");
  const s = '{"testnet":true,"d":"Escrow on Base Sepolia testnet in Circle test USDC (eip155:84532); no real value"}';
  assert.equal(netCopy(s, true), s);
  const b = netCopy(s, false);
  assert.equal(b, '{"testnet":true,"d":"Escrow on Base in Circle USDC (eip155:8453); real USDC"}');
  const doc = "# T\n- Test USDC faucet pointers: x\n- FX quote (Uniswap on Base Sepolia)\n## Arbiter (Base Sepolia)\n- a\n## Next\n- b";
  assert.equal(netHide(doc, true), doc);
  assert.equal(netHide(doc, false), "# T\n## Next\n- b");
});

test("network-driven x402 v1 name, router preference, Exchange chainId, faucets per network", () => {
  const code = `const n = await import("./lib/network.mjs"); const d = await import("./x402/dexter.mjs"); const p = await import("./router/parse.mjs"); const e = await import("./exchange/exchange.mjs");
    const v1 = d.v1ExactRequirements({ amount: 1, payTo: "0x0", asset: "0x0", maxTimeoutSeconds: 60 }, { resource: "u" }).network;
    const pref = p.preferredAccept([{ network: "eip155:8453" }, { network: "eip155:84532" }]).network;
    console.log(JSON.stringify({ v1, pl: d.v1ExactPayload({ resource: "u" }).network, x: n.X402_NETWORK, cid: e.CHAIN_ID, pref }));`;
  assert.deepEqual(child(code, { AGENTCOIN_NETWORK: "base-sepolia" }), { v1: "base-sepolia", pl: "base-sepolia", x: "eip155:84532", cid: 84532, pref: "eip155:84532" });
  assert.deepEqual(child(code, { AGENTCOIN_NETWORK: "local" }), { v1: "base-sepolia", pl: "base-sepolia", x: "eip155:84532", cid: 84532, pref: "eip155:84532" });
  assert.deepEqual(child(code, { AGENTCOIN_NETWORK: "base", ...DUMMY, AGENTCOIN_EXCHANGE_FEE_RECIPIENT: "0x00000000000000000000000000000000005afe02" }), { v1: "base", pl: "base", x: "eip155:8453", cid: 8453, pref: "eip155:8453" });
});
