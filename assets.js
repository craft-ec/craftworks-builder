// THE ASSETS TAB'S VIEW (the owner's first repair goal): a tree's state after a repair pass, as the SDK's
// `db.repairAll()` report SAYS it. No DOM: `assets-panel.js` paints what this returns.
//
// The report (engineer4, sdk#479):
//   { rows, outcome, missing, putBack, rejected, givenUp, parityMismatched, pending, damaged: [{ block, present, k, health }], why }
// `outcome` is a word of the SDK's `status.repairOutcome` (healthy / repaired / partial / damaged / cancelled), derived
// ONCE in the SDK; each damaged group's `health` is a word of `status.groupHealth`. The tab derives NO health of its
// own (one owner per fact): it shows those words and lays out the counts. Its only words of its own are the tab's
// states before a report exists: "not checked", "repairing", and a pass that could not run.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = id => `${String(id).slice(0, 12)}…`;

/**
 * The row for one tree. `state`: `{ phase: "never" }`, `{ phase: "running", since, cancelling }`,
 * `{ phase: "done", report, at }` or `{ phase: "failed", error, at }`. `words`: the SDK's status lists
 * (`{ repairOutcome, groupHealth }`), so a word the SDK does not define is refused, never painted. `nowMs`: the clock.
 */
export function treeRow({ name, address, state, words, nowMs }) {
  const row = { name, address, word: "not checked", notes: [], counts: null, last: null, canRepair: true, canCancel: false, damaged: [] };
  switch (state.phase) {
    case "never":
      row.notes.push({ kind: "mute", text: "not checked this session — Repair now reads every block of this tree from your node" });
      return row;
    case "running":
      row.word = "repairing";
      row.canRepair = false;
      row.canCancel = !state.cancelling;
      row.notes.push({ kind: "mute", text: state.cancelling ? "stopping — the counts so far follow" : `reading every block from your node for ${Math.max(0, Math.round((nowMs - state.since) / 1000))} s — missing ones are rebuilt from parity and put back` });
      return row;
    case "failed":
      row.notes.push({ kind: "damaged", text: `the repair pass could not run: ${state.error}` });
      row.last = state.at;
      return row;
    case "done": {
      const r = state.report;
      if (!words.repairOutcome.includes(r.outcome)) throw new Error(`assets: repairAll said outcome ${JSON.stringify(r.outcome)}, not a word of status.repairOutcome`);
      row.word = r.outcome;
      row.last = state.at;
      row.counts = `${r.rows} rows · ${r.missing} missing · ${r.putBack} put back`;
      if (r.pending > 0) row.notes.push({ kind: "warn", text: `${plural(r.pending, "put-back")} not answered yet — Repair again to check` });
      if (r.rejected > 0) row.notes.push({ kind: "damaged", text: `${plural(r.rejected, "rebuilt block")} refused by the node (its block contract)` });
      if (r.parityMismatched > 0) row.notes.push({ kind: "damaged", text: `${plural(r.parityMismatched, "parity block")} re-encoded to a different id than the group lists — not put back` });
      if (r.givenUp > 0) row.notes.push({ kind: "damaged", text: `${plural(r.givenUp, "group")} could not be rebuilt${r.why ? `: ${r.why}` : ""}` });
      for (const g of r.damaged ?? []) {
        if (!words.groupHealth.includes(g.health)) throw new Error(`assets: a damaged group's health ${JSON.stringify(g.health)} is not a word of status.groupHealth`);
        row.damaged.push({ block: short(g.block), health: g.health, text: `${g.present} of ${g.k} blocks found` });
      }
      return row;
    }
    default:
      throw new Error(`assets: unknown repair state ${JSON.stringify(state.phase)}`);
  }
}
