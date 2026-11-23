#!/usr/bin/env node
// READ-ONLY: pages the public x402 Bazaar discovery catalog (CDP) with plain unauthenticated GETs.
// Contacts no seller. Output: agent/router/data/bazaar-raw.json (gitignored; input to build-seed.mjs).
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "data");
const UA = "agentcoin-index-builder/0.1 (read-only catalog pages; testnet)";
const BASE = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
async function get(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, redirect: "manual" }).catch((e) => ({ status: 0, e }));
    if (r.status === 200) return r.json();
    await new Promise((s) => setTimeout(s, 2000 * (i + 1)));
  }
  throw new Error(`GET failed ${url}`);
}
const items = [];
let total = Infinity;
const fetchedAt = new Date().toISOString();
for (let off = 0; off < total; off += 1000) {
  const d = await get(`${BASE}?limit=1000&offset=${off}`);
  total = d.pagination?.total ?? 0;
  items.push(...(d.items ?? []));
  console.error(`offset ${off}: +${d.items?.length ?? 0} (total ${total})`);
  if (!d.items?.length) break;
  await new Promise((s) => setTimeout(s, 500));
}
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "bazaar-raw.json"), JSON.stringify({ source: BASE, fetchedAt, total, count: items.length, items }));
console.log(JSON.stringify({ fetchedAt, total, count: items.length }));
