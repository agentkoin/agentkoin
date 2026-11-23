// AD-009 Phase 1: multi-stablecoin support (Base Sepolia testnet only). Pure helpers with injected chain reads so they
// can be tested without the service's SQLite stack.
//  - asset registry (USDC, EURC) with sources
//  - fxQuote: Uniswap v3 QuoterV2 (or MockSwapRouter) quote with expiry and minOut / maxIn
//  - swapRequirements: the extra "agentcoin-swap" 402 accepts entry (appended after the unchanged USDC entries)
//  - quoteHash: off-chain mirror of CrossCurrencySettler.quoteHash (EIP-3009 nonce the buyer signs)
//  - verifySwapPayload / settlementFromReceipt / paymentRecord
import { PUBLIC_CHAIN_ID } from "./network.mjs";
import { randomBytes } from "node:crypto";
import { encodeAbiParameters, keccak256, toBytes, getAddress, isAddress, parseAbi, parseEventLogs, parseSignature, verifyTypedData } from "viem";

export const SOURCES = {
  usdc: "https://developers.circle.com/stablecoins/usdc-contract-addresses",
  eurc: "https://developers.circle.com/stablecoins/eurc-contract-addresses",
  uniswapV3: "https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments",
};

export const BASE_SEPOLIA = Object.freeze({
  chainId: PUBLIC_CHAIN_ID,
  network: "eip155:84532",
  assets: Object.freeze({
    USDC: Object.freeze({ symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, eip712: { name: "USDC", version: "2" }, source: SOURCES.usdc }),
    EURC: Object.freeze({ symbol: "EURC", address: "0x808456652fdb597867f38412077A9182bf77359F", decimals: 6, eip712: { name: "EURC", version: "2" }, source: SOURCES.eurc }),
  }),
  uniswapV3: Object.freeze({
    factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    quoterV2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
    swapRouter02: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    eurcUsdcPool: "0x43047A302cD99DDb32E32B2886B40935b60aD2C1",
    poolFee: 500,
    source: SOURCES.uniswapV3,
  }),
});

export const QUOTE_TYPE =
  "AgentCoinQuote(uint256 chainId,address settler,address router,address buyer,address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,uint24 poolFee,uint64 expiry,bytes32 quoteId,address recipient,address escrow,address evaluator,uint64 deadlineSeconds,bytes32 specHash)";
export const QUOTE_TYPEHASH = keccak256(toBytes(QUOTE_TYPE));

const QUOTE_STRUCT = "(address buyer,address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,uint24 poolFee,uint64 expiry,bytes32 quoteId,address recipient,address escrow,address evaluator,uint64 deadlineSeconds,bytes32 specHash)";
export const SETTLER_ABI = parseAbi([
  `function settle(${QUOTE_STRUCT} q, (uint256 validAfter,uint256 validBefore,uint8 v,bytes32 r,bytes32 s) a) returns (bool swapped, uint256 amountOut, uint256 jobId)`,
  `function quoteHash(${QUOTE_STRUCT} q) view returns (bytes32)`,
  "function router() view returns (address)",
  "event CrossCurrencySettled(bytes32 indexed quoteHash, bytes32 indexed quoteId, address indexed buyer, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut, uint256 jobId)",
  "event SwapFailedRefunded(bytes32 indexed quoteHash, bytes32 indexed quoteId, address indexed buyer, address tokenIn, uint256 amountIn, bytes reason)",
]);
export const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
export const MOCK_ROUTER_ABI = parseAbi(["function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)"]);

/** Multi-asset config from env; null (feature off, 402 unchanged) unless MULTIASSET_SETTLER is set. */
export function multiAssetConfig(env = process.env) {
  const settler = env.MULTIASSET_SETTLER;
  const kind = env.MULTIASSET_ROUTER_KIND === "mock" ? "mock" : "uniswap-v3";
  const base = {
    routerKind: kind,
    router: env.MULTIASSET_ROUTER || BASE_SEPOLIA.uniswapV3.swapRouter02,
    poolFee: Number(env.MULTIASSET_POOL_FEE ?? BASE_SEPOLIA.uniswapV3.poolFee),
    slippageBps: Number(env.MULTIASSET_SLIPPAGE_BPS ?? 50),
    quoteTtlSeconds: Number(env.MULTIASSET_QUOTE_TTL_SECONDS ?? 300),
    quoteCacheSeconds: Number(env.MULTIASSET_402_QUOTE_CACHE_SECONDS ?? 60),
    maxQuoteAmount: BigInt(env.MULTIASSET_MAX_QUOTE_AMOUNT ?? 1_000_000_000n), // 1000 units (6 decimals)
  };
  if (!settler || !isAddress(settler)) return { ...base, settler: null, enabled: false };
  return { ...base, settler: getAddress(settler), enabled: true };
}

