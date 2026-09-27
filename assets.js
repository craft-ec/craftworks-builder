// THE ASSETS TAB'S VIEW (the owner's first repair goal, 2026-09-27): a tree's health AFTER a repair pass, read from the
// SDK's `repairAll()` report and nothing else. No DOM: `assets-panel.js` paints what this returns.
//
// `repairAll()` (the SDK, engineer4) reads the WHOLE tree through the normal read on a page whose store is cold for it,
// rebuilds every missing block from any k of its group (members and parity alike) and PUTs it back, and resolves when
// the scan has ended and every repair PUT is answered:
//   { rows, missing, putBack, rejected, givenUp, why }
// The tab derives ONE word from it (one derivation, `health`), and says what the counts mean; it measures nothing.

/** The pass's health word, from a finished report. */
export function health(r) {
  if (r.givenUp > 0) return "damaged";
  if (r.missing === 0) return "healthy";
  if (r.putBack === r.missing) return "repaired";
  return "partial";
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The row for one tree. `state`: `{ phase: "never" }`, `{ phase: "running", since }`, `{ phase: "done", report, at }`
 * or `{ phase: "failed", error, at }`. `nowMs` is the page's clock.
 */
export function treeRow({ name, address, state, nowMs }) {
  const row = { name, address, word: "not checked", notes: [], counts: null, last: null, canRepair: true };
  switch (state.phase) {
    case "never":
      row.notes.push({ kind: "mute", text: "not checked this session — Repair now reads every block of this tree from your node" });
      return row;
    case "running":
      row.word = "repairing";
      row.canRepair = false;
      row.notes.push({ kind: "mute", text: `reading every block from your node for ${Math.max(0, Math.round((nowMs - state.since) / 1000))} s — missing ones are rebuilt from parity and put back` });
      return row;
    case "failed":
      row.word = "not checked";
      row.notes.push({ kind: "damaged", text: `the repair pass could not run: ${state.error}` });
      row.last = state.at;
      return row;
    case "done": {
      const r = state.report;
      row.word = health(r);
      row.last = state.at;
      row.counts = `${r.rows} rows · ${r.missing} missing · ${r.putBack} put back`;
      if (row.word === "healthy") row.notes.push({ kind: "mute", text: "every block was on your node" });
      if (row.word === "repaired") row.notes.push({ kind: "ok", text: `${plural(r.missing, "missing block")} rebuilt from parity and put back` });
      if (row.word === "partial") row.notes.push({ kind: "warn", text: `${r.putBack} of ${r.missing} missing blocks put back — Repair again to finish` });
      if (r.rejected > 0) row.notes.push({ kind: "damaged", text: `${plural(r.rejected, "rebuilt block")} refused by the node (its block contract)` });
      if (r.givenUp > 0) row.notes.push({ kind: "damaged", text: `${plural(r.givenUp, "group")} could not be rebuilt: fewer than k of its blocks anywhere${r.why ? ` (${r.why})` : ""}` });
      return row;
    }
    default:
      throw new Error(`assets: unknown repair state ${JSON.stringify(state.phase)}`);
  }
}
