// Create, open and browse projects.
//
// The list is the OWNER'S TREE's (`project-list.js`): the apps that hold a draft, each named by its own draft's
// `meta`, read through the list app's session (`list()`, null until that session is open). Nothing about a project
// is kept on this device except which one was open last (`lastOpened`), a convenience behind the storage guard.
// What a project IS is its draft, which the page's project runtime reads and writes; this file never writes one.

import { browserStorage } from "./storage.js";
import { readDeviceSettings, writeDeviceSettings, PUBLIC_UNTIL_PHASE_7 } from "./projects.js";
import { listProjects, metaOf, newProjectId, newest } from "./project-list.js";

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.flat(Infinity));
  return e;
};

const when = ms => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—");

/** A row's label from its `meta` as read: "…" while it loads, the name (or "Untitled") and its component count after. */
export function rowLabel(meta) {
  if (meta === undefined) return { name: "…", detail: "" };
  const n = Array.isArray(meta?.order) ? meta.order.length : 0;
  return { name: meta?.name || "Untitled", detail: `${n} component${n === 1 ? "" : "s"}` };
}

export async function mountProjects(host, {
  // () => the list app's db (the owner's tree), or null while its session is not open yet.
  list = () => null,
  // (project, { fresh, from }) => open it in the page: a new runtime, its tree opened, its draft shown. `project` is
  // `{ id }` (and `created`, `forkedFrom` for a new one); `fresh`: made in this tab; `from`: the definition it starts as.
  open,
  // () => the open project's definition as the canvas holds it ({ name, components, schemas, seed }): what a
  // Duplicate starts as.
  getApp = () => null,
  storage = browserStorage,
  onChange = () => {},
}) {
  let shown = false;
  // What each row's meta read answered: a view of the drafts, never written back.
  const metas = new Map();

  const chip = el("button", { className: "proj-chip", type: "button", id: "projects-chip", textContent: "Projects" });
  const pop = el("div", { className: "proj-pop", id: "projects-pop", hidden: true });
  host.replaceChildren(chip, pop);

  const current = () => readDeviceSettings(storage).lastOpened ?? null;

  /** Ask each row's meta, and paint again as answers come. A read that fails leaves the row at "…". */
  function readMetas(db, ids) {
    for (const id of ids) {
      Promise.resolve(metaOf(db, id)).then(m => {
        const had = metas.get(id);
        metas.set(id, m ?? null);
        if (JSON.stringify(had) !== JSON.stringify(m ?? null) && shown) paint({ read: false });
      }, () => {});
    }
  }

  async function paint({ read = true } = {}) {
    const db = list();
    const ids = db ? await listProjects(db).catch(() => null) : null;
    if (db && ids && read && shown) readMetas(db, ids);
    const openId = current();
    const items = (ids ?? []).map(id => {
      const isOpen = id === openId;
      const m = metas.get(id);
      const { name, detail } = rowLabel(m);
      return el("button", { className: `proj-row${isOpen ? " is-open" : ""}`, type: "button", onclick: () => choose(id) },
        el("b", { textContent: name }),
        el("small", { textContent: [detail, when(m?.created), isOpen ? "open" : ""].filter(Boolean).join(" · ") }),
      );
    });
    pop.replaceChildren(
      el("div", { className: "proj-head" },
        el("b", { textContent: "My projects" }),
        el("span", { className: "proj-acts" },
          el("button", { type: "button", id: "projects-dup", textContent: "Duplicate", onclick: duplicate, disabled: !current() }),
          el("button", { type: "button", id: "projects-new", textContent: "New project", onclick: () => create() }),
        ),
      ),
      !ids ? el("p", { className: "proj-empty", id: "projects-waiting", textContent: "Your projects are listed from your node: waiting for it." })
        : items.length ? el("div", { className: "proj-list" }, items)
          : el("p", { className: "proj-empty", textContent: "No projects yet. A new project starts empty; Duplicate copies the one you have open." }),
      el("p", { className: "proj-note" }, `Every project is ${PUBLIC_UNTIL_PHASE_7}ly readable until private domains exist.`),
    );
    pop.hidden = !shown;
    chip.setAttribute("aria-expanded", String(shown));
  }

  /** A NEW project: its id minted here, its draft starting as `from` (or empty, numbered as the list would). */
  async function create({ from = null, forkedFrom = null } = {}) {
    const db = list();
    const count = db ? (await listProjects(db).catch(() => [])).length : null;
    const start = { components: [], schemas: {}, seed: {}, ...(from ?? {}) };
    if (!start.name) start.name = count === null ? "Untitled" : `Project ${count + 1}`;
    const project = { id: newProjectId(), created: Date.now(), forkedFrom };
    writeDeviceSettings(storage, { lastOpened: project.id });
    open(project, { fresh: true, from: start });
    await paint();
    onChange();
    return project;
  }

  /** Duplicate the open project: a new one starting as its definition, recording where it came from. */
  async function duplicate() {
    const from = current();
    if (!from) return;
    const src = getApp() ?? {};
    await create({ from: { ...src, name: `${src.name || "Untitled"} copy` }, forkedFrom: { project: from } });
  }

  /** Open a project: switched FIRST (lastOpened), then handed to the page, which reads its draft. */
  async function choose(id) {
    writeDeviceSettings(storage, { lastOpened: id });
    open({ id }, { fresh: false });
    await paint();
    onChange();
  }

  chip.onclick = async () => { shown = !shown; await paint(); };
  document.addEventListener("click", e => {
    if (shown && !pop.contains(e.target) && e.target !== chip) { shown = false; pop.hidden = true; }
  });

  await paint();
  return {
    refresh: paint, openProjectId: current, create,
    /** Reopen what this DEVICE had open (a convenience, never synced); false when it has none. */
    reopen() {
      const last = current();
      if (!last) return false;
      open({ id: last }, { fresh: false });
      return true;
    },
    /** With no project remembered: the NEWEST of the tree's projects (by meta.created), or a new one. Needs the list. */
    async openNewestOrCreate() {
      const db = list();
      if (!db) return false;
      const ids = await listProjects(db);
      const pick = newest(await Promise.all(ids.map(async id => ({ id, meta: await metaOf(db, id).catch(() => null) }))));
      if (pick) await choose(pick.id);
      else await create();
      return true;
    },
  };
}
