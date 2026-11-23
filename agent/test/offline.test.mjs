// Offline tests (no chain needed): signing round-trips, tamper detection, schema, MCP tool metadata rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { signEip191, verifyEip191, signAgentCard, verifyAgentCard, addressFromJwk, jwkFromPrivateKey, jwksFor } from "../lib/sign.mjs";
import { checkExactAuthorization, AUTH_TYPES } from "../x402/server.mjs";
import { TOKEN_EIP712, CHAIN_ID } from "../lib/config.mjs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { jcs } from "../lib/canonical.mjs";
import { TOOLS } from "../mcp/tools.mjs";
import { validateTrustManifest } from "../lib/schema.mjs";

const pk = generatePrivateKey();
const addr = privateKeyToAccount(pk).address;

test("RFC 8785 canonicalization sorts keys and strips whitespace", () => {
  assert.equal(jcs({ b: 1, a: [true, "x"], c: { z: null, y: 1.5 } }), '{"a":[true,"x"],"b":1,"c":{"y":1.5,"z":null}}');
});

test("A2A spec 8.4.1 example canonical form", () => {
  const card = { name: "Example Agent", description: "An example agent that echoes messages.", supportedInterfaces: [{ url: "https://example.com/a2a/v1", protocolBinding: "JSONRPC", protocolVersion: "1.0" }], version: "1.0.0", capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [{ id: "echo", name: "Echo", description: "Echoes the input.", tags: ["echo"] }] };
  assert.equal(jcs(card), '{"capabilities":{"pushNotifications":false,"streaming":false},"defaultInputModes":["text/plain"],"defaultOutputModes":["text/plain"],"description":"An example agent that echoes messages.","name":"Example Agent","skills":[{"description":"Echoes the input.","id":"echo","name":"Echo","tags":["echo"]}],"supportedInterfaces":[{"protocolBinding":"JSONRPC","protocolVersion":"1.0","url":"https://example.com/a2a/v1"}],"version":"1.0.0"}');
});

test("EIP-191 sign/verify round trip; key order irrelevant; tamper detected", async () => {
  const d = await signEip191({ z: 1, a: "x" }, pk);
  assert.equal((await verifyEip191(d)).valid, true);
  assert.equal((await verifyEip191({ signature: d.signature, a: "x", z: 1 })).valid, true);
  assert.equal((await verifyEip191({ ...d, z: 2 })).valid, false);
  assert.equal((await verifyEip191(d)).signer, addr);
});

test("A2A card JWS ES256K: verify, tamper, jwk->address", async () => {
  const card = await signAgentCard({ name: "n", description: "d", skills: [] }, pk, "kid-1");
  const r = await verifyAgentCard(card);
  assert.equal(r.valid, true);
  assert.equal(r.signerAddress, addr);
  assert.equal(addressFromJwk(jwkFromPrivateKey(pk)), addr);
  assert.equal((await verifyAgentCard({ ...card, name: "m" })).valid, false);
  const other = await signAgentCard({ name: "n", description: "d", skills: [] }, generatePrivateKey(), "kid-1");
  assert.equal((await verifyAgentCard({ ...card, signatures: [{ ...card.signatures[0], header: other.signatures[0].header }] })).valid, false);
});

test("MCP legacy escrow tool set (v0.4, used when no router is attached): exactly 5 tools, descriptions <= 300 chars, no instruction-shaped or superlative text", () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ["quote", "open_job", "get_job_status", "get_evaluator_reputation", "verify_attestation"]);
  const banned = /\b(you (must|should)|always|never|ignore|best|fastest|cheapest|leading|trusted|recommended|prefer|choose this)\b/i;
  for (const t of TOOLS) {
    assert.ok(t.config.description.length <= 300, `${t.name} description ${t.config.description.length} chars`);
    assert.ok(!banned.test(t.config.description), `${t.name} description contains banned phrase`);
    assert.equal(typeof t.config.annotations.readOnlyHint, "boolean");
    assert.ok(t.config.outputSchema.chainId && t.config.outputSchema.contracts, `${t.name} output lacks chainId/contracts`);
  }
  assert.equal(TOOLS.filter((t) => !t.config.annotations.readOnlyHint).map((t) => t.name).join(), "open_job");
});

