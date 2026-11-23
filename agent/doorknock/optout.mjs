// Do-not-contact list. Entries match on target id, host, A2A endpoint URL, or ERC-8004 agentId.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const OPTOUT_FILE = process.env.DOORKNOCK_OPTOUT_FILE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "do-not-contact.json");
// self-service opt-outs recorded by the public service (POST /v1/optout) are merged in
export const SERVICE_OPTOUT_FILE = process.env.DOORKNOCK_SERVICE_OPTOUT_FILE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".state", "base-sepolia", "optouts.json");
const readEntries = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).entries ?? [] : []);
export function loadOptOuts() {
  return [...readEntries(OPTOUT_FILE), ...readEntries(SERVICE_OPTOUT_FILE)];
}
export function isOptedOut(list, t) {
  const keys = [t.id, t.host, t.channel?.url, t.agentId && `erc8004:84532:${t.agentId}`].filter(Boolean).map((x) => String(x).toLowerCase());
  return list.some((e) => keys.includes(String(e.match).toLowerCase()));
}
export function addOptOut(match, reason = "opt-out") {
  const list = readEntries(OPTOUT_FILE);
  if (!list.some((e) => String(e.match).toLowerCase() === String(match).toLowerCase())) list.push({ match, reason, at: new Date().toISOString() });
  writeFileSync(OPTOUT_FILE, JSON.stringify({ entries: list }, null, 2) + "\n");
  return list;
}
