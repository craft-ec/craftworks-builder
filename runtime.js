// Runs an app definition as live UI over the SDK. Used by the builder's Preview;
// the published app will use the same module.
import { byType } from "./catalogue.js";
import { openApp, toFields, display, headline, inputType } from "./runtime-logic.js";

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat(Infinity)); return e; };

/**
 * Mount `app` into `root`. `onData(db)` is called after every change so the host
 * (the builder's tree panel) can show live counts. Returns the db.
 */
export function mountApp(root, sdk, app, onData = () => {}) {
  const { db, problems } = openApp(sdk, app);
  const editing = {}; // domain → record being edited

  const changed = () => { render(); onData(db); };
  const guard = (fn, box) => { try { fn(); box.textContent = ""; } catch (e) { box.textContent = e.message; } };

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
    save.onclick = () => guard(() => {
      const raw = Object.fromEntries(schema.fields.map(f => [f.name, f.kind === "bool" ? inputs[f.name].checked : inputs[f.name].value]));
      const fields = toFields(schema, raw);
      if (rec) db.update(inst.domain, rec.id, fields); else db.put(inst.domain, fields);
      delete editing[inst.domain];
      changed();
    }, err);
    const cancel = rec && el("button", { textContent: "Cancel", onclick: () => { delete editing[inst.domain]; render(); } });
    return [rows, el("div", { className: "rt-actions" }, save, cancel || ""), err];
  }

  const actions = (inst, r) => el("span", { className: "rt-actions" },
    el("button", { textContent: "Edit", onclick: () => { editing[inst.domain] = r; render(); } }),
    el("button", { textContent: "Delete", onclick: () => { db.delete(inst.domain, r.id); if (editing[inst.domain]?.id === r.id) delete editing[inst.domain]; changed(); } }));

  function table(inst, schema) {
    const recs = db.scan(inst.domain);
    if (!recs.length) return el("p", { className: "rt-empty", textContent: "No records yet." });
    return el("div", { className: "rt-scroll" }, el("table", {},
      el("thead", {}, el("tr", {}, schema.fields.map(f => el("th", { textContent: f.name })), el("th"))),
      el("tbody", {}, recs.map(r => el("tr", {}, schema.fields.map(f => el("td", { textContent: display(f.kind, r.fields[f.name]) })), el("td", {}, actions(inst, r)))))));
  }

  function list(inst, schema) {
    const recs = db.scan(inst.domain, { reverse: true });
    const h = headline(schema);
    if (!recs.length) return el("p", { className: "rt-empty", textContent: "Nothing here yet." });
    return el("ul", { className: "rt-list" }, recs.map(r => el("li", {},
      el("span", { textContent: display(schema.fields.find(f => f.name === h)?.kind, r.fields[h]) || "(untitled)" }),
      el("small", { textContent: new Date(r.created).toLocaleString() }))));
  }

  const RENDER = { form, table, list };

  function render() {
    root.replaceChildren(
      ...problems.map(p => el("p", { className: "rt-err", textContent: p })),
      ...app.components.map(inst => {
        const schema = db.schema(inst.domain);
        const body = !schema ? el("p", { className: "rt-err", textContent: `No schema for “${inst.domain}”.` })
          : RENDER[inst.type] ? RENDER[inst.type](inst, schema)
          : el("p", { className: "rt-empty", textContent: `${byType[inst.type]?.label ?? inst.type} runs once its substrate lands (phase ${byType[inst.type]?.phase}).` });
        return el("section", { className: "rt-comp" },
          el("h4", { textContent: `${byType[inst.type]?.label ?? inst.type} · ${inst.domain}` }), body);
      }));
  }

  render();
  onData(db);
  return db;
}
