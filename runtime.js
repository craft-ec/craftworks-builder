// Runs an app definition as live UI over the SDK. Used by the builder's Preview;
// the published app will use the same module.
import { byType } from "./catalogue.js";
import { openApp, toFields, display, headline, inputType } from "./runtime-logic.js";
import { show, isLive, UNPUBLISHED } from "./publish-state.js";

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat(Infinity)); return e; };

/**
 * Mount `app` into `root`. `onData(db)` is called after every change so the host
 * (the builder's tree panel) can show live counts. Returns the db.
 */
export function mountApp(root, sdk, app, onData = () => {}) {
  const { db, problems } = openApp(sdk, app);
  const editing = {}; // domain → record being edited

  // ONE BINDING PER COMPONENT, and components read its snapshot rather than
  // calling the db. That is the whole point of the shape: a snapshot read is
  // synchronous on every backend, and the round trip — the reload — is the
  // only part that is not. Flipping `live` changes which mechanism refreshes
  // the binding and nothing about how the component reads it.
  const bindings = app.components.map(inst => db.bind(inst.domain, { live: isLive(inst) }));

  // Reloading is a ROUND TRIP once this is over the engine, so it is awaited
  // even though the in-memory backend answers at once. Writing it synchronous
  // now and async later is how one surface becomes two.
  const refresh = async () => { for (const b of bindings) await b.reload(); };
  const changed = async () => { await refresh(); render(); onData(db); };
  const guard = async (fn, box) => { try { await fn(); box.textContent = ""; } catch (e) { box.textContent = e.message; } };

  // What a row says about itself.
  //
  // An unpublished project's rows say so, because its data is in this tab and
  // nowhere else — "saved" would claim the exact thing Publish is for, and the
  // person would find out by closing the tab. Per ROW and not only in the
  // address bar, because the decision to close is made while looking at the
  // rows.
  //
  // `published` is false until Publish switches the backend; then each row
  // carries its own write's state, which is why this is a function of the
  // record rather than a constant.
  const published = false;
  const stateChip = () => {
    const s = show(published ? "published" : UNPUBLISHED);
    return el("span", { className: `rt-state ${s.tone}`, textContent: s.label, title: s.hint });
  };

  function form(inst, schema) {
    const rec = editing[inst.domain];
    const inputs = {};
    const err = el("p", { className: "rt-err" });
    const rows = schema.fields.map(f => {
      const i = el("input", { type: inputType(f.kind), name: f.name });
      if (f.kind === "float") i.step = "any";
      const v = rec?.fields[f.name];
      if (f.kind === "bool") i.checked = !!v;
      else if (v !== undefined && v !== null) i.value = f.kind === "time" ? new Date(v).toISOString().slice(0, 16) : v;
      inputs[f.name] = i;
      return el("label", { className: "rt-row" }, el("span", { textContent: f.name + (f.required ? " *" : "") }), i);
    });
    const save = el("button", { className: "pri", textContent: rec ? "Save changes" : "Add" });
    save.onclick = () => guard(async () => {
      const raw = Object.fromEntries(schema.fields.map(f => [f.name, f.kind === "bool" ? inputs[f.name].checked : inputs[f.name].value]));
      const fields = toFields(schema, raw);
      if (rec) db.update(inst.domain, rec.id, fields); else db.put(inst.domain, fields);
      delete editing[inst.domain];
      await changed();
    }, err);
    const cancel = rec && el("button", { textContent: "Cancel", onclick: () => { delete editing[inst.domain]; render(); } });
    return [rows, el("div", { className: "rt-actions" }, save, cancel || ""), err];
  }

  const actions = (inst, r) => el("span", { className: "rt-actions" },
    el("button", { textContent: "Edit", onclick: () => { editing[inst.domain] = r; render(); } }),
    el("button", { textContent: "Delete", onclick: async () => { db.delete(inst.domain, r.id); if (editing[inst.domain]?.id === r.id) delete editing[inst.domain]; await changed(); } }));

  function table(inst, schema, i) {
    const recs = bindings[i].getSnapshot();
    if (!recs.length) return el("p", { className: "rt-empty", textContent: "No records yet." });
    return el("div", { className: "rt-scroll" }, el("table", {},
      el("thead", {}, el("tr", {}, schema.fields.map(f => el("th", { textContent: f.name })), el("th", { textContent: "state" }), el("th"))),
      el("tbody", {}, recs.map(r => el("tr", {}, schema.fields.map(f => el("td", { textContent: display(f.kind, r.fields[f.name]) })), el("td", {}, stateChip()), el("td", {}, actions(inst, r)))))));
  }

  function list(inst, schema, i) {
    const recs = [...bindings[i].getSnapshot()].reverse();
    const h = headline(schema);
    if (!recs.length) return el("p", { className: "rt-empty", textContent: "Nothing here yet." });
    return el("ul", { className: "rt-list" }, recs.map(r => el("li", {},
      el("span", { textContent: display(schema.fields.find(f => f.name === h)?.kind, r.fields[h]) || "(untitled)" }),
      el("small", { textContent: new Date(r.created).toLocaleString() }), stateChip())));
  }

  const RENDER = { form, table, list };

  function render() {
    root.replaceChildren(
      ...problems.map(p => el("p", { className: "rt-err", textContent: p })),
      ...app.components.map((inst, i) => {
        const schema = db.schema(inst.domain);
        const body = !schema ? el("p", { className: "rt-err", textContent: `No schema for “${inst.domain}”.` })
          : RENDER[inst.type] ? RENDER[inst.type](inst, schema, i)
          : el("p", { className: "rt-empty", textContent: `${byType[inst.type]?.label ?? inst.type} runs once its substrate lands (phase ${byType[inst.type]?.phase}).` });
        return el("section", { className: "rt-comp" },
          el("h4", {}, `${byType[inst.type]?.label ?? inst.type} · ${inst.domain}`,
            isLive(inst) ? el("span", { className: "rt-live", textContent: "live", title: "updates by itself" }) : ""),
          body);
      }));
  }

  render();
  onData(db);
  return db;
}
