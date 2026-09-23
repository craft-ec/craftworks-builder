// Create, open and browse projects.
//
// The judgement lives in `projects.js`, which has no DOM and is tested on its
// own; this file paints and calls. A project is a record plus one record per
// component, so "browse" is a scan and "open" is a read — there is no separate
// index to keep in step.

import { PROJECT,
  defineProjectDomains, createProject, listProjects, openProject,
  addComponent, componentsOf, removeComponent, setComponentProps, saveDefinition,
  readDeviceSettings, writeDeviceSettings, PUBLIC_UNTIL_PHASE_7, openInto,
  recordPublication, publicationsOf, nextSeq, recordPerComponentKey,
  restoreProject, restoreComponent,
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

/**
 * WHAT A COMPONENT LOOKED LIKE when this tab last loaded or wrote it: its
 * stored content, and the token of the write that produced it (builder#74).
 *
 * A component is DIRTY against this base, never against storage. With one
 * holder the two are the same; with two tabs they are not, and diffing against
 * storage made a tab that never touched K write its stale K over another tab's
 * edit. NOT STORED: a non-enumerable symbol, so no spread, `toRecord`, or JSON
 * of the working copy ever carries it.
 *
 * SAFE ONLY WHILE COMPONENTS ARE MUTATED IN PLACE. The same non-enumerability
 * means a COPY (`{ ...c }`, `structuredClone`, a JSON round trip) drops the
 * base without a word, and a component with no base falls back to the old
 * storage diff — the two-tab revert, back. Anything that replaces a canvas
 * component with a copy must carry the base across (`setBase` from a record,
 * or copy the symbol) or it reintroduces builder#74.
 */
const BASE = Symbol("base");
/** This tab. A write's token is `{ gen, by }`, so "stored == my base" cannot be true of a write that was not mine. */
const TAB = globalThis.crypto.randomUUID();
const contentOf = c => {
  const { [BUILDER]: _m, ...rest } = toRecord(c).props;
  return JSON.stringify({ kind: c.type, props: rest });
};
const tokenOf = c => ({ gen: c[BUILDER]?.gen ?? 0, by: c[BUILDER]?.by ?? null });
const setBase = c => Object.defineProperty(c, BASE, { value: { content: contentOf(c), token: tokenOf(c) }, enumerable: false, configurable: true, writable: true });

export const fromRecord = r => setBase({ ...(r.props ?? {}), type: r.kind, rid: r.id });

/**
 * THE CANVAS'S BASE: the record ids this tab last loaded or wrote (builder#78).
 *
 * The component BASE settles CONTENT; this settles MEMBERSHIP. Diffed against
 * storage, a tab's removal pass deleted every stored record not on its canvas
 * — including one another tab ADDED that it never saw — and a component whose
 * record was gone was taken for new and re-added. Against this set: a record
 * not on my canvas and not in my set was added elsewhere (adopt it); one in my
 * set I deleted (remove it); a rid in my set with no record was deleted
 * elsewhere (drop it, or keep and tell if I changed it).
 *
 * Non-enumerable on the canvas ARRAY, never stored, and set where records
 * become a canvas (`canvasOf`) and after every save. A canvas without one —
 * brand new, or assembled some other way — behaves exactly as before until its
 * first save records one.
 */
const MEMBERS = Symbol("members");
// The set is OF A PROJECT. One canvas array can be saved into another project
// — Duplicate saves the open canvas into the new copy — and there the old
// project's ids, with no record in the new one, would read as "deleted
// elsewhere" and empty the canvas. So the set names the project it describes,
// and a save into any other project uses the old rule.
//
// It also holds the PROJECT RECORD as this tab last read it (builder#82). If
// the store is lost under an open tab, this canvas is the only copy left of
// the project as well as of its components, and a restore that put back only
// the components left a project nobody could open: no record, not listed, and
// the person told it had been saved.
const setMembers = (canvas, pid, ids, project = canvas[MEMBERS]?.pid === pid ? canvas[MEMBERS].project : null) =>
  Object.defineProperty(canvas, MEMBERS, { value: { pid, ids: new Set(ids), project }, enumerable: false, configurable: true, writable: true });

/** A project's components as a canvas, with its base set. Use this, not a bare `map(fromRecord)`. */
export const canvasOf = project =>
  setMembers(project.components.map(fromRecord), project.id, project.components.map(c => c.id), project.record ?? null);

/** A raw stored record as the component `fromRecord` expects. */
const decoded = r => {
  let props = {};
  try { props = JSON.parse(r.fields.props) ?? {}; } catch { /* unreadable: an empty component, rather than a throw */ }
  return { id: r.id, kind: r.fields.kind, props };
};

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
/** The token of the write a record holds: `{ gen, by }`. */
const storedToken = rec => {
  try { const m = JSON.parse(rec.fields.props)?.[BUILDER] ?? {}; return { gen: m.gen ?? 0, by: m.by ?? null }; }
  catch { return { gen: 0, by: null }; }
};
/** Replace a canvas component's content with a record's, in place, keeping its identity. */
const adopt = (c, rec) => {
  let props = {};
  try { props = JSON.parse(rec.fields.props) ?? {}; } catch { /* unreadable: leave the canvas as it is */ return false; }
  for (const k of Object.keys(c)) if (k !== "rid") delete c[k];
  Object.assign(c, props, { type: rec.fields.kind, rid: rec.id });
  setBase(c);
  return true;
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
export async function saveCanvas(db, pid, components, { by = TAB, onConflict, ids = null } = {}) {
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
  // `adopted`: this tab's clean copy was behind another tab's write, and took
  // it — nothing written. `conflicts`: both tabs changed one component; this
  // tab's write wins and the person is told.
  // `dropped`: a clean component another tab DELETED, taken off this canvas.
  // `restored`: this tab's components whose store was LOST, saved again.
  // `restoredProject`: the project record itself was put back.
  const did = { added: 0, updated: 0, removed: 0, untouched: 0, adopted: 0, conflicts: 0, dropped: 0, restored: 0, restoredProject: false };
  // No base set, or one recorded for ANOTHER project: nothing is deleted on
  // its say-so (see the removal pass).
  const members = components[MEMBERS]?.pid === pid ? components[MEMBERS].ids : undefined;
  const drop = new Set();
  // "Deleted in another tab" presumes the PROJECT is still there: a tab that
  // deleted a component did not delete the project. If the project record is
  // gone too, the store was LOST under this tab — cleared site data, eviction,
  // a private window — and this canvas is the only copy left. Dropping clean
  // components there would destroy them; they are saved again instead, and the
  // person is told (found by the architect's probe of builder#78).
  //
  // RESTORED IN PLACE (builder#82): the project record under its own id from
  // the copy this tab holds, then each component under its own id — so a
  // reload opens the SAME project, listed, with its components, and the
  // definition follows in the save that called this. `createAt` never
  // overwrites: a second tab restoring at the same moment finds the first's.
  //
  // "No project record ⇒ the store was lost" is sound only because NOTHING
  // deletes a project today. The day that ships, a project deleted in another
  // tab looks identical — so deletion must leave a tombstone, and `createAt`
  // refuses to create over one.
  // Read on every save, not only with a base set: the copy it leaves on the
  // canvas is what a later restore puts back.
  const stored = await db.get(PROJECT, pid);
  const projectStored = members ? Boolean(stored) : true;
  const held = components[MEMBERS]?.pid === pid ? components[MEMBERS].project : null;
  let unrestorable = false;
  if (!projectStored) {
    if (held) {
      await restoreProject(db, pid, held, ids);
      did.restoredProject = true;
    } else {
      unrestorable = true;
    }
  }

  for (const c of components) {
    const key = c[BUILDER].key;
    let rec = c.rid ? byId.get(c.rid) : null;
    if (!rec && byKey.has(key)) {
      rec = byKey.get(key);
      c.rid = rec.id;
    }
    // EVERY WRITE OF A COMPONENT BUMPS ITS GENERATION, past both what this
    // canvas last wrote and what ANY record of this key holds, and names THIS
    // tab. `gen` is a per-key WRITE COUNTER — it chooses one record
    // deterministically and is a holder's base version — not a measure of
    // freshness: with two holders the highest count can be a revert.
    const bump = () => { c[BUILDER] = { key, gen: Math.max(c[BUILDER].gen ?? 0, topGen.get(key) ?? 0) + 1, by }; };
    if (!rec && c.rid && members?.has(c.rid) && !projectStored) {
      bump();
      const again = await restoreComponent(db, pid, c.rid, toRecord(c), ids);
      c.rid = again.record.id;
      setBase(c);
      kept.add(again.record.id);
      did.added += 1;
      did.restored += 1;
      continue;
    }
    if (!rec && c.rid && members?.has(c.rid)) {
      // I LOADED OR WROTE THIS, AND ITS RECORD IS GONE: deleted in another tab.
      // `rid` is only ever set from an add that answered, so this is not "never
      // landed". Clean here, it goes; changed here, the person's version is
      // kept and they are TOLD.
      if (c[BASE] && contentOf(c) === c[BASE].content) {
        drop.add(c);
        did.dropped += 1;
        continue;
      }
      if (typeof onConflict !== "function") {
        throw new Error("saveCanvas: a component was deleted in another tab and changed here, and there is no onConflict to tell the person");
      }
      delete c.rid;
      bump();
      const readded = await addComponent(db, pid, toRecord(c));
      c.rid = readded.id;
      setBase(c);
      kept.add(readded.id);
      did.added += 1;
      did.conflicts += 1;
      onConflict("This component was deleted in another tab; your version was kept.");
      continue;
    }
    if (!rec) {
      bump();
      const added = await addComponent(db, pid, toRecord(c));
      // The new id goes back onto the canvas component, or the next save
      // cannot find it either and the re-keying returns.
      c.rid = added.id;
      setBase(c);
      kept.add(added.id);
      did.added += 1;
      continue;
    }
    kept.add(rec.id);
    const base = c[BASE];
    if (!base) {
      // Never loaded from a record by this tab (made here, or reached by key):
      // there is no base to compare with, so the stored copy stands in for it.
      if (changed(c, rec)) {
        bump();
        await setComponentProps(db, rec.id, toRecord(c).props);
        did.updated += 1;
      } else {
        did.untouched += 1;
      }
      setBase(c);
      continue;
    }
    const theirs = storedToken(rec);
    const mine = base.token.gen === theirs.gen && base.token.by === theirs.by;
    const dirty = contentOf(c) !== base.content;
    if (!dirty && mine) {
      did.untouched += 1;
    } else if (!dirty) {
      // CLEAN HERE, CHANGED ELSEWHERE: adopt theirs, write nothing. This is the
      // case that used to write a stale copy back over another tab's edit.
      if (adopt(c, rec)) did.adopted += 1; else did.untouched += 1;
    } else {
      if (!mine) {
        // A REAL CONFLICT: this tab and another both changed it. Last writer
        // wins, and the person is TOLD — never silently. With no one to tell,
        // this is a wiring error and it fails before anything is written.
        if (typeof onConflict !== "function") {
          throw new Error("saveCanvas: a component was changed in two tabs and there is no onConflict to tell the person");
        }
        did.conflicts += 1;
      }
      bump();
      await setComponentProps(db, rec.id, toRecord(c).props);
      setBase(c);
      did.updated += 1;
      if (!mine) onConflict("This component was also changed in another tab; your version was kept.");
    }
  }

  // Drops happen in place: the canvas is the person's, and this is its array.
  for (let i = components.length - 1; i >= 0; i -= 1) if (drop.has(components[i])) components.splice(i, 1);

  const onCanvasKeys = new Set(components.map(c => c[BUILDER]?.key).filter(Boolean));
  for (const r of existing) {
    if (kept.has(r.id)) continue;
    const key = componentKeyOf(r);
    // A second record of a component already on the canvas is a DUPLICATE
    // (builder#49): removed, as ever — never adopted as a second copy.
    const duplicate = key && onCanvasKeys.has(key);
    // NO BASE SET, NO DELETION. A canvas that cannot show it ever held a
    // record must not delete it: a fresh array — a Clear that replaced the
    // canvas, a tab that never loaded this project — would otherwise delete
    // every record another tab added. Duplicates of what IS on the canvas are
    // still cleaned up (#49).
    if (!duplicate && !members) continue;
    if (!duplicate && members && !members.has(r.id) && (!key || byKey.get(key) === r)) {
      // ADDED ELSEWHERE: not on my canvas, never in my set. Adopt, write nothing.
      const c = fromRecord(decoded(r));
      components.push(c);
      if (key) onCanvasKeys.add(key);
      did.adopted += 1;
      continue;
    }
    await removeComponent(db, r.id);
    did.removed += 1;
  }
  // What this tab now holds is its new base set — and the project record as
  // it now stands.
  setMembers(components, pid, components.map(c => c.rid).filter(Boolean), stored?.fields ?? held);
  if (unrestorable) {
    // Components back, record not: a canvas that never read the record holds
    // no copy of it to put back. Loud, never "saved".
    throw new Error("saveCanvas: this project's stored copy was lost, and this tab holds no copy of the project record to put it back under its own id");
  }
  if (did.restored || did.restoredProject) {
    // Told once, AFTER the project is safe again: with no one to tell, the
    // save still fails loudly, but not before the data is back.
    if (typeof onConflict !== "function") {
      throw new Error("saveCanvas: this project's stored copy was lost and was saved again from this tab, and there is no onConflict to tell the person");
    }
    onConflict("This device's saved copy of this project was missing; it has been saved again from this tab.");
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
/** Where the pre-upgrade working copy is kept, once, as the recovery store. */
export const LEGACY_SNAPSHOT_KEY = "craftec.builder.legacy-definition.v1";

/**
 * Adopt the pre-#53 working copy into the projects that were stored without a
 * definition — once, from a snapshot. See the call site in `mountProjects`.
 * `copy` is called only when the snapshot does not exist yet.
 */
export async function adoptLegacy({ db, storage, copy, last }) {
  let snap = null;
  try { snap = JSON.parse(storage.getItem(LEGACY_SNAPSHOT_KEY) ?? "null"); } catch { snap = null; }
  if (!snap) {
    const pending = [];
    for (const row of await listProjects(db)) {
      const p = await openProject(db, row.id);
      // At the first mount of this build, "no definition stored" can only mean
      // "made before it": every project this build creates stores one.
      if (p?.legacy) pending.push(p.id);
    }
    snap = { taken: Date.now(), copy: JSON.parse(JSON.stringify(copy() ?? {})), last, pending, adopted: [] };
    // Not stored → nothing adopted this mount. Adopting from a snapshot that
    // was never kept would be adopting from the live copy by another name.
    try { storage.setItem(LEGACY_SNAPSHOT_KEY, JSON.stringify(snap)); } catch { return; }
  }
  const todo = snap.pending.filter(id => !snap.adopted.includes(id));
  if (!todo.length) return;

  const listed = [];
  for (const id of snap.pending) {
    const p = await openProject(db, id);
    if (p) listed.push(p);
  }
  const domainsOf = p => new Set(p.components.map(c => c.props?.domain).filter(Boolean));
  const binders = d => listed.filter(p => domainsOf(p).has(d)).map(p => p.id);
  const claimed = new Set(listed.flatMap(p => [...domainsOf(p)]));
  const { schemas = {}, seed = {}, tree = null, versions = null } = snap.copy;
  const seedOwner = d => {
    const b = binders(d);
    if (b.length === 1) return b[0];
    if (b.includes(snap.last)) return snap.last;
    return null;   // the rows stay in the snapshot
  };

  for (const id of todo) {
    const p = listed.find(x => x.id === id);
    // STILL legacy, checked NOW. The definition is written before the marker,
    // so a marker write that fails — or a page that dies between the two —
    // leaves a project adopted but unmarked, and the person may have defined
    // it since. Adopting again from the older snapshot would overwrite that.
    if (p?.legacy) {
      const isLast = id === snap.last;
      const own = domainsOf(p);
      // The last-opened project also keeps copy domains NO listed project binds:
      // they were set in the open project and nothing else can claim them.
      const mine = d => own.has(d) || (isLast && !claimed.has(d));
      await saveDefinition(db, id, {
        schemas: Object.fromEntries(Object.entries(schemas).filter(([d]) => mine(d))),
        seed: Object.fromEntries(Object.entries(seed).filter(([d]) => mine(d) && (seedOwner(d) === id || (isLast && !claimed.has(d))))),
        tree: isLast ? (tree ?? { realm: "public", identity: null }) : { realm: "public", identity: null },
        versions: isLast ? versions : null,
      });
    }
    // RECORDED, adopted or not, so it never runs for this project again.
    snap.adopted.push(id);
    try { storage.setItem(LEGACY_SNAPSHOT_KEY, JSON.stringify(snap)); } catch { return; }
  }
}

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
  //
  // NO DEFAULT. `() => ({})` looked like a no-op and was a WIPE: `persist`
  // hands it to `saveDefinition`, which removes every domain record the
  // project has. A caller that supplies none gets its definition left alone.
  getDefinition = null,
  setCanvas,          // (components, project) => load them, and project's definition, into the builder
  storage = globalThis.localStorage,
  onChange = () => {},
  // Told when a save finds a component that another tab also changed (its
  // version was kept). No default: with nobody to tell, `saveCanvas` fails
  // at the conflict rather than being quiet about it (builder#74, #73).
  onConflict,
  // () => the SDK's id rules (`sdk.ids`), or a promise of them while it loads:
  // a restore reads a record's slot by them, waiting for the load if it must.
  getIds = () => null,
}) {
  await defineProjectDomains(db);
  // Every save of this panel goes through here, one at a time (builder#49).
  const save = serialSaves(async (pid, canvas, definition) => {
    const did = await saveCanvas(db, pid, canvas, { onConflict, ids: getIds() });
    if (definition) await saveDefinition(db, pid, definition);
    // A save that ADOPTED another tab's version changed the canvas under the
    // person, so what is on screen must be drawn again from it.
    if (did.adopted || did.dropped) onChange();
    return did;
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

  /**
   * Keep what the builder is SHOWING as a new project, and make it the open
   * one — for a Publish pressed with no project open (builder#83).
   *
   * A publish is keyed by its project, so it needs one; the person pressed
   * Publish on an app they can see, and the builder can do this step for them.
   * It is `create` minus the handover: `setCanvas` would dispose the runtime,
   * and with it the Preview whose records this publish is about to copy. The
   * canvas and definition are already the builder's, so they are saved as
   * they are, through the same chain every save takes.
   *
   * Answers null when a project is already open: nothing to adopt, and never a
   * second project. "Open" means the record EXISTS — a `lastOpened` naming a
   * project deleted elsewhere is no project. And one adoption at a time: a
   * second Publish pressed while the first is adopting gets the same project,
   * not another.
   */
  let adopting = null;
  function adopt({ title } = {}) {
    adopting ??= (async () => {
      const open = current();
      if (open && await db.get(PROJECT, open)) return null;
      const name = title || `Project ${(await listProjects(db)).length + 1}`;
      const p = await createProject(db, { title: name });
      writeDeviceSettings(storage, { lastOpened: p.id });
      await save(p.id, getCanvas(), getDefinition ? getDefinition() : null);
      await paint();
      onChange();
      return { id: p.id, created: p.fields.created, title: name };
    })().finally(() => { adopting = null; });
    return adopting;
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
    await save(p.id, getCanvas(), getDefinition ? getDefinition() : null);
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
    // Read BEFORE the handover, which is synchronous: a published project
    // reopens connected (`reconnectsOnOpen`).
    const publication = (await publicationsOf(db, pid))[0] ?? null;
    const project = await openInto(db, pid, {
      setLastOpened: id => writeDeviceSettings(storage, { lastOpened: id }),
      handOver: p => {
        loading = true;
        try { setCanvas(canvasOf(p), { ...p, publication }); }
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
    // No `getDefinition`, no definition write — never an empty one, which is a
    // wipe.
    await save(pid, getCanvas(), getDefinition ? getDefinition() : null);
    await paint();
  }

  /**
   * Record that the open project was published, with what is TRUE at the time.
   *
   * The tree root it published FROM, the SDK it was built against, when, and
   * — once the app is on the network (builder#104) — its bundle hash, its
   * address and the head its data is read from.
   */
  async function published({ sourceRoot = null, sdkVersion = null, bundleHash = null, appContractId = null, head = null } = {}) {
    const pid = current();
    if (!pid) return null;
    const rec = await recordPublication(db, pid, {
      seq: await nextSeq(db, pid),
      source_root: sourceRoot,
      sdk_version: sdkVersion,
      bundle_hash: bundleHash,
      app_contract_id: appContractId,
      head,
    });
    await paint();
    return rec;
  }

  chip.onclick = async () => { open = !open; await paint(); };
  document.addEventListener("click", e => {
    if (open && !pop.contains(e.target) && e.target !== chip) { open = false; pop.hidden = true; }
  });

  // PROJECTS FROM BEFORE builder#53 have no stored definition: their schemas
  // and seeds lived only in the builder's one shared working copy. Opened as
  // they are, each would show an empty definition and its first edit would
  // store that — losing the schema for good. So they ADOPT from that copy.
  //
  // From a SNAPSHOT, never the live copy (review of builder#67). The live copy
  // keeps changing — the next project someone builds writes its schemas there
  // — so adopting from it at a later mount hands one project another's data.
  // At the FIRST mount of this build the copy is still the pre-upgrade one; it
  // is copied, once, to its own key, together with the list of projects that
  // had no definition AT THAT MOMENT, and the last-opened id. Only the
  // projects on that list ever adopt, and only from that snapshot. It is kept
  // afterwards: it is the recovery store for what the upgrade inherited.
  //
  // Each adoption is RECORDED in the snapshot — even one that adopted zero
  // domains — so "done" is a fact, not inferred from three nulls.
  //
  // SEED IS NOT SCHEMA. A schema for domain `d` describes records; every
  // listed project that binds `d` adopts it. Seed rows ARE records — one
  // project's typed data — so rows for `d` go to exactly one project: the sole
  // binder of `d`, else the last-opened if it binds `d`, else none (they stay
  // in the snapshot). Two projects on the default `tables` domain would
  // otherwise each store the other's rows.
  const last = current();
  if (getDefinition) await adoptLegacy({ db, storage, copy: getDefinition, last });

  await paint();
  // Reopen what this DEVICE had open — never a synced value, which would be
  // wrong on a second device.
  if (last) {
    const project = await openProject(db, last);
    if (project) setCanvas(canvasOf(project), { ...project, publication: (await publicationsOf(db, project.id))[0] ?? null });
  }
  return { persist, refresh: paint, openProjectId: current, published, adopt };
}
