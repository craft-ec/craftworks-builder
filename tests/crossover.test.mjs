// Where the crossover sits at DIFFERENT item sizes — and what that says about
// whether ARCHITECTURE §5 may publish a number at all.
//
// # The predictions, written down BEFORE the run
//
// The model: equating one growing value (`c·N²/2 + N·k₁`) with one record per
// item (`N·k₂`) gives `N* = 2(k₂ − k₁)/c`, so the crossover COUNT is inversely
// proportional to item size — and `N*·c = 2(k₂ − k₁)` has no item size in it,
// so the crossover TOTAL SIZE should be constant. Calibrated from the measured
// point (≈25 items at ~300 B, ≈ 7.5 KB), the predictions are:
//
//     ~30 B items    crossover ≈ 250 items
//     ~3 KB items    crossover ≈ 2–3 items
//     both cases     crossover total size ≈ 7.5 KB
//
// # The falsifying outcome, stated in advance
//
// If the crossover comes back near 25 ITEMS again at a different item size,
// the count is what is constant and the model is wrong — and §5 must stop
// offering a number rather than quote one that does not travel.
//
// This file is committed BEFORE it is run, so the predictions cannot be fitted
// to the result afterwards. The confirming outcome is the one that needs the
// scrutiny; a contradicting one audits itself.
//
// # THE RESULT — the direction holds, the constant does not
//
//     item size    predicted count   measured (3 runs)   crossover value size
//        ~30 B                 250           100-150 items        3,481-5,331 B
//       ~300 B                   —                ~25 items             ~7,500 B
//        ~3 KB                   3                 <=1 item             <=3,004 B
//
// THE NUMBERS ARE BANDS, and the first version of this file reported points.
// Five repeats of the SAME arm land anywhere from 100 to 150 items (1.5x),
// because record ids are time-derived: the keys differ between runs and the
// content-defined chunk boundaries move with them. A single run reports a
// point where there is a band, which is how a crossover of "150" got quoted.
//
// 1. THE DIRECTION IS CONFIRMED, and strongly: the crossover count moved
//    150-fold across a 100-fold change in item size. The falsifier — "the
//    count comes back the same at both sizes" — did not fire, and it is
//    asserted below so it fires if it ever becomes true.
//
// 2. THE CONSTANT TOTAL SIZE IS NOT CONFIRMED — and cannot be settled here.
//    The predicted ~7,500 B did not come back (3.5-5.3 KB at 30 B items), but
//    one arm's own repeat spread is 1.5x, so two arms cannot decide whether
//    the underlying quantity is constant. What the data supports is a BAND of
//    roughly one to two leaves, which is what §5 says. The earlier version of
//    this file ASSERTED "not constant" on a difference smaller than the noise;
//    that assertion is gone.
//
// 3. THE 3 KB ARM IS AN UPPER BOUND, NOT A MEASUREMENT. Its crossover landed
//    on the FIRST point of the sweep (n=1), so the sweep never bracketed it —
//    per-item already wins at one item, and there is no n below one. It is
//    reported as "<=1 item, <=3,004 B" rather than as a measured crossover,
//    because a value at the edge of a sweep is a bound.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));

const PREDICTIONS = [
  { label: "~30 B items", itemBytes: 30, predictedCount: 250, sweep: [50, 100, 150, 200, 250, 300, 400] },
  { label: "~3 KB items", itemBytes: 3000, predictedCount: 3, sweep: [1, 2, 3, 4, 6, 8] },
];
const PREDICTED_TOTAL_BYTES = 7500;

/** Build N items each way, incrementally, and return the store sizes. */
async function sizes(n, itemBytes) {
  const item = i => ({ d: `d${i}`, b: "x".repeat(Math.max(1, itemBytes - 20)) });

  const perItem = new sdk.Db();
  await perItem.define("it", { type: "I", fields: [{ name: "v", kind: "text", required: true }] });
  for (let i = 0; i < n; i++) await perItem.put("it", { v: JSON.stringify(item(i)) });

  const oneValue = new sdk.Db();
  await oneValue.define("k", { type: "K", fields: [{ name: "v", kind: "text", required: true }] });
  const rec = await oneValue.put("k", { v: "{}" });
  const all = {};
  for (let i = 0; i < n; i++) {
    all[`c${i}`] = item(i);
    await oneValue.update("k", rec.id, { v: JSON.stringify(all) });
  }

  return { perItem: perItem.stats().bytes, oneValue: oneValue.stats().bytes, valueSize: JSON.stringify(all).length };
}

