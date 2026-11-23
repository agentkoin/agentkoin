// Local Anvil only: mint MockUSDC to demo actors and stake the demo evaluator. Idempotent-ish.
import { privateKeyToAccount } from "viem/accounts";
import { assertChain, contracts, wallet, send, read, usdc6, publicClient } from "../lib/chain.mjs";
import { ANVIL_KEYS } from "../lib/config.mjs";
import { operatorKey } from "../lib/keys.mjs";

await assertChain();
const c = contracts();
const deployer = wallet(ANVIL_KEYS.deployer);
const addr = (k) => privateKeyToAccount(ANVIL_KEYS[k]).address;

for (const who of ["client", "provider", "evaluator"]) {
  const bal = await read(c.usdc, "balanceOf", [addr(who)]);
  if (bal < usdc6(1000)) await send(deployer, c.usdc, "mint", [addr(who), usdc6(10_000)]);
}
const ev = wallet(ANVIL_KEYS.evaluator);
const info = await read(c.registry, "evaluatorInfo", [ev.account.address]);
if (info.stake === 0n) {
  await send(ev, c.usdc, "approve", [c.registry.address, usdc6(200)]);
  await send(ev, c.registry, "stake", [usdc6(200)]);
}
// Throwaway operator: give it local gas via Anvil cheat RPC (no real value).
try {
  const op = operatorKey();
  await publicClient.request({ method: "anvil_setBalance", params: [op.address, "0x56BC75E2D63100000"] }); // 100 ETH (local)
} catch (e) {
  console.error(`operator not funded: ${e.message}`);
}
const after = await read(c.registry, "evaluatorInfo", [ev.account.address]);
console.log(JSON.stringify({ evaluator: ev.account.address, stake: after.stake.toString(), client: addr("client"), provider: addr("provider") }));
