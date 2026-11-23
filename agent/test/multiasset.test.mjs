// AD-009 Phase 1 service tests (no SQLite, no network unless LIVE_RPC=1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { headerCopy, HEADER_LIMIT_BYTES } from "../lib/header402.mjs";
import { createPublicClient, http, encodeAbiParameters, encodeEventTopics, getAddress, toFunctionSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  BASE_SEPOLIA, QUOTE_TYPEHASH, SETTLER_ABI, QuoteBook, fxQuote, parseQuoteParams, quoteHash, ratio, resolveAsset,
  settleQuote, slimSwapForHeader, swapStructFromEntry, swapRequirements, verifySwapPayload, settlementFromReceipt, paymentRecord, paymentFromReceipt, multiAssetConfig,
} from "../lib/multiasset.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const fx = (f) => path.join(HERE, "fixtures", f);
const { USDC, EURC } = BASE_SEPOLIA.assets;
const SETTLER = "0x1111111111111111111111111111111111111111";
const cfg = { ...multiAssetConfig({ MULTIASSET_SETTLER: SETTLER }), slippageBps: 50, quoteTtlSeconds: 300 };
const NOW = 1_763_200_000;
const links = { notarizeSchema: "https://agentcoinhq.com/v1/notarize/schema.json", quote: "https://agentcoinhq.com/v1/quote" };
const offer = { escrow: "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D", provider: "0x745528C4E0CBdA5759175A660da06d0aaA72db7F", evaluator: "0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a", deadlineSeconds: 3600, specHash: "0x6b4542f5b8f5c0e6a332f4fed6c1f840db2e26fa2840a194664bee75c49504db" };
const SCHEMA_HASH = "sha256:1f66a3f25ebe5a9e7167a150bf6a3d3a808e0042206c5491516425821c2f4586";
// Values observed on Base Sepolia QuoterV2 (block ~58983124): 10000 EURC -> 10169 USDC; exactOut 10000 USDC needs ~9834 EURC.
const fakeCall = async ({ functionName, args }) => {
  if (functionName === "quoteExactInputSingle") return [(args[0].amountIn * 10169n) / 10000n, 0n, 0, 0n];
  if (functionName === "quoteExactOutputSingle") return [(args[0].amount * 10000n + 10168n) / 10169n, 0n, 0, 0n];
  throw new Error("unexpected " + functionName);
};
const sp = (o) => new URLSearchParams(o);

test("multiAssetConfig: off unless MULTIASSET_SETTLER is a valid address", () => {
  assert.equal(multiAssetConfig({}).enabled, false);
  assert.equal(multiAssetConfig({ MULTIASSET_SETTLER: "nope" }).enabled, false);
  const c = multiAssetConfig({ MULTIASSET_SETTLER: SETTLER });
  assert.equal(c.enabled, true);
  assert.equal(c.router, BASE_SEPOLIA.uniswapV3.swapRouter02);
  assert.equal(c.poolFee, 500);
});

test("resolveAsset / parseQuoteParams", () => {
  assert.equal(resolveAsset("eurc"), EURC);
  assert.equal(resolveAsset(EURC.address.toLowerCase()), EURC);
  assert.equal(resolveAsset("DAI"), null);
  assert.ok(parseQuoteParams(sp({ from: "EURC", to: "DAI", amount: "1" })).error);
  assert.ok(parseQuoteParams(sp({ from: "EURC", to: "USDC", amount: "0" })).error);
  assert.ok(parseQuoteParams(sp({ from: "EURC", to: "USDC", amount: "1.5" })).error);
  assert.ok(parseQuoteParams(sp({ from: "EURC", to: "USDC", amount: "1000000001" })).error);
  assert.ok(parseQuoteParams(sp({ from: "EURC", to: "USDC", amount: "1", side: "x" })).error);
  const ok = parseQuoteParams(sp({ from: "EURC", to: "usdc", amount: "10000" }));
  assert.deepEqual([ok.from.symbol, ok.to.symbol, ok.amount, ok.side], ["EURC", "USDC", 10000n, "exactIn"]);
});

