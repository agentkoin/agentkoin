// Verifies agent/artifacts/* (or a given file) against signatures and the local chain. Exit 1 on any failure.
// Usage: node scripts/verify-artifacts.mjs [file.json ...] [--tamper]
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_DIR, ARTIFACTS_DIR } from "../lib/config.mjs";
import { verifyDocument } from "../lib/verify.mjs";

const dir = ARTIFACTS_DIR;
const load = (f) => JSON.parse(readFileSync(f, "utf8"));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const tamper = process.argv.includes("--tamper");

const docs = args.length
  ? args.map((f) => [f, load(f)])
  : [
      ["agent-registration.json+sig", { document: load(path.join(dir, "agent-registration.json")), signature: load(path.join(dir, "agent-registration.sig.json")).signature }],
      ["agent-card.json", load(path.join(dir, "agent-card.json"))],
      ["trust-manifest.json", load(path.join(dir, "trust-manifest.json"))],
    ];

// The card's jku points at the local server, which may not be running yet; use the JWKS file written next to it.
const jwksPath = path.join(dir, "jwks.json");
const localJwks = (() => { try { return load(jwksPath); } catch { return undefined; } })();
let ok = true;
const signers = new Set();
for (const [name, doc] of docs) {
  const r = await verifyDocument(doc, { jwks: localJwks });
  ok &&= r.valid;
  signers.add(r.signer);
  console.log(`${r.valid ? "VALID  " : "INVALID"} ${name} (${r.kind}) signer=${r.signer}`);
  for (const ch of r.checks) if (!ch.pass || process.env.VERBOSE) console.log(`   ${ch.pass ? "ok  " : "FAIL"} ${ch.check}: ${ch.detail}`);
  console.log(`   ${r.checks.filter((x) => x.pass).length}/${r.checks.length} checks passed`);
  if (tamper) {
    const t = structuredClone(doc);
    if (t.document) t.document.description += " ";
    else if (t.fees) t.fees.feeBps = 0;
    else t.description += " ";
    const rt = await verifyDocument(t, { jwks: localJwks });
    console.log(`   tampered copy -> ${rt.valid ? "VALID (unexpected)" : "INVALID (expected)"}`);
    if (rt.valid) ok = false;
  }
}
if (!args.length) {
  const same = signers.size === 1;
  console.log(`${same ? "ok  " : "FAIL"} all artifacts signed by one operator key: ${[...signers].join(", ")}`);
  ok &&= same;
}
process.exit(ok ? 0 : 1);
