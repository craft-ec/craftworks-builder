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
//     item size    predicted count   measured count   crossover value size
//        ~30 B                 250              150                5,331 B
//       ~300 B                   —              ~25              ~7,500 B
//        ~3 KB                   3               <=1              <=3,004 B
//
// 1. THE DIRECTION IS CONFIRMED, and strongly: the crossover count moved
//    150-fold across a 100-fold change in item size. The falsifier — "the
//    count comes back the same at both sizes" — did not fire, and it is
//    asserted below so it fires if it ever becomes true.
//
// 2. THE CONSTANT TOTAL SIZE IS NOT CONFIRMED. The predicted ~7,500 B is not
//    what came back: 5,331 B at 30 B items against ~7,500 B at 300 B items.
//    That is a BAND of roughly one to two leaves, not a constant, and §5
//    should say so rather than quote a number to four figures.
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

const found = [];
for (const p of PREDICTIONS) {
  let crossover = null, crossoverBytes = null;
  const rows = [];
  for (const n of p.sweep) {
    const s = await sizes(n, p.itemBytes);
    rows.push({ n, ...s });
    if (crossover === null && s.oneValue > s.perItem) { crossover = n; crossoverBytes = s.valueSize; }
  }
  process.stdout.write(`\n${p.label} (predicted crossover ≈ ${p.predictedCount} items)\n`);
  for (const r of rows) {
    process.stdout.write(
      `   n=${String(r.n).padStart(4)}  per-item ${String(r.perItem).padStart(9)} B   ` +
      `one-value ${String(r.oneValue).padStart(10)} B   value ${String(r.valueSize).padStart(8)} B   ` +
      `${r.oneValue > r.perItem ? "per-item wins" : "one-value wins"}\n`,
    );
  }
  process.stdout.write(`   => crossover at ${crossover} items, value size ${crossoverBytes} B\n`);
  found.push({ ...p, crossover, crossoverBytes });
}

process.stdout.write("\nPREDICTION vs MEASURED\n");
for (const f of found) {
  process.stdout.write(
    `   ${f.label}: predicted ${f.predictedCount} items, measured ${f.crossover}; ` +
    `crossover value size ${f.crossoverBytes} B (predicted ≈ ${PREDICTED_TOTAL_BYTES} B)\n`,
  );
}

// THE FALSIFIER, and it is the point of the file: if the crossover count is
// roughly the same at both item sizes, the COUNT is what is constant, the model
// is wrong, and §5 must withdraw its number instead of quoting it.
const counts = found.map(f => f.crossover).filter(n => n !== null);
assert.equal(counts.length, found.length, "every arm must have found a crossover inside its sweep");
assert.ok(
  Math.max(...counts) / Math.min(...counts) > 3,
  `the crossover COUNT barely moved across a 100x change in item size (${JSON.stringify(counts)}) — ` +
  "the model that makes it inversely proportional to item size is WRONG, and " +
  "ARCHITECTURE §5 must stop offering a crossover number",
);

// The constant-total-size half of the model, pinned as NOT holding. If the
// crossover sizes ever do converge, this fails and §5 may quote a number.
const sizesAtCrossover = found.map(f => f.crossoverBytes);
assert.ok(
  Math.max(...sizesAtCrossover) / Math.min(...sizesAtCrossover) > 1.5,
  "the crossover total size is now near-constant across item sizes " +
  `(${JSON.stringify(sizesAtCrossover)}) — the model's stronger claim holds ` +
  "after all, and ARCHITECTURE §5 may quote a size instead of a band",
);

// The small-item arm must be BRACKETED — its crossover must not sit on the
// first point of the sweep, or it is a bound rather than a measurement.
const smallest = found[0];
assert.notEqual(
  smallest.crossover, smallest.sweep[0],
  "the crossover landed on the first point of the sweep, so it was never " +
  "bracketed: widen the sweep downwards before reporting a number",
);

process.stdout.write("\ncrossover: all ok\n");
