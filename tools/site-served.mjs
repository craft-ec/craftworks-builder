// WHICH VERSION OF A SITE EACH NODE SERVES (realnet names its own failure; the architect on batch 7a's step 9).
//
// When a republish is not seen, two things can be wrong: the PUBLISHER's register never moved, or the READER's node
// serves a stale state. The demo's step line cannot tell them apart. This reads the site's starter `app.json` -- the
// app definition a structure change changes -- from a node's WEB path, the same read-only HTTP GET a view's loader
// makes, and reports its sha256 and component count. Read from the publisher's node and from A's, side by side, the
// line says WHICH node serves which version.
//
// It never writes: a GET of `/v1/contract/web/<address>/app.json`, bounded, and a failure is reported as what happened
// (a status, a timeout), never as a version.
//
// NOT here: the site record's own version (its signed seq). The web path serves only the unpacked starter, and reading
// the record needs a client-API GET, which only the SDK's encoder may frame (a second encoder here is refused, as
// frame-put's rule says).
import { createHash } from "node:crypto";

/** What `port`'s node serves as the site `address`'s app.json: `{ sha256, components }`, or `{ status }` / `{ error }`. */
export async function siteServed(port, address, { fetchImpl = globalThis.fetch, ms = 30_000 } = {}) {
  let r;
  try {
    r = await fetchImpl(`http://127.0.0.1:${port}/v1/contract/web/${address}/app.json`, { signal: AbortSignal.timeout(ms) });
  } catch (e) {
    return { error: e.name === "TimeoutError" ? `no answer within ${ms} ms` : e.message };
  }
  if (!r.ok) return { status: r.status };
  const bytes = new Uint8Array(await r.arrayBuffer());
  let components = null;
  try {
    components = JSON.parse(new TextDecoder().decode(bytes)).components?.length ?? null;
  } catch {
    components = null;
  }
  return { sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16), components };
}

/** The line realnet prints: each node's served version, and whether they agree. */
export function servedLine(when, served) {
  const one = ([label, s]) => (s.sha256 ? `${label} serves app.json ${s.sha256} (${s.components ?? "?"} components)` : `${label}: ${s.status ? `HTTP ${s.status}` : s.error}`);
  const shas = served.map(([, s]) => s.sha256).filter(Boolean);
  const verdict = shas.length === served.length ? (new Set(shas).size === 1 ? "SAME version" : "DIFFERENT versions") : "not all read";
  return `SITE  ${when}: ${served.map(one).join("; ")} -- ${verdict}`;
}

/**
 * UNTIL `port`'s node SERVES the version `wanted` accepts (a `siteServed` answer -> boolean), read-only: one GET every
 * `everyMs`, bounded by `ms` (realnet's step budget; a DEADLINE on a wait for the network's propagation, never on a
 * write). A page loads ONE app.json, so a view opened before its node serves the new version can never show it: step
 * 10 waits HERE, then loads (7c's run loaded v1 at +1.4 s and waited 180 s on a page that could not change).
 * Returns `{ served: true, after, reads, last }`, or `{ served: false, after, reads, last }` -- `last` is what the node
 * served at the end (a version, a status, an error), so a real propagation failure reads as one.
 */
export async function untilServed(port, address, wanted, { ms, everyMs = 2_000, fetchImpl = globalThis.fetch, now = Date.now, sleep = t => new Promise(r => setTimeout(r, t)) } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("untilServed needs a bound `ms`");
  const t0 = now();
  let reads = 0, last = null;
  for (;;) {
    // Each read has its own bound (a GET, at most 30 s); the step's bound `ms` is checked between reads.
    last = await siteServed(port, address, { fetchImpl, ms: Math.min(30_000, ms) });
    reads += 1;
    if (wanted(last)) return { served: true, after: now() - t0, reads, last };
    if (now() - t0 + everyMs > ms) return { served: false, after: now() - t0, reads, last };
    await sleep(everyMs);
  }
}

/** What a node served, in words: its version, or why there is none. */
export const servedWords = s => (s?.sha256 ? `app.json ${s.sha256} (${s.components ?? "?"} components)` : s?.status ? `HTTP ${s.status}` : s?.error ?? "nothing");
