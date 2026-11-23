// Signing schemes used by AgentCoin artifacts.
//  - EIP-191 personal_sign over keccak256(JCS(document without "signature")) -> trust manifest, ERC-8004 registration sidecar.
//  - JWS (RFC 7515, ES256K, detached-style per A2A 8.4) over JCS(card without "signatures") -> A2A agent card.
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, keccak256, getAddress, hexToBytes, bytesToHex } from "viem";
import { recoverPublicKey, sha256 } from "viem";
import { sign as secpSign } from "viem/accounts";
import { jcs, omit, keccakJcs } from "./canonical.mjs";

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

// ---------- EIP-191 ----------
export async function signEip191(doc, privateKey) {
  const account = privateKeyToAccount(privateKey);
  const unsigned = omit(doc, ["signature"]);
  const digest = keccakJcs(unsigned);
  const value = await account.signMessage({ message: { raw: digest } });
  return {
    ...unsigned,
    signature: { scheme: "eip191", canonicalization: "RFC8785", digest: "keccak256", signer: account.address, signedDigest: digest, value },
  };
}

export async function verifyEip191(doc) {
  const s = doc.signature;
  if (!s || s.scheme !== "eip191") return { valid: false, reason: "no eip191 signature" };
  const digest = keccakJcs(omit(doc, ["signature"]));
  if (s.signedDigest && s.signedDigest !== digest) return { valid: false, reason: "digest mismatch (document modified)", digest };
  const valid = await verifyMessage({ address: s.signer, message: { raw: digest }, signature: s.value });
  return { valid, signer: getAddress(s.signer), digest, reason: valid ? undefined : "signature does not match signer" };
}

// ---------- JWK helpers for secp256k1 ----------
export function jwkFromPrivateKey(privateKey) {
  const priv = hexToBytes(privateKey);
  const pub = hexToBytes(privateKeyToAccount(privateKey).publicKey); // 0x04 || x || y
  return {
    kty: "EC",
    crv: "secp256k1",
    x: b64u(pub.slice(1, 33)),
    y: b64u(pub.slice(33, 65)),
    d: b64u(priv),
  };
}

export function publicJwk(jwk) {
  const { d, ...pub } = jwk;
  return pub;
}

/** Ethereum address controlled by a secp256k1 public JWK. */
export function addressFromJwk(jwk) {
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const hash = keccak256(bytesToHex(Buffer.concat([x, y])));
  return getAddress("0x" + hash.slice(-40));
}

// ---------- A2A card JWS (ES256K, RFC 7515 + RFC 8812) ----------
// Signing input = BASE64URL(protected) || "." || BASE64URL(JCS(card without "signatures")).
// Signature = r || s (32 + 32 bytes, low-s) over SHA-256(signing input).
function signingInput(protectedB64, card) {
  return `${protectedB64}.${b64u(new TextEncoder().encode(jcs(omit(card, ["signatures"]))))}`;
}

// A-4: the public key is carried inline (header.jwk) and, when `jku` is given, also published as a JWKS
// at that URL with the same kid. ES256 / RS256 are not implemented (the operator key is secp256k1).
export function jwksFor(privateKey, kid) {
  return { keys: [{ ...publicJwk(jwkFromPrivateKey(privateKey)), kid, alg: "ES256K", use: "sig" }] };
}

const sameKey = (a, b) => a && b && a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y;

export async function signAgentCard(card, privateKey, kid, { jku } = {}) {
  const jwk = jwkFromPrivateKey(privateKey);
  const header = { alg: "ES256K", typ: "JOSE", kid, ...(jku ? { jku } : {}) };
  const protectedB64 = b64u(new TextEncoder().encode(JSON.stringify(header)));
  const hash = sha256(new TextEncoder().encode(signingInput(protectedB64, card)));
  const { r, s } = await secpSign({ hash, privateKey });
  const sigBytes = Buffer.concat([Buffer.from(hexToBytes(r, { size: 32 })), Buffer.from(hexToBytes(s, { size: 32 }))]);
  return {
    ...omit(card, ["signatures"]),
    signatures: [{ protected: protectedB64, signature: b64u(sigBytes), header: { jwk: publicJwk(jwk) } }],
  };
}

/**
 * Verify the card JWS against the inline jwk. If the protected header has `jku` and a JWKS is supplied
 * (`opts.jwks`), the JWKS entry with the header kid must equal the inline key; result.jku reports this.
 */
export async function verifyAgentCard(card, opts = {}) {
  const r = await verifyAgentCardInline(card);
  if (!r.valid || !r.jku) return r;
  if (!opts.jwks) return { ...r, jkuChecked: false };
  const k = opts.jwks.keys?.find((x) => x.kid === r.kid);
  if (!k) return { ...r, valid: false, jkuChecked: true, reason: `kid ${r.kid} not in JWKS at ${r.jku}` };
  if (k.alg && k.alg !== "ES256K") return { ...r, valid: false, jkuChecked: true, reason: `JWKS alg ${k.alg} != ES256K` };
  if (!sameKey(k, r.jwk)) return { ...r, valid: false, jkuChecked: true, reason: "JWKS key != inline jwk" };
  return { ...r, jkuChecked: true };
}

async function verifyAgentCardInline(card) {
  const sig = card.signatures?.[0];
  if (!sig) return { valid: false, reason: "no signatures" };
  const jwk = sig.header?.jwk;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "secp256k1") return { valid: false, reason: "missing or unsupported jwk" };
  let header;
  try {
    header = JSON.parse(Buffer.from(sig.protected, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "protected header not valid base64url JSON" };
  }
  if (header.alg !== "ES256K") return { valid: false, reason: `unsupported alg ${header.alg}` };
  const raw = Buffer.from(sig.signature, "base64url");
  if (raw.length !== 64) return { valid: false, reason: "signature length != 64" };
  const hash = sha256(new TextEncoder().encode(signingInput(sig.protected, card)));
  const r = bytesToHex(raw.subarray(0, 32));
  const s = bytesToHex(raw.subarray(32));
  const expected = ("0x04" + Buffer.from(jwk.x, "base64url").toString("hex") + Buffer.from(jwk.y, "base64url").toString("hex")).toLowerCase();
  for (const yParity of [0, 1]) {
    try {
      const pub = await recoverPublicKey({ hash, signature: { r, s, yParity } });
      if (pub.toLowerCase() === expected) return { valid: true, kid: header.kid, alg: header.alg, jku: header.jku, jwk, signerAddress: addressFromJwk(jwk) };
    } catch {}
  }
  return { valid: false, reason: "signature does not match jwk (card modified or wrong key)" };
}
