// Create, open and browse projects.
//
// The judgement lives in `projects.js`, which has no DOM and is tested on its
// own; this file paints and calls. A project is a record plus one record per
// component, so "browse" is a scan and "open" is a read — there is no separate
// index to keep in step.

import {
  defineProjectDomains, createProject, listProjects, openProject,
  addComponent, componentsOf, removeComponent,
  readDeviceSettings, writeDeviceSettings, PUBLIC_UNTIL_PHASE_7, openInto,
} from "./projects.js";

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.flat(Infinity));
  return e;
};

const when = ms => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—");

/** A builder component <-> a stored component record. */
export const toRecord = c => ({ kind: c.type, layout: null, binding: null, props: { ...c } });
export const fromRecord = r => ({ ...(r.props ?? {}), type: r.kind });

/**
 * Save the open canvas as records: the project, then one record per component.
 *
 * Components are REPLACED rather than diffed. A diff is the right thing once
 * there is something to preserve per component (a stable id from the canvas),
 * and the canvas does not carry one yet — so this is honest about rewriting
 * them rather than pretending to be incremental.
 */
export async function saveCanvas(db, pid, components) {
  for (const r of await componentsOf(db, pid)) await removeComponent(db, r.id);
  for (const c of components) await addComponent(db, pid, toRecord(c));
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
  return { persist, refresh: paint, openProjectId: current };
}
