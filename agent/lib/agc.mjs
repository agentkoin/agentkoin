// AD-010 (AGC) service helpers. Pure functions; everything is off unless AGC_ADDRESS, AGC_ESCROW, AGC_ROUTE_FACTORY
// and AGC_ADAPTER are all valid addresses. With AGC off the 402, header and receipts are exactly v0.5.15.
import { getAddress, isAddress, parseAbi } from "viem";

export const AGC_EIP712 = Object.freeze({ name: "AgentCoin", version: "1" }); // must match src/AGC.sol (ERC20Permit("AgentCoin"))
export const AGC_SYMBOL = "AGC";
export const AGC_ABI = parseAbi([
  "function USDC() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address,bytes32) view returns (bool)",
  "function backing() view returns (uint256 reserve, uint256 supply)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const addr = (v) => (typeof v === "string" && isAddress(v) ? getAddress(v) : null);

/** Env: AGC_ADDRESS, AGC_ESCROW, AGC_ROUTE_FACTORY, AGC_ADAPTER, AGC_FIRST (default 0), AGC_SWAP_OUT (default 1). */
export function agcConfig(env = process.env) {
  const address = addr(env.AGC_ADDRESS);
  const escrow = addr(env.AGC_ESCROW);
  const routeFactory = addr(env.AGC_ROUTE_FACTORY);
  const adapter = addr(env.AGC_ADAPTER);
  const enabled = !!(address && escrow && routeFactory && adapter);
  return Object.freeze({ enabled, address, escrow, routeFactory, adapter, first: enabled && env.AGC_FIRST === "1", swapOut: enabled && env.AGC_SWAP_OUT !== "0" });
}

/** asset-table entry, same shape as multiasset BASE_SEPOLIA.assets.* */
export const agcAsset = (cfg) => ({ symbol: AGC_SYMBOL, address: cfg.address, decimals: 6, eip712: { ...AGC_EIP712 } });

/**
 * `exact` entry in AGC: the USDC exact entry's shape with asset/payTo/EIP-712 domain/escrow/factory swapped for the AGC
 * stack. `usdcExact` is the live exactRequirements() output (not modified); fee values come from the AGC escrow.
 */
export function agcExactRequirements(usdcExact, { cfg, payTo, feeBps, evaluatorFeeBps, evaluatorStake, evaluatorActive, reserveUrl }) {
  const ag = usdcExact.extra.agentcoin;
  return {
    ...usdcExact,
    asset: cfg.address,
    payTo: getAddress(payTo),
    extra: {
      ...usdcExact.extra,
      name: AGC_EIP712.name,
      version: AGC_EIP712.version,
      agentcoin: {
        ...ag,
        depositRouteFactory: cfg.routeFactory,
        escrowContract: cfg.escrow,
        evaluatorStake,
        evaluatorActive,
        feeBps,
        evaluatorFeeBps,
        backing: { asset: "USDC", ratio: "1:1", reserveUrl },
      },
    },
  };
}

/** Header copy of the AGC exact entry (6.2): fields a standard x402 exact client signs with, plus the escrow pointers. */
export function slimAgcForHeader(e) {
  const { name, version, assetTransferMethod, responseSchemaHash, agentcoin: a } = e.extra;
  return {
    scheme: e.scheme, network: e.network, amount: e.amount, asset: e.asset, payTo: e.payTo, maxTimeoutSeconds: e.maxTimeoutSeconds,
    extra: { name, version, assetTransferMethod, responseSchemaHash, agentcoin: { depositRouteFactory: a.depositRouteFactory, escrowContract: a.escrowContract, offer: a.offer, feeBps: a.feeBps, relayerPaysGas: a.relayerPaysGas, backing: a.backing } },
  };
}

export const isAgcExact = (e, cfg) => !!cfg?.enabled && e?.scheme === "exact" && !!e.asset && getAddress(e.asset) === cfg.address;

/** accepts[] order: AGC_FIRST=1 puts AGC exact first; otherwise it follows the USDC exact entry. */
export function orderAccepts({ usdcExact, agcExact, escrow, swap = [] }, cfg) {
  if (!agcExact) return [usdcExact, escrow, ...swap];
  return cfg.first ? [agcExact, usdcExact, escrow, ...swap] : [usdcExact, agcExact, escrow, ...swap];
}

/** Swap entry with AGC out: on-chain tokenOut stays USDC (the pool and the quoteHash use it); the adapter wraps 1:1. */
export function agcSwapEntry(e, cfg) {
  return { ...e, extra: { ...e.extra, settlement: { ...e.extra.settlement, escrowContract: cfg.adapter, receivedAs: { symbol: AGC_SYMBOL, asset: cfg.address, ratio: "1:1", wrapper: cfg.adapter, escrow: cfg.escrow } } } };
}

/** agentcoin.payment for an AGC exact payment. */
export function agcExactPaymentRecord({ cfg, amount, transaction, jobId }) {
  return { scheme: "exact", paid: { symbol: AGC_SYMBOL, asset: cfg.address, amount: String(amount) }, received: { symbol: AGC_SYMBOL, asset: cfg.address, amount: String(amount), into: `AGC JobEscrow job ${jobId} (client = payer)` }, escrow: cfg.escrow, settleTx: transaction };
}

/** EURC->AGC swap: the settler reports USDC out; the adapter wrapped it 1:1 into AGC and opened the AGC escrow job. */
export function agcSwapPaymentRecord(rec, cfg) {
  return { ...rec, received: { ...rec.received, symbol: AGC_SYMBOL, asset: cfg.address, into: "AGC JobEscrow job (client = buyer)", wrappedFrom: { symbol: "USDC", asset: rec.received.asset, ratio: "1:1", wrapper: cfg.adapter } }, escrow: cfg.escrow };
}

/** GET /v1/agc body. reserve and supply are read at the same block. */
export async function agcReserve({ cfg, usdc, readAt, blockNumber }) {
  const [reserve, supply] = await Promise.all([readAt(usdc, "balanceOf", [cfg.address], blockNumber), readAt(cfg.address, "totalSupply", [], blockNumber)]);
  return {
    contract: cfg.address,
    kind: "wrapper over USDC, redeemable 1:1",
    usdc,
    wrapFunctions: ["wrap(uint256)", "wrapTo(address,uint256)", "wrapWithPermit(uint256,uint256,uint8,bytes32,bytes32)", "wrapWithAuthorization(address,uint256,uint256,uint256,bytes32,bytes)"],
    wrapFeeBps: 0,
    unwrapFeeBps: 0,
    holderYield: "none",
    admin: "none",
    blockNumber: blockNumber.toString(),
    reserve: reserve.toString(),
    supply: supply.toString(),
    surplus: (reserve - supply).toString(),
    fullyBacked: reserve >= supply,
    redeemFunctions: ["unwrap(uint256)", "unwrapTo(address,uint256)", "unwrapWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)"],
    sourceCalls: ["USDC.balanceOf(contract)", "contract.totalSupply()"],
  };
}

/** /v1/quote?to=AGC: an EURC->USDC quote plus an identity step USDC->AGC. Returns the rewritten params and a decorator. */
export function agcQuoteParams(sp, cfg, usdcAddress) {
  if (!cfg.enabled) return null;
  const to = sp.get("to");
  if (!to || !(to.toUpperCase() === AGC_SYMBOL || (isAddress(to) && getAddress(to) === cfg.address))) return null;
  const p = new URLSearchParams(sp);
  p.set("to", usdcAddress);
  const decorate = (q) => ({ ...q, to: { ...q.to, symbol: AGC_SYMBOL, asset: cfg.address, via: { symbol: "USDC", asset: usdcAddress, step: "AGC.wrapTo 1:1 (AGCSettlerAdapter)" } }, rateSource: { ...q.rateSource, kind: `${q.rateSource.kind}+agc-wrap-1:1` } });
  return { params: p, decorate };
}
