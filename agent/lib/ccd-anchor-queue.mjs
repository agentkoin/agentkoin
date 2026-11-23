// Anchor queue: frozen proof cores in, Concordium RegisterData txs out. Feature-flagged OFF by default (CCD_ANCHOR=1 enables it in the service).
// The sender is pluggable: { send(payloadHex) -> {txHash}, status(txHash) -> {state, blockHash?, blockHeight?, sender?} }.
// Tests use a mock sender. makeSdkSender() is the real one and is NEVER constructed unless the flag is on and a key file is configured.
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { buildAnchorPayload, proofCoreSha256, ANCHOR_MAGIC, proxyNodeReader, DEFAULT_CCD_PROXY } from "./ccd-anchor.mjs";

export class AnchorStore {
  constructor(file = null) { this.file = file; this.m = new Map(); if (file && existsSync(file)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) this.m.set(k, v); }
  get(k) { return this.m.get(k); }
  put(k, patch) { const v = { ...(this.m.get(k) ?? {}), ...patch }; this.m.set(k, v); this.#save(); return v; }
  all() { return [...this.m.entries()]; }
  #save() { if (!this.file) return; const t = this.file + ".tmp"; writeFileSync(t, JSON.stringify(Object.fromEntries(this.m)), { mode: 0o600 }); renameSync(t, this.file); }
}
export const anchorKey = (escrow, jobId) => `${String(escrow).toLowerCase()}:${jobId}`;

export function createAnchorQueue({ store, sender, network = "testnet", genesis = null, now = () => Date.now(), maxAttempts = 8, backoffMs = (n) => Math.min(30 * 60_000, 15_000 * 2 ** n), log = () => {} }) {
  /** Freeze `bundle` (unsigned proof, no anchors) for a Settled job and queue it. Idempotent: an existing record is never overwritten (the core must stay byte-identical). */
  function freeze({ escrow, jobId, chainId, bundle }) {
    const k = anchorKey(escrow, jobId);
    const ex = store.get(k);
    if (ex) return ex;
    const core = JSON.stringify(bundle);
    const coreSha256 = proofCoreSha256(JSON.parse(core));
    const payloadHex = buildAnchorPayload({ coreSha256, jobId, escrow, chainId }).toString("hex");
    return store.put(k, { escrow, jobId: String(jobId), chainId, core, coreSha256, payloadHex, status: "queued", attempts: 0, nextAt: 0, createdAt: now() });
  }
  const frozenCore = (escrow, jobId) => { const r = store.get(anchorKey(escrow, jobId)); return r ? JSON.parse(r.core) : null; };
  /** The optional `anchors` object for a bundle; null when the job is not in the queue. */
  function anchorsFor(escrow, jobId) {
    const r = store.get(anchorKey(escrow, jobId));
    if (!r) return null;
    const c = { network, ...(genesis ? { genesis } : {}), status: r.status, coreSha256: r.coreSha256, payloadHex: r.payloadHex };
    if (r.txHash) Object.assign(c, { txHash: r.txHash, sender: r.sender ?? undefined, blockHash: r.blockHash ?? undefined, blockHeight: r.blockHeight ?? undefined });
    if (r.status === "failed") c.error = r.error;
    return { concordium: c };
  }
  /** Process every due record once. Never throws; failures back off and finally mark the record failed. */
  async function tick() {
    const out = [];
    for (const [k, r] of store.all()) {
      if (r.status === "finalized" || r.status === "failed" || (r.nextAt ?? 0) > now()) continue;
      try {
        if (!r.txHash) {
          const { txHash } = await sender.send(r.payloadHex);
          store.put(k, { txHash, status: "submitted", submittedAt: now(), attempts: 0, nextAt: now() + 5000 });
          out.push({ k, step: "submitted", txHash });
          continue;
        }
        const st = await sender.status(r.txHash);
        if (st.state === "finalized") { store.put(k, { status: "finalized", blockHash: st.blockHash ?? null, blockHeight: st.blockHeight ?? null, sender: st.sender ?? r.sender ?? null, finalizedAt: now() }); out.push({ k, step: "finalized" }); }
        // a tx we submitted can only be "dropped" once its 10-minute expiry has passed; resubmitting earlier could anchor twice
        else if (st.state === "unknown" && now() - (r.submittedAt ?? 0) > 11 * 60_000) { store.put(k, { txHash: null, status: "queued", attempts: 0, nextAt: now() + backoffMs(0), error: "tx dropped by node; resubmitting" }); out.push({ k, step: "resubmit" }); }
        else { store.put(k, { attempts: (r.attempts ?? 0) + 1, nextAt: now() + 5000 }); out.push({ k, step: st.state }); }
      } catch (e) {
        const attempts = (r.attempts ?? 0) + 1;
        const msg = String(e?.message ?? e).slice(0, 160);
        log(`ccd-anchor ${k}: ${msg}`);
        store.put(k, attempts >= maxAttempts ? { status: "failed", attempts, error: msg } : { attempts, nextAt: now() + backoffMs(attempts), error: msg });
        out.push({ k, step: "error", error: msg });
      }
    }
    return out;
  }
  return { freeze, frozenCore, anchorsFor, tick, store };
}

/**
 * Real sender over @concordium/web-sdk. Reads the key file INSIDE this function; the key is never logged or returned.
 * keyFile JSON: { "address": "<base58>", "privateKey": "<hex ed25519 sign key>" }  (single-credential, single-key account).
 * UNVERIFIED against a live node (no account exists yet): the offline build+sign path was exercised in this repo's tests with a throwaway key.
 */
export async function makeSdkSender({ keyFile, host, port, sdk = null }) {
  sdk ??= await import("@concordium/web-sdk/nodejs");
  const k = JSON.parse(readFileSync(keyFile, "utf8"));
  const sender = sdk.AccountAddress.fromBase58(k.address);
  const signer = sdk.buildBasicAccountSigner(k.privateKey);
  const client = new sdk.ConcordiumGRPCNodeClient(host, port, sdk.credentials.createSsl(), { timeout: 20000 });
  const { sdkNodeReader } = await import("./ccd-anchor.mjs");
  const reader = await sdkNodeReader({ host, port, sdk });
  return {
    async send(payloadHex) {
      const data = Buffer.from(payloadHex, "hex");
      if (data.length > 256 || data.toString("ascii", 0, 4) !== ANCHOR_MAGIC) throw new Error("refusing to send a payload that is not an AGK1 anchor");
      const { nextNonce } = await client.getNextAccountNonce(sender);
      const tx = sdk.Transaction.registerData({ data: new sdk.DataBlob(data) }).addMetadata({ sender, nonce: nextNonce, expiry: sdk.TransactionExpiry.futureMinutes(10) }).build();
      const fin = await sdk.Transaction.signAndFinalize(tx, signer);
      const h = await client.sendTransaction(fin);
      return { txHash: sdk.TransactionHash.toHexString(h) };
    },
    status: (txHash) => reader.getTx(txHash),
    address: k.address,
  };
}

/**
 * Sender that needs no gRPC: builds + signs RegisterData offline with the SDK and submits via the public wallet-proxy REST
 * (GET /v0/accNonce, PUT /v0/submitRawTransaction, status via /v0/submissionStatus). VERIFIED live 2026-11-20 (see runbook results).
 * keyFile JSON: { "address": "<base58>", "privateKey": "<hex ed25519 sign key>" }. The key is read here and never logged.
 */
export async function makeProxySender({ keyFile, base = DEFAULT_CCD_PROXY, sdk = null, fetchImpl = fetch }) {
  sdk ??= await import("@concordium/web-sdk");
  const k = JSON.parse(readFileSync(keyFile, "utf8"));
  const sender = sdk.AccountAddress.fromBase58(k.address);
  const signer = sdk.buildBasicAccountSigner(k.privateKey);
  const reader = proxyNodeReader({ base, fetchImpl });
  return {
    async send(payloadHex) {
      const data = Buffer.from(payloadHex, "hex");
      if (data.length > 256 || data.toString("ascii", 0, 4) !== ANCHOR_MAGIC) throw new Error("refusing to send a payload that is not an AGK1 anchor");
      const nr = await fetchImpl(`${base}/v0/accNonce/${k.address}`, { signal: AbortSignal.timeout(20000) });
      if (!nr.ok) throw new Error(`accNonce HTTP ${nr.status}`);
      const { nonce } = await nr.json();
      const tx = sdk.Transaction.registerData({ data: new sdk.DataBlob(data) }).addMetadata({ sender, nonce: sdk.SequenceNumber.create(nonce), expiry: sdk.TransactionExpiry.futureMinutes(10) }).build();
      const fin = await sdk.Transaction.signAndFinalize(tx, signer);
      const r = await fetchImpl(`${base}/v0/submitRawTransaction`, { method: "PUT", body: Buffer.from(sdk.Transaction.serializeBlockItem(fin)), signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`submitRawTransaction HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      // The proxy's submissionId is the authoritative transaction hash. (The SDK-computed hash did NOT match the on-chain hash in the live
      // test on 2026-11-20, which made the queue resubmit and anchor the same payload 7 times; so never trust a locally computed hash here.)
      const { submissionId } = await r.json();
      if (!/^[0-9a-f]{64}$/.test(submissionId ?? "")) throw new Error("submitRawTransaction returned no submissionId");
      return { txHash: submissionId };
    },
    status: (txHash) => reader.getTx(txHash),
    address: k.address,
  };
}
