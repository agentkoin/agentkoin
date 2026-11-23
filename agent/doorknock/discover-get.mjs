#!/usr/bin/env node
// Read-only format-discovery GET (agent cards / docs). No redirects followed, 15s timeout, 1 retry on network error only.
// Logs request + response to out/knock-log.jsonl as kind "resend-discovery" (sent:false, so it never counts as a knock).
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export async function discoverGet(url, { id, name, fetchImpl = fetch, timeoutMs = 15000, logFile = path.join(HERE, "out", "knock-log.jsonl") } = {}) {
  let r;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { accept: "application/json, text/plain, */*", "user-agent": "agentcoin-doorknock/0.4 (testnet)" }, signal: ctl.signal });
      r = { status: res.status, headers: { "content-type": res.headers.get("content-type"), location: res.headers.get("location") }, text: (await res.text()).slice(0, 20000), attempts: attempt };
      break;
    } catch (e) { r = { status: 0, text: "", error: String(e?.cause?.code ?? e?.name) + ": " + String(e?.message ?? e), attempts: attempt }; }
    finally { clearTimeout(t); }
  }
  appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), kind: "resend-discovery", resend: true, id, name, sent: false, request: { method: "GET", url }, status: r.status, attempts: r.attempts, error: r.error, response: { status: r.status, headers: r.headers ?? null, text: r.text } }) + "\n");
  return r;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url, id, name] = process.argv.slice(2);
  const r = await discoverGet(url, { id, name });
  console.log(r.status, r.error ?? "", r.headers?.["content-type"] ?? "", r.headers?.location ?? "");
  console.log(r.text.slice(0, Number(process.env.SHOW ?? 6000)));
}
