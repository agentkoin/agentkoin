// Sign + submit ONE Agent Registry transaction built by the Concordium Agent Registry MCP (build_register, build_set_agent_uri, ...).
//   CCD_ANCHOR_KEY_FILE=... node scripts/ccd-registry-tx.mjs <build-output.json>
// Submits exactly once through the wallet-proxy and trusts only the proxy's submissionId; never retries (a retry could mint twice). Prints public values only.
import { readFileSync } from "node:fs";
import * as sdk from "@concordium/web-sdk";
const W = process.env.CCD_PROXY_URL ?? "https://wallet-proxy.testnet.concordium.com";
const b = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (b.network !== "testnet") throw new Error("testnet only");
const k = JSON.parse(readFileSync(process.env.CCD_ANCHOR_KEY_FILE, "utf8"));
if (b.sender !== k.address) throw new Error("build sender is not our account");
const { nonce } = await (await fetch(`${W}/v0/accNonce/${k.address}`)).json();
const tx = sdk.Transaction.updateContract({ amount: sdk.CcdAmount.zero(), address: sdk.ContractAddress.create(BigInt(b.contract_address.index), BigInt(b.contract_address.subindex)), receiveName: sdk.ReceiveName.fromString(b.receive_name), message: sdk.Parameter.fromHexString(b.parameter_hex) }, sdk.Energy.create(b.suggested_energy))
  .addMetadata({ sender: sdk.AccountAddress.fromBase58(k.address), nonce: sdk.SequenceNumber.create(nonce), expiry: sdk.TransactionExpiry.futureMinutes(10) }).build();
const fin = await sdk.Transaction.signAndFinalize(tx, sdk.buildBasicAccountSigner(k.privateKey));
const r = await fetch(`${W}/v0/submitRawTransaction`, { method: "PUT", body: Buffer.from(sdk.Transaction.serializeBlockItem(fin)) });
if (!r.ok) { console.log("submit failed", r.status, (await r.text()).slice(0, 200)); process.exit(1); }
const { submissionId } = await r.json();
console.log(b.receive_name, "nonce", nonce, "tx", submissionId);
for (let i = 0; i < 40; i++) {
  await new Promise((x) => setTimeout(x, 3000));
  const s = await (await fetch(`${W}/v0/submissionStatus/${submissionId}`)).json();
  if (s.status === "finalized") { console.log("finalized", s.outcome, "cost(microCCD)", s.cost, "block", s.blockHashes?.[0]); process.exit(s.outcome === "success" ? 0 : 1); }
}
console.log("not finalized after 2 minutes; check status of", submissionId, "- do NOT resubmit blindly");
