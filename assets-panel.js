// THE ASSETS TAB (the owner's first repair goal): this app's tree, and a Repair now button that runs the SDK's
// `repairAll()` on the project's session. The judgement lives in `assets.js` (no DOM, tested on its own); this file
// paints and calls. The tab keeps the last result for this session only: nothing is stored, and nothing is shown as
// measured that no pass of this tab measured.
import { treeRow } from "./assets.js";

const el = (tag, { dataset, ...props } = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  Object.assign(e.dataset, dataset ?? {});
  e.append(...kids.flat(Infinity).filter(k => k !== null && k !== undefined));
  return e;
};
const clock = ms => new Date(ms).toLocaleTimeString();

/**
 * Paint the tab into `root`. `session`: the project's SDK session (its `repairAll()`); `tree()`: `{ name, address }` of
 * the tree it works on. Returns `{ refresh }`.
 */
export function mountAssets(root, { session, tree, now = () => Date.now() }) {
  let state = { phase: "never" };
  let ticker = null;
  const repair = async () => {
    state = { phase: "running", since: now() };
    ticker = setInterval(paint, 1_000);
    paint();
    try {
      state = { phase: "done", report: await session.repairAll(), at: now() };
    } catch (e) {
      state = { phase: "failed", error: e?.message ?? String(e), at: now() };
    } finally {
      clearInterval(ticker);
      paint();
    }
  };
  function paint() {
    const { name, address } = tree();
    const row = treeRow({ name, address, state, nowMs: now() });
    root.replaceChildren(
      el("h2", { textContent: "Assets" }),
      el("div", { className: "sub", textContent: "Repair now reads every block of this tree from your node. A missing block is rebuilt from its group's parity and put back on the node. A group with fewer than k blocks left anywhere cannot be rebuilt: it is DAMAGED. Repair runs only while this tab is open." }),
      el("table", { className: "at" },
        el("tr", {}, ["Tree", "Health", "Last repair", ""].map(h => el("th", { textContent: h }))),
        el("tr", { dataset: { health: row.word } },
          el("td", {}, el("span", { className: "name", textContent: row.name }), el("small", {}, el("code", { textContent: row.address }))),
          el("td", {}, el("span", { className: `h ${row.word.split(" ")[0]}`, textContent: row.word }), row.notes.map(n => el("div", { className: n.kind === "damaged" ? "dmg" : n.kind === "warn" ? "warn" : n.kind === "ok" ? "okn" : "mute", textContent: n.text }))),
          el("td", {}, row.last ? clock(row.last) : "—", row.counts && el("small", { className: "g", textContent: row.counts })),
          el("td", {}, el("button", { id: "repair-now", textContent: row.canRepair ? "Repair now" : "Repairing…", disabled: !row.canRepair, onclick: repair })),
        ),
      ),
    );
  }
  paint();
  return { refresh: paint };
}
