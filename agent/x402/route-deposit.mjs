// Helpers to recover an escrow job after a third-party facilitator (e.g. Dexter)
// has already submitted EIP-3009 transferWithAuthorization to an EscrowDepositRoute.
// Does not replace factory.settle for unused authorizations.
import { getAddress, parseEventLogs } from "viem";

const TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
];

/** Find the USDC Transfer into `route` that matches from+value on a successful receipt. */
export function findUsdcTransferToRoute(receipt, { token, route, from, value }) {
  if (!receipt || receipt.status !== "success") return null;
  const tokenA = getAddress(token);
  const routeA = getAddress(route);
  const fromA = getAddress(from);
  const want = BigInt(value);
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== tokenA) continue;
    const [ev] = parseEventLogs({ abi: TRANSFER_ABI, logs: [log], eventName: "Transfer" });
    if (!ev) continue;
    if (getAddress(ev.args.to) !== routeA) continue;
    if (getAddress(ev.args.from) !== fromA) continue;
    if (BigInt(ev.args.value) !== want) continue;
    return { logIndex: Number(log.logIndex), from: fromA, to: routeA, value: want, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
  }
  return null;
}

export function jobCreatedFromReceipt(receipt, escrowAbi) {
  if (!receipt || receipt.status !== "success") return null;
  const evs = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "JobCreated" });
  return evs[0] ?? null;
}

export function depositAttestedFromReceipt(receipt, factoryAbi) {
  if (!receipt || receipt.status !== "success") return null;
  const evs = parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: "DepositAttested" });
  return evs[0] ?? null;
}

/** Extra tx hashes a client may attach after a facilitator settle / keeper attest (ignored by unused-nonce settle). */
export function attachedTxHashes(paymentPayload) {
  const p = paymentPayload?.payload ?? {};
  const xs = [p.transaction, p.txHash, p.settleTx, p.attestTx, paymentPayload?.transaction].filter(Boolean);
  return [...new Set(xs.map(String))];
}
