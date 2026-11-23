// LOCAL ONLY x402 `exact` keeper (ASSUMPTIONS A-1b, A-1e, v0.1.2 k-of-n). TRUSTED ROLE: only addresses
// allowlisted on EscrowDepositRouteFactory (deploy-time, then 48h-timelocked changes) can attest, and a
// deposit is credited only once `threshold` (k, default 2 of 3) distinct current keepers attested the
// SAME (route, from, value, refundOnly) for the same (txHash, logIndex). A mismatching attestation
// freezes the deposit on-chain (DepositFrozen); the owner resolves it through the timelock.
//
// Each keeper process runs this pass independently with its own key. For every Transfer log into a
// watched EscrowDepositRoute it verifies off-chain:
//   - FINALITY: the log's block is at or below the safe head = latest - confirmations, and also at or
//     below the RPC's `finalized` block when the chain supports that tag (skipped on Anvil 31337,
//     where `finalized` is meaningless; depth only). Logs above it are reported "pending-finality" and
//     revisited next pass (nextFromBlock never skips them);
//   - REORG CHECK: the receipt's blockHash equals the canonical block hash at that height right now;
//   - the receipt succeeded, and the log at (txHash, logIndex) is a Transfer emitted by the configured
//     token with to == route (from/value are decoded from the log, never taken from anyone else);
//   - the same transaction has no DepositSettled from that route (the atomic path already credited it);
//   - from != address(0) (mints are unattributable: left for the sweep into the RecoveryVault);
//   - the on-chain claim is not Credited / Frozen and this keeper has not voted in the current round.
// Then it votes factory.attestDeposit(offer, txHash, logIndex, from, value, refundOnly): value ==
// offer.amount opens the escrow job for `from` (refund if the job cannot open); any other value, or
// --refund, refunds `from`. The k-th matching vote credits; when the route no longer holds the
// funds (swept), the claim is paid from the RecoveryVault (always a refund).
// Reorg handling beyond the configured depth/finality is out of scope (see SECURITY-NOTES).
import { getAddress, parseEventLogs, zeroAddress } from "viem";
import { publicClient, read, send } from "./chain.mjs";
import { ABI } from "./config.mjs";
const LOCAL_CHAIN_ID = 31337;

export const CLAIM_STATUS = ["None", "Pending", "Credited", "Frozen"];
export const DEFAULT_CONFIRMATIONS = BigInt(process.env.AGENTCOIN_KEEPER_CONFIRMATIONS ?? 2);

/**
 * Pure: the highest block a keeper may act on. depth head = latest - confirmations (-1 if the chain
 * is shorter); if a `finalized` block number is known, the min of both.
 */
export function safeHead({ latest, confirmations, finalized = null }) {
  const depthHead = latest >= confirmations ? latest - confirmations : -1n;
  if (finalized === null || finalized === undefined) return depthHead;
  return finalized < depthHead ? finalized : depthHead;
}

/** Finality view of the connected chain: { latest, finalized|null, safe, source }. */
export async function finalityHead({ confirmations = DEFAULT_CONFIRMATIONS, useFinalizedTag } = {}) {
  const chainId = await publicClient.getChainId();
  const latest = await publicClient.getBlockNumber();
  const tryTag = useFinalizedTag ?? chainId !== LOCAL_CHAIN_ID; // Anvil: depth only
  let finalized = null;
  if (tryTag) {
    finalized = await publicClient
      .getBlock({ blockTag: "finalized" })
      .then((b) => b.number)
      .catch(() => null); // RPC without the tag: fall back to depth
  }
  return { latest, finalized, safe: safeHead({ latest, confirmations, finalized }), source: finalized === null ? "depth" : "finalized+depth" };
}

async function routeView(c, route) {
  const code = await publicClient.getCode({ address: route });
  const deployed = !!code && code !== "0x";
  const balance = await read(c.usdc, "balanceOf", [route]);
  return { deployed, balance };
}

/**
 * Off-chain verification of one Transfer log. Returns { ok, reason, from, value, blockNumber }.
 * `safe` (optional): highest block allowed (finality); logs above it return reason "pending-finality".
 */
