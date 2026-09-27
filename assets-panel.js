// THE ASSETS TAB (the owner's first repair goal): this person's tree, Repair now (the SDK's `repairAll()`) and Cancel.
// The judgement lives in `assets.js` (no DOM, tested on its own): the words are the SDK's, and this file paints and
// calls. The tab keeps the last result for this session only: nothing is stored, and nothing is shown as measured
// that no pass of this tab measured.
import { treeRow } from "./assets.js";

const el = (tag, { dataset, ...props } = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  Object.assign(e.dataset, dataset ?? {});
  e.append(...kids.flat(Infinity).filter(k => k !== null && k !== undefined));
  return e;
};
const clock = ms => new Date(ms).toLocaleTimeString();

/**
 * Paint the tab into `root`.
 *   `repair()`: starts ONE pass and returns `{ done, cancel }` -- `done` resolves with the SDK's report (a cancelled
 *     pass resolves too, with its outcome and the counts so far); `cancel()` asks it to stop.
 *   `words`: the SDK's status lists `{ repairOutcome, groupHealth }` (a word outside them is refused).
 *   `tree()`: `{ name, address }` of the tree the pass reads.
 * Returns `{ refresh }`.
 */
export function mountAssets(root, { repair, check = null, words, tree, now = () => Date.now() }) {
  let state = { phase: "never" };
  let pass = null, ticker = null;
  // `checking`: the CHECK (nothing put back) the tab runs when it opens; else Repair now's pass.
  const start = async ({ checking = false } = {}) => {
    state = { phase: "running", since: now(), checking };
    ticker = setInterval(paint, 1_000);
    paint();
    try {
      pass = checking ? check() : repair();
      state = { phase: "done", report: await pass.done, at: now(), checked: checking };
    } catch (e) {
      state = { phase: "failed", error: e?.message ?? String(e), at: now() };
    } finally {
      pass = null;
      clearInterval(ticker);
      paint();
    }
  };
  const cancel = () => {
    if (!pass || state.phase !== "running") return;
    state = { ...state, cancelling: true };
    pass.cancel();
    paint();
  };
  function paint() {
    const { name, address } = tree();
    let row;
    try {
      row = treeRow({ name, address, state, words, nowMs: now() });
    } catch (e) {
      // A report the tab cannot read (a word the SDK does not define) is said, never painted as a health word.
      row = treeRow({ name, address, state: { phase: "failed", error: e.message, at: now() }, words, nowMs: now() });
    }
    root.replaceChildren(
      el("h2", { textContent: "Assets" }),
      el("div", { className: "sub", textContent: "Repair now reads every block of your tree from your node, on a fresh page that holds none of it. A missing block is rebuilt from its group's parity and put back on the node. A group with fewer than k blocks left anywhere cannot be rebuilt. Repair runs only while this tab is open." }),
      el("table", { className: "at" },
        el("tr", {}, ["Tree", "Health", "Last repair", ""].map(h => el("th", { textContent: h }))),
        el("tr", { dataset: { health: row.word } },
          el("td", {}, el("span", { className: "name", textContent: row.name }), row.address && el("small", {}, el("code", { textContent: row.address }))),
          el("td", {},
            el("span", { className: `h ${row.word.split(" ")[0].toLowerCase()}`, textContent: row.word }),
            row.notes.map(n => el("div", { className: n.kind === "damaged" ? "dmg" : n.kind === "warn" ? "warn" : "mute", textContent: n.text })),
            row.damaged.map(g => el("div", { className: "dmg" }, el("code", { textContent: g.block }), ` ${g.health}: ${g.text}`))),
          el("td", {}, row.last ? clock(row.last) : "—", row.counts && el("small", { className: "g", textContent: row.counts })),
          el("td", {},
            el("button", { id: "repair-now", textContent: row.canRepair ? "Repair now" : state.checking ? "Checking…" : "Repairing…", disabled: !row.canRepair, onclick: () => start() }),
            row.canCancel && el("button", { id: "repair-cancel", textContent: "Cancel", onclick: cancel })),
        ),
      ),
    );
  }
  paint();
  // The tab's first look: a CHECK of the tree (nothing put back), so the loss shows before any repair.
  if (check) start({ checking: true });
  return { refresh: paint };
}
