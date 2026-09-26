// THE PER-PIECE VIEW OF AN OPEN (sdk#451's measurement, main: every realnet run carries it). From wire-capture's
// `requests` JSONL (one line per HTTP event a browser's targets made: sent / response / finished / failed, with the
// step window it happened in), for one window: every web path the page asked (`/v1/contract/web/<path>`), each ask's
// send time, status and end, how long it took, and the GAP from its end to the next ask of the same path -- what a
// hold or a back-off looks like. Times are from the window's first request. No decoding: paths are the node's own
// addresses, as the page asked them.
//
//   node tools/piece-table.mjs <requests.jsonl> <window> [label]
import { readFileSync } from "node:fs";

/** The asks of one window, grouped by web path: `Map<path, [{ sent, status, end, how }]>`, times from its first request. */
export function piecesOf(lines, window) {
  const inWin = lines.filter(l => String(l.window) === String(window));
  if (inWin.length === 0) return { t0: null, pieces: new Map(), requests: 0 };
  const t0 = Math.min(...inWin.map(l => l.t));
  const reqs = new Map();
  for (const l of inWin) {
    const k = `${l.target}:${l.id}`;
    const r = reqs.get(k) ?? { url: null, sent: null, status: null, end: null, how: null };
    if (l.event === "sent") { r.url = l.url; r.sent = l.t - t0; }
    if (l.event === "response") r.status = l.status;
    if (l.event === "finished") { r.end = l.t - t0; r.how = "finished"; }
    if (l.event === "failed") { r.end = l.t - t0; r.how = l.canceled ? "canceled" : "failed"; }
    reqs.set(k, r);
  }
  const pieces = new Map();
  for (const r of reqs.values()) {
    if (!r.url || r.sent === null || !r.url.includes("/v1/contract/web/")) continue;
    const path = new URL(r.url).pathname.replace("/v1/contract/web/", "");
    if (!pieces.has(path)) pieces.set(path, []);
    pieces.get(path).push({ sent: r.sent, status: r.status, end: r.end, how: r.how ?? "open" });
  }
  for (const asks of pieces.values()) asks.sort((a, b) => a.sent - b.sent);
  return { t0, pieces, requests: reqs.size };
}

/** One window's summary: paths, asks, paths answered 200, re-asks, the longest ask, the longest gap, the last activity. */
export function summary(p) {
  const all = [...p.pieces.values()];
  const asks = all.flat();
  const gaps = all.flatMap(a => a.slice(1).map((r, i) => (a[i].end === null ? null : r.sent - a[i].end))).filter(g => g !== null);
  return {
    paths: all.length,
    asks: asks.length,
    ok: all.filter(a => a.some(r => r.status === 200)).length,
    reasks: asks.length - all.length,
    nonOk: asks.filter(r => r.status !== null && r.status !== 200).length,
    longestAsk: Math.max(0, ...asks.map(r => (r.end ?? r.sent) - r.sent)),
    longestGap: Math.max(0, ...gaps),
    last: Math.max(0, ...asks.map(r => r.end ?? r.sent)),
  };
}

/** The table as text: one line per ask. */
export function table(p, label = "") {
  const out = [`${label} ${p.requests} requests, ${p.pieces.size} web paths; ms from the window's first request`, "path | ask | sent | status | end | took | how | gap to next ask"];
  for (const [path, asks] of [...p.pieces.entries()].sort((a, b) => a[1][0].sent - b[1][0].sent)) {
    asks.forEach((r, i) => {
      const next = asks[i + 1];
      const gap = next && r.end !== null ? next.sent - r.end : "";
      out.push(`${path.slice(0, 24)} | ${i + 1} | ${r.sent} | ${r.status ?? "-"} | ${r.end ?? "-"} | ${r.end === null ? "" : r.end - r.sent} | ${r.how} | ${gap}`);
    });
  }
  const s = summary(p);
  out.push(`summary: ${s.paths} paths, ${s.ok} answered 200, ${s.asks} asks (${s.reasks} re-asks, ${s.nonOk} non-200); longest ask ${s.longestAsk} ms, longest gap ${s.longestGap} ms; last activity ${s.last} ms`);
  return out.join("\n");
}

export const readRequests = file => readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, window, label = ""] = process.argv.slice(2);
  if (!file || window === undefined) {
    console.error("usage: node tools/piece-table.mjs <requests.jsonl> <window> [label]");
    process.exit(2);
  }
  console.log(table(piecesOf(readRequests(file), window), label));
}