export async function verifyTransferLog(c, route, txHash, logIndex, safe = null) {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt || receipt.status !== "success") return { ok: false, reason: "no-successful-receipt" };
  const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null);
  if (!canonical || canonical.hash !== receipt.blockHash) return { ok: false, reason: "reorged-out", blockNumber: receipt.blockNumber };
  const raw = receipt.logs.find((l) => Number(l.logIndex) === Number(logIndex));
  if (!raw || getAddress(raw.address) !== getAddress(c.usdc.address)) return { ok: false, reason: "log-not-from-token" };
  const [ev] = parseEventLogs({ abi: ABI.usdc, logs: [raw], eventName: "Transfer" });
  if (!ev) return { ok: false, reason: "not-a-transfer" };
  if (getAddress(ev.args.to) !== getAddress(route)) return { ok: false, reason: "not-to-route" };
  const base = { from: ev.args.from, value: ev.args.value, blockNumber: receipt.blockNumber };
  if (safe !== null && receipt.blockNumber > safe) return { ok: false, reason: "pending-finality", ...base };
  const routeLogs = receipt.logs.filter((l) => getAddress(l.address) === getAddress(route));
  const atomic = parseEventLogs({ abi: ABI.route, logs: routeLogs, eventName: "DepositSettled" }).length > 0;
  if (atomic) return { ok: false, reason: "atomic-settled", ...base };
  if (ev.args.from === zeroAddress) return { ok: false, reason: "unattributable-mint", ...base };
  return { ok: true, ...base, from: getAddress(ev.args.from) };
}

/** On-chain claim view for (txHash, logIndex) from this keeper's perspective. */
export async function claimView(c, txHash, logIndex, keeper) {
  const id = await read(c.routeFactory, "transferId", [txHash, logIndex]);
  const [cl, voted, k] = await Promise.all([
    read(c.routeFactory, "claimOf", [id]),
    keeper ? read(c.routeFactory, "hasAttested", [id, keeper]) : false,
    read(c.routeFactory, "threshold"),
  ]);
  return { id, status: CLAIM_STATUS[Number(cl.status)], count: Number(cl.count), epoch: cl.epoch, round: cl.round, voted, threshold: Number(k) };
}

/** Classify the receipt of one attestDeposit vote. */
export function voteOutcome(receipt) {
  const logs = receipt.logs;
  const [frozen] = parseEventLogs({ abi: ABI.routeFactory, logs, eventName: "DepositFrozen" });
  if (frozen) return { kind: "frozen", recordedDigest: frozen.args.recordedDigest, conflictingDigest: frozen.args.conflictingDigest };
  const [att] = parseEventLogs({ abi: ABI.routeFactory, logs, eventName: "DepositAttested" });
  if (att) {
    const kind = att.args.fromVault ? "credited-vault-refund" : att.args.refunded ? "credited-refund" : "credited-job";
    return { kind, jobId: att.args.jobId.toString(), refunded: att.args.refunded, fromVault: att.args.fromVault };
  }
  const [rec] = parseEventLogs({ abi: ABI.routeFactory, logs, eventName: "AttestationRecorded" });
  if (rec) return { kind: "vote-recorded", count: Number(rec.args.count), epoch: rec.args.epoch.toString() };
  return { kind: "vote-unknown" };
}

/**
 * One keeper pass.
 * @param {object} p
 * @param {object} p.c          contracts() handles
 * @param {object[]} p.offers   offers (EscrowDepositRouteFactory.Offer) whose routes are watched
 * @param {object} p.signer     viem wallet client of an allowlisted keeper
 * @param {bigint} [p.fromBlock]
 * @param {bigint} [p.confirmations]  finality depth (default AGENTCOIN_KEEPER_CONFIRMATIONS or 2)
 * @param {boolean} [p.useFinalizedTag] also bound by the RPC `finalized` tag (default: not on 31337)
 * @param {boolean} [p.startSweep] call startSweep() (keeper-only) on routes holding a balance after attesting
 * @param {boolean} [p.sweep]      call sweep() on routes whose sweep delay elapsed (into the RecoveryVault)
 * @param {boolean} [p.refund]     attest every deposit in refund mode (never open a job)
 */
