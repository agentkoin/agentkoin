// Builds and signs: ERC-8004 registration (+ EIP-191 sidecar), A2A agent card (JWS ES256K), trust manifest (EIP-191).
// local: registers in the MockIdentityRegistry on Anvil. Public testnet: reads the ERC-8004 agentId from the
// deployment file (registered by scripts/sepolia-v04.mjs). Writes the network's artifacts dir.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { parseEventLogs } from "viem";
import { assertChain, contracts, wallet, send, read } from "../lib/chain.mjs";
import { ARTIFACTS_DIR, NETWORK, ROOT, roleKey } from "../lib/config.mjs";
import { operatorKey } from "../lib/keys.mjs";
import { URLS, buildRegistration, buildAgentCard, buildTrustManifest, signCard, buildJwks } from "../lib/artifacts.mjs";
import { signEip191 } from "../lib/sign.mjs";

await assertChain();
const c = contracts();
const operator = operatorKey();
const op = wallet(operator.privateKey);
const outDir = ARTIFACTS_DIR;
mkdirSync(outDir, { recursive: true });
const write = (name, obj) => writeFileSync(path.join(outDir, name), JSON.stringify(obj, null, 2) + "\n");

// 1. ERC-8004 identity (local registry). Reuse if the operator already owns one.
let agentId = null;
if (NETWORK !== "local") {
  // Public testnet: the operator registered in the official ERC-8004 IdentityRegistry via scripts/sepolia-v04.mjs;
  // the agentId is recorded in the deployment file (never re-registered here). null if not registered.
  agentId = c.d.erc8004?.agentId != null ? BigInt(c.d.erc8004.agentId) : null;
  if (agentId !== null && (await read(c.identity, "ownerOf", [agentId])).toLowerCase() !== operator.address.toLowerCase()) throw new Error("ERC-8004 agentId is not owned by the operator");
} else if (!c.identity.address) {
  // no registry
} else if ((await read(c.identity, "balanceOf", [operator.address])) > 0n) {
  const n = await read(c.identity, "agentCount");
  for (let i = 1n; i <= n; i++) if ((await read(c.identity, "ownerOf", [i])).toLowerCase() === operator.address.toLowerCase()) agentId = i;
} else {
  const { receipt } = await send(op, c.identity, "register", [URLS.registration]);
  agentId = parseEventLogs({ abi: c.identity.abi, logs: receipt.logs, eventName: "Registered" })[0].args.agentId;
}

// ONLY=trust-manifest re-signs the trust manifest alone (registration, card and jwks are left untouched).
// ONLY=agent-card re-signs the A2A card + jwks; ONLY=agent-card,registration also the ERC-8004 registration + sidecar.
const only = process.env.ONLY ?? null;
const ONLY_SETS = ["trust-manifest", "agent-card", "agent-card,registration", "registration"];
if (only && !ONLY_SETS.includes(only)) throw new Error(`ONLY=${only}: supported: ${ONLY_SETS.join(" | ")}`);
// ONLY=registration re-signs the ERC-8004 registration + sidecar alone (agent card, jwks and trust manifest untouched).
if (only === "registration") {
  const registration = await buildRegistration({ agentId });
  const signedReg = await signEip191(registration, operator.privateKey);
  write("agent-registration.json", registration);
  write("agent-registration.sig.json", { document: "agent-registration.json", signature: signedReg.signature });
  console.log(JSON.stringify({ operator: operator.address, network: NETWORK, agentId: agentId === null ? null : agentId.toString(), files: ["agent-registration.json", "agent-registration.sig.json"] }, null, 2));
  process.exit(0);
}
if (only && only.startsWith("agent-card")) {
  const files = [];
  if (only.includes("registration")) {
    const registration = await buildRegistration({ agentId });
    const signedReg = await signEip191(registration, operator.privateKey);
    write("agent-registration.json", registration);
    write("agent-registration.sig.json", { document: "agent-registration.json", signature: signedReg.signature });
    files.push("agent-registration.json", "agent-registration.sig.json");
  }
  write("agent-card.json", await signCard(await buildAgentCard(), operator));
  write("jwks.json", buildJwks(operator));
  files.push("agent-card.json", "jwks.json");
  console.log(JSON.stringify({ operator: operator.address, network: NETWORK, agentId: agentId === null ? null : agentId.toString(), files: files.map((f) => path.relative(ROOT, path.join(outDir, f))) }, null, 2));
  process.exit(0);
}
if (only === "trust-manifest") {
  const { knownEvaluators } = await import("../lib/evaluators.mjs");
  const { AGENT_DIR, CHAIN_ID } = await import("../lib/config.mjs");
  const ref = privateKeyToAccount(roleKey("evaluator")).address; // address only
  const labels = knownEvaluators({ agentDir: AGENT_DIR, chainId: CHAIN_ID });
  const evaluators = [ref, ...labels.map((l) => l.address).filter((a) => a.toLowerCase() !== ref.toLowerCase())].map((a) => {
    const l = labels.find((x) => x.address.toLowerCase() === a.toLowerCase()) ?? {};
    return { address: a, label: l.label, operator: l.operator, default: a.toLowerCase() === ref.toLowerCase() };
  });
  write("trust-manifest.json", await buildTrustManifest({ operator, agentId, evaluators }));
  console.log(JSON.stringify({ operator: operator.address, network: NETWORK, evaluators: evaluators.map((e) => e.address), files: [path.relative(ROOT, path.join(outDir, "trust-manifest.json"))] }, null, 2));
  process.exit(0);
}

// 2. Registration JSON + sidecar signature.
const registration = await buildRegistration({ agentId });
const signedReg = await signEip191(registration, operator.privateKey);
write("agent-registration.json", registration);
write("agent-registration.sig.json", { document: "agent-registration.json", signature: signedReg.signature });

// 3. A2A card.
const card = await signCard(await buildAgentCard(), operator);
write("agent-card.json", card);
write("jwks.json", buildJwks(operator)); // served at /.well-known/jwks.json (jku in the card's protected header)

// 4. Trust manifest.
const evaluator = process.env.AGENTCOIN_REFERENCE_EVALUATOR ?? privateKeyToAccount(roleKey("evaluator")).address; // address only
const manifest = await buildTrustManifest({ operator, agentId, evaluators: [evaluator] });
write("trust-manifest.json", manifest);

console.log(JSON.stringify({ operator: operator.address, network: NETWORK, agentId: agentId === null ? null : agentId.toString(), files: ["agent-registration.json", "agent-registration.sig.json", "agent-card.json", "jwks.json", "trust-manifest.json"].map((f) => path.relative(ROOT, path.join(outDir, f))) }, null, 2));
