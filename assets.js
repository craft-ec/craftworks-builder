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
      row.word = state.checking ? "checking" : "repairing";
      row.canRepair = false;
      row.canCancel = !state.cancelling;
      row.notes.push({ kind: "mute", text: state.cancelling ? "stopping — the counts so far follow" : state.checking ? `checking every block on your node for ${Math.max(0, Math.round((nowMs - state.since) / 1000))} s — nothing is changed` : `reading every block from your node for ${Math.max(0, Math.round((nowMs - state.since) / 1000))} s — missing ones are rebuilt from parity and put back` });
      return row;
    case "failed":
      row.notes.push({ kind: "damaged", text: `the repair pass could not run: ${state.error}` });
      row.last = state.at;
      return row;
    case "done": {
      const r = state.report;
      // The report names the list its word is from (`outcomeList`: groupHealth for a pass's health, repairOutcome for
      // what a repair did): the word is checked against THAT list, so no word is spelled twice (engineer4, sdk#479).
      const list = words[r.outcomeList];
      if (!list) throw new Error(`assets: the report names outcome list ${JSON.stringify(r.outcomeList)}, not one of the SDK's`);
      if (!list.includes(r.outcome)) throw new Error(`assets: the report said outcome ${JSON.stringify(r.outcome)}, not a word of status.${r.outcomeList}`);
      row.word = r.outcome;
      // The SDK spells groupHealth's words as the engine does (upper case); compared without regard to case.
      const damagedWord = r.outcomeList === "groupHealth" && r.outcome.toLowerCase() === "damaged";
      if (r.missing > 0 && r.outcomeList === "groupHealth") row.notes.push({ kind: damagedWord ? "damaged" : "warn", text: `${plural(r.missing, "block")} missing from your node — ${damagedWord ? "some cannot be rebuilt" : "Repair now rebuilds them from parity"}` });
      row.last = state.at;
      row.counts = state.checked ? `${r.rows} rows · ${r.missing} missing` : `${r.rows} rows · ${r.missing} missing · ${r.putBack} put back`;
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

/**
 * ONE repair pass over the owner's own tree, on a COLD page: `handle.tree(headId, { seq })` opens a page of its own
 * that holds none of the tree (the project's own page wrote it and would ask the node nothing), the pass runs there, and
 * the page is closed after. Returns `{ done, cancel }`: `done` resolves with the SDK's report; `cancel()` stops it.
 * A Cancel pressed while that page is still OPENING wins: the pass is never started, the page is closed, and `done`
 * resolves with the SDK's own cancelled word (`cancelled`, from status.repairOutcome) and nothing counted.
 */
export function repairPass(handle, { cancelled: cancelledWord, putBack = true }) {
  let tree = null, cancelled = false;
  const done = (async () => {
    tree = await handle.tree(handle.headId(), { seq: handle.headSeq() });
    try {
      if (cancelled) return { rows: 0, outcome: cancelledWord, missing: 0, putBack: 0, rejected: 0, givenUp: 0, parityMismatched: 0, pending: 0, damaged: [], why: null };
      // putBack false: the CHECK (`checkAll()`, sdk#479) -- the same cold scan and counts, nothing put back by either
      // put path (the tab's first look: DEGRADED shows the loss before any repair).
      return await (putBack ? tree.db.repairAll() : tree.db.checkAll());
    } finally {
      tree.close();
    }
  })();
  return { done, cancel: () => { cancelled = true; tree?.db.repairAllCancel(); } };
}
