// Verifies AgentCoin artifacts: signature + every on-chain claim that can be re-read from the local chain.
// Output: { kind, valid, checks: [{ check, pass, detail }] }. valid = all checks pass.
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAddress, keccak256 } from "viem";
import { publicClient, contracts, read } from "./chain.mjs";
import { ROOT, CHAIN_ID } from "./config.mjs";
import { verifyEip191, verifyAgentCard } from "./sign.mjs";
import { sha256Hex } from "./canonical.mjs";
import { validateTrustManifest } from "./schema.mjs";

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function detectKind(doc) {
  if (doc?.v === "agentcoin-trust/0.1") return "trust-manifest";
  if (doc?.v === "agentcoin-attestation/0.1") return "attestation";
  if (Array.isArray(doc?.supportedInterfaces) && Array.isArray(doc?.skills)) return "a2a-agent-card";
  if (doc?.document?.type === "https://eips.ethereum.org/EIPS/eip-8004#registration-v1") return "erc8004-registration";
  if (doc?.type === "https://eips.ethereum.org/EIPS/eip-8004#registration-v1") return "erc8004-registration-unsigned";
  return "unknown";
}

async function checkAttestation(a, checks, prefix = "") {
  const sig = await verifyEip191(a);
  checks.push({ check: `${prefix}signature`, pass: sig.valid, detail: sig.valid ? `eip191 signer ${sig.signer}` : sig.reason });
  checks.push({ check: `${prefix}chainId`, pass: Number(a.chainId) === CHAIN_ID, detail: String(a.chainId) });
  const blockNumber = BigInt(a.blockNumber);
  const c = contracts();
  if (a.type === "evaluator-stake") {
    const info = await read({ ...c.registry, address: a.contract }, "evaluatorInfo", [a.subject]).catch(() => null);
    const atBlock = await publicClient.readContract({ ...c.registry, address: a.contract, functionName: "evaluatorInfo", args: [a.subject], blockNumber }).catch(() => null);
    checks.push({ check: `${prefix}stake@${a.blockNumber}`, pass: !!atBlock && atBlock.stake.toString() === a.claim.stake, detail: atBlock ? `chain ${atBlock.stake} claim ${a.claim.stake}` : "unreadable at block" });
    checks.push({ check: `${prefix}stake@latest (informational)`, pass: true, detail: info ? `current ${info.stake}${info.stake.toString() === a.claim.stake ? "" : " (changed since attestation)"}` : "unreadable" });
  } else if (a.type === "contract-code") {
    const code = await publicClient.getCode({ address: a.subject, blockNumber });
    const h = code ? keccak256(code) : null;
    checks.push({ check: `${prefix}codeHash ${a.claim.name}`, pass: eq(h, a.claim.codeHash), detail: `chain ${h}` });
  } else {
    checks.push({ check: `${prefix}type`, pass: false, detail: `unknown attestation type ${a.type}` });
  }
  return sig.signer;
}