test("fxQuote exactIn: amounts, minOut, rate, expiry, source", async () => {
  const q = await fxQuote({ from: EURC, to: USDC, amount: 10_000n, side: "exactIn" }, { call: fakeCall, cfg, nowSec: NOW, id: () => "0x" + "ab".repeat(32) });
  assert.equal(q.from.amount, "10000");
  assert.equal(q.to.amount, "10169");
  assert.equal(q.minOut, ((10169n * 9950n) / 10000n).toString());
  assert.equal(q.maxIn, "10000");
  assert.equal(q.rate, "1.01690000");
  assert.equal(q.rateUnit, "USDC per EURC");
  assert.equal(q.expiry, NOW + 300);
  assert.equal(q.expiresAt, new Date((NOW + 300) * 1000).toISOString());
  assert.equal(q.rateSource.kind, "uniswap-v3-quoterv2");
  assert.equal(q.rateSource.pool, "0x43047A302cD99DDb32E32B2886B40935b60aD2C1");
  assert.deepEqual(q.executableVia, { scheme: "agentcoin-swap", settler: SETTLER });
});

test("fxQuote exactOut: maxIn carries the slippage buffer, minOut = requested out", async () => {
  const q = await fxQuote({ from: EURC, to: USDC, amount: 10_000n, side: "exactOut" }, { call: fakeCall, cfg, nowSec: NOW });
  assert.equal(q.to.amount, "10000");
  assert.equal(q.minOut, "10000");
  const quotedIn = BigInt(q.from.amount);
  assert.equal(BigInt(q.maxIn), (quotedIn * 10050n + 9999n) / 10000n);
  assert.match(q.quoteId, /^0x[0-9a-f]{64}$/);
});

test("fxQuote identity and ratio helper", async () => {
  const q = await fxQuote({ from: USDC, to: USDC, amount: 5n }, { call: fakeCall, cfg, nowSec: NOW });
  assert.equal(q.rate, "1.00000000");
  assert.equal(q.executableVia, null);
  assert.equal(ratio(1n, 3n, 4), "0.3333");
});

test("quoteHash matches the Solidity encoding (vector from cast abi-encode + keccak)", () => {
  assert.equal(QUOTE_TYPEHASH, "0x4c068b99c0b81cb9c063faae13371164e46a24cbc73cc6b767b5a8f0d981b9cd");
  const s = { buyer: "0x2222222222222222222222222222222222222222", tokenIn: EURC.address, tokenOut: USDC.address, amountIn: 10223n, minOut: 10000n, poolFee: 500, expiry: 1763200000n, quoteId: "0x" + "ab".repeat(32), recipient: offer.provider, escrow: offer.escrow, evaluator: offer.evaluator, deadlineSeconds: 3600n, specHash: offer.specHash };
  assert.equal(quoteHash(s, { chainId: 84532, settler: SETTLER, router: BASE_SEPOLIA.uniswapV3.swapRouter02 }), "0x746b905d23bc626b01faaa65939f3ad5aeb5e526524383c0e1914b288a0a8c94");
});

test("SETTLER_ABI matches the forge artifact", { skip: !existsSync(path.join(ROOT, "out/CrossCurrencySettler.sol/CrossCurrencySettler.json")) }, () => {
  const art = JSON.parse(readFileSync(path.join(ROOT, "out/CrossCurrencySettler.sol/CrossCurrencySettler.json"), "utf8")).abi;
  for (const item of SETTLER_ABI) {
    const a = art.find((x) => x.type === item.type && x.name === item.name);
    assert.ok(a, item.name);
    assert.equal(toFunctionSignature(a), toFunctionSignature(item), item.name);
  }
});

// ---- 402 shape ----
const live = JSON.parse(readFileSync(fx("v0.5.12-notarize-402.json"), "utf8"));
const swapEntry = async () => {
  const q = await fxQuote({ from: EURC, to: USDC, amount: 10_000n, side: "exactOut" }, { call: fakeCall, cfg, nowSec: NOW });
  return { q, e: swapRequirements(q, { cfg, offer, links, responseSchemaHash: SCHEMA_HASH }) };
};

