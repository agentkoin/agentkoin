import { createPublicClient, createWalletClient, http, defineChain, parseEventLogs, encodeFunctionData, keccak256 } from "viem";
import { retryTx } from "./txretry.mjs";
import { baseSepolia, base as baseMainnet } from "viem/chains";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { RPC_URL, CHAIN_ID, NETWORK, NET, MAX_LOG_RANGE, AGENT_DIR, loadDeployment, ABI, isLoopback } from "./config.mjs";

const base = NETWORK === "base-sepolia" ? baseSepolia : NETWORK === "base" ? baseMainnet : { nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } };
export const chain = defineChain({ ...base, id: CHAIN_ID, name: NET.name, rpcUrls: { default: { http: [RPC_URL] } } });
/** @deprecated name kept for older imports */
export const anvil = chain;

// cacheTime 0: getBlockNumber must not return a cached (stale) head; indexer toBlock depends on it.
// Public RPC: small retry with backoff on 429/5xx.
export const publicClient = createPublicClient({ chain, transport: http(RPC_URL, { retryCount: 4, retryDelay: 400 }), cacheTime: 0 });

export async function assertChain() {
  const id = await publicClient.getChainId();
  if (id !== CHAIN_ID) throw new Error(`connected chainId ${id} != ${CHAIN_ID} (${NETWORK})`);
  return id;
}

export function wallet(privateKey) {
  // Public load-balanced RPCs can serve a stale pending nonce right after a receipt; track nonces locally there.
  const account = isLoopback(RPC_URL) ? privateKeyToAccount(privateKey) : privateKeyToAccount(privateKey, { nonceManager });
  return createWalletClient({ account, chain, transport: http(RPC_URL, { retryCount: 2, retryDelay: 400 }) });
}

export function contracts() {
  const d = loadDeployment();
  return {
    d,
    escrow: { address: d.escrow, abi: ABI.escrow },
    registry: { address: d.registry, abi: ABI.registry },
    usdc: { address: d.usdc, abi: ABI.usdc },
    arbitrator: { address: d.arbitrator, abi: ABI.arbitrator },
    identity: { address: d.identityRegistry, abi: ABI.identity },
    adapter: { address: d.adapter, abi: ABI.adapter },
    kernel: { address: d.externalKernel, abi: ABI.kernel },
    routeFactory: { address: d.depositRouteFactory, abi: ABI.routeFactory },
    vault: { address: d.recoveryVault, abi: ABI.vault },
  };
}

/**
 * EIP-1559 fee overrides for testnet writes: maxFee = 2 * baseFee + priority, priority = eth_maxPriorityFeePerGas
 * capped at 0.001 gwei (Base Sepolia reports 1e6 wei; an anvil fork reports 1 gwei, which would distort a rehearsal).
 * local network: {} (viem defaults).
 */
export async function feeOverrides() {
  if (NETWORK === "local") return {};
  const [blk, prio] = await Promise.all([publicClient.getBlock(), publicClient.estimateMaxPriorityFeePerGas()]);
  const maxPriorityFeePerGas = prio > 1_000_000n ? 1_000_000n : prio;
  return { maxPriorityFeePerGas, maxFeePerGas: blk.baseFeePerGas * 2n + maxPriorityFeePerGas };
}

