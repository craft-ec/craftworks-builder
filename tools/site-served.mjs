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