// Fetches the card's jku only when it is a loopback URL (LOCAL ONLY). Returns null otherwise or on failure.
async function fetchLocalJwks(card) {
  try {
    const h = JSON.parse(Buffer.from(card.signatures?.[0]?.protected ?? "", "base64url").toString("utf8"));
    if (!h.jku) return undefined;
    const u = new URL(h.jku);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function verifyDocument(doc, opts = {}) {
  const { expectedSigner } = opts;
  const kind = detectKind(doc);
  const checks = [];
  const c = contracts();
  let signer;

  if (kind === "attestation") {
    signer = await checkAttestation(doc, checks);
  } else if (kind === "trust-manifest") {
    const schemaOk = validateTrustManifest(doc);
    checks.push({ check: "JSON Schema agentcoin-trust/0.1", pass: schemaOk, detail: schemaOk ? "valid" : JSON.stringify(validateTrustManifest.errors?.slice(0, 3)) });
    const sig = await verifyEip191(doc);
    signer = sig.signer;
    checks.push({ check: "signature", pass: sig.valid, detail: sig.valid ? `eip191 signer ${sig.signer}` : sig.reason });
    checks.push({ check: "issuer == signer", pass: sig.valid && eq(doc.issuer, sig.signer), detail: doc.issuer });
    checks.push({ check: "chainId", pass: doc.chainId === CHAIN_ID, detail: String(doc.chainId) });
    for (const [name, entry] of Object.entries(doc.contracts ?? {})) {
      if (!entry || typeof entry !== "object") continue;
      const code = await publicClient.getCode({ address: entry.address });
      const h = code ? keccak256(code) : keccak256("0x"); // no code -> hash of empty bytecode
      checks.push({ check: `contract ${name} codeHash`, pass: eq(h, entry.codeHash), detail: `${entry.address} chain ${h}` });
    }
    const cfg = await read(c.escrow, "config", [doc.escrowConfig.version]);
    const mism = Object.entries(cfg).filter(([k, v]) => String(v) !== String(doc.escrowConfig[k])).map(([k]) => k);
    checks.push({ check: `escrowConfig v${doc.escrowConfig.version}`, pass: mism.length === 0, detail: mism.length ? `mismatch: ${mism.join(",")}` : "matches chain" });
    const cur = await read(c.escrow, "currentConfigVersion");
    checks.push({ check: "escrowConfig is current (informational)", pass: true, detail: Number(cur) === doc.escrowConfig.version ? "current" : `chain current version ${cur}` });
    checks.push({ check: "fees.feeBps == escrowConfig.feeBps", pass: String(doc.fees.feeBps) === String(doc.escrowConfig.feeBps), detail: String(doc.fees.feeBps) });
    if (doc.fees.evaluatorFeeBps !== undefined) checks.push({ check: "fees.evaluatorFeeBps == escrowConfig.evaluatorFeeBps", pass: String(doc.fees.evaluatorFeeBps) === String(doc.escrowConfig.evaluatorFeeBps), detail: String(doc.fees.evaluatorFeeBps) });
    if (doc.adapterConfig && doc.contracts?.evaluatorAdapter) {
      const acfg = await publicClient.readContract({ ...c.adapter, address: doc.contracts.evaluatorAdapter.address, functionName: "config", args: [doc.adapterConfig.version] }).catch(() => null);
      const am = acfg ? Object.entries(acfg).filter(([k, v]) => String(v) !== String(doc.adapterConfig[k])).map(([k]) => k) : ["unreadable"];
      checks.push({ check: `adapterConfig v${doc.adapterConfig.version}`, pass: am.length === 0, detail: am.length ? `mismatch: ${am.join(",")}` : "matches chain" });
    }
    if (doc.fees.arbitrationFee !== undefined) {
      const fee = await publicClient.readContract({ ...c.arbitrator, address: doc.contracts.arbitrator.address, functionName: "arbitrationCost", args: [0n, 0n] }).catch(() => null);
      checks.push({ check: "fees.arbitrationFee == arbitrator.arbitrationCost(0, 0) (at latest)", pass: fee !== null && String(fee) === String(doc.fees.arbitrationFee), detail: `chain ${fee}` });
    }
    if (doc.agent) {
      const [, , idAddr] = doc.agent.agentRegistry.split(":");
      const owner = await publicClient.readContract({ ...c.identity, address: idAddr, functionName: "ownerOf", args: [BigInt(doc.agent.agentId)] }).catch(() => null);
      checks.push({ check: "ERC-8004 agentId owner == issuer", pass: eq(owner, doc.issuer), detail: `owner ${owner}` });
    } else {
      checks.push({ check: "ERC-8004 identity (informational)", pass: true, detail: "none: no identity registry on this network; issuer is identified by its signing address only" });
    }
    for (const rule of doc.disputeRules ?? []) {
      let h = null;
      try { h = sha256Hex(readFileSync(path.join(ROOT, rule.path))); } catch {}
      checks.push({ check: `disputeRules ${rule.path} sha256`, pass: eq(h, rule.sha256), detail: h ?? "file not found locally" });
    }
    for (const [i, a] of (doc.attestations ?? []).entries()) {
      const s2 = await checkAttestation(a, checks, `attestation[${i}] ${a.type} `);
      checks.push({ check: `attestation[${i}] signer == issuer`, pass: eq(s2, doc.issuer), detail: s2 });
    }
  } else if (kind === "a2a-agent-card") {
    const jwks = opts.jwks ?? (await fetchLocalJwks(doc));
    const r = await verifyAgentCard(doc, { jwks });
    signer = r.signerAddress;
    checks.push({ check: "jws signature (ES256K over RFC8785 card)", pass: r.valid, detail: r.valid ? `kid ${r.kid}` : r.reason });
    if (r.jku) checks.push({ check: "jku JWKS contains kid with same key", pass: r.valid && r.jkuChecked === true, detail: r.jkuChecked ? r.jku : `JWKS not retrieved from ${r.jku}${jwks === null ? " (non-loopback URL not fetched: local only)" : ""}` });
    if (r.valid) checks.push({ check: "kid did:pkh matches jwk address", pass: eq(r.kid.split(":")[4]?.split("#")[0], r.signerAddress), detail: r.signerAddress });
  } else if (kind === "erc8004-registration") {
    // { document: <registration JSON>, signature: <eip191 sidecar> }
    const wrapped = { ...doc.document, signature: doc.signature };
    const sig = await verifyEip191(wrapped);
    signer = sig.signer;
    checks.push({ check: "signature (eip191 sidecar over RFC8785 registration)", pass: sig.valid, detail: sig.valid ? sig.signer : sig.reason });
    for (const reg of doc.document.registrations ?? []) {
      const [, chain, addr] = reg.agentRegistry.split(":");
      checks.push({ check: "registration chain", pass: Number(chain) === CHAIN_ID, detail: reg.agentRegistry });
      const owner = await publicClient.readContract({ ...c.identity, address: addr, functionName: "ownerOf", args: [BigInt(reg.agentId)] }).catch(() => null);
      checks.push({ check: `agentId ${reg.agentId} owner == signer`, pass: eq(owner, sig.signer), detail: `owner ${owner}` });
      const uri = await publicClient.readContract({ ...c.identity, address: addr, functionName: "tokenURI", args: [BigInt(reg.agentId)] }).catch(() => null);
      checks.push({ check: `agentId ${reg.agentId} tokenURI present`, pass: !!uri, detail: uri ?? "none" });
    }
  } else {
    checks.push({ check: "kind", pass: false, detail: "unrecognized document; expected trust manifest, attestation, A2A agent card, or {document, signature} ERC-8004 registration" });
  }
  if (expectedSigner) checks.push({ check: "signer == expectedSigner", pass: eq(signer, expectedSigner), detail: `${signer}` });
  return { kind, valid: checks.every((x) => x.pass), signer: signer ? getAddress(signer) : null, chainId: CHAIN_ID, checks };
}
