// THE ASSETS TAB (builder#164; KEEPER.md §1, §3). The judgement lives in `assets.js`, which has no DOM and is tested on
// its own; this file paints and calls. `api` is the SDK's keep API on the session handle: `keepAssets`, `keepReport`,
// `keepSet`, `keepAudit`, `notAnswering({ lane })`. Every edit is ONE `keepSet` (the SDK validates the address and
// merges the record, rule 15); the builder writes nothing else.
import { assetsView } from "./assets.js";

const el = (tag, { dataset, ...props } = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  Object.assign(e.dataset, dataset ?? {});
  e.append(...kids.flat(Infinity).filter(k => k !== null && k !== undefined));
  return e;
};

const POLICIES = [["always", "always (keep backed up)"], ["below 1", "below 1"], ["below 2", "below 2"], ["below 3", "below 3"], ["off", "off (watch only)"]];
const toPolicy = v => (v === "always" || v === "off" ? v : { below: Number(v.split(" ")[1]) });
const fromWords = w => (w.startsWith("always") ? "always" : w.startsWith("off") ? "off" : w);

/** Paint the tab into `root` from `api`; `labels` names the apps this builder published. Returns `{ refresh }`. */
export function mountAssets(root, { api, labels = () => new Map(), now = () => Date.now() }) {
  const note = el("div", { className: "keep-said", role: "status" });
  const paint = () => {
    const assets = api.keepAssets();
    const reports = new Map(assets.map(a => [a.target, api.keepReport(a.target)]));
    const { running, rows } = assetsView({ assets, reports, labels: labels(), waiting: api.notAnswering({ lane: "background" }), nowMs: now() });
    const policySelect = (row) => {
      const s = el("select", { title: "Repair" }, POLICIES.map(([v, w]) => el("option", { value: v, textContent: w })));
      const cur = POLICIES.find(([, w]) => w === row.repair) ?? [fromWords(row.repair)];
      s.value = cur[0];
      s.onchange = () => { api.keepSet(row.target, { repair: toPolicy(s.value) }); paint(); };
      return s;
    };
    const warnInput = (row) => {
      const i = el("input", { className: "n", type: "number", min: 0, value: row.warnBelow, title: "Warn below" });
      i.onchange = () => { api.keepSet(row.target, { warn_below: Number(i.value) }); paint(); };
      return i;
    };
    const table = el("table", { className: "at" },
      el("tr", {}, ["Asset", "Health", "Groups", "Last full audit", "Repair", "Warn below", ""].map(h => el("th", { textContent: h }))),
      rows.map(r => el("tr", { dataset: { target: r.target } },
        el("td", {}, el("span", { className: "name", textContent: r.name }), el("small", { textContent: r.sub })),
        el("td", {}, el("span", { className: `h ${r.word.split(" ")[0]}`, textContent: r.word }), r.notes.map(n => el("div", { className: n.kind === "damaged" ? "dmg" : n.kind === "warn" ? "warn" : "mute", textContent: n.text }))),
        el("td", { className: "g", textContent: r.groups }),
        el("td", {}, r.last, r.lastNote && el("small", { textContent: r.lastNote })),
        el("td", {}, policySelect(r)),
        el("td", {}, warnInput(r)),
        el("td", {}, el("button", { textContent: r.word === "auditing" ? "Auditing" : "Audit now", disabled: !r.canAudit, onclick: () => { api.keepAudit(r.target); paint(); } })),
      )));
    const addr = el("input", { placeholder: "Keep an app by its link (a …/v1/contract/web/… URL, or its site id)" });
    const pol = el("select", {}, POLICIES.map(([v, w]) => el("option", { value: v, textContent: w })));
    const keep = el("button", { textContent: "Keep this", onclick: () => {
      const r = api.keepSet(addr.value.trim(), { repair: toPolicy(pol.value) });
      note.textContent = r?.refused ? `Not kept: ${r.said}` : "";
      if (!r?.refused) { addr.value = ""; paint(); }
    } });
    root.replaceChildren(
      el("h2", { textContent: "Assets" }),
      el("div", { className: "sub", textContent: "What this identity keeps, and how each one is doing. Audits and repairs run only while an Assets tab is open (one op at a time, behind your apps' own requests). Health means: held by your node or findable from it, and verified — the network does not report how many copies exist." }),
      running && el("div", { className: "pass" }, el("b", { textContent: "Auditing" }), el("span", { textContent: `${running.name} · ${running.pass} pass` }),
        el("span", { className: "bar" }, el("i", { style: `width:${Math.round((100 * running.asked) / Math.max(1, running.of))}%` })),
        el("span", { className: "g", textContent: `${running.asked} / ${running.of} blocks asked` }), running.waiting && el("span", { className: "slow", textContent: running.waiting })),
      table,
      el("div", { className: "keep" }, addr, pol, keep), note,
      el("div", { className: "foot", textContent: "Publishing an app adds it here once, on its first publish, with always (keep backed up) and warn below 2. Every setting is saved in your own tree, so your other devices show and continue the same list." }),
    );
  };
  paint();
  return { refresh: paint };
}
