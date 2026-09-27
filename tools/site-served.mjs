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
import { served, sleepFor } from "../sdk/served.js";

const appJson = (port, address) => `http://127.0.0.1:${port}/v1/contract/web/${address}/app.json`;

/** A served app.json's version: its sha256 (16 hex) and component count. */
function version(bytes) {
  let components = null;
  try {
    components = JSON.parse(new TextDecoder().decode(bytes)).components?.length ?? null;
  } catch {
    components = null;
  }
  return { sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16), components };
}

/** What a round that did not return said: the node's HTTP status, or the failure's words. */
const notServed = (w, ms) => {
  if (w?.statuses?.length) return { status: w.statuses.at(-1) };
  const said = (w?.failures ?? []).join("; ");
  return { error: /abort|timeout|timed out/i.test(said) ? `no answer within ${ms} ms` : said || "no answer" };
};

/**
 * What `port`'s node serves as the site `address`'s app.json, in ONE round: `{ sha256, components }`, or `{ status }`
 * / `{ error }`. Through the SDK's one fetch (`served`, #126), GET only, the request bounded by `ms`.
 */
export async function siteServed(port, address, { fetchImpl, ms = 30_000 } = {}) {
  const once = new AbortController();
  let said = null;
  try {
    const bytes = await served({ url: appJson(port, address) }, {
      fetch: fetchImpl,
      rec: null,
      name: "the site's app.json",
      signal: once.signal,
      init: { cache: "no-store", signal: AbortSignal.timeout(ms) },
      onWait: w => {
        said = w;
        once.abort();
      },
    });
    return version(bytes);
  } catch {
    return notServed(said, ms);
  }
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
export async function untilServed(port, address, wanted, { ms, fetchImpl, now = Date.now, sleep } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("untilServed needs a bound `ms`");
  const t0 = now();
  let reads = 0, last = null;
  try {
    // THE SDK's ONE FETCH (`served`): re-asked on the page's back-off until the node serves what `wanted` accepts; a
    // version it does not accept is "not yet" (never final), and the step's bound ends it (the `signal`).
    await served({ url: appJson(port, address) }, {
      fetch: fetchImpl,
      rec: null,
      name: "the site's app.json",
      now,
      // The page's back-off, CAPPED at what is left of the bound: a sleep never carries the wait past `ms`.
      sleep: (t, sig) => (sleep ?? sleepFor)(Math.max(0, Math.min(t, ms - (now() - t0))), sig),
      signal: { get aborted() { return now() - t0 >= ms; } },
      init: { cache: "no-store", signal: AbortSignal.timeout(Math.min(30_000, ms)) },
      check: bytes => {
        reads += 1;
        last = version(bytes);
        return wanted(last) ? null : { says: servedWords(last), answer: false };
      },
      onWait: w => {
        if (w?.statuses?.length) {
          reads += 1;
          last = { status: w.statuses.at(-1) };
        }
      },
    });
    return { served: true, after: now() - t0, reads, last };
  } catch (e) {
    return { served: false, after: now() - t0, reads, last: last ?? { error: e.message } };
  }
}

/** What a node served, in words: its version, or why there is none. */
export const servedWords = s => (s?.sha256 ? `app.json ${s.sha256} (${s.components ?? "?"} components)` : s?.status ? `HTTP ${s.status}` : s?.error ?? "nothing");