// REPEATS, because a single run of one arm cannot say where a crossover is.
// Measured: the same arm lands anywhere from 100 to 150 items across five runs
// (1.5x), because record ids are time-derived, so the keys differ between runs
// and the content-defined chunk boundaries move with them. A single run of this
// sweep reports a point where there is a band.
const REPEATS = 3;

const found = [];
for (const p of PREDICTIONS) {
  const crossings = [], byteses = [];
  let rows = [];
  for (let run = 0; run < REPEATS; run++) {
    let crossover = null, crossoverBytes = null;
    const theseRows = [];
    for (const n of p.sweep) {
      const s = await sizes(n, p.itemBytes);
      theseRows.push({ n, ...s });
      if (crossover === null && s.oneValue > s.perItem) { crossover = n; crossoverBytes = s.valueSize; break; }
    }
    crossings.push(crossover); byteses.push(crossoverBytes);
    if (run === 0) rows = theseRows;
  }
  const crossover = Math.min(...crossings), crossoverHigh = Math.max(...crossings);
  const crossoverBytes = Math.min(...byteses), crossoverBytesHigh = Math.max(...byteses);
  process.stdout.write(`\n${p.label} (predicted crossover ≈ ${p.predictedCount} items)\n`);
  for (const r of rows) {
    process.stdout.write(
      `   n=${String(r.n).padStart(4)}  per-item ${String(r.perItem).padStart(9)} B   ` +
      `one-value ${String(r.oneValue).padStart(10)} B   value ${String(r.valueSize).padStart(8)} B   ` +
      `${r.oneValue > r.perItem ? "per-item wins" : "one-value wins"}\n`,
    );
  }
  process.stdout.write(
    `   => crossover ${crossover}-${crossoverHigh} items over ${REPEATS} runs, ` +
    `value ${crossoverBytes}-${crossoverBytesHigh} B\n`,
  );
  found.push({ ...p, crossover, crossoverHigh, crossoverBytes, crossoverBytesHigh });
}

process.stdout.write("\nPREDICTION vs MEASURED\n");
for (const f of found) {
  process.stdout.write(
    `   ${f.label}: predicted ${f.predictedCount} items, measured ${f.crossover}-${f.crossoverHigh}; ` +
    `crossover value ${f.crossoverBytes}-${f.crossoverBytesHigh} B (predicted ≈ ${PREDICTED_TOTAL_BYTES} B)\n`,
  );
}

// THE FALSIFIER, and it is the point of the file: if the crossover count is
// roughly the same at both item sizes, the COUNT is what is constant, the model
// is wrong, and §5 must withdraw its number instead of quoting it.
const counts = found.map(f => f.crossover).filter(n => n !== null);
assert.equal(counts.length, found.length, "every arm must have found a crossover inside its sweep");
assert.ok(
  Math.max(...counts) / Math.min(...counts) > 10,
  `the crossover COUNT barely moved across a 100x change in item size (${JSON.stringify(counts)}) — ` +
  "the model that makes it inversely proportional to item size is WRONG, and " +
  "ARCHITECTURE §5 must stop offering a crossover number",
);

// The constant-total-size half is REPORTED, NOT ASSERTED, and that is the
// honest call: the same arm's crossover value ranges 3,481-5,331 B across
// repeats, so two arms cannot settle whether the underlying quantity is
// constant. What the data does support is a BAND of roughly one to two leaves,
// which is what §5 says. Asserting "not constant" here would be asserting a
// difference smaller than the noise — the error this file exists to avoid.

// The small-item arm must be BRACKETED — its crossover must not sit on the
// first point of the sweep, or it is a bound rather than a measurement.
const smallest = found[0];
assert.notEqual(
  smallest.crossover, smallest.sweep[0],
  "the crossover landed on the first point of the sweep, so it was never " +
  "bracketed: widen the sweep downwards before reporting a number",
);

process.stdout.write("\ncrossover: all ok\n");
