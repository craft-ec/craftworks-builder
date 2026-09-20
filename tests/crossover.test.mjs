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

process.stdout.write("\ncrossover: all ok\n");