test("402: existing USDC entries are byte-identical to live v0.5.12; EURC entry is appended", async () => {
  const { e } = await swapEntry();
  const accepts = [...live.accepts.slice(0, 2), e]; // app.mjs paymentRequired(): [exact, escrow, ...swapAccepts()]
  assert.equal(JSON.stringify(accepts[0]), JSON.stringify(live.accepts[0]));
  assert.equal(JSON.stringify(accepts[1]), JSON.stringify(live.accepts[1]));
  const ex = live.accepts[0];
  assert.deepEqual([ex.scheme, ex.payTo, ex.amount, ex.asset], ["exact", "0x6A32bC3Bb5eA1dc814f14E29e6f026535129A84f", "10000", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"]);
  assert.deepEqual([live.accepts[1].scheme, live.accepts[1].asset, live.accepts[1].amount], ["agentcoin-escrow", USDC.address, "10000"]);
  assert.equal(e.scheme, "agentcoin-swap");
  assert.equal(e.asset, EURC.address);
  assert.equal(e.payTo, SETTLER);
  assert.equal(e.network, "eip155:84532");
  assert.equal(e.extra.name, "EURC");
  assert.equal(e.extra.quote.tokenOut, USDC.address);
  assert.equal(e.extra.quote.minOut, "10000");
  assert.ok(e.extra.quote.expiry > NOW);
  assert.equal(e.extra.responseSchemaHash, live.accepts[0].extra.responseSchemaHash);
  assert.equal(e.extra.settlement.escrowContract, live.accepts[0].extra.agentcoin.escrowContract);
  assert.equal(e.extra.settlement.provider, live.accepts[0].extra.agentcoin.offer.provider);
});

test("402: exactRequirements/escrowRequirements source unchanged vs the v0.5.12 commit", () => {
  const cur = readFileSync(path.join(ROOT, "agent/service/app.mjs"), "utf8");
  let old;
  try {
    old = execFileSync("git", ["-C", ROOT, "show", "6637cc3:agent/service/app.mjs"], { encoding: "utf8" });
  } catch {
    return; // no git history available (e.g. inside the image)
  }
  const body = (s, name) => {
    const i = s.indexOf(`async function ${name}(`);
    return s.slice(i, s.indexOf("\n  }\n", i));
  };
  // AD-011 (v0.5.16) threads only the buyer-chosen evaluator through as an optional parameter; with no argument
  // notaryOffer() is the v0.5.12 offer, so normalizing the parameter must give the v0.5.12 source exactly.
  const norm = (src) => src.replace(/^async function (\w+)\((?:chosen|ev) = null\)/, "async function $1()").replace(/notaryOffer\((?:chosen|ev)\)/g, "notaryOffer()");
  for (const n of ["exactRequirements", "escrowRequirements"]) assert.equal(norm(body(cur, n)), body(old, n), n);
});

test("402: all response headers <= 6,144 - 256 B with the v0.5.15 header copy (measured on live v0.5.14 headers)", async () => {
  // Fixtures: curl -sD of an unpaid POST /v1/notarize against v0.5.14 (headers incl. Caddy's alt-svc/via) and its JSON body.
  const raw = readFileSync(fx("v0.5.14-notarize-402.headers.txt"), "utf8");
  const body = JSON.parse(readFileSync(fx("v0.5.14-notarize-402.json"), "utf8"));
  const old = raw.match(/^payment-required: (\S+)\r?$/im)[1];
  const oldHdr = JSON.parse(Buffer.from(old, "base64").toString("utf8"));
  assert.equal(Buffer.byteLength(raw), 5990); // v0.5.14 live total
  const { e } = await swapEntry();
  const pr = { ...body, accepts: [body.accepts[0], body.accepts[1], e] };
  delete pr.testnet; delete pr.realValue;
  const hdr = { ...headerCopy(pr), testnet: true, realValue: false }; // app.mjs: b64(label(headerPR(pr)))
  const b64 = Buffer.from(JSON.stringify(hdr)).toString("base64");
  const total = Buffer.byteLength(raw) - old.length + b64.length;
  assert.equal(HEADER_LIMIT_BYTES, 5888);
  assert.ok(total <= HEADER_LIMIT_BYTES, `all headers ${total} bytes (PAYMENT-REQUIRED ${b64.length})`);
  // USDC exact and agentcoin-escrow entries byte-identical to the live v0.5.14 header and body
  assert.equal(JSON.stringify(hdr.accepts[0]), JSON.stringify(oldHdr.accepts[0]));
  assert.equal(JSON.stringify(hdr.accepts[1]), JSON.stringify(oldHdr.accepts[1]));
  assert.equal(JSON.stringify(hdr.accepts[0]), JSON.stringify(body.accepts[0]));
  assert.deepEqual([hdr.accepts[0].payTo, hdr.accepts[0].amount, hdr.accepts[0].asset], ["0x6A32bC3Bb5eA1dc814f14E29e6f026535129A84f", "10000", USDC.address]);
  assert.deepEqual(hdr.accepts.map((a) => a.scheme), ["exact", "agentcoin-escrow"]);
  assert.deepEqual(hdr.bodyOnly, ["extensions.bazaar.info.output.example", "extensions.agentcoin-escrow", "accepts.agentcoin-swap"]);
  assert.deepEqual(hdr.resource, oldHdr.resource);
  assert.deepEqual(hdr.extensions, oldHdr.extensions);
  // without a swap entry (settler unset or no quote) the header lists nothing extra
  assert.deepEqual(headerCopy({ ...pr, accepts: pr.accepts.slice(0, 2) }).bodyOnly, oldHdr.bodyOnly);
});

// ---- payment payload checks ----
const buyer = privateKeyToAccount("0x" + "11".repeat(32));
async function signedPayload(q, over = {}) {
  const struct = settleQuote(q, buyer.address, offer);
  const nonce = quoteHash(struct, { chainId: 84532, settler: SETTLER, router: cfg.router });
  const authorization = { from: buyer.address, to: SETTLER, value: q.maxIn, validAfter: "0", validBefore: String(NOW + 600), nonce, ...over };
  const signature = await buyer.signTypedData({
    domain: { name: "EURC", version: "2", chainId: 84532, verifyingContract: EURC.address },
    types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "ReceiveWithAuthorization",
    message: { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce },
  });
  return { x402Version: 2, accepted: { scheme: "agentcoin-swap", network: "eip155:84532" }, payload: { quoteId: q.quoteId, authorization, signature } };
}

test("verifySwapPayload: valid payload, then rejections", async () => {
  const book = new QuoteBook();
  const { q } = await swapEntry();
  book.put(q);
  const ctx = { book, cfg, offer, chainId: 84532, nowSec: NOW };
  const v = await verifySwapPayload(await signedPayload(q), ctx);
  assert.equal(v.isValid, true, v.invalidReason);
  assert.equal(v.payer, buyer.address);
  assert.equal(v.struct.minOut, 10000n);
  assert.equal(v.struct.escrow, getAddress(offer.escrow));
  assert.ok([27, 28].includes(v.auth.v));
  assert.equal(book.markUsed(v.hash), true);
  assert.equal(book.markUsed(v.hash), false);

  assert.match((await verifySwapPayload(await signedPayload(q, { value: "1" }), ctx)).invalidReason, /value/);
  assert.match((await verifySwapPayload(await signedPayload(q, { to: offer.provider }), ctx)).invalidReason, /settler/);
  assert.match((await verifySwapPayload(await signedPayload(q, { nonce: "0x" + "00".repeat(32) }), ctx)).invalidReason, /quoteHash/);
  const bad = await signedPayload(q);
  bad.payload.authorization.from = "0x2222222222222222222222222222222222222222";
  assert.match((await verifySwapPayload(bad, ctx)).invalidReason, /quoteHash|signature/);
  assert.match((await verifySwapPayload(await signedPayload(q), { ...ctx, nowSec: q.expiry + 1 })).invalidReason, /expired/);
  const unknown = await signedPayload(q);
  unknown.payload.quoteId = "0x" + "cd".repeat(32);
  assert.match((await verifySwapPayload(unknown, ctx)).invalidReason, /unknown/);
});

test("settlementFromReceipt + paymentRecord: both assets, rate, source, quote id", async () => {
  const { q } = await swapEntry();
  const qh = "0x" + "77".repeat(32);
  const mk = (eventName, args, data) => ({ address: SETTLER, topics: encodeEventTopics({ abi: SETTLER_ABI, eventName, args }), data });
  const okLog = mk("CrossCurrencySettled", { quoteHash: qh, quoteId: q.quoteId, buyer: buyer.address }, encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [EURC.address, BigInt(q.maxIn), USDC.address, 10_021n, 42n]));
  const s = settlementFromReceipt({ logs: [okLog] }, SETTLER);
  assert.deepEqual([s.swapped, s.amountOut, s.jobId], [true, 10_021n, 42n]);
  const r = paymentRecord(q, s, { transaction: "0xabc", settler: SETTLER });
  assert.deepEqual(r.paid, { symbol: "EURC", asset: EURC.address, amount: q.maxIn });
  assert.equal(r.received.symbol, "USDC");
  assert.equal(r.received.amount, "10021");
  assert.equal(r.quoteId, q.quoteId);
  assert.equal(r.quoteHash, qh);
  assert.equal(r.rateSource.kind, "uniswap-v3-quoterv2");
  assert.ok(r.executedRate && r.quotedRate);
  const refLog = mk("SwapFailedRefunded", { quoteHash: qh, quoteId: q.quoteId, buyer: buyer.address }, encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [EURC.address, BigInt(q.maxIn), "0x"]));
  const f = settlementFromReceipt({ logs: [refLog] }, SETTLER);
  assert.deepEqual([f.swapped, f.refunded], [false, true]);
  assert.equal(settlementFromReceipt({ logs: [{ ...okLog, address: offer.provider }] }, SETTLER), null);
  // GET /v1/notarize/{id} backfill for jobs settled before v0.5.15 (no stored record)
  const b = paymentFromReceipt({ logs: [okLog], transactionHash: "0xdef" }, SETTLER, "42");
  assert.deepEqual([b.scheme, b.paid.symbol, b.paid.amount, b.received.symbol, b.received.amount, b.quoteId, b.quoteHash, b.settleTx], ["agentcoin-swap", "EURC", q.maxIn, "USDC", "10021", q.quoteId, qh, "0xdef"]);
  assert.equal(b.executedRate, r.executedRate);
  assert.equal(paymentFromReceipt({ logs: [okLog] }, SETTLER, "41"), null); // other job
  assert.equal(paymentFromReceipt({ logs: [refLog] }, SETTLER, "42"), null); // refund: no job
});

