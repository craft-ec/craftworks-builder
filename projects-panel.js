// Create, open and browse projects.
//
// The judgement lives in `projects.js`, which has no DOM and is tested on its
// own; this file paints and calls. A project is a record plus one record per
// component, so "browse" is a scan and "open" is a read — there is no separate
// index to keep in step.

import {
  defineProjectDomains, createProject, listProjects, openProject,
  addComponent, componentsOf, removeComponent, setComponentProps, saveDefinition,
  readDeviceSettings, writeDeviceSettings, PUBLIC_UNTIL_PHASE_7, openInto,
  recordPublication, publicationsOf, nextSeq, recordPerComponentKey,
  oneRecordPerComponent, BUILDER, componentKey as componentKeyOf,
} from "./projects.js";

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.flat(Infinity));
  return e;
};

const when = ms => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—");

/** A builder component <-> a stored component record. */
/**
 * A canvas component carries the id of the record backing it, as `rid`.
 *
 * Without it a save cannot tell which record a component IS, so it can only
 * delete everything and re-add — which is what this did, and it made the whole
 * per-component record shape buy nothing: ids changed on every save, so no
 * neighbour was untouched, no id was stable for phase-6 conflict granularity,
 * and `changes_since` saw the entire project as changed after any edit.
 *
 * `rid` is deliberately NOT stored inside the record's props: a record does not
 * contain its own id.
 */
export const toRecord = c => {
  const { rid, ...props } = c;
  return { kind: c.type, layout: null, binding: null, props };
};
export const fromRecord = r => ({ ...(r.props ?? {}), type: r.kind, rid: r.id });

const meta = c => c[BUILDER] ?? {};

/** Do two components differ in anything stored — ignoring the generation? */
const changed = (c, rec) => {
  const without = p => {
    const { [BUILDER]: m, ...rest } = p ?? {};
    return JSON.stringify({ ...rest, [BUILDER]: { key: m?.key } });
  };
  let stored = null;
  try { stored = JSON.parse(rec.fields.props); } catch { return true; }
  return rec.fields.kind !== c.type || without(stored) !== without(toRecord(c).props);
};

/** The generation a record was written at. */
const genOf = rec => {
  try { return JSON.parse(rec.fields.props)?.[BUILDER]?.gen ?? 0; } catch { return 0; }
};

/**
 * Save the open canvas as records — as a DIFF, so ids survive.
 *
 * Update what changed, add what is new, remove what is gone. A component that
 * did not change is not written at all, which is what makes a tweak cost one
 * record instead of the canvas, and what makes the neighbour's record
 * byte-identical THROUGH THE PATH THE APP TAKES rather than only through the
 * data model underneath it.
 *
 * Returns what it did, so a caller can assert on it rather than infer it.
 */
