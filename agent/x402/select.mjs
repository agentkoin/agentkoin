// Balance-aware x402 accept selection (AD-010 6.3). The reference @x402/core x402Client (2.31.0) filters accepts[] by
// registered network/scheme, paymentFlow, spend controls and policies, then its default selector returns accepts[0]
// with no balance check (dist/cjs/client/index.js: `(x402Version, accepts) => accepts[0]`). This selector keeps the
// server's order but skips `exact` entries whose asset balance is below the amount.
import { getAddress } from "viem";

/**
 * @param accepts   402 accepts[]
 * @param balanceOf async (asset) => bigint, the payer's balance of that asset
 * @param opts.network CAIP-2 network the client pays on; opts.allowedAssets optional asset allowlist
 * @returns { entry, index, balances } or { entry: null, reason, balances }
 */
export async function selectPayableExact(accepts, balanceOf, { network, allowedAssets = null } = {}) {
  const allow = allowedAssets ? new Set(allowedAssets.map((a) => getAddress(a))) : null;
  const balances = {};
  for (let i = 0; i < accepts.length; i++) {
    const a = accepts[i];
    if (a?.scheme !== "exact" || (network && a.network !== network)) continue;
    const asset = getAddress(a.asset);
    if (allow && !allow.has(asset)) continue;
    if (!(asset in balances)) balances[asset] = await balanceOf(asset);
    if (balances[asset] >= BigInt(a.amount)) return { entry: a, index: i, balances };
  }
  return { entry: null, reason: "no exact entry with a sufficient balance", balances };
}

/** x402Client-compatible paymentRequirementsSelector built from pre-read balances ({[asset]: bigint}). */
export function balanceAwareSelector(balances) {
  const bal = Object.fromEntries(Object.entries(balances).map(([k, v]) => [getAddress(k), BigInt(v)]));
  return (_x402Version, accepts) => accepts.find((a) => a.scheme !== "exact" || (bal[getAddress(a.asset)] ?? 0n) >= BigInt(a.amount)) ?? accepts[0];
}