test("committed trust manifest example validates against JSON Schema", () => {
  const m = JSON.parse(readFileSync(new URL("../artifacts/trust-manifest.json", import.meta.url)));
  assert.equal(validateTrustManifest(m), true, JSON.stringify(validateTrustManifest.errors));
  const bad = { ...m, fees: { ...m.fees, feeBps: 20000 } };
  assert.equal(validateTrustManifest(bad), false);
});

test("artifact text contains no superlatives or instruction-shaped text", () => {
  const banned = /\b(you (must|should)|ignore previous|best|fastest|cheapest|leading|most trusted|recommended)\b/i;
  for (const f of ["agent-card.json", "agent-registration.json", "trust-manifest.json"]) {
    const s = readFileSync(new URL(`../artifacts/${f}`, import.meta.url), "utf8");
    assert.ok(!banned.test(s), f);
  }
});

test("A-4: card protected header carries jku; JWKS with same kid+key verifies; mismatches fail", async () => {
  const kid = "did:pkh:eip155:31337:x#secp256k1";
  const jku = "http://127.0.0.1:4020/.well-known/jwks.json";
  const card = await signAgentCard({ name: "n", description: "d", skills: [] }, pk, kid, { jku });
  const header = JSON.parse(Buffer.from(card.signatures[0].protected, "base64url").toString());
  assert.deepEqual(header, { alg: "ES256K", typ: "JOSE", kid, jku });
  assert.ok(card.signatures[0].header.jwk, "inline jwk kept");
  const jwks = jwksFor(pk, kid);
  assert.equal(jwks.keys[0].d, undefined, "JWKS must not contain the private key");
  assert.equal(jwks.keys[0].alg, "ES256K");
  const ok = await verifyAgentCard(card, { jwks });
  assert.equal(ok.valid, true);
  assert.equal(ok.jkuChecked, true);
  assert.equal((await verifyAgentCard(card)).jkuChecked, false);
  assert.equal((await verifyAgentCard(card, { jwks: jwksFor(pk, "other-kid") })).valid, false);
  assert.equal((await verifyAgentCard(card, { jwks: jwksFor(generatePrivateKey(), kid) })).valid, false);
  assert.equal((await verifyAgentCard(card, { jwks: { keys: [{ ...jwks.keys[0], alg: "ES256" }] } })).valid, false);
});

test("A-1: x402 exact authorization checks (signature, recipient, value, window)", async () => {
  const asset = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const payTo = "0x2BEb502a732F0986239d7B1C09B78fc0c6Ad41CC";
  const requirements = { scheme: "exact", network: `eip155:${CHAIN_ID}`, amount: "2000000", asset, payTo, maxTimeoutSeconds: 300, extra: { ...TOKEN_EIP712, assetTransferMethod: "eip3009" } };
  const now = 1_000_000n;
  const authorization = { from: addr, to: payTo, value: "2000000", validAfter: "0", validBefore: String(now + 300n), nonce: "0x" + "11".repeat(32) };
  const sign = (a, domainName = TOKEN_EIP712.name) =>
    privateKeyToAccount(pk).signTypedData({
      domain: { name: domainName, version: TOKEN_EIP712.version, chainId: CHAIN_ID, verifyingContract: asset },
      types: AUTH_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
    });
  const payload = (a, sig) => ({ x402Version: 2, accepted: requirements, payload: { signature: sig, authorization: a } });
  const sig = await sign(authorization);
  assert.equal((await checkExactAuthorization(payload(authorization, sig), requirements, now)).ok, true);
  const r = async (a, s2 = sig, t = now) => (await checkExactAuthorization(payload(a, s2), requirements, t)).reason;
  assert.equal(await r({ ...authorization, value: "1" }), "invalid_exact_evm_payload_authorization_value");
  assert.equal(await r({ ...authorization, to: addr }), "invalid_exact_evm_payload_recipient_mismatch");
  assert.equal(await r(authorization, sig, now + 296n), "invalid_exact_evm_payload_authorization_valid_before");
  assert.equal(await r({ ...authorization, validAfter: String(now + 10n) }), "invalid_exact_evm_payload_authorization_valid_after");
  assert.equal(await r({ ...authorization, nonce: "0x" + "22".repeat(32) }), "invalid_exact_evm_payload_signature");
  assert.equal(await r(authorization, await sign(authorization, "USD Coin")), "invalid_exact_evm_payload_signature");
  assert.equal((await checkExactAuthorization({ ...payload(authorization, sig), accepted: { ...requirements, scheme: "agentcoin-escrow" } }, requirements, now)).reason, "invalid_scheme_or_network");
});

