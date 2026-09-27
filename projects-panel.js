// Create, open and browse projects.
//
// The list is THIS DEVICE's (`projects.js`: what identifies each project, and its publications). What a project IS —
// its name, its components, its domains — is its draft in the owner's tree (`definition.js`, ARCHITECTURE §19), which
// the page's project runtime reads and writes. So this file never writes a definition: it lists, and it hands a
// project to the page to open (`open`). Each row's name and component count are read from that project's `meta`
// through the normal read (`metaOf`), lazily: "…" until it answers.

import { browserStorage } from "./storage.js";
import {
  defineProjectDomains, createProject, listProjects, openProject, saveProjectMeta,
  readDeviceSettings, writeDeviceSettings, PUBLIC_UNTIL_PHASE_7, openInto,
  recordPublication, publicationsOf, nextSeq,
} from "./projects.js";

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
  db,
  // (project, { fresh, from }) => open it in the page: a new runtime, its tree opened, its draft shown. `fresh`: made
  // in this tab (its canvas IS its definition); `from`: the definition a new project starts as (a duplicate).
  open,
  // pid => Promise<meta | null>: the project's `meta` read from its draft (`{ name, order }`), for the list.
  metaOf = async () => null,
  // () => { tree, versions } of the open project, kept on its list record.
  getProjectMeta = null,
  // () => the open project's definition as the canvas holds it ({ name, components, schemas, seed }): what a
  // Duplicate starts as.
  getApp = () => null,
  storage = browserStorage,
  onChange = () => {},
}) {
  await defineProjectDomains(db);
  let shown = false;
  // What each row's meta read answered, for this paint and the next (a view of the drafts, never written back).
  const metas = new Map();

  const chip = el("button", { className: "proj-chip", type: "button", id: "projects-chip", textContent: "Projects" });
  const pop = el("div", { className: "proj-pop", id: "projects-pop", hidden: true });
  host.replaceChildren(chip, pop);

  const current = () => readDeviceSettings(storage).lastOpened ?? null;

  /** Ask each row's meta, and paint again as answers come. A read that fails leaves the row at "…". */
  function readMetas(rows) {
    for (const r of rows) {
      Promise.resolve(metaOf(r.id)).then(m => {
        const had = metas.get(r.id);
        metas.set(r.id, m ?? null);
        if (JSON.stringify(had) !== JSON.stringify(m ?? null) && shown) paint({ read: false });
      }, () => {});
    }
  }

  async function paint({ read = true } = {}) {
    const rows = await listProjects(db);
    if (read && shown) readMetas(rows);
    const openId = current();
    const items = rows.map(r => {
      const isOpen = r.id === openId;
      const { name, detail } = rowLabel(metas.get(r.id));
      return el("button", {
        className: `proj-row${isOpen ? " is-open" : ""}`,
        type: "button",
        onclick: () => choose(r.id),
      },
        el("b", { textContent: name }),
        el("small", { textContent: [detail, when(r.fields.created), isOpen ? "open" : ""].filter(Boolean).join(" · ") }),
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
      items.length ? el("div", { className: "proj-list" }, items)
        : el("p", { className: "proj-empty", textContent: "No projects yet. A new project starts empty; Duplicate copies the one you have open." }),
      // History of the OPEN project: the publication records, newest first.
      ...(openId ? await historySection(openId) : []),
      // Development mode is stated where a person can see it, not only in a doc.
      el("p", { className: "proj-note" },
        `Every project is ${PUBLIC_UNTIL_PHASE_7}ly readable until private domains exist.`),
    );
    pop.hidden = !shown;
    chip.setAttribute("aria-expanded", String(shown));
  }

  /** What this project has published. */
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
      ),
    ];
  }

  /**
   * A NEW project: empty, or — `from` — starting as the definition given (an import, a duplicate). It inherits
   * nothing else from the one that was open: no binding, no version stamp.
   */
  async function create({ from = null, forked_from = null } = {}) {
    // A project with no name of its own (empty, or an app imported without one) is named as the list would number
    // it; the name is its draft's from here on.
    const start = { components: [], schemas: {}, seed: {}, ...(from ?? {}) };
    if (!start.name) start.name = `Project ${(await listProjects(db)).length + 1}`;
    const rec = await createProject(db, { forked_from });
    writeDeviceSettings(storage, { lastOpened: rec.id });
    const project = await openProject(db, rec.id);
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
    await create({ from: { ...src, name: `${src.name || "Untitled"} copy` }, forked_from: { project: from } });
  }

  /** Open a project: switched FIRST, then handed to the page (see `openInto`). */
  async function choose(pid) {
    const publication = (await publicationsOf(db, pid))[0] ?? null;
    const project = await openInto(db, pid, {
      setLastOpened: id => writeDeviceSettings(storage, { lastOpened: id }),
      handOver: p => open({ ...p, publication }, { fresh: false }),
    });
    if (!project) return;
    await paint();
    onChange();
  }

  /** Keep the open project's tree binding and version stamp on its list record. */
  async function persist() {
    const pid = current();
    if (!pid || !getProjectMeta) return;
    await saveProjectMeta(db, pid, getProjectMeta());
  }

  /** Record that the open project was published, with what is TRUE at the time. */
  async function published({ sourceRoot = null, sdkVersion = null, bundleHash = null, appContractId = null, head = null, headSeq = null } = {}) {
    const pid = current();
    if (!pid) return null;
    const rec = await recordPublication(db, pid, {
      seq: await nextSeq(db, pid),
      source_root: sourceRoot,
      sdk_version: sdkVersion,
      bundle_hash: bundleHash,
      app_contract_id: appContractId,
      head,
      head_seq: headSeq,
    });
    await paint();
    return rec;
  }

  chip.onclick = async () => { shown = !shown; await paint(); };
  document.addEventListener("click", e => {
    if (shown && !pop.contains(e.target) && e.target !== chip) { shown = false; pop.hidden = true; }
  });

  await paint();
  return {
    persist, refresh: paint, openProjectId: current, published, create,
    /** Reopen what this DEVICE had open (never a synced value); false when there is none to reopen. */
    async reopen() {
      const last = current();
      const project = last ? await openProject(db, last) : null;
      if (!project) return false;
      open({ ...project, publication: (await publicationsOf(db, project.id))[0] ?? null }, { fresh: false });
      return true;
    },
  };
}
