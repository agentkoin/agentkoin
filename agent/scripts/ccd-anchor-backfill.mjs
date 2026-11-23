// Anchor settled job(s) on Concordium testnet using the SAME code path as the service (frozen proof core -> queue -> RegisterData).
//   AGENTCOIN_NETWORK=base-sepolia CCD_ANCHOR_KEY_FILE=../.secrets/ccd-anchor.json SERVICE_STATE_DIR=<dir> node scripts/ccd-anchor-backfill.mjs <jobId> [jobId...] [--out DIR]
// Sends ONE testnet RegisterData tx per job that is not already anchored. Prints public values only. Needs Concordium testnet CCD on the sender.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../service/app.mjs";

const args = process.argv.slice(2);
const oi = args.indexOf("--out");
const out = oi >= 0 ? args.splice(oi, 2)[1] : null;
const ids = args.filter((a) => /^\d+$/.test(a));
if (!ids.length || !process.env.CCD_ANCHOR_KEY_FILE) { console.error("usage: CCD_ANCHOR_KEY_FILE=... node scripts/ccd-anchor-backfill.mjs <jobId...> [--out DIR]"); process.exit(2); }
const app = createApp({ publicUrl: process.env.AGENTCOIN_BASE_URL ?? "https://agentcoinhq.com", loopMs: 1e9, ccdAnchor: { noTimer: true } });
const escrow = (await import("../lib/job-proof.mjs")).ESCROWS ? Object.keys((await import("../lib/job-proof.mjs")).ESCROWS).find((a) => /4eaf6d09/i.test(a)) : null;
const { getAddress } = await import("viem");
const esc = getAddress(escrow ?? "0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D");
for (const id of ids) {
  const p = await app.buildJobProof(esc, id);
  if (!p) { console.log(`job ${id}: not found`); continue; }
  console.log(`job ${id}: state ${p.job.state}${p.anchors ? ", anchor " + p.anchors.concordium.status : ", NOT settled (no anchor)"}`);
}
const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  const steps = await app.ccd.tick();
  for (const s of steps) console.log(`  ${s.k.split(":")[1]}: ${s.step}${s.txHash ? " " + s.txHash : ""}${s.error ? " " + s.error : ""}`);
  const pend = app.ccd.store.all().filter(([, r]) => ids.includes(r.jobId) && r.status !== "finalized" && r.status !== "failed");
  if (!pend.length) break;
  await new Promise((r) => setTimeout(r, 6000));
}
for (const id of ids) {
  const p = await app.buildJobProof(esc, id);
  const a = p?.anchors?.concordium;
  console.log(`job ${id}: anchor ${a?.status ?? "none"} tx ${a?.txHash ?? "-"} block ${a?.blockHash ?? "-"} height ${a?.blockHeight ?? "-"} sender ${a?.sender ?? "-"}`);
  if (out && p) { mkdirSync(out, { recursive: true }); writeFileSync(path.join(out, `proof-${id}.json`), JSON.stringify(p, null, 2)); }
}
await app.stop();
process.exit(0);