test("A-6: open_job builds unsigned txs by default; server signing is an explicit flag", () => {
  const t = TOOLS.find((x) => x.name === "open_job");
  assert.ok(/unsigned/i.test(t.config.description));
  assert.ok(t.config.inputSchema.demoSign, "demoSign input present");
  assert.ok(t.config.outputSchema.transactions, "transactions output present");
  assert.deepEqual(t.config.outputSchema.mode.options, ["unsigned", "demo-signed"]);
});

test("E-1c/E-1d/A-1d/A-1e surface: interface.json and ABIs match the decisions", async () => {
  const { ABI, ADAPTER_STATES } = await import("../lib/config.mjs");
  const iface = JSON.parse(readFileSync(new URL("../../docs/interface.json", import.meta.url)));
  assert.equal(ADAPTER_STATES.at(-1), "ExpiryRefused");
  assert.deepEqual(iface.erc8183Adapter.states, ADAPTER_STATES);
  const tr = iface.erc8183Adapter.transitions;
  assert.ok(tr.some((t) => t.from === "Active" && t.to === "ExpiryRefused"));
  assert.ok(tr.some((t) => t.from === "Proposed" && t.to === "KernelEnded" && t.fn === "closeKernelEnded"));
  assert.ok(!/flag only/.test(iface.erc8183Adapter.expiryBound.lateSubmission), "no ExpiryRisk-only path");
  const routeFns = ABI.route.filter((x) => x.type === "function").map((x) => x.name);
  assert.ok(routeFns.includes("sweepTo") && routeFns.includes("creditAttested"));
  assert.ok(!routeFns.includes("refund"), "A-1e: no permissionless refund");
  const fFns = ABI.routeFactory.filter((x) => x.type === "function").map((x) => x.name);
  for (const fn of ["attestDeposit", "attested", "transferId", "isKeeper", "proposeKeeper", "cancelKeeper", "executeKeeper", "keeperTimelock"]) assert.ok(fFns.includes(fn), fn);
  assert.ok(!fFns.some((n) => /setKeeper/i.test(n)), "keeper changes only via timelock");
  assert.ok(!ABI.route.some((x) => x.type === "event" && x.name === "DepositRefunded"));
  assert.ok(iface.x402.accepts.some((a) => a.scheme === "exact-attest"));
  assert.ok(!iface.x402.accepts.some((a) => a.scheme === "exact-refund"));
  const sweepTo = ABI.route.find((x) => x.name === "sweepTo");
  assert.equal(sweepTo.stateMutability, "view");
  assert.ok(!ABI.route.some((x) => x.type === "function" && /setSweep/i.test(x.name)), "no sweep destination setter");
  assert.ok(!ABI.routeFactory.some((x) => x.type === "function" && /setSweep/i.test(x.name)));
  // v0.1.2: sweep destination is the factory's RecoveryVault (deployed by the constructor), not a parameter
  const ctor = ABI.routeFactory.find((x) => x.type === "constructor");
  const cfgIn = ctor.inputs.find((i) => i.name === "cfg");
  assert.deepEqual(cfgIn.components.map((c) => c.name), ["sweepDelay", "treasury", "recoveryHorizon", "keeperTimelock", "threshold"]);
  assert.ok(fFns.includes("vault"));
});

