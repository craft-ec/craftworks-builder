// Runs an app definition as live UI over the SDK. Used by the builder's Preview;
// the published app will use the same module.
import { byType } from "./catalogue.js";
import { openApp, toFields, display, headline, inputType, readsNewestFirst, pageView, savingLabel } from "./runtime-logic.js";
import { show, bindsLive, rowState } from "./publish-state.js";
import { previewDb } from "./handoff.js";

/**
 * How many rows a component reads.
 *
 * A SCREENFUL, not a domain. The number is a screen's worth with room to
 * scroll, not a guess at how much data exists — the point is that the read
 * is bounded by what is shown rather than by what is stored.
 */
export const PAGE = 50;

/** A component's data source (DATA-SOURCE): `publisher` unless it says. */
export const sourceOf = inst => inst.source ?? "publisher";

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat(Infinity)); return e; };

/**
 * Mount `app` into `root`. `onData(db)` is called after every change so the host
 * (the builder's tree panel) can show live counts. Returns the db.
 */
export async function mountApp(root, sdk, app, onData = () => {}, backend = null, phase = "idle", { alive, seed = !backend, canWrite } = {}) {
  // WHOSE DATA EACH COMPONENT SHOWS (DATA-SOURCE, builder#113). `backend` is
  // either ONE db -- the person's own project, which they write -- or, for a
  // PUBLISHED app opened by address, a db per source:
  //   `publisher`: the APP's data (the tree app.json names: the session's own
  //     db on the node that signs for it, a read-only `tree(head)` db anywhere
  //     else);
  //   `mine`: the USER's own tree, which they write (null when the app has no
  //     `mine` component). Everyone is a user; there are no roles here.
  // Which components show inputs is the SDK's ONE decision, `canWrite(source)`
  // -> {answer: yes|no|unknown, why}, ASKED each render and kept nowhere here.
  // "no": no write controls at all -- no Form, no Edit or Delete -- rather
  // than controls that fail (the SDK refuses a write anyway; that is the net
  // under this). "unknown": the controls are shown DISABLED, with why.
  const bySource = backend && "publisher" in backend;
  // NO DEFAULT for a published app (builder#73): without the decision a view
  // would show inputs -- the unsafe direction. One db is the person's own.
  if (bySource && typeof canWrite !== "function") {
    throw new Error("mountApp: a published app needs `canWrite` — without it every component would show inputs, on somebody else's data too");
  }
  if (bySource && seed) throw new Error("mountApp: a published app seeds nothing — it shows its sources' data");
  const may = inst => (bySource ? canWrite(sourceOf(inst)) : { answer: "yes", why: "" });
  // NO DEFAULT (builder#73). `() => true` made the guard fail OPEN: a mount
  // whose runtime was disposed, switched or edited away was never refused, and
  // nothing said the guard was missing. A caller with no owner to ask says so
  // with an explicit `() => true`.
  if (typeof alive !== "function") {
    throw new Error("mountApp: no `alive` — without it a mount that is no longer wanted would still paint the canvas and keep its listeners");
  }
  // `backend = null` means a fresh, in-memory `sdk.Db` below, which KEEPS
  // NOTHING: safe because a null backend is the preview, whose records reach a
  // real backend only through the publish handoff, and whose mounts are the
  // only ones that seed (`seed = !backend`).
  // `alive` says whether this mount is still WANTED. The owner of a project's
  // runtime (project-runtime.js) answers false once the project was switched,
  // the definition edited, or the preview left — and a mount that finishes
  // after that must not paint the canvas, must not report data, and must not
  // leave listeners behind. Checked after every await, because each await is
  // a point where the world can have moved on (builder#54, #57).
  //
  // The preview db RECORDS its deletes and which rows are the seed
  // (`previewDb`): a delete made in it is the only proof a handoff accepts
  // that a person removed a row, and a seed row is handed off by its place in
  // the definition (builder#83).
  // ONE openApp PER db a source reads: each defines the app's domains (a view
  // of the app's tree defines nothing new: the same schema is a no-op).
  const sources = bySource ? backend : { publisher: backend ?? previewDb(new sdk.Db()) };
  const opened = new Map();
  for (const d of new Set(Object.values(sources).filter(Boolean))) {
    opened.set(d, await openApp(sdk, app, d, { seed }));
    if (!alive()) return null;
  }
  const dbOf = inst => {
    const d = sources[sourceOf(inst)] ?? (bySource ? null : sources.publisher);
    return d && opened.get(d).db;
  };
  const db = opened.get(sources.publisher ?? [...opened.keys()][0]).db;
  const problems = [...new Set([...opened.values()].flatMap(o => o.problems))];
  const schemas = Object.assign({}, ...[...opened.values()].map(o => o.schemas));
  const editing = {}; // domain → record being edited
  const report = d => { if (alive()) onData(d); };

  // ONE BINDING PER DOMAIN, not per component — and it reads a PAGE.
  //
  // Components read a snapshot rather than calling the db, which is the whole
  // point of the shape: a snapshot read is synchronous on every backend, and
  // the round trip is the only part that is not.
  //
  // TWO THINGS THAT WERE COSTING A WHOLE DOMAIN EACH.
  //
  // One binding per COMPONENT meant two components over `notes` read `notes`
  // twice — the same rows, fetched twice, re-fetched on every change. They
  // share one binding now, keyed by what actually distinguishes a read:
  // the domain, whether it is live, and how much of it is wanted.
  //
  // And each binding scanned the WHOLE DOMAIN to fill a screen. Priced by
  // F43, a cold far read is seconds, so a list over a cold domain fetched
  // every record in it to show twenty rows. `PAGE` is what a screen holds;
  // `Scan { limit, after }` has existed unused the whole time
  // (craftworks-sdk#126 carries it to the binding).
  //
  // WHAT THIS DOES NOT FIX, deliberately: a component filtered by a parent
  // still reads the whole domain, because a record's key cannot carry a
  // parent and the filter cannot be expressed as a range
  // (craftworks-sdk#122). A page over a filtered scan would be actively
  // misleading — twenty scanned rows can yield zero matches — so it is left
  // alone and pinned by a test rather than papered over.
  //
  // THE DIRECTION IS PART OF THE READ. A list shows the newest rows, so it
  // reads a REVERSE page; a forward table and a reverse list over one domain
  // are two different reads and do not share (builder#51).
  const bindings = [];
  const shared = new Map();
  for (const inst of app.components) {
    const cdb = dbOf(inst);
    // A `mine` component with no own db (the app was opened without one):
    // nothing to read. Said on the component, never a read of someone else's.
    if (!cdb) { bindings.push(null); continue; }
    const live = bindsLive(inst, may(inst).answer !== "yes");
    const reverse = readsNewestFirst(inst.type);
    const key = `${sourceOf(inst)}\u0000${inst.domain}\u0000${live}\u0000${PAGE}\u0000${reverse}`;
    if (!shared.has(key)) {
      const b = cdb.bind(inst.domain, { live, limit: PAGE, reverse });
      // THE BINDING MUST SAY IT READS WHAT WAS ASKED FOR.
      //
      // An SDK too old to know an option drops it without a word: at an old
      // pin `limit` was ignored and every component read its whole domain,
      // and `reverse` ignored puts the OLDEST page under a newest-first list.
      // Three stale pins in three PRs, each found by review, not by running.
      // So the runtime checks the binding it got back and refuses to draw a
      // screen it knows would be wrong — a loud refusal, not a quiet one.
      if (b.limit !== PAGE || b.reverse !== reverse) {
        throw new Error(
          `This SDK ignored the page the app asked for on “${inst.domain}” ` +
          `(asked limit ${PAGE}, reverse ${reverse}; the binding reports limit ${b.limit}, reverse ${b.reverse}). ` +
          "SDK_REV is older than the runtime needs — bump it.");
      }
      shared.set(key, b);
    }
    bindings.push(shared.get(key));
  }

  // PAST THE PAGE, per binding: what the person asked for with "Show more".
  // `{ rows, ended, err }` — see `pageView` for what each may claim.
  const beyond = new Map();
  const moreOf = b => beyond.get(b) ?? { rows: [], ended: false, err: "" };

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
  // THE UNIQUE BINDINGS, not one entry per component. `bindings` is indexed
  // by component so a component can find its own, and two components over one
  // domain point at the SAME object — so subscribing per component would
  // subscribe twice and re-render twice for one change, and reloading per
  // component would read the same rows twice.
  const each = [...new Set(bindings.filter(Boolean))];
  // A change resets what was fetched past the page: new rows shift the page
  // itself, so pages fetched against the old one could leave a gap or repeat
  // a row. Back to the first page is honest; a stitched-together one is not.
  const stops = each.map(b => b.subscribe(() => { if (!alive()) return; beyond.delete(b); render(); }));
  // Stops EVERY subscription this mount made — one per unique binding, which
  // is what `each` holds — and is what the mount's owner calls to dispose it.
  const stop = () => { for (const s of stops.splice(0)) s?.(); };

  const refresh = async () => { for (const b of each) await b.reload(); };
  const changed = async () => { await refresh(); if (!alive()) return; render(); report(db); };
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
    const db = dbOf(inst);
    const w = may(inst);
    const rec = editing[inst.domain];
    const inputs = {};
    const err = el("p", { className: "rt-err" });
    const rows = schema.fields.map(f => {
      const i = el("input", { type: inputType(f.kind), name: f.name, disabled: w.answer !== "yes" });
      if (f.kind === "float") i.step = "any";
      const v = rec?.fields[f.name];
      if (f.kind === "bool") i.checked = !!v;
      else if (v !== undefined && v !== null) i.value = f.kind === "time" ? new Date(v).toISOString().slice(0, 16) : v;
      inputs[f.name] = i;
      return el("label", { className: "rt-row" }, el("span", { textContent: f.name + (f.required ? " *" : "") }), i);
    });
    const save = el("button", { className: "pri", textContent: rec ? "Save changes" : "Add", disabled: w.answer !== "yes", title: w.why || "" });
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
    const why = w.answer === "unknown" ? el("p", { className: "rt-why", role: "note", textContent: `Cannot tell yet whether you may write here: ${w.why}` }) : "";
    return [rows, el("div", { className: "rt-actions" }, save, cancel || ""), why, err];
  }

  const actions = (inst, r, w) => el("span", { className: "rt-actions" },
    el("button", { textContent: "Edit", disabled: w.answer !== "yes", title: w.why || "", onclick: () => { editing[inst.domain] = r; render(); } }),
    el("button", { textContent: "Delete", disabled: w.answer !== "yes", title: w.why || "", onclick: async () => { await dbOf(inst).delete(inst.domain, r.id); if (editing[inst.domain]?.id === r.id) delete editing[inst.domain]; await changed(); } }));
  // Rows a component may not write carry no actions ("no"), or disabled ones
  // with the reason ("unknown").
  const rowActions = (inst, r) => { const w = may(inst); return w.answer === "no" ? "" : actions(inst, r, w); };

  // WHAT THE VIEW SAYS ABOUT ITS OWN EXTENT.
  //
  // A full page is "at least this many", never "this many" — so a full page
  // always carries a line saying so, and "Show more" reads the next page with
  // `after`, in the same direction. Only a read that comes back SHORT turns
  // the line into "all N shown".
  function footer(inst, i, view) {
    if (!view.footer) return "";
    const b = bindings[i], m = moreOf(b);
    const end = readsNewestFirst(inst.type) ? "newest" : "first";
    if (!view.footer.more) return el("p", { className: "rt-more", textContent: `All ${view.footer.shown} shown.` });
    const btn = el("button", { textContent: "Show more" });
    btn.onclick = async () => {
      btn.disabled = true;
      const last = view.rows[view.rows.length - 1];
      try {
        const next = await dbOf(inst).scan(inst.domain, { limit: PAGE, reverse: b.reverse, after: last.id });
        beyond.set(b, { rows: [...m.rows, ...next], ended: next.length < PAGE, err: "" });
      } catch (e) {
        // A failed read proves nothing about the end — it stays "may be more".
        beyond.set(b, { ...m, err: e.message });
      }
      // The read was a round trip; a page that was disowned meanwhile must
      // not repaint the canvas that now belongs to a later mount.
      if (alive()) render();
    };
    return el("p", { className: "rt-more" },
      `Showing the ${end} ${view.footer.shown} — there may be more. `, btn,
      m.err ? el("span", { className: "rt-err", textContent: ` ${m.err}` }) : "");
  }

  const viewOf = i => (bindings[i] ? pageView(bindings[i].getSnapshot(), moreOf(bindings[i]), PAGE) : pageView([], moreOf(null), PAGE));

  function table(inst, schema, i) {
    const view = viewOf(i);
    if (!view.rows.length) return el("p", { className: "rt-empty", textContent: "No records yet." });
    return [el("div", { className: "rt-scroll" }, el("table", {},
      el("thead", {}, el("tr", {}, schema.fields.map(f => el("th", { textContent: f.name })), el("th", { textContent: "state" }), el("th"))),
      el("tbody", {}, view.rows.map(r => el("tr", {}, schema.fields.map(f => el("td", { textContent: display(f.kind, r.fields[f.name]) })), el("td", {}, stateChip(r)), el("td", {}, rowActions(inst, r))))))),
      footer(inst, i, view)];
  }

  // NEWEST FIRST BECAUSE IT READ THE NEWEST END — no reversing here. The
  // snapshot of a reverse page is already in the order the list shows.
  function list(inst, schema, i) {
    const view = viewOf(i);
    const h = headline(schema);
    if (!view.rows.length) return el("p", { className: "rt-empty", textContent: "Nothing here yet." });
    return [el("ul", { className: "rt-list" }, view.rows.map(r => el("li", {},
      el("span", { textContent: display(schema.fields.find(f => f.name === h)?.kind, r.fields[h]) || "(untitled)" }),
      el("small", { textContent: new Date(r.created).toLocaleString() }), stateChip(r)))),
      footer(inst, i, view)];
  }

  const RENDER = { form, table, list };

  // Writes not yet PUBLISHED, as the session last said (craftworks-sdk#163).
  // Set through the returned `setSaving`; 0 until a session says otherwise.
  let saving = 0;

  function render() {
    const savingText = savingLabel(saving);
    root.replaceChildren(
      ...(savingText ? [el("p", {
        className: "rt-saving", role: "status", textContent: savingText,
        title: "Not yet published to your node — closing this tab now would lose them",
      })] : []),
      ...problems.map(p => el("p", { className: "rt-err", textContent: p })),
      // A FORM IS A WRITE: a component that may not write ("no") does not
      // render one at all. Skipped in place (flatMap), so `i` stays the
      // component's index — the bindings are indexed by it.
      ...app.components.flatMap((inst, i) => {
        const w = may(inst);
        if (w.answer === "no" && inst.type === "form") return [];
        const schema = schemas[inst.domain];
        const body = !schema ? el("p", { className: "rt-err", textContent: `No schema for “${inst.domain}”.` })
          : RENDER[inst.type] ? RENDER[inst.type](inst, schema, i)
          : el("p", { className: "rt-empty", textContent: `${byType[inst.type]?.label ?? inst.type} runs once its substrate lands (phase ${byType[inst.type]?.phase}).` });
        // A READ THAT ENDED IS SAID, by name — never a silent empty table or
        // a page left at "Reading…" (the binding records it: `status()`).
        const st = bindings[i]?.status?.();
        const ended = st?.state === "unreachable"
          ? el("p", { className: "rt-err rt-read", role: "status", textContent: `Could not read “${inst.domain}”: ${st.why}` })
          : "";
        return el("section", { className: "rt-comp" },
          el("h4", {}, `${byType[inst.type]?.label ?? inst.type} · ${inst.domain}`,
            bindsLive(inst, w.answer !== "yes") ? el("span", { className: "rt-live", textContent: "live", title: "updates by itself" }) : ""),
          w.answer === "no" ? el("p", { className: "rt-view", role: "note", textContent: sourceOf(inst) === "publisher" ? "View only — the app's data, which only its owner's identity changes." : `View only: ${w.why}` }) : "",
          !bindings[i] && inst.type !== "form" ? el("p", { className: "rt-err", textContent: "This component shows your own data, and this app was opened without it." }) : "",
          ended, body);
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
  if (!alive()) { stop(); return null; }

  render();
  report(db);

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
  // The previous mount's listeners are stopped by whoever OWNS the mount, via
  // the `stop` returned here. This used to be a page global that each mount
  // called on the one before — so a stale mount finishing late stopped the
  // CURRENT mount's listeners and took its place (builder#54).
  // `refresh` is the app's own "read now". A binding that is not LIVE shows
  // what it last read — the owner's rule is "not live = read when needed" —
  // so something has to be able to say NEEDED: a screen the person opens
  // again, a pull-to-refresh, a tool checking the rule. Without it the only
  // way to re-read was to reload the tab, which is a different thing and
  // hides what is being tested.
  globalThis.__craftworks = { db, app, phase, refresh: changed };

  // The saving line's input. Re-renders only a mount that is still wanted.
  const setSaving = n => {
    savingLabel(n); // refuses anything that is not a count, before it is shown
    saving = n;
    if (alive()) render();
  };

  return { db, stop, setSaving };
}