export async function saveCanvas(db, pid, components) {
  // A STABLE KEY PER CANVAS COMPONENT, assigned before the first `await`,
  // kept under `_builder` beside the component's generation.
  //
  // `rid` names the RECORD, and it is only known once an add has come back.
  // An add that landed but whose answer was lost, or two saves overlapping
  // before either knew the rid, both write a SECOND record for the same
  // component — and reload showed it twice (builder#49). The key is what says
  // two records are one component: it is stored in the props, assigned here
  // synchronously so a save that overlaps this one sees it, and `openProject`
  // keeps one record per key. Two components that merely look alike have
  // different keys and both stay.
  //
  // A key is ONE component, so it must be unique on the canvas. A component
  // that repeats a key already seen — a copy of another, or an imported canvas
  // that listed one twice — is a NEW component: fresh key, and no record yet.
  //
  // A component with a record but no key yet (saved before keys existed)
  // keeps its record: it gets a key and is UPDATED, so its id survives. Only a
  // REPEATED key or record id — a copy — is a new component and loses the rid,
  // or two canvas components would write one record and one would vanish.
  const seenKeys = new Set();
  const seenRids = new Set();
  for (const c of components) {
    const m = meta(c);
    const copy = (m.key && seenKeys.has(m.key)) || (c.rid && seenRids.has(c.rid));
    if (copy) delete c.rid;
    if (!m.key || copy) c[BUILDER] = { key: newKey(), gen: 0 };
    seenKeys.add(c[BUILDER].key);
    if (c.rid) seenRids.add(c.rid);
  }
  const existing = await componentsOf(db, pid);
  const byId = new Map(existing.map(r => [r.id, r]));
  // ADOPT BY KEY. A component whose record id this canvas never learnt — its
  // add landed but the answer was lost, or its rid names another project's
  // record — already HAS a record here if one carries its key. That record is
  // it: update it rather than add a second and delete the first. One write
  // instead of two, and no second record for the load path to resolve.
  const byKey = recordPerComponentKey(existing);
  // The highest generation ANY record of a key holds. A write must outrank
  // all of them, not only the record it updates: two records of one key can
  // sit at the same generation, and a write that only passed its own would
  // tie with the other and could lose the tie-break.
  const topGen = new Map();
  for (const r of existing) {
    const k = componentKeyOf(r);
    if (k) topGen.set(k, Math.max(topGen.get(k) ?? 0, genOf(r)));
  }
  const kept = new Set();
  const did = { added: 0, updated: 0, removed: 0, untouched: 0 };

  for (const c of components) {
    const key = c[BUILDER].key;
    let rec = c.rid ? byId.get(c.rid) : null;
    if (!rec && byKey.has(key)) {
      rec = byKey.get(key);
      c.rid = rec.id;
    }
    // EVERY WRITE OF A COMPONENT BUMPS ITS GENERATION, past both what this
    // canvas last wrote and what ANY record of this key holds: freshness is counted, not
    // read off an id or a clock, both of which can go backwards.
    const bump = () => { c[BUILDER] = { key, gen: Math.max(c[BUILDER].gen ?? 0, topGen.get(key) ?? 0) + 1 }; };
    if (!rec) {
      bump();
      const added = await addComponent(db, pid, toRecord(c));
      // The new id goes back onto the canvas component, or the next save
      // cannot find it either and the re-keying returns.
      c.rid = added.id;
      kept.add(added.id);
      did.added += 1;
      continue;
    }
    kept.add(rec.id);
    if (changed(c, rec)) {
      bump();
      await setComponentProps(db, rec.id, toRecord(c).props);
      did.updated += 1;
    } else {
      did.untouched += 1;
    }
  }

  for (const r of existing) {
    if (!kept.has(r.id)) { await removeComponent(db, r.id); did.removed += 1; }
  }
  return did;
}

/** A component key: random, so two devices never mint the same one. */
const newKey = () => globalThis.crypto.randomUUID();

/**
 * Saves run ONE AT A TIME, each on the project and canvas named when it was
 * asked for.
 *
 * `persist` is called on every canvas change and did not wait for the previous
 * save: two saves could both read the project before either added a new
 * component, and both added it (builder#49, reproduced with two successful
 * saves and no failure at all). So each call is chained behind the last, and
 * NAMES its project and canvas at call time — a save that ran on "whatever is
 * open when it starts" would write one project's canvas into another if the
 * person switched in between.
 *
 * The canvas is a REFERENCE, not a snapshot: a queued save writes the canvas
 * as it is when the save runs. That is right here because switching project or
 * clearing replaces the array (`setCanvas`, `clear`) rather than editing it, so
 * the reference a save holds is still that project's canvas. A snapshot would
 * be wrong the other way: `saveCanvas` writes each record's id back onto the
 * live components, and a copy would never learn them.
 *
 * A save that fails does not stop the ones after it; its error still reaches
 * its own caller.
 */
export function serialSaves(save) {
  let tail = Promise.resolve();
  return (...args) => {
    const run = tail.then(() => save(...args));
    tail = run.catch(() => {});
    return run;
  };
}

