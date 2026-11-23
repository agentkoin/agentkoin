// OFAC SDN digital-currency address screen (static/ofac-sdn-addresses.json, rebuilt by scripts/ofac-refresh.mjs).
// EVM addresses match case-insensitively; other chains exactly. A match is refused with code OFAC_SDN_MATCH.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "static", "ofac-sdn-addresses.json");
let cache = null;

export function loadSdn(file = process.env.AGENTCOIN_OFAC_FILE ?? DEFAULT_FILE) {
  if (cache?.file === file) return cache;
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { publishDate: null, entries: [] };
  const map = new Map();
  for (const e of doc.entries) map.set(e.evm ? e.address.toLowerCase() : e.address, e);
  cache = { file, publishDate: doc.publishDate, count: doc.entries.length, map };
  return cache;
}

const key = (a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);

/** First sanctioned address among `addrs` (strings; others ignored), or null. */
export function sdnMatch(addrs, sdn = loadSdn()) {
  for (const a of addrs) {
    if (typeof a !== "string" || !a) continue;
    const e = sdn.map.get(key(a.trim()));
    if (e) return { address: a, ticker: e.ticker, uid: e.uid };
  }
  return null;
}

/** Throws an HTTP 403 error carrying a machine-readable reason when any address is on the SDN list. */
export function assertNotSanctioned(addrs, sdn = loadSdn()) {
  const m = sdnMatch(addrs, sdn);
  if (!m) return;
  throw Object.assign(new Error("sanctioned_address"), {
    status: 403,
    reason: { code: "OFAC_SDN_MATCH", address: m.address, sdnUid: m.uid, list: "OFAC SDN", listPublishDate: sdn.publishDate },
  });
}
