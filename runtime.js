// Runs an app definition as live UI over the SDK. Used by the builder's Preview;
// the published app will use the same module.
import { byType } from "./catalogue.js";
import { openApp, toFields, display, headline, inputType } from "./runtime-logic.js";
import { show, isLive, rowState } from "./publish-state.js";

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat(Infinity)); return e; };

/**
 * Mount `app` into `root`. `onData(db)` is called after every change so the host
 * (the builder's tree panel) can show live counts. Returns the db.
 */
export async function mountApp(root, sdk, app, onData = () => {}, backend = null, phase = "idle") {
  const { db, problems, schemas } = await openApp(sdk, app, backend ?? new sdk.Db());
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
  // THE SCHEMAS COME FROM `openApp`, NOT FROM A READ.
  //
  // `db.schema(domain)` is SYNCHRONOUS on the in-memory backend and ASYNC on
  // the engine-backed one — a schema is a read, and a read over the network
  // can answer "not loaded yet". `render` is synchronous and is called from a
  // dozen places, so calling it there returned a Promise, which is truthy: it
  // sailed past the `!schema` guard below into `schema.fields.map`.
  //
  // MEASURED, twice, against a real node:
  //   * calling it in `render` replaced the whole canvas with "Cannot read
  //     properties of undefined (reading 'map')" the moment the backend
  //     switched — the button said Published and the app was gone;
  //   * awaiting it at mount instead got a transient NotLoaded and rendered
  //     "No schema for “notes”." for a domain the app had just defined.
  //
  // The second one is the lesson: the round trip was never needed. `openApp`
  // is handed these schemas and passes them to `define`, so it knows what
  // every domain IS. Asking the network to say it back is a question that can
  // only add failure modes, and NotLoaded is not "no schema" — that is the
  // distinction the whole cached-read layer exists for, and collapsing it is
  // how a transient becomes a wrong screen.

  // LISTEN TO THE BINDINGS.
  //
  // A binding's whole purpose is to say "these rows changed", and nothing was
  // listening: components read `getSnapshot()` and the app re-rendered only
  // when the PERSON did something. So data that changed underneath — a write
  // reaching the network, another tab's row arriving — updated the snapshot
  // and never reached the screen.
  //
  // MEASURED against a real node: `db.scan()` returned rows CLEAN three
  // seconds after a write while the chips on screen still said "saving" ten
  // seconds later, and a second tab never showed the first tab's row at all.
  // Every acceptance item about data appearing failed on this one line being
  // absent — the SDK offered `subscribe` (craftworks-sdk#77) and this file
  // never called it.
  //
  // Safe against a loop: `render` reads snapshots and never reloads, so a
  // re-render cannot trigger another change.
  const stops = bindings.map(b => b.subscribe(() => render()));

  const refresh = async () => { for (const b of bindings) await b.reload(); };
  const changed = async () => { await refresh(); render(); onData(db); };
  const guard = async (fn, box) => { try { await fn(); box.textContent = ""; } catch (e) { box.textContent = e.message; } };

  // What a row says about ITSELF.
  //
  // An unpublished project's rows say so, because its data is in this tab and
  // nowhere else — "saved" would claim the exact thing Publish is for, and the
  // person would find out by closing the tab. Per ROW and not only in the
  // address bar, because the decision to close is made while looking at the
  // rows.
  //
  // Once published each row carries its OWN write's state, which is why this
  // takes the record. "Saving", "saved here but not yet on the network" and
  // "on the network" are three different facts, and a row must not show one
  // spinner for all three.
  const stateChip = record => {
    const s = show(rowState(phase, record));
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
      // AWAITED. Both are async on the engine-backed backend — a write is a
      // round trip — so an unawaited one hands `guard` a promise it never
      // looks at: a REFUSED write showed no message at all on a published
      // project, and the rejection went unhandled. It only ever appeared to
      // work because the in-memory backend threw synchronously
      // (craftworks-sdk#87 makes both async, which is what caught this).
      if (rec) await db.update(inst.domain, rec.id, fields);
      else await db.put(inst.domain, fields);
      delete editing[inst.domain];
      await changed();
    }, err);
    const cancel = rec && el("button", { textContent: "Cancel", onclick: () => { delete editing[inst.domain]; render(); } });
    return [rows, el("div", { className: "rt-actions" }, save, cancel || ""), err];
  }

  const actions = (inst, r) => el("span", { className: "rt-actions" },
    el("button", { textContent: "Edit", onclick: () => { editing[inst.domain] = r; render(); } }),
    el("button", { textContent: "Delete", onclick: async () => { await db.delete(inst.domain, r.id); if (editing[inst.domain]?.id === r.id) delete editing[inst.domain]; await changed(); } }));

  function table(inst, schema, i) {
    const recs = bindings[i].getSnapshot();
    if (!recs.length) return el("p", { className: "rt-empty", textContent: "No records yet." });
    return el("div", { className: "rt-scroll" }, el("table", {},
      el("thead", {}, el("tr", {}, schema.fields.map(f => el("th", { textContent: f.name })), el("th", { textContent: "state" }), el("th"))),
      el("tbody", {}, recs.map(r => el("tr", {}, schema.fields.map(f => el("td", { textContent: display(f.kind, r.fields[f.name]) })), el("td", {}, stateChip(r)), el("td", {}, actions(inst, r)))))));
  }

  function list(inst, schema, i) {
    const recs = [...bindings[i].getSnapshot()].reverse();
    const h = headline(schema);
    if (!recs.length) return el("p", { className: "rt-empty", textContent: "Nothing here yet." });
    return el("ul", { className: "rt-list" }, recs.map(r => el("li", {},
      el("span", { textContent: display(schema.fields.find(f => f.name === h)?.kind, r.fields[h]) || "(untitled)" }),
      el("small", { textContent: new Date(r.created).toLocaleString() }), stateChip(r))));
  }

  const RENDER = { form, table, list };

  function render() {
    root.replaceChildren(
      ...problems.map(p => el("p", { className: "rt-err", textContent: p })),
      ...app.components.map((inst, i) => {
        const schema = schemas[inst.domain];
        const body = !schema ? el("p", { className: "rt-err", textContent: `No schema for “${inst.domain}”.` })
          : RENDER[inst.type] ? RENDER[inst.type](inst, schema, i)
          : el("p", { className: "rt-empty", textContent: `${byType[inst.type]?.label ?? inst.type} runs once its substrate lands (phase ${byType[inst.type]?.phase}).` });
        return el("section", { className: "rt-comp" },
          el("h4", {}, `${byType[inst.type]?.label ?? inst.type} · ${inst.domain}`,
            isLive(inst) ? el("span", { className: "rt-live", textContent: "live", title: "updates by itself" }) : ""),
          body);
      }));
  }

  // LOAD BEFORE THE FIRST FRAME.
  //
  // A binding starts EMPTY on the engine-backed backend — its rows come over
  // the network — and the in-memory one used to fill in its constructor. So
  // rendering before any reload showed rows in a preview and an empty table
  // the moment the project was published: the same component, the same code,
  // two different screens, which is the one thing this file promises cannot
  // happen (craftworks-sdk#87 makes both start empty, so this is now the only
  // thing that fills them).
  //
  // Awaited, like every other reload here: the round trip is the part that is
  // not synchronous.
  await refresh();

  render();
  onData(db);

  // THE ACCEPTANCE SEAM.
  //
  // Two tabs on one node cannot be checked from inside the page. The question
  // the acceptance asks is which MECHANISM told the second tab — a head
  // subscription, or its own tick — and that is a fact about the session, not
  // about the DOM. Counting rows cannot tell the two apart, and a table built
  // from a row count would report "live works" over a number the tick
  // produced.
  //
  // So one handle, named and documented, rather than a hook invented per run:
  // a harness that reaches in a different way each time ends up measuring
  // itself. Read-only by intent — nothing in this file reads it back.
  // A STABLE ID PER DATABASE, so a dump can say whether two readings are of
  // the SAME copy. The chip on a row and the figure in the tree panel read
  // through different call paths, and "pending here, nothing pending there"
  // is either one copy contradicting itself or two copies — which are
  // different faults with different fixes.
  db.__id ??= (globalThis.__dbSeq = (globalThis.__dbSeq ?? 0) + 1);
  // The previous mount's listeners, stopped: two mounts both re-rendering
  // into one canvas is the shape that made Preview mount the app twice.
  globalThis.__craftworksStop?.();
  globalThis.__craftworksStop = () => { for (const s of stops) s?.(); };
  globalThis.__craftworks = { db, app, phase };

  return db;
}