export function resolveAsset(x, chain = BASE_SEPOLIA) {
  if (typeof x !== "string" || !x) return null;
  const bySym = chain.assets[x.toUpperCase()];
  if (bySym) return bySym;
  if (!isAddress(x)) return null;
  return Object.values(chain.assets).find((a) => a.address.toLowerCase() === x.toLowerCase()) ?? null;
}

/** GET /v1/quote?from=&to=&amount=[&side=exactIn|exactOut]; amount in atomic units of `from` (exactIn) or `to` (exactOut). */
export function parseQuoteParams(sp, { maxQuoteAmount = 1_000_000_000n } = {}) {
  const from = resolveAsset(sp.get("from"));
  const to = resolveAsset(sp.get("to"));
  if (!from || !to) return { error: `from and to must be one of ${Object.keys(BASE_SEPOLIA.assets).join(", ")} (symbol or Base Sepolia address)` };
  const raw = sp.get("amount") ?? "";
  if (!/^[1-9][0-9]{0,18}$/.test(raw)) return { error: "amount must be a positive integer in atomic units (6 decimals: 10000 = 0.01)" };
  const amount = BigInt(raw);
  if (amount > maxQuoteAmount) return { error: `amount exceeds testnet quote cap ${maxQuoteAmount}` };
  const side = sp.get("side") ?? "exactIn";
  if (side !== "exactIn" && side !== "exactOut") return { error: "side must be exactIn or exactOut" };
  return { from, to, amount, side };
}

/** Decimal string of `num/den` with `dp` decimals (floor). */
export function ratio(num, den, dp = 8) {
  const s = ((num * 10n ** BigInt(dp)) / den).toString().padStart(dp + 1, "0");
  return `${s.slice(0, -dp)}.${s.slice(-dp)}`;
}

const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * Quote `amount` from -> to. `call({address, abi, functionName, args})` performs an eth_call (QuoterV2 is non-view but
 * simulated). Returns a factual quote object; amounts are atomic decimal strings.
 */
export async function fxQuote({ from, to, amount, side = "exactIn" }, { call, cfg, nowSec = Math.floor(Date.now() / 1000), id = () => "0x" + randomBytes(32).toString("hex") }) {
  let amountIn, amountOut, rateSource;
  if (from.address === to.address) {
    amountIn = amountOut = amount;
    rateSource = { kind: "identity" };
  } else if (cfg.routerKind === "mock") {
    if (side !== "exactIn") throw new QuoteError("mock router supports side=exactIn only");
    amountIn = amount;
    amountOut = await call({ address: cfg.router, abi: MOCK_ROUTER_ABI, functionName: "quoteExactInputSingle", args: [from.address, to.address, amount] });
    rateSource = { kind: "mock-router-owner-set-rate", router: cfg.router, note: "testnet MockSwapRouter; not a market price" };
  } else {
    const q = BASE_SEPOLIA.uniswapV3;
    if (side === "exactIn") {
      amountIn = amount;
      [amountOut] = await call({ address: q.quoterV2, abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn: from.address, tokenOut: to.address, amountIn: amount, fee: cfg.poolFee, sqrtPriceLimitX96: 0n }] });
    } else {
      amountOut = amount;
      [amountIn] = await call({ address: q.quoterV2, abi: QUOTER_V2_ABI, functionName: "quoteExactOutputSingle", args: [{ tokenIn: from.address, tokenOut: to.address, amount, fee: cfg.poolFee, sqrtPriceLimitX96: 0n }] });
    }
    rateSource = { kind: "uniswap-v3-quoterv2", quoter: q.quoterV2, router: q.swapRouter02, pool: q.eurcUsdcPool, poolFee: cfg.poolFee, source: q.source, note: "testnet pool; price set by testnet liquidity providers, not a reference FX rate" };
  }
  if (!amountIn || !amountOut) throw new QuoteError("no liquidity for this amount");
  const bps = BigInt(cfg.slippageBps);
  const minOut = side === "exactIn" ? (amountOut * (10_000n - bps)) / 10_000n : amountOut;
  const maxIn = side === "exactOut" ? ceilDiv(amountIn * (10_000n + bps), 10_000n) : amountIn;
  const expiry = nowSec + cfg.quoteTtlSeconds;
  return {
    quoteId: id(),
    network: BASE_SEPOLIA.network,
    side,
    from: { symbol: from.symbol, asset: from.address, amount: amountIn.toString() },
    to: { symbol: to.symbol, asset: to.address, amount: amountOut.toString() },
    rate: ratio(amountOut * 10n ** BigInt(from.decimals), amountIn * 10n ** BigInt(to.decimals)),
    rateUnit: `${to.symbol} per ${from.symbol}`,
    slippageBps: cfg.slippageBps,
    minOut: minOut.toString(),
    maxIn: maxIn.toString(),
    issuedAt: new Date(nowSec * 1000).toISOString(),
    expiry,
    expiresAt: new Date(expiry * 1000).toISOString(),
    rateSource,
    executableVia: cfg.enabled && rateSource.kind !== "identity" ? { scheme: "agentcoin-swap", settler: cfg.settler } : null,
  };
}