/** Send a contract write and wait for the receipt. Throws on revert (simulated first, so a revert costs no gas). */
export async function send(w, c, functionName, args = []) {
  // Simulation only (no broadcast) is retried briefly on public RPCs, where a lagging node may not yet see the
  // previous receipt's state. The broadcast itself is sent exactly once.
  let request;
  for (let i = 0; ; i++) {
    try {
      ({ request } = await publicClient.simulateContract({ ...c, functionName, args, account: w.account, ...(await feeOverrides()) }));
      break;
    } catch (e) {
      if (isLoopback(RPC_URL) || i >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  const hash = await w.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, receipt, costWei: txCostWei(receipt) };
}

/**
 * Idempotent variant of send() for job-lifecycle writes (see lib/txretry.mjs): signs once, retries only transient
 * errors, re-reads the job via opts.isDone() before every retry, never re-signs a tx that was broadcast (a dropped
 * one is rebroadcast byte-identical: same nonce, same hash). Returns {hash, receipt, costWei, skipped, ours, attempts}.
 */
export async function sendIdempotent(w, c, functionName, args = [], opts = {}) {
  const ops = {
    isDone: opts.isDone ?? (async () => ({ done: false })),
    async prepare() {
      let request;
      for (let i = 0; ; i++) {
        try {
          ({ request } = await publicClient.simulateContract({ ...c, functionName, args, account: w.account, ...(await feeOverrides()) }));
          break;
        } catch (e) {
          if (isLoopback(RPC_URL) || i >= 3) throw e;
          await new Promise((r) => setTimeout(r, 2500));
        }
      }
      const data = encodeFunctionData({ abi: c.abi, functionName, args });
      const { maxFeePerGas, maxPriorityFeePerGas, gas } = request;
      const prepared = await w.prepareTransactionRequest({ account: w.account, chain: w.chain, to: c.address, data, value: 0n, ...(gas ? { gas } : {}), ...(maxFeePerGas ? { maxFeePerGas, maxPriorityFeePerGas } : {}) });
      const raw = await w.signTransaction(prepared);
      return { raw, hash: keccak256(raw), nonce: prepared.nonce };
    },
    broadcast: (raw) => w.sendRawTransaction({ serializedTransaction: raw }),
    async receipt(hash, timeoutMs) {
      if (!timeoutMs) {
        try {
          return await publicClient.getTransactionReceipt({ hash });
        } catch (e) {
          if (e?.name === "TransactionReceiptNotFoundError") return null;
          throw e;
        }
      }
      try {
        return await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
      } catch (e) {
        if (e?.name === "WaitForTransactionReceiptTimeoutError") return null;
        throw e;
      }
    },
    async known(hash) {
      try {
        return !!(await publicClient.getTransaction({ hash }));
      } catch (e) {
        if (e?.name === "TransactionNotFoundError") return false;
        throw e;
      }
    },
    resetNonce: () => w.account.nonceManager?.reset({ address: w.account.address, chainId: CHAIN_ID }),
  };
  const log = opts.log ?? ((ev) => console.log(JSON.stringify({ t: new Date().toISOString(), evt: "tx-attempt", fn: functionName, ...ev })));
  const out = await retryTx(ops, { label: opts.label ?? functionName, deadline: opts.deadline, policy: opts.policy, log });
  return { ...out, costWei: out.receipt ? txCostWei(out.receipt) : 0n };
}

/** Total fee paid by a tx: L2 execution (gasUsed * effectiveGasPrice) plus the OP-stack L1 data fee when reported. */
export const txCostWei = (r) => BigInt(r.gasUsed ?? 0n) * BigInt(r.effectiveGasPrice ?? 0n) + BigInt(r.l1Fee ?? 0n);

export const read = (c, functionName, args = []) => publicClient.readContract({ ...c, functionName, args });

// ---------------- event reads (chunked + cached) ----------------
// Public RPCs cap eth_getLogs ranges (sepolia.base.org: 200 blocks). Logs per contract address are cached
// under agent/.cache/<chainId>/<address>.json ({toBlock, logs}) so each call only fetches new blocks.
// Loopback RPCs (Anvil / fork) are not cached.
const CACHE_DIR = path.join(AGENT_DIR, ".cache", String(CHAIN_ID));
const ser = (l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: String(l.blockNumber), transactionHash: l.transactionHash, logIndex: Number(l.logIndex), blockHash: l.blockHash, transactionIndex: Number(l.transactionIndex) });
const de = (l) => ({ ...l, blockNumber: BigInt(l.blockNumber), removed: false });

export async function rawLogsChunked(address, fromBlock, toBlock) {
  const step = MAX_LOG_RANGE > 0 ? BigInt(MAX_LOG_RANGE) : null;
  if (!step) return publicClient.getLogs({ address, fromBlock, toBlock });
  const ranges = [];
  for (let b = fromBlock; b <= toBlock; b += step) ranges.push([b, b + step - 1n > toBlock ? toBlock : b + step - 1n]);
  const out = [];
  const CONC = 3;
  for (let i = 0; i < ranges.length; i += CONC) {
    const part = await Promise.all(ranges.slice(i, i + CONC).map(([f, t]) => publicClient.getLogs({ address, fromBlock: f, toBlock: t })));
    for (const p of part) out.push(...p);
  }
  return out;
}

/** All raw logs of `address` from fromBlock to toBlock (inclusive). */
export async function rawLogs(address, fromBlock, toBlock) {
  if (isLoopback(RPC_URL)) return rawLogsChunked(address, fromBlock, toBlock);
  const file = path.join(CACHE_DIR, `${address.toLowerCase()}.json`);
  let cache = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  if (!cache || BigInt(cache.fromBlock) > fromBlock) cache = { fromBlock: String(fromBlock), toBlock: String(fromBlock - 1n), logs: [] };
  const have = BigInt(cache.toBlock);
  if (have < toBlock) {
    const fresh = await rawLogsChunked(address, have + 1n, toBlock);
    cache.logs.push(...fresh.map(ser));
    cache.toBlock = String(toBlock);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(cache));
  }
  return cache.logs.map(de).filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
}

/** Decoded contract events (getContractEvents replacement that respects the RPC log-range cap). `args` filters after decoding. */
export async function contractEvents(c, { fromBlock, toBlock, args } = {}) {
  const to = toBlock ?? (await publicClient.getBlockNumber());
  const logs = await rawLogs(c.address, fromBlock ?? 0n, to);
  let ev = parseEventLogs({ abi: c.abi, logs, strict: false });
  if (args) {
    const eq = (a, b) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);
    ev = ev.filter((l) => Object.entries(args).every(([k, v]) => (Array.isArray(v) ? v.some((x) => eq(l.args?.[k], x)) : eq(l.args?.[k], v))));
  }
  return ev;
}

/** Local-only time travel helper (Anvil RPC). */
export async function increaseTime(seconds) {
  await publicClient.request({ method: "evm_increaseTime", params: [seconds] });
  await publicClient.request({ method: "evm_mine", params: [] });
}

/** Local-only: mine n empty blocks (Anvil RPC), e.g. to reach the keeper confirmation depth. */
export async function mine(n = 1) {
  for (let i = 0; i < n; i++) await publicClient.request({ method: "evm_mine", params: [] });
}

export const usdc6 = (n) => BigInt(Math.round(n * 1e6));
export const fmt6 = (v) => (Number(v) / 1e6).toFixed(6);
