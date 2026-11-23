#!/usr/bin/env node
// Rebuilds static/ofac-sdn-addresses.json from the free OFAC SDN list (public, read-only download).
// Usage: node scripts/ofac-refresh.mjs [--file sdn.xml] [--out static/ofac-sdn-addresses.json]
// Default source: https://www.treasury.gov/ofac/downloads/sdn.xml. Only "Digital Currency Address - <TICKER>"
// identifiers are kept. EVM addresses (0x + 40 hex) are stored lowercased; others as published.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OFAC_SDN_URL = "https://www.treasury.gov/ofac/downloads/sdn.xml";
const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseSdnXml(xml) {
  const publishDate = xml.match(/<Publish_Date>([^<]*)<\/Publish_Date>/)?.[1] ?? null;
  const out = [];
  for (const entry of xml.split("<sdnEntry>").slice(1)) {
    const uid = entry.match(/<uid>(\d+)<\/uid>/)?.[1] ?? null;
    for (const id of entry.split("<id>").slice(1)) {
      const t = id.match(/<idType>Digital Currency Address - ([A-Za-z0-9-]+)<\/idType>/)?.[1];
      const n = id.match(/<idNumber>([^<]+)<\/idNumber>/)?.[1]?.trim();
      if (!t || !n) continue;
      const evm = /^0x[0-9a-fA-F]{40}$/.test(n);
      out.push({ address: evm ? n.toLowerCase() : n, ticker: t, evm, uid: uid ? Number(uid) : null });
    }
  }
  const seen = new Set();
  const entries = out.filter((e) => (seen.has(`${e.ticker}:${e.address}`) ? false : seen.add(`${e.ticker}:${e.address}`))).sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : a.ticker < b.ticker ? -1 : 1));
  return { publishDate, entries };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  const file = arg("--file", null);
  const outFile = path.resolve(AGENT, arg("--out", "static/ofac-sdn-addresses.json"));
  const xml = file ? readFileSync(file, "utf8") : await (await fetch(OFAC_SDN_URL)).text();
  const { publishDate, entries } = parseSdnXml(xml);
  if (!publishDate || entries.length < 100) throw new Error(`unexpected SDN parse (publishDate ${publishDate}, ${entries.length} addresses); file not written`);
  const doc = {
    v: "agentkoin-ofac-sdn-addresses/1",
    source: OFAC_SDN_URL,
    publishDate,
    sourceSha256: createHash("sha256").update(xml).digest("hex"),
    generatedAt: new Date().toISOString(),
    count: entries.length,
    evmCount: entries.filter((e) => e.evm).length,
    entries,
  };
  writeFileSync(outFile, JSON.stringify(doc, null, 1) + "\n");
  console.log(JSON.stringify({ out: path.relative(AGENT, outFile), publishDate, count: doc.count, evmCount: doc.evmCount }));
}