export class QuoteError extends Error {}

/** In-memory quote book (bounded). Quotes are only honoured at settle if issued here and unexpired. */
export class QuoteBook {
  constructor(max = 5000) {
    this.max = max;
    this.m = new Map();
    this.used = new Set();
  }
  put(q) {
    this.m.set(q.quoteId, q);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
    return q;
  }
  get(id, nowSec = Math.floor(Date.now() / 1000)) {
    const q = this.m.get(id);
    return q && q.expiry > nowSec ? q : null;
  }
  markUsed(h) {
    if (this.used.has(h)) return false;
    this.used.add(h);
    if (this.used.size > this.max * 4) this.used.clear();
    return true;
  }
}

/** Contract Quote struct for a buyer, from an issued 402 swap quote and the notary offer. */
export function settleQuote(q, buyer, offer) {
  return {
    buyer: getAddress(buyer),
    tokenIn: getAddress(q.from.asset),
    tokenOut: getAddress(q.to.asset),
    amountIn: BigInt(q.maxIn),
    minOut: BigInt(q.minOut),
    poolFee: q.rateSource.poolFee ?? 0,
    expiry: BigInt(q.expiry),
    quoteId: q.quoteId,
    recipient: getAddress(offer.provider),
    escrow: offer.escrow ? getAddress(offer.escrow) : "0x0000000000000000000000000000000000000000",
    evaluator: offer.escrow ? getAddress(offer.evaluator) : "0x0000000000000000000000000000000000000000",
    deadlineSeconds: offer.escrow ? BigInt(offer.deadlineSeconds) : 0n,
    specHash: offer.escrow ? offer.specHash : "0x" + "00".repeat(32),
  };
}

/** Mirror of CrossCurrencySettler.quoteHash: keccak256(abi.encode(TYPEHASH, chainId, settler, router, ...quote)). */
export function quoteHash(s, { chainId, settler, router }) {
  const t = ["bytes32", "uint256", "address", "address", "address", "address", "address", "uint256", "uint256", "uint24", "uint64", "bytes32", "address", "address", "address", "uint64", "bytes32"].map((type) => ({ type }));
  return keccak256(encodeAbiParameters(t, [QUOTE_TYPEHASH, BigInt(chainId), settler, router, s.buyer, s.tokenIn, s.tokenOut, s.amountIn, s.minOut, s.poolFee, s.expiry, s.quoteId, s.recipient, s.escrow, s.evaluator, s.deadlineSeconds, s.specHash]));
}

/** Client side: the settler Quote struct a buyer signs for a 402 agentcoin-swap entry (inverse of swapRequirements). */
export function swapStructFromEntry(e, buyer) {
  const q = e.extra.quote;
  const st = e.extra.settlement;
  if (!q || !st) throw new Error("agentcoin-swap entry without extra.quote/extra.settlement (read the JSON body, not the header copy)");
  const zero = "0x0000000000000000000000000000000000000000";
  const escrow = st.escrowContract ? getAddress(st.escrowContract) : zero;
  return {
    buyer: getAddress(buyer),
    tokenIn: getAddress(e.asset),
    tokenOut: getAddress(q.tokenOut),
    amountIn: BigInt(e.amount),
    minOut: BigInt(q.minOut),
    poolFee: Number(q.poolFee ?? 0),
    expiry: BigInt(q.expiry),
    quoteId: q.quoteId,
    recipient: getAddress(st.provider),
    escrow,
    evaluator: escrow === zero ? zero : getAddress(st.evaluator),
    deadlineSeconds: escrow === zero ? 0n : BigInt(st.deadlineSeconds),
    specHash: escrow === zero ? "0x" + "00".repeat(32) : st.specHash,
  };
}

export const RECEIVE_AUTH_TYPES = { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };

