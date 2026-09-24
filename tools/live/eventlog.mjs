// WHO TOUCHED A KEY, from the harness nodes' own EVENT LOGS (`--enable-event-log true`; harness nodes only).
//
// Measured on freenet 0.2.136 (engineer1, 2026-09-24; the architect's ruling (2')):
//   * the FILE log never carries DEBUG (`--log-level debug`, LOG_LEVEL and RUST_LOG all gave 0 DEBUG lines),
//     and at INFO a GET's answer names no peer, so the file log cannot say who answered;
//   * the event log (`<data-dir>/_EVENT_LOG.*`, freenet's own bincode) records every operation on a key, and
//     carries the contract key as its 32 RAW bytes, each record preceded by an RFC 3339 timestamp.
//
// So this reads it at the BYTE level: every occurrence of the key's 32 bytes, dated by the timestamp that
// precedes it. The claim this supports is exactly "node K TOUCHED key k at t" -- TOUCHED, not SERVED: the
// byte read cannot tell a Request from a ResponseSent. A typed decoder built on freenet's own types at the
// node's exact version (refusing on a version mismatch) is the upgrade; freenet's pub(crate) types are never
// copied to fake it. A false 32-byte match is negligible.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const LIMIT = "byte-level read: 'touched' (any event on the key), never 'served' -- it cannot tell a Request from a ResponseSent";

/** A contract address (base58, as the node serves it) as its 32 raw bytes. */
export function keyBytes(address) {
  let n = 0n;
  for (const c of address) {
    const d = ALPHABET.indexOf(c);
    if (d < 0) throw new Error(`not a base58 address: ${address}`);
    n = n * 58n + BigInt(d);
  }
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  if (n !== 0n) throw new Error(`${address} is longer than 32 bytes`);
  return out;
}

const STAMP = /20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g;

/** The event-log files of a node's data dir; [] when there are none. */
export function eventLogs(dataDir) {
  let names = [];
  try { names = readdirSync(dataDir).filter(n => /^_EVENT_LOG\.\d+$/.test(n)).sort(); } catch { return []; }
  return names.map(n => join(dataDir, n));
}

/**
 * Every time node `dataDir` touched `address`: the ms timestamps of the records whose bytes hold the key.
 * `readable: false` when there is no event log, or a hit has no timestamp before it -- the precheck's fields.
 */
export function touches(dataDir, address) {
  const files = eventLogs(dataDir);
  if (!files.length) return { readable: false, why: `no event log in ${dataDir}`, at: [] };
  const key = keyBytes(address);
  const at = [];
  for (const f of files) {
    const buf = readFileSync(f);
    const text = buf.toString("latin1");
    const stamps = [...text.matchAll(STAMP)].map(m => ({ i: m.index, t: Date.parse(m[0]) }));
    for (let i = buf.indexOf(key); i !== -1; i = buf.indexOf(key, i + 1)) {
      let t = null;
      for (let lo = 0, hi = stamps.length - 1; lo <= hi;) {
        const mid = (lo + hi) >> 1;
        if (stamps[mid].i < i) { t = stamps[mid].t; lo = mid + 1; } else hi = mid - 1;
      }
      if (t === null) return { readable: false, why: `a record of the key in ${f} has no timestamp before it`, at };
      at.push(t);
    }
  }
  return { readable: true, at };
}

/** Did node `dataDir` touch `address` inside [fromMs, toMs]? The count, and the read's limit. */
export function touchedIn(dataDir, address, fromMs, toMs) {
  const r = touches(dataDir, address);
  return { ...r, n: r.at.filter(t => t >= fromMs && t <= toMs).length };
}
