// Opt-out matching for the index. Sources: doorknock/do-not-contact.json and the service's optouts.json
// (written by POST /v1/optout). A match string may be a URL, a host, erc8004:84532:<agentId>, a service id
// (svc_...), an operator id (op_...) or an EVM address (payTo / wallet). URL matches delist the whole host.
import { readFileSync, existsSync } from "node:fs";

export function loadOptOutMatches(files) {
  const out = [];
  for (const f of files) {
    if (!f || !existsSync(f)) continue;
    try {
      const d = JSON.parse(readFileSync(f, "utf8"));
      for (const e of d.entries ?? []) {
        const m = typeof e === "string" ? e : e.match ?? e.host ?? e.url ?? e.id;
        if (typeof m === "string" && m.trim()) out.push(m.trim());
      }
    } catch {}
  }
  return out;
}

export function normalizeMatch(m) {
  const s = String(m).trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(s)) return { kind: "address", v: s };
  if (/^svc_[0-9a-f]{16}$/.test(s)) return { kind: "service", v: s };
  if (/^op_[0-9a-f]{16}$/.test(s)) return { kind: "operator", v: s };
  const e = /^erc8004:(\d+):(\d+)$/.exec(s);
  if (e) return { kind: "erc8004", v: e[2], chain: e[1] };
  if (/^https?:\/\//.test(s)) {
    try {
      return { kind: "host", v: new URL(s).host };
    } catch {
      return { kind: "none" };
    }
  }
  if (/^[a-z0-9.-]+(:\d+)?$/.test(s) && s.includes(".")) return { kind: "host", v: s };
  return { kind: "none" };
}

/** svc: {id, operatorId, host, erc8004AgentId, payTo, wallets[]} */
export function matchesService(nm, svc) {
  switch (nm.kind) {
    case "host":
      return svc.host === nm.v || svc.host.endsWith("." + nm.v);
    case "service":
      return svc.id === nm.v;
    case "operator":
      return svc.operatorId === nm.v;
    case "erc8004":
      return nm.chain === "84532" && svc.erc8004AgentId != null && String(svc.erc8004AgentId) === nm.v;
    case "address":
      return [svc.payTo, ...(svc.wallets ?? [])].filter(Boolean).some((a) => a.toLowerCase() === nm.v);
    default:
      return false;
  }
}
export const isOptedOut = (matches, svc) => matches.some((m) => matchesService(normalizeMatch(m), svc));