/**
 * The extra 402 accepts entry: buyer pays `from` (EURC) via EIP-3009 ReceiveWithAuthorization to the settler, seller
 * receives `to` (USDC) as a JobEscrow job (escrow mode). `q` is an exactOut quote for the notary price.
 */
export function swapRequirements(q, { cfg, offer, links, responseSchemaHash, maxTimeoutSeconds = 300 }) {
  const from = resolveAsset(q.from.asset);
  return {
    scheme: "agentcoin-swap",
    network: q.network,
    amount: q.maxIn,
    asset: from.address,
    payTo: cfg.settler,
    maxTimeoutSeconds,
    extra: {
      name: from.eip712.name,
      version: from.eip712.version,
      assetTransferMethod: "eip3009-receiveWithAuthorization",
      responseSchemaHash,
      responseSchemaUrl: links.notarizeSchema,
      quote: { quoteId: q.quoteId, tokenOut: q.to.asset, tokenOutSymbol: q.to.symbol, minOut: q.minOut, quotedIn: q.from.amount, rate: q.rate, rateUnit: q.rateUnit, slippageBps: q.slippageBps, expiry: q.expiry, expiresAt: q.expiresAt, rateSource: q.rateSource.kind, pool: q.rateSource.pool ?? null, poolFee: q.rateSource.poolFee ?? null },
      settlement: { settler: cfg.settler, router: cfg.router, routerKind: cfg.routerKind, escrowContract: offer.escrow, provider: offer.provider, evaluator: offer.evaluator, deadlineSeconds: offer.deadlineSeconds, specHash: offer.specHash, onSwapFailure: "tokenIn returned to buyer in the same transaction" },
      nonce: { kind: "CrossCurrencySettler.quoteHash", type: QUOTE_TYPE, encoding: "keccak256(abi.encode(typehash, chainId, settler, router, buyer, tokenIn, tokenOut, amountIn, minOut, poolFee, expiry, quoteId, recipient, escrow, evaluator, deadlineSeconds, specHash))", buyer: "authorization.from" },
      quoteUrl: links.quote,
      schemeSpec: "buyer signs EIP-3009 ReceiveWithAuthorization(from=buyer, to=payTo, value=amount, validAfter, validBefore, nonce=quoteHash); PAYMENT-SIGNATURE payload = {quoteId, authorization:{from,to,value,validAfter,validBefore,nonce}, signature}; relayer calls settler.settle (pays gas)",
    },
  };
}

/**
 * Header copy of the swap entry (all 402 response headers < 6 KB): EIP-712 token name/version and the quote id, minOut
 * and expiry only. Signing needs the full quote terms (quoteHash inputs), which are in the JSON body entry.
 */
export function slimSwapForHeader(e) {
  const { name, version, quote } = e.extra;
  return { ...e, extra: { name, version, quote: { quoteId: quote.quoteId, minOut: quote.minOut, expiry: quote.expiry } } };
}

/** Pre-flight checks before spending relayer gas. Returns {isValid, invalidReason} or {isValid, payer, quote, struct, auth, hash}. */
export async function verifySwapPayload(pp, { book, cfg, offer, chainId, nowSec = Math.floor(Date.now() / 1000), verify = verifyTypedData }) {
  const pl = pp?.payload ?? {};
  const au = pl.authorization ?? {};
  const q = book.get(pl.quoteId, nowSec);
  if (!q) return { isValid: false, invalidReason: "quote unknown or expired; request a fresh 402" };
  if (q.expiry - nowSec < 15) return { isValid: false, invalidReason: "quote expires in under 15 s; request a fresh 402" };
  if (!isAddress(au.from ?? "") || !isAddress(au.to ?? "")) return { isValid: false, invalidReason: "authorization.from/to required" };
  if (getAddress(au.to) !== cfg.settler) return { isValid: false, invalidReason: "authorization.to must be the settler (payTo)" };
  if (String(au.value) !== q.maxIn) return { isValid: false, invalidReason: `authorization.value must equal amount ${q.maxIn}` };
  if (!(Number(au.validBefore) > nowSec + 15)) return { isValid: false, invalidReason: "authorization.validBefore too soon" };
  if (Number(au.validAfter ?? 0) > nowSec) return { isValid: false, invalidReason: "authorization not yet valid" };
  const struct = settleQuote(q, au.from, offer);
  const hash = quoteHash(struct, { chainId, settler: cfg.settler, router: cfg.router });
  if (String(au.nonce).toLowerCase() !== hash) return { isValid: false, invalidReason: `authorization.nonce must be quoteHash ${hash}` };
  let sig;
  try {
    sig = parseSignature(pl.signature);
  } catch {
    return { isValid: false, invalidReason: "signature must be a 65-byte hex ECDSA signature" };
  }
  const from = resolveAsset(q.from.asset);
  const ok = await verify({
    address: getAddress(au.from),
    domain: { name: from.eip712.name, version: from.eip712.version, chainId, verifyingContract: from.address },
    types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "ReceiveWithAuthorization",
    message: { from: getAddress(au.from), to: cfg.settler, value: BigInt(au.value), validAfter: BigInt(au.validAfter ?? 0), validBefore: BigInt(au.validBefore), nonce: hash },
    signature: pl.signature,
  }).catch(() => false);
  if (!ok) return { isValid: false, invalidReason: "invalid ReceiveWithAuthorization signature" };
  const v = sig.v !== undefined ? Number(sig.v) : 27 + Number(sig.yParity);
  return { isValid: true, payer: getAddress(au.from), quote: q, struct, hash, auth: { validAfter: BigInt(au.validAfter ?? 0), validBefore: BigInt(au.validBefore), v, r: sig.r, s: sig.s } };
}

