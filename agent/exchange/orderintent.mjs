// AgentKoin Exchange: EIP-712 OrderIntent for POST /exchange/v1/orders and the MCP place_order (Exchange listing) path, plus the
// optional ERC-8004 "Verified agent" badge. Testnet only.
//  - OrderIntent(buyer, listingId, skillId, inputHash, evaluator, expiresAt, nonce) signed by the buyer key proves the caller controls `buyer`.
//  - Unsigned orders stay accepted for one release (flag AGENTCOIN_EXCHANGE_REQUIRE_ORDER_INTENT=1 turns enforcement on); the response is marked deprecated.
//  - If erc8004_id is given with a valid signature, the server checks ownerOf(agentId) / getAgentWallet(agentId) (read-only); a match records the
//    "verified-agent" badge. No ID means no badge, never a rejection.
// A signature proves a key. It does not prove the caller is not a human; the responses say so.
import { getAddress, isAddress, recoverTypedDataAddress, keccak256, toBytes, zeroAddress } from "viem";
import { randomBytes } from "node:crypto";
import { jcs } from "../lib/canonical.mjs";
import { ExchangeError } from "./exchange.mjs";

export const ORDER_INTENT_TYPES = {
  OrderIntent: [
    { name: "buyer", type: "address" }, { name: "listingId", type: "string" }, { name: "skillId", type: "string" }, { name: "inputHash", type: "bytes32" },
    { name: "evaluator", type: "address" }, { name: "expiresAt", type: "uint256" }, { name: "nonce", type: "uint256" },
  ],
};
export const VERIFIED_BADGE = "verified-agent";
export const CAVEAT = "A valid signature proves the caller controls this key. It does not prove the caller is not a human.";
const ZERO32 = "0x" + "0".repeat(64);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ex_order_intents (
  buyer TEXT NOT NULL, nonce TEXT NOT NULL, order_id TEXT, listing_id TEXT NOT NULL, signature TEXT NOT NULL, intent TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (buyer, nonce));
CREATE TABLE IF NOT EXISTS ex_verified_agents (
  address TEXT PRIMARY KEY, agent_id TEXT NOT NULL, basis TEXT NOT NULL, link TEXT NOT NULL, via TEXT NOT NULL, verified_at INTEGER NOT NULL);