export async function mountProjects(host, {
  db,
  getCanvas,          // () => the builder's current components
  // () => the rest of what the open project is MADE OF: schemas, seed, tree
  // binding, version stamp (builder#53). Saved beside the components; without
  // it they lived only on the builder's one shared app object.
  getDefinition = () => ({}),
  setCanvas,          // (components, project) => load them, and project's definition, into the builder
  storage = globalThis.localStorage,
  onChange = () => {},
}) {
  await defineProjectDomains(db);
  // Every save of this panel goes through here, one at a time (builder#49).
  const save = serialSaves(async (pid, canvas, definition) => {
    await saveCanvas(db, pid, canvas);
    await saveDefinition(db, pid, definition);
  });
  let open = false;
  // True while a project is being loaded INTO the builder; see `choose`.
  let loading = false;

  const chip = el("button", { className: "proj-chip", type: "button", id: "projects-chip", textContent: "Projects" });
  const pop = el("div", { className: "proj-pop", id: "projects-pop", hidden: true });
  host.replaceChildren(chip, pop);

  const current = () => readDeviceSettings(storage).lastOpened ?? null;

  async function paint() {
    const rows = await listProjects(db);
    const openId = current();
    const items = [];
    for (const r of rows) {
      // What `openProject` would show, not the raw record count: a project
      // holding a duplicate listed "2 components" and opened 1.
      const n = oneRecordPerComponent(await componentsOf(db, r.id)).length;
      const isOpen = r.id === openId;
      items.push(el("button", {
        className: `proj-row${isOpen ? " is-open" : ""}`,
        type: "button",
        onclick: () => choose(r.id),
      },
        el("b", { textContent: r.fields.title || "Untitled" }),
        el("small", { textContent: `${n} component${n === 1 ? "" : "s"} · ${when(r.fields.updated)}${isOpen ? " · open" : ""}` }),
      ));
    }

    pop.replaceChildren(
      el("div", { className: "proj-head" },
        el("b", { textContent: "My projects" }),
        el("span", { className: "proj-acts" },
          el("button", { type: "button", id: "projects-dup", textContent: "Duplicate", onclick: duplicate, disabled: !current() }),
          el("button", { type: "button", id: "projects-new", textContent: "New project", onclick: create }),
        ),
      ),
      items.length ? el("div", { className: "proj-list" }, items)
        : el("p", { className: "proj-empty", textContent: "No projects yet. A new project starts empty; Duplicate copies the one you have open." }),
      // History of the OPEN project: the publication records, newest first.
      ...(openId ? await historySection(openId) : []),
      // Development mode is stated where a person can see it, not only in a doc.
      el("p", { className: "proj-note" },
        `Every project is ${PUBLIC_UNTIL_PHASE_7}ly readable until private domains exist.`),
    );
    pop.hidden = !open;
    chip.setAttribute("aria-expanded", String(open));
  }

  /**
   * A NEW project starts EMPTY.
   *
   * It used to start from the canvas you had open, which conflates "new" with
   * "duplicate": you would make a project meaning to start fresh and silently
   * get a copy of the last one, with no way to tell from the list. Duplicating
   * is a separate act and records `forked_from` — see `duplicate`.
   */
  /** What this project has published, and what a publication can say yet. */
  async function historySection(pid) {
    const hist = await publicationsOf(db, pid);
    if (!hist.length) return [];
    return [
      el("div", { className: "proj-hist" },
        el("b", { textContent: "Published" }),
        ...hist.map(h => el("div", { className: "proj-pub" },
          el("span", { textContent: `v${h.seq}` }),
          el("small", { textContent: `${when(h.published_at)}${h.source_root ? ` · root ${String(h.source_root).slice(0, 8)}` : ""}` }),
        )),
        // Honest about what a publication cannot say yet, rather than showing
        // a blank where a bundle hash will one day be.
        el("small", { className: "proj-note", textContent:
          "No bundle yet — publishing switches this builder onto a node; it does not package the app. Rollback needs that (builder#47)." }),
      ),
    ];
  }

  async function create() {
    const title = `Project ${(await listProjects(db)).length + 1}`;
    const p = await createProject(db, { title });
    writeDeviceSettings(storage, { lastOpened: p.id });
    loading = true;
    // A new project inherits NOTHING from the one that was open: no schemas,
    // no seed, the default binding, and no version stamp — it is stamped with
    // what it is made with now, not with what another project was made with.
    try { setCanvas([], { ...p, title, components: [], schemas: {}, seed: {}, tree: null, versions: null }); }
    finally { loading = false; }
    // STORED NOW, not at the first edit. The handover stamps the new project
    // with the versions it is made with, inside `loading`, which suppresses the
    // save — so without this a reload before any edit re-stamped it with
    // whatever the builder was by then, and "stamped once" would not hold.
    await persist();
    await paint();
    onChange();
  }

  /** Duplicate the open project, recording where it came from. */
  async function duplicate() {
    const from = current();
    if (!from) return;
    const src = await openProject(db, from);
    const p = await createProject(db, {
      title: `${src.title} copy`,
      forked_from: { project: from },
    });
    // Through the same one-at-a-time chain as `persist`, or the two overlap.
    // A duplicate is a copy of the definition too — the same schemas, seed and
    // stamp — or "copy" would mean "the components, over whatever is lying
    // around".
    await save(p.id, getCanvas(), getDefinition());
    writeDeviceSettings(storage, { lastOpened: p.id });
    await paint();
    onChange();
  }

  /**
   * Open a project.
   *
   * The ORDER here is load-bearing and was a data-losing bug: `setCanvas` makes
   * the builder save, saving persists into whatever project is currently open,
   * and if that is still the PREVIOUS one the project you just left is
   * overwritten with the contents of the one you opened. Two projects, one
   * click, and the first is gone.
   *
   * So the open project is switched BEFORE the canvas is handed over, and
   * `loading` suppresses the write that the handover triggers — the canvas
   * being loaded is already what the records say, so writing it back is at best
   * a no-op and at worst the bug above.
   */
  async function choose(pid) {
    const project = await openInto(db, pid, {
      setLastOpened: id => writeDeviceSettings(storage, { lastOpened: id }),
      handOver: p => {
        loading = true;
        try { setCanvas(p.components.map(fromRecord), p); }
        finally { loading = false; }
      },
    });
    if (!project) return;
    await paint();
    onChange();
  }

  /** Write the open project's canvas back. Called when the canvas changes. */
  async function persist() {
    if (loading) return;   // see `choose`
    const pid = current();
    if (!pid) return;
    // Project, canvas AND definition NAMED now, before waiting on any earlier
    // save (see `serialSaves`). The definition rides the SAME chain: it is a
    // diff like the canvas, and two overlapping runs of it would duplicate
    // domain records exactly as overlapping canvas saves duplicated components.
    await save(pid, getCanvas(), getDefinition());
    await paint();
  }

  /**
   * Record that the open project was published, with what is TRUE at the time.
   *
   * No bundle hash and no app address: publishing does not package the app yet
   * (builder#47, blocked on craftworks-sdk#108). What IS true is the tree root
   * it published FROM, the SDK it was built against, and when.
   */
  async function published({ sourceRoot = null, sdkVersion = null } = {}) {
    const pid = current();
    if (!pid) return null;
    const rec = await recordPublication(db, pid, {
      seq: await nextSeq(db, pid),
      source_root: sourceRoot,
      sdk_version: sdkVersion,
    });
    await paint();
    return rec;
  }

  chip.onclick = async () => { open = !open; await paint(); };
  document.addEventListener("click", e => {
    if (open && !pop.contains(e.target) && e.target !== chip) { open = false; pop.hidden = true; }
  });

  await paint();
  // Reopen what this DEVICE had open — never a synced value, which would be
  // wrong on a second device.
  const last = current();
  if (last) {
    let project = await openProject(db, last);
    // A project from before builder#53 has no stored definition. The shared
    // working copy the builder loaded IS the definition of the project that
    // was open — this one — so it is adopted and stored rather than replaced
    // by an empty one, which saved back would have deleted a person's real
    // schemas on the first load after the upgrade. Only for the last-opened
    // project: any other legacy project never had its definition stored, and
    // guessing it from the working copy would be the old bug again.
    if (project?.legacy) project = { ...project, ...getDefinition() };
    if (project) setCanvas(project.components.map(fromRecord), project);
    if (project?.legacy) await persist();
  }
  return { persist, refresh: paint, openProjectId: current, published };
}