test("live Base Sepolia QuoterV2 quote (LIVE_RPC=1 only)", { skip: process.env.LIVE_RPC !== "1" }, async () => {
  const pc = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const q = await fxQuote({ from: EURC, to: USDC, amount: 10_000n, side: "exactIn" }, { call: (a) => pc.readContract(a), cfg });
  assert.ok(BigInt(q.to.amount) > 0n);
  const qo = await fxQuote({ from: EURC, to: USDC, amount: 10_000n, side: "exactOut" }, { call: (a) => pc.readContract(a), cfg });
  assert.equal(qo.to.amount, "10000");
  console.log("live quote", q.from.amount, "EURC ->", q.to.amount, "USDC; exactOut 10000 USDC needs", qo.from.amount, "EURC (maxIn", qo.maxIn + ")");
});

test("client swapStructFromEntry + quoteHash round-trips through server verifySwapPayload", async () => {
  const book = new QuoteBook();
  const { q, e } = await swapEntry();
  book.put(q);
  const struct = swapStructFromEntry(e, buyer.address);
  assert.deepEqual(struct, settleQuote(q, buyer.address, offer));
  const nonce = quoteHash(struct, { chainId: 84532, settler: SETTLER, router: e.extra.settlement.router });
  const p = await signedPayload(q);
  assert.equal(p.payload.authorization.nonce, nonce);
  assert.equal((await verifySwapPayload(p, { book, cfg, offer, chainId: 84532, nowSec: NOW })).isValid, true);
  assert.throws(() => swapStructFromEntry(slimSwapForHeader(e), buyer.address), /JSON body/);
});
