// THE PER-PIECE VIEW OF AN OPEN (tools/piece-table.mjs, sdk#451's measurement): from a window's HTTP events, each web
// path's asks -- sent, status, end, took, how -- and the gap before the next ask of it (a hold's shape). Synthetic
// events, so every figure here is known exactly.
import assert from "node:assert/strict";
import { piecesOf, summary, table } from "../tools/piece-table.mjs";

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

const W = "http://127.0.0.1:7509/v1/contract/web/";
let id = 0;
/** One request's events: `sent` at `at`, answered `status` at `end` (or failed/canceled), in `window`. */
const ask = (path, at, status, end, { window = "9", how = "finished" } = {}) => {
  id += 1;
  const base = { window, target: "s1", id: String(id) };
  const ev = [{ ...base, t: at, event: "sent", url: `${W}${path}` }];
  if (status !== null) ev.push({ ...base, t: at + 1, event: "response", status });
  if (end !== null) ev.push({ ...base, t: end, event: how === "finished" ? "finished" : "failed", canceled: how === "canceled" });
  return ev;
};

await t("**a HOLD shows as its gap**: a slow 503, then the re-ask a hold later, answered 200", async () => {
  const lines = [
    ...ask("pieceA", 1000, 200, 1010),
    ...ask("pieceB", 1000, 503, 31_000),
    ...ask("pieceB", 31_100, 200, 31_150),
    ...ask("other/path", 1000, 200, 1005, { window: "8" }),
  ];
  const p = piecesOf(lines, 9);
  assert.equal(p.pieces.size, 2, "the window's paths");
  const b = p.pieces.get("pieceB");
  assert.deepEqual(b.map(r => [r.sent, r.status, r.end, r.how]), [[0, 503, 30_000, "finished"], [30_100, 200, 30_150, "finished"]]);
  const s = summary(p);
  assert.deepEqual(s, { paths: 2, asks: 3, ok: 2, reasks: 1, nonOk: 1, longestAsk: 30_000, longestGap: 100, last: 30_150 });
  assert.match(table(p, "T"), /pieceB \| 1 \| 0 \| 503 \| 30000 \| 30000 \| finished \| 100/);
});

await t("a CANCELLED ask (the race's extras past k) and one never answered are named, not dropped", async () => {
  const lines = [...ask("c", 5, null, 9, { how: "canceled" }), ...ask("open", 6, null, null)];
  const p = piecesOf(lines, 9);
  assert.equal(p.pieces.get("c")[0].how, "canceled");
  assert.equal(p.pieces.get("open")[0].how, "open");
  assert.equal(summary(p).ok, 0);
});

await t("only web paths count, and only this window's; an empty window says so", async () => {
  id += 1;
  const lines = [{ window: "9", target: "s1", id: String(id), t: 1, event: "sent", url: "http://127.0.0.1:7509/v1/contract/other" }, ...ask("x", 2, 200, 3, { window: "7" })];
  assert.equal(piecesOf(lines, 9).pieces.size, 0, "a non-web request was counted");
  assert.equal(piecesOf(lines, 3).t0, null, "an empty window was not empty");
});

await t("**realnet captures EVERY browser's HTTP requests by default, windowed (A and V), one loop** (every run carries the tables)", async () => {
  const { readFileSync } = await import("node:fs");
  const demo = readFileSync(new URL("../tools/realnet-demo.mjs", import.meta.url), "utf8");
  const wire = readFileSync(new URL("../tools/wire-capture.mjs", import.meta.url), "utf8");
  // EVERY captured browser records its requests (A's and V's: #451's gate is steps 9 and 12), and the table is one loop.
  const caps = [...demo.matchAll(/captureWire\((\w+)\.debug, \{([^}]*)\}/g)];
  assert.ok(caps.length >= 2, `THE CONTROL: the scan found ${caps.length} captures`);
  for (const [, browser, opts] of caps) assert.match(opts, /requests: join\(WIRE_DIR, "requests-\w+\.jsonl"\)/, `${browser}'s capture does not record its HTTP requests`);
  assert.match(demo, /for \(const wire of wires\.filter\(w => w\.requests\)\)/, "the per-piece table is not one loop over the captured browsers");
  assert.match(demo, /PIECES  \$\{wire\.label\}, step/, "the run prints no per-piece line per browser");
  assert.match(wire, /appendFileSync\(requests, JSON\.stringify\(\{ t: Date\.now\(\), window: windowOf\(\)/, "a request line carries no step window");
});

if (failures) { process.stdout.write(`piece-table: ${failures} FAILED\n`); process.exit(1); }
process.stdout.write("piece-table: all ok\n");