/** Parse a settle() receipt into {swapped, ...}. */
export function settlementFromReceipt(receipt, settler) {
  const logs = receipt.logs.filter((l) => l.address?.toLowerCase() === settler.toLowerCase());
  const ok = parseEventLogs({ abi: SETTLER_ABI, logs, eventName: "CrossCurrencySettled" })[0];
  if (ok) return { swapped: true, amountIn: ok.args.amountIn, amountOut: ok.args.amountOut, jobId: ok.args.jobId, quoteHash: ok.args.quoteHash };
  const ref = parseEventLogs({ abi: SETTLER_ABI, logs, eventName: "SwapFailedRefunded" })[0];
  if (ref) return { swapped: false, refunded: true, amountIn: ref.args.amountIn, reason: ref.args.reason, quoteHash: ref.args.quoteHash };
  return null;
}

/** agentcoin.payment for a job opened before the record was stored (GET /v1/notarize/{id}), rebuilt from the
 * settle tx's CrossCurrencySettled event only. Quote-time fields (quotedRate, rateSource, minOut) are not on-chain and are omitted. */
export function paymentFromReceipt(receipt, settler, jobId) {
  const logs = receipt.logs.filter((l) => l.address?.toLowerCase() === settler.toLowerCase());
  const ev = parseEventLogs({ abi: SETTLER_ABI, logs, eventName: "CrossCurrencySettled" })[0];
  if (!ev || (jobId != null && ev.args.jobId.toString() !== String(jobId))) return null;
  const from = resolveAsset(ev.args.tokenIn) ?? { symbol: null, address: getAddress(ev.args.tokenIn), decimals: null };
  const to = resolveAsset(ev.args.tokenOut) ?? { symbol: null, address: getAddress(ev.args.tokenOut), decimals: null };
  const paid = BigInt(ev.args.amountIn);
  const recv = BigInt(ev.args.amountOut);
  return {
    scheme: "agentcoin-swap",
    paid: { symbol: from.symbol, asset: from.address, amount: paid.toString() },
    received: { symbol: to.symbol, asset: to.address, amount: recv.toString(), into: "JobEscrow job (client = buyer)" },
    ...(from.decimals != null && to.decimals != null ? { executedRate: ratio(recv * 10n ** BigInt(from.decimals), paid * 10n ** BigInt(to.decimals)) } : {}),
    quoteId: ev.args.quoteId,
    quoteHash: ev.args.quoteHash,
    settler: getAddress(settler),
    settleTx: receipt.transactionHash,
    recordSource: "CrossCurrencySettled event in settleTx",
  };
}

/** Payment record attached to the paid response (agentcoin.payment) and PAYMENT-RESPONSE: both assets, rate, source, quote id. */
export function paymentRecord(q, s, { transaction, settler }) {
  const from = resolveAsset(q.from.asset);
  const to = resolveAsset(q.to.asset);
  const paid = BigInt(s.amountIn);
  const recv = BigInt(s.amountOut);
  return {
    scheme: "agentcoin-swap",
    paid: { symbol: from.symbol, asset: from.address, amount: paid.toString() },
    received: { symbol: to.symbol, asset: to.address, amount: recv.toString(), into: "JobEscrow job (client = buyer)" },
    executedRate: ratio(recv * 10n ** BigInt(from.decimals), paid * 10n ** BigInt(to.decimals)),
    quotedRate: q.rate,
    rateUnit: q.rateUnit,
    rateSource: q.rateSource,
    quoteId: q.quoteId,
    quoteHash: s.quoteHash,
    minOut: q.minOut,
    settler,
    settleTx: transaction,
  };
}