test("v0.1.2 k-of-n + RecoveryVault surface", async () => {
  const { ABI, KEEPER_KEYS } = await import("../lib/config.mjs");
  const iface = JSON.parse(readFileSync(new URL("../../docs/interface.json", import.meta.url)));
  const fFns = ABI.routeFactory.filter((x) => x.type === "function").map((x) => x.name);
  for (const fn of ["threshold", "keeperCount", "keeperEpoch", "claimOf", "hasAttested", "attestationDigest", "proposeThreshold", "executeThreshold", "cancelThreshold", "proposeResolution", "executeResolution", "cancelResolution", "lowThresholdAllowed"]) assert.ok(fFns.includes(fn), fn);
  const ev = (abi) => abi.filter((x) => x.type === "event").map((x) => x.name);
  for (const e of ["AttestationRecorded", "AttestationRoundReset", "DepositFrozen", "DepositResolved", "ThresholdSet", "DepositAttested"]) assert.ok(ev(ABI.routeFactory).includes(e), e);
  const att = ABI.routeFactory.find((x) => x.name === "attestDeposit");
  assert.deepEqual(att.outputs.map((o) => o.name), ["credited", "jobId", "refunded"]);
  const err = ABI.routeFactory.filter((x) => x.type === "error").map((x) => x.name);
  for (const e of ["ThresholdBelowTwoOnProductionChain", "DepositIsFrozen", "AlreadyVoted", "InvalidThreshold"]) assert.ok(err.includes(e), e);
  const vFns = ABI.vault.filter((x) => x.type === "function").map((x) => x.name);
  for (const fn of ["unclaimed", "totalUnclaimed", "releaseExpired", "releasableAt", "horizon", "treasury", "payout", "recordSweep"]) assert.ok(vFns.includes(fn), fn);
  assert.ok(!vFns.some((n) => /sweep(To)?Treasury|withdraw|rescue/i.test(n)), "no admin drain of the vault");
  assert.ok(ev(ABI.vault).includes("ReleasedToTreasury") && ev(ABI.vault).includes("Claimed"));
  assert.ok(ev(ABI.route).includes("FlushedToVault"));
  assert.equal(KEEPER_KEYS.length, 3);
  for (const s of ["exact-attest", "exact-resolve", "exact-sweep", "exact-recovery-vault", "exact-keeper"]) assert.ok(iface.x402.accepts.some((a) => a.scheme === s), s);
  assert.ok(!iface.x402.accepts.some((a) => a.scheme === "exact-committed"), "no exact-committed scheme (v0.1.2 decision 4)");
  assert.ok(iface.contracts.RecoveryVault);
});

test("v0.1.2 keeper finality: safe head = min(latest - depth, finalized)", async () => {
  const { safeHead, voteOutcome } = await import("../lib/keeper.mjs");
  assert.equal(safeHead({ latest: 100n, confirmations: 2n }), 98n);
  assert.equal(safeHead({ latest: 1n, confirmations: 2n }), -1n);
  assert.equal(safeHead({ latest: 100n, confirmations: 2n, finalized: 90n }), 90n);
  assert.equal(safeHead({ latest: 100n, confirmations: 12n, finalized: 95n }), 88n);
  assert.equal(safeHead({ latest: 100n, confirmations: 0n, finalized: null }), 100n);
  assert.equal(voteOutcome({ logs: [] }).kind, "vote-unknown");
});
