// Create, open and browse projects.
//
// The judgement lives in `projects.js`, which has no DOM and is tested on its
// own; this file paints and calls. A project is a record plus one record per
// component, so "browse" is a scan and "open" is a read — there is no separate
// index to keep in step.

import {
  defineProjectDomains, createProject, listProjects, openProject,
  addComponent, componentsOf, removeComponent, setComponentProps,
  readDeviceSettings, writeDeviceSettings, PUBLIC_UNTIL_PHASE_7, openInto,
  recordPublication, publicationsOf, nextSeq,
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

/** Do two components differ in anything that is stored? */
const changed = (c, rec) =>
  rec.fields.kind !== c.type ||
  rec.fields.props !== JSON.stringify(toRecord(c).props);

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
  const existing = await componentsOf(db, pid);
  const byId = new Map(existing.map(r => [r.id, r]));
  const kept = new Set();
  const did = { added: 0, updated: 0, removed: 0, untouched: 0 };

  for (const c of components) {
    const rec = c.rid ? byId.get(c.rid) : null;
    if (!rec) {
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

export async function mountProjects(host, {
  db,
  getCanvas,          // () => the builder's current components
  setCanvas,          // (components, project) => load them into the builder
  storage = globalThis.localStorage,
  onChange = () => {},
}) {
  await defineProjectDomains(db);
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
      const n = (await componentsOf(db, r.id)).length;
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
    try { setCanvas([], { ...p, title, components: [] }); }
    finally { loading = false; }
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
    await saveCanvas(db, p.id, getCanvas());
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
    await saveCanvas(db, pid, getCanvas());
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
    const project = await openProject(db, last);
    if (project) setCanvas(project.components.map(fromRecord), project);
  }
  return { persist, refresh: paint, openProjectId: current, published };
}