`;
const iso = (ms) => new Date(ms).toISOString();

export class OrderIntents {
  constructor(ex, o = {}) {
    this.ex = ex;
    this.db = ex.db;
    this.require = !!o.require;
    this.db.exec(SCHEMA);
    ex.intents = this;
  }
  typedData({ buyer, listingId, skillId, input = null, evaluator = null, expiresAt, nonce }) {
    return {
      domain: this.ex.domain, types: ORDER_INTENT_TYPES, primaryType: "OrderIntent",
      message: { buyer: getAddress(buyer), listingId, skillId, inputHash: input == null ? ZERO32 : keccak256(toBytes(jcs(input))), evaluator: evaluator ? getAddress(evaluator) : zeroAddress, expiresAt: String(expiresAt), nonce: String(nonce) },
    };
  }
  /** What a client signs next time (fresh nonce, 1 h expiry). */
  suggestion(args) {
    const exp = Math.floor(this.ex.now() / 1000) + 3600;
    return { eip712: this.typedData({ ...args, expiresAt: exp, nonce: BigInt("0x" + randomBytes(8).toString("hex")).toString() }), send: "add signature, expiresAt and nonce (and optionally erc8004_id) to the same request", rule: "expiresAt: unix seconds, in the future and at most 1 h ahead; nonce: unique decimal per buyer; skillId and evaluator must match what you signed", caveat: CAVEAT };
  }
  isVerified(addr) {
    return !!this.db.prepare("SELECT 1 FROM ex_verified_agents WHERE address = ?").get(getAddress(addr));
  }
  verifiedRow(addr) {
    const r = this.db.prepare("SELECT * FROM ex_verified_agents WHERE address = ?").get(getAddress(addr));
    return r ? { agent_id: r.agent_id, basis: r.basis, via: r.via, verified_at: iso(r.verified_at), link: JSON.parse(r.link) } : null;
  }
  markVerified(addr, link, via) {
    if (!link?.linked) return false;
    this.db.prepare("INSERT INTO ex_verified_agents (address, agent_id, basis, link, via, verified_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET agent_id = excluded.agent_id, basis = excluded.basis, link = excluded.link, via = excluded.via, verified_at = excluded.verified_at")
      .run(getAddress(addr), String(link.agentId), link.basis, JSON.stringify(link), via, this.ex.now());
    return true;
  }
  /**
   * Gate + create. args: the same fields as Exchange.hire plus {signature, expiresAt, nonce, erc8004_id}. Returns hire()'s view plus
   * `orderIntent` (verified signer, badge) or `deprecated` (unsigned path).
   */
  async hire(args = {}) {
    const { signature, expiresAt, nonce, erc8004_id, ...h } = args;
    const ex = this.ex;
    const r = ex._row(h.listing_id);
    const skill = ex._skill(r, h.skill_id);
    if (!h.buyer || !isAddress(h.buyer, { strict: false })) throw new ExchangeError(400, "buyer (EVM address that funds the escrow) required");
    const buyer = getAddress(h.buyer);
    const base = { buyer, listingId: r.id, skillId: skill.skill_id, input: h.input ?? null, evaluator: h.evaluator ?? null };
    if (!signature) {
      if (this.require) throw new ExchangeError(400, "signature required: EIP-712 OrderIntent signed by buyer", this.suggestion(base));
      const v = await ex.hire(h);
      return { ...v, deprecated: { code: "unsigned_order_deprecated", message: "Unsigned orders are accepted for this release only and will be refused later. Sign an EIP-712 OrderIntent with the buyer key.", orderIntent: this.suggestion(base) }, agentVerification: { orderIntent: "absent", badge: null, caveat: CAVEAT } };
    }
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(signature))) throw new ExchangeError(400, "signature must be 0x + 130 hex");
    if (!/^[0-9]{1,12}$/.test(String(expiresAt ?? ""))) throw new ExchangeError(400, "expiresAt (unix seconds) required with signature");
    if (!/^[0-9]{1,30}$/.test(String(nonce ?? ""))) throw new ExchangeError(400, "nonce (decimal) required with signature");
    const nowS = Math.floor(ex.now() / 1000);
    if (Number(expiresAt) < nowS || Number(expiresAt) > nowS + 3600) throw new ExchangeError(400, "expiresAt must be in the future and at most 1 h ahead");
    const td = this.typedData({ ...base, expiresAt, nonce });
    let rec;
    try {
      rec = await recoverTypedDataAddress({ ...td, message: { ...td.message, expiresAt: BigInt(expiresAt), nonce: BigInt(nonce) }, signature });
    } catch {
      throw new ExchangeError(400, "signature does not parse");
    }
    if (getAddress(rec) !== buyer) throw new ExchangeError(403, "signature is not by buyer", { recovered: rec });
    if (this.db.prepare("SELECT 1 FROM ex_order_intents WHERE buyer = ? AND nonce = ?").get(buyer, String(nonce))) throw new ExchangeError(409, "nonce already used by this buyer");
    // reserve the nonce first so a concurrent replay cannot create a second order
    const t = ex.now();
    this.db.prepare("INSERT INTO ex_order_intents (buyer, nonce, order_id, listing_id, signature, intent, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)").run(buyer, String(nonce), r.id, signature, JSON.stringify(td), t);
    let v;
    try {
      v = await ex.hire(h);
    } catch (e) {
      this.db.prepare("DELETE FROM ex_order_intents WHERE buyer = ? AND nonce = ?").run(buyer, String(nonce));
      throw e;
    }
    this.db.prepare("UPDATE ex_order_intents SET order_id = ? WHERE buyer = ? AND nonce = ?").run(v.order_id, buyer, String(nonce));
    let erc = null;
    if (erc8004_id != null && erc8004_id !== "") {
      if (!/^[0-9]{1,30}$/.test(String(erc8004_id))) throw new ExchangeError(400, "erc8004_id must be a decimal agent id");
      erc = await ex.erc8004Link(erc8004_id, buyer);
      if (erc.linked) this.markVerified(buyer, erc, "order-intent");
    }
    const verified = this.isVerified(buyer);
    return { ...v, agentVerification: { orderIntent: "verified", signer: buyer, erc8004: erc, badge: verified ? VERIFIED_BADGE : null, basis: verified ? this.verifiedRow(buyer)?.basis ?? null : null, caveat: CAVEAT } };
  }
}