export async function keeperPass({
  c,
  offers,
  signer,
  fromBlock = 0n,
  confirmations = DEFAULT_CONFIRMATIONS,
  useFinalizedTag,
  startSweep = false,
  sweep = false,
  refund = false,
}) {
  const fin = await finalityHead({ confirmations, useFinalizedTag });
  const me = signer.account.address;
  const routes = new Map();
  for (const o of offers) routes.set(getAddress(await read(c.routeFactory, "routeFor", [o])), o);
  const isKeeper = await read(c.routeFactory, "isKeeper", [me]);

  const logs = routes.size
    ? await publicClient.getContractEvents({ ...c.usdc, eventName: "Transfer", args: { to: [...routes.keys()] }, fromBlock, toBlock: fin.latest })
    : [];
  const actions = [];
  let next = fin.safe + 1n; // never skip a log that is not final yet
  if (next < fromBlock) next = fromBlock;
  for (const l of logs) {
    const route = getAddress(l.args.to);
    const o = routes.get(route);
    if (!o) continue;
    const txHash = l.transactionHash;
    const logIndex = BigInt(l.logIndex);
    const v = await verifyTransferLog(c, route, txHash, logIndex, fin.safe);
    const base = { route, tx: txHash, logIndex: logIndex.toString(), from: v.from ?? l.args.from, value: (v.value ?? l.args.value).toString() };
    if (!v.ok) {
      if (v.reason === "pending-finality" && l.blockNumber < next) next = l.blockNumber;
      actions.push({ kind: v.reason, ...base, ...(v.blockNumber !== undefined ? { block: v.blockNumber.toString(), safeHead: fin.safe.toString() } : {}) });
      continue;
    }
    const cv = await claimView(c, txHash, logIndex, me);
    if (cv.status === "Credited") {
      actions.push({ kind: "already-attested", ...base });
      continue;
    }
    if (cv.status === "Frozen") {
      actions.push({ kind: "frozen-awaiting-resolution", ...base });
      continue;
    }
    if (cv.voted) {
      actions.push({ kind: "already-voted", ...base, votes: `${cv.count}/${cv.threshold}` });
      continue;
    }
    if (!isKeeper) {
      actions.push({ kind: "not-keeper", ...base });
      continue;
    }
    const refundOnly = refund || v.value !== o.amount;
    try {
      const { hash, receipt } = await send(signer, c.routeFactory, "attestDeposit", [o, txHash, logIndex, v.from, v.value, refundOnly]);
      const out = voteOutcome(receipt);
      if (out.kind === "vote-recorded") out.votes = `${out.count}/${cv.threshold}`;
      actions.push({ ...base, ...out, attestTx: hash, refundOnly });
    } catch (e) {
      actions.push({ kind: "attest-failed", ...base, error: e.shortMessage ?? e.message });
    }
  }

  const now = (await publicClient.getBlock()).timestamp;
  const vaultAddr = await read(c.routeFactory, "vault");
  const vault = { address: vaultAddr, abi: ABI.vault };
  const report = [];
  for (const route of routes.keys()) {
    const { deployed, balance } = await routeView(c, route);
    const r = { route, deployed, balance: balance.toString(), sweepAmount: "0", sweepableAt: "0" };
    if (deployed) {
      const rc = { address: route, abi: ABI.route };
      let [amt, at] = await Promise.all([read(rc, "sweepAmount"), read(rc, "sweepableAt")]);
      if (sweep && at !== 0n && now >= at) {
        const { hash } = await send(signer, rc, "sweep");
        actions.push({ kind: "swept-to-vault", route, tx: hash, amount: (amt < balance ? amt : balance).toString() });
        [amt, at] = [0n, 0n];
      } else if (startSweep && isKeeper && at === 0n && balance > 0n) {
        const { hash } = await send(signer, rc, "startSweep");
        [amt, at] = await Promise.all([read(rc, "sweepAmount"), read(rc, "sweepableAt")]);
        actions.push({ kind: "sweep-started", route, tx: hash, amount: amt.toString(), sweepableAt: at.toString() });
      }
      const after = await routeView(c, route);
      Object.assign(r, { balance: after.balance.toString(), sweepAmount: amt.toString(), sweepableAt: at.toString() });
    }
    const [unclaimed, releasableAt] = await Promise.all([read(vault, "unclaimed", [route]), read(vault, "releasableAt", [route])]);
    Object.assign(r, { vaultUnclaimed: unclaimed.toString(), vaultReleasableAt: releasableAt.toString() });
    report.push(r);
  }
  return {
    keeper: me,
    isKeeper,
    finality: { latest: fin.latest.toString(), finalized: fin.finalized?.toString() ?? null, safeHead: fin.safe.toString(), confirmations: confirmations.toString(), source: fin.source },
    fromBlock: fromBlock.toString(),
    toBlock: fin.latest.toString(),
    actions,
    routes: report,
    nextFromBlock: next.toString(),
  };
}
