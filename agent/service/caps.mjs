// Daily usage caps for the public testnet service. Pure in-memory accounting (no persistence of IPs).
// - per-IP paid calls/day: the IP is never stored; it is reduced to HMAC-SHA256(daySalt, ip), and the salt is random,
//   kept only in memory and replaced at each UTC day boundary, so hashes cannot be linked across days or restarts.
// - per-payer-address paid calls/day (addresses are public on-chain data).
// - global gas budget/day (wei) across every tx the service signs (relayer settle/finalize, provider submit,
//   evaluator verdict). Admission reserves an estimated lifecycle cost; actual costs replace the reservation.
// - per-IP free requests/hour (read endpoints and MCP), to bound RPC load.
import { createHmac, randomBytes } from "node:crypto";

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export class Caps {
  constructor({ perIpPerDay = 10, perAddressPerDay = 5, globalGasWeiPerDay = 50_000_000_000_000n, globalPaidPerDay = 100, freePerIpPerHour = 600, now = () => Date.now() } = {}) {
    Object.assign(this, { perIpPerDay, perAddressPerDay, globalGasWeiPerDay: BigInt(globalGasWeiPerDay), globalPaidPerDay, freePerIpPerHour, now });
    this._reset(utcDay(now()));
  }

  _reset(day) {
    this.day = day;
    this.salt = randomBytes(32);
    this.ip = new Map();
    this.addr = new Map();
    this.free = new Map();
    this.paid = 0;
    this.gasSpent = 0n;
    this.gasReserved = 0n;
  }

  _roll() {
    const d = utcDay(this.now());
    if (d !== this.day) this._reset(d);
  }

  ipKey(ip) {
    return createHmac("sha256", this.salt).update(String(ip ?? "unknown")).digest("hex").slice(0, 32);
  }

  /** Free-request limiter (per IP per hour). Returns {ok, retryAfterSeconds?}. */
  checkFree(ip) {
    this._roll();
    const hour = Math.floor(this.now() / 3_600_000);
    const k = this.ipKey(ip);
    const e = this.free.get(k);
    const cur = e && e.hour === hour ? e : { hour, n: 0 };
    if (cur.n >= this.freePerIpPerHour) return { ok: false, reason: "free_rate_limit", retryAfterSeconds: 3600 - Math.floor((this.now() / 1000) % 3600) };
    cur.n++;
    this.free.set(k, cur);
    return { ok: true };
  }

  /** Check (without consuming) whether a paid call from ip/payer with estimated lifecycle gas can be admitted. */
  checkPaid(ip, payer, estGasWei) {
    this._roll();
    const ipN = this.ip.get(this.ipKey(ip)) ?? 0;
    const aN = this.addr.get(String(payer).toLowerCase()) ?? 0;
    if (this.paid >= this.globalPaidPerDay) return { ok: false, reason: "global_daily_paid_call_cap" };
    if (ipN >= this.perIpPerDay) return { ok: false, reason: "per_ip_daily_cap" };
    if (aN >= this.perAddressPerDay) return { ok: false, reason: "per_address_daily_cap" };
    if (this.gasSpent + this.gasReserved + BigInt(estGasWei) > this.globalGasWeiPerDay) return { ok: false, reason: "global_daily_gas_cap" };
    return { ok: true };
  }

  /** Consume one paid-call slot and reserve gas. Returns a reservation handle or a rejection. */
  admitPaid(ip, payer, estGasWei) {
    const r = this.checkPaid(ip, payer, estGasWei);
    if (!r.ok) return r;
    const k = this.ipKey(ip);
    const a = String(payer).toLowerCase();
    this.ip.set(k, (this.ip.get(k) ?? 0) + 1);
    this.addr.set(a, (this.addr.get(a) ?? 0) + 1);
    this.paid++;
    const res = { day: this.day, reserved: BigInt(estGasWei) };
    this.gasReserved += res.reserved;
    return { ok: true, reservation: res };
  }

  /** Undo an admission (e.g. settle failed before any tx landed). */
  release(reservation, { ip, payer } = {}) {
    if (!reservation || reservation.day !== this.day) return;
    this.gasReserved -= reservation.reserved;
    if (this.gasReserved < 0n) this.gasReserved = 0n;
    reservation.reserved = 0n;
    if (ip !== undefined) {
      const k = this.ipKey(ip);
      this.ip.set(k, Math.max(0, (this.ip.get(k) ?? 1) - 1));
    }
    if (payer !== undefined) {
      const a = String(payer).toLowerCase();
      this.addr.set(a, Math.max(0, (this.addr.get(a) ?? 1) - 1));
    }
    this.paid = Math.max(0, this.paid - 1);
  }

  /** Job finished (settled/disputed/terminal): return any unspent reserved gas to the pool; admission counts stay. */
  finish(reservation) {
    if (!reservation) return;
    if (reservation.day === this.day && reservation.reserved > 0n) {
      this.gasReserved -= reservation.reserved;
      if (this.gasReserved < 0n) this.gasReserved = 0n;
    }
    reservation.reserved = 0n;
  }

  /** Record actual gas spent by a service-signed tx; draws down the reservation first. */
  spend(weiSpent, reservation) {
    this._roll();
    const w = BigInt(weiSpent);
    this.gasSpent += w;
    if (reservation && reservation.day === this.day && reservation.reserved > 0n) {
      const d = w < reservation.reserved ? w : reservation.reserved;
      reservation.reserved -= d;
      this.gasReserved -= d;
    }
  }

  /** Whether a background (non-admission) tx may spend: verdict/finalize for already-admitted jobs are always allowed
   *  up to 2x the daily budget so admitted jobs are never stranded (a missed verdict would slash the evaluator). */
  canSpendBackground(estWei) {
    this._roll();
    return this.gasSpent + BigInt(estWei) <= this.globalGasWeiPerDay * 2n;
  }

  snapshot() {
    this._roll();
    return {
      day: this.day,
      limits: { perIpPaidPerDay: this.perIpPerDay, perAddressPaidPerDay: this.perAddressPerDay, globalPaidPerDay: this.globalPaidPerDay, globalGasWeiPerDay: this.globalGasWeiPerDay.toString(), freeRequestsPerIpPerHour: this.freePerIpPerHour },
      usage: { paidCalls: this.paid, gasSpentWei: this.gasSpent.toString(), gasReservedWei: this.gasReserved.toString() },
    };
  }
}
