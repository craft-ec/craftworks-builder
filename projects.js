// Projects, as records — one per COMPONENT, not one per project.
//
// # Why the granularity is the decision
//
// A record is the unit of four different things at once, and they are the same
// unit whether anyone intended it or not:
//
//   - CONFLICT granularity — two devices editing one project collide per
//     record, so a whole-canvas record makes every concurrent edit a conflict.
//   - UNDO granularity — what can be put back without disturbing its
//     neighbours.
//   - READ granularity — what a reader must fetch to show one component.
//
// Changing it later means migrating every project that exists, which is why it
// is settled here rather than discovered.
//
// # WRITE COST IS NOT AN ARGUMENT EITHER WAY — measured twice, corrected once
//
// The issue argued that "a whole-canvas record makes every property tweak a
// full-canvas rewrite". My first comparison said the opposite and was WRONG: it
// built the whole-canvas record in ONE put while building the per-component
// store incrementally. A person adds components one at a time. Measured that
// way, with both sides incremental:
//
//     components   per-component   whole-canvas   winner
//              5        17,431 B        5,845 B    whole-canvas, 3x
//             20        62,814 B       61,695 B    a tie
//             60       171,402 B      494,375 B    per-component, 2.9x
//            200       676,536 B    5,269,655 B    per-component, 7.8x
//            600     2,636,352 B   54,110,709 B    per-component, 20x
//
//   - TWEAK COST IS A WASH: neither shape wins by more than a block. The
//     issue's original rationale is dead and does not come back in reverse.
//   - BUILDING HAS A CROSSOVER at about 25 components. Below it, whole-canvas
//     is up to 3x cheaper; above it, per-component wins and the gap grows
//     QUADRATICALLY, reaching 20x at 600.
//
// The shape is per-component (core dev, 2026-09-21) because the risk is
// asymmetric: whole-canvas saves at most a few tens of KB on a small canvas and
// costs 50 MB on a large one. A canvas only grows.
//
// # AND THE SLOPE ENDS IN A WALL — measured
//
// A record is capped at 262,144 bytes and there is no blob path behind it. A
// whole-canvas project does not merely get expensive, it becomes a REFUSED
// WRITE:
//
//     1,000 components   value 259,781 B   accepted
//     1,200 components   value 312,181 B   REFUSED
//
//     "record is 312248 bytes and the limit is 262144; store content this
//      large as a file or a blob and keep a reference to it"
//
// The advice in that message is not available: `freenet-prolly` has no blob
// machinery, and the doc comment promising one ("anything larger is a blob —
// manifest + chunks") describes something unbuilt (freenet-prolly#50). So the
// shape rejected here had a ceiling in it, not just a slope, and a project that
// reached it would be unable to save at all.
//
// # WHY whole-canvas goes quadratic — measured, not inferred
//
// The proposed explanation was that a map serialisation shifts bytes when one
// entry changes size, breaking content-defined chunk boundaries downstream so
// unchanged components stop deduping. That is REFUTED. At 600 components:
//
//     one version of the canvas          2 blocks
//     one add (600 -> 601)               2 NEW blocks, 156,428 bytes
//     blocks shared with the previous    0 of 2
//
// There are no chunk boundaries to break, because the canvas is never chunked.
// A record value over MAX_INLINE (1 KiB) is stored as ONE content-addressed
// block, so a 156 KB canvas is a single value block — and changing any byte of
// it produces an entirely new one. Dedup works at BLOCK granularity, and the
// value IS the block.
//
// That makes the cost inherent rather than an artefact: N adds each rewrite the
// whole value, so building is O(N^2) bytes, and it generalises to any growing
// collection stored as one value. The block COUNT stays flat at 2 while the
// bytes explode, which is why a blocks-only measurement misses it entirely.
//
// Conflict granularity is now a free bonus rather than the thing being paid
// for: two devices editing different components write different keys. It is
// still unrealisable until phase 6 — an engine does not adopt a head it did not
// write (craftworks-sdk#78).
//
// UNDO works from `changes_since` over the project's range either way. What a
// whole-canvas record would have cost is SELECTIVE undo, which is not phase 3.
//
// The assertions in `tests/projects.test.mjs` fail loudly if either result
// moves, so a change of substrate re-opens this deliberately rather than being
// rediscovered a third time.
//
export const PROJECT = "project";
export const COMPONENT = "project.component";
export const PUBLICATION = "project.publication";
export const DOMAIN = "project.domain";

/** Every domain a project lives in, with its schema. */
export const SCHEMAS = {
  [PROJECT]: {
    type: "Project",
    fields: [
      { name: "title", kind: "text", required: true },
      { name: "created", kind: "time" },
      { name: "updated", kind: "time" },
      { name: "builder_rev", kind: "text" },
      { name: "sdk_version", kind: "text" },
      // Stored from day one and shown READ-ONLY: the selector is phase 12, and
      // reserving the field now is what stops every project needing a
      // migration when it lands.
      { name: "root_binding", kind: "text" },
      { name: "visibility", kind: "text" },
      // Recorded whenever a project is duplicated from another.
      { name: "forked_from", kind: "text" },
      // WHAT A PROJECT IS MADE OF, beyond its components (builder#53). These
      // lived on one shared `app` object, so reopening Project 1 showed
      // whatever Project 2 last set. Appended, and optional: a project stored
      // before them opens as it did.
      { name: "tree", kind: "text" },       // the tree binding (realm, identity)
      { name: "versions", kind: "text" },   // the version stamp it was made with
    ],
  },
  [COMPONENT]: {
    type: "ProjectComponent",
    // KEYED UNDER THE PROJECT. A component's key is `<pid>‖<rkey>`, so one
    // project's components are a contiguous band and reading them is a bounded
    // prefix scan rather than a scan of every component of every project
    // (craftworks-sdk#122).
    parent: "pid",
    fields: [
      { name: "pid", kind: "text", required: true },
      { name: "kind", kind: "text", required: true },
      { name: "layout", kind: "text" },
      { name: "binding", kind: "text" },
      { name: "props", kind: "text" },
    ],
  },
  [PUBLICATION]: {
    type: "ProjectPublication",
    // Same shape: `nextSeq` reads a project's publications on every publish,
    // and did it by scanning all publications of all projects.
    parent: "pid",
    fields: [
      { name: "pid", kind: "text", required: true },
      { name: "seq", kind: "int", required: true },
      { name: "sdk_version", kind: "text" },
      { name: "schema_block_ids", kind: "text" },
      { name: "published_at", kind: "time" },
      { name: "source_root", kind: "text" },
    ],
  },
  // ONE RECORD PER (PROJECT, DOMAIN): that domain's schema and seed rows, for
  // this project. Two projects may use the same domain name with different
  // schemas — each has its own record, keyed under its own project, so neither
  // can read the other's (builder#53). A record per domain rather than one
  // field on the project, because a project's domains grow and a value that
  // grows is many records (ARCHITECTURE §5).
  [DOMAIN]: {
    type: "ProjectDomain",
    parent: "pid",
    fields: [
      { name: "pid", kind: "text", required: true },
      { name: "domain", kind: "text", required: true },
      { name: "schema", kind: "text" },
      { name: "seed", kind: "text" },
    ],
  },
};

/**
 * Until private domains exist (phase 7), everything here is publicly readable.
 * The UI says this in words on the project; the constant is here so the words
 * and the stored value cannot drift apart.
 */
export const PUBLIC_UNTIL_PHASE_7 = "public";

/** Define every domain a project needs. Safe to call more than once. */
export async function defineProjectDomains(db) {
  for (const [domain, schema] of Object.entries(SCHEMAS)) {
    await db.define(domain, schema);
  }
}

/** Structured values ride as JSON text, because a field kind is a scalar. */
const enc = v => (v === undefined || v === null ? null : JSON.stringify(v));
const dec = v => {
  if (v === undefined || v === null || v === "") return null;
  try { return JSON.parse(v); } catch { return null; }
};

/** A new project. Returns the stored record. */
export async function createProject(db, { title, builder_rev = null, sdk_version = null, forked_from = null, now = Date.now() } = {}) {
  return db.put(PROJECT, {
    title,
    created: now,
    updated: now,
    builder_rev,
    sdk_version,
    root_binding: "craftec://public/<you>/",
    visibility: PUBLIC_UNTIL_PHASE_7,
    forked_from: enc(forked_from),
  });
}

/** Every project, newest first — "browse my projects". */
export async function listProjects(db) {
  return db.scan(PROJECT, { reverse: true });
}

/**
 * The slot a stored id is re-created at.
 *
 * An id is self-describing by length: 32 hex is a bare record's own key, 64
 * is `parent ‖ key` in a domain keyed under a parent, and the parent is
 * re-derived from the fields — so the slot is the last half. A LocalDb id is
 * its own slot.
 */
const slotOfId = id => (/^[0-9a-f]{64}$/.test(id) ? id.slice(32) : id);

/** Put a project record back under ITS OWN id (builder#82). Never overwrites. */
export async function restoreProject(db, pid, fields) {
  return db.createAt(PROJECT, slotOfId(pid), fields);
}

/** Put one component back under ITS OWN id (builder#82). Never overwrites. */
export async function restoreComponent(db, pid, rid, { kind, layout = null, binding = null, props = null }) {
  return db.createAt(COMPONENT, slotOfId(rid), { pid, kind, layout: enc(layout), binding: enc(binding), props: enc(props) });
}

/** Add one component to a project. ONE record. */
export async function addComponent(db, pid, { kind, layout = null, binding = null, props = null }) {
  return db.put(COMPONENT, { pid, kind, layout: enc(layout), binding: enc(binding), props: enc(props) });
}

/**
 * A project's components, in stored order.
 *
 * A BOUNDED read of this project's band. It used to scan every component of
 * every project and filter by `pid`, which made `paint()` — which calls this
 * once per project row just to show a count — quadratic in the library.
 */
export async function componentsOf(db, pid) {
  return db.children(COMPONENT, pid);
}

/**
 * Change ONE property of ONE component.
 *
 * The whole point of the record shape: this writes one small record, not the
 * canvas. `tests/projects.test.mjs` measures it.
 */
export async function setComponentProps(db, componentId, props) {
  return db.update(COMPONENT, componentId, { props: enc(props) });
}

/** Remove one component. ONE record, and its neighbours are untouched. */
export async function removeComponent(db, componentId) {
  return db.delete(COMPONENT, componentId);
}

/**
 * What the builder keeps on a component, under ONE reserved name in its props:
 * `{ key, gen, by }`. `key` says which canvas component a record is; `gen`
 * counts that component's writes; `by` names the tab that made the write, so a
 * write's token `{ gen, by }` is unique to it (builder#74). Reserved, so a
 * component type with a `key` field of its own is never mistaken for it
 * (builder#49).
 */
export const BUILDER = "_builder";
const builderOf = r => dec(r.fields.props)?.[BUILDER] ?? {};

/**
 * For each component key, the record that IS that component (builder#49).
 *
 * Two records carry one key when an add landed but its answer was lost and a
 * later save's removal of it was refused, or when saves overlapped. The winner
 * has the highest generation, which every write of the component bumps.
 *
 * `gen` IS A PER-KEY WRITE COUNTER, NOT FRESHNESS. It chooses one record
 * deterministically, and it is a holder's base version. It does not say which
 * content is newest: with two tabs holding one project, the write with the
 * highest count was, before builder#74, a stale copy written back over the
 * other tab's edit. Newer is decided per holder, against its base. Not the larger id (that only ever meant "added later":
 * an update keeps the id) and not `updated` (a clock: on `LocalDb` both ids and
 * times are `Date.now()`, and a clock stepping back made the FRESH record lose
 * and the next save delete the edit — measured in review).
 *
 * Ties — equal generations, which only a genuine race produces — fall to
 * `updated`, then to the id. Those are not claims of freshness; they make the
 * choice DETERMINISTIC, so the same stored state resolves the same way on
 * every open and every device.
 */
export function recordPerComponentKey(records) {
  const winner = new Map();
  const rank = r => [builderOf(r).gen ?? 0, r.updated ?? 0, r.id];
  const beats = (a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  for (const r of records) {
    const key = componentKey(r);
    if (!key) continue;
    const had = winner.get(key);
    if (!had || beats(r, had)) winner.set(key, r);
  }
  return winner;
}

/**
 * One record per canvas component, as the load path shows them. Records with
 * no key (saved before keys existed) are each their own component and are
 * never collapsed.
 */
export function oneRecordPerComponent(records) {
  const winner = recordPerComponentKey(records);
  return records.filter(r => {
    const key = componentKey(r);
    return !key || winner.get(key) === r;
  });
}

/** Which canvas component a record is: the key `saveCanvas` stored, if any. */
export const componentKey = r => builderOf(r).key;

/** Open a project: its record and its components, decoded. */
export async function openProject(db, pid) {
  // The ids reaching here come from outside this module: a stale
  // `lastOpened` in device storage, a link, a project someone deleted on
  // another device. `db.get` answers null for an id it cannot address
  // (craftworks-sdk#118), so no catch: the catch that used to stand here also
  // turned a read that FAILED — a node out of reach — into "no such project",
  // and the builder opened an empty canvas as if the project were gone.
  const project = await db.get(PROJECT, pid);
  if (!project) return null;
  const components = oneRecordPerComponent(await componentsOf(db, pid)).map(r => ({
    id: r.id,
    kind: r.fields.kind,
    layout: dec(r.fields.layout),
    binding: dec(r.fields.binding),
    props: dec(r.fields.props),
  }));
  const schemas = {}, seed = {};
  const defs = await domainRecordsOf(db, pid);
  for (const r of defs) {
    const d = r.fields.domain;
    const sc = dec(r.fields.schema), sd = dec(r.fields.seed);
    if (sc) schemas[d] = sc;
    if (sd) seed[d] = sd;
  }
  return {
    id: project.id,
    // The stored record's fields, as they are: what a tab puts back if the
    // store is lost under it (builder#82). Never re-derived from the decoded
    // fields below, so a restore writes exactly what was there.
    record: { ...project.fields },
    title: project.fields.title,
    created: project.fields.created,
    updated: project.fields.updated,
    root_binding: project.fields.root_binding,
    visibility: project.fields.visibility,
    forked_from: dec(project.fields.forked_from),
    components,
    // The definition, as THIS project stored it. `null`/`{}` where it stored
    // nothing — never another project's.
    schemas,
    seed,
    tree: dec(project.fields.tree),
    versions: dec(project.fields.versions),
    // STORED BEFORE builder#53: nothing of its definition is with it. Its
    // schemas lived only in the builder's shared working copy, so opening it
    // with an empty definition and saving that back would DELETE them. The
    // caller decides what to adopt; see the panel's startup reopen.
    legacy: defs.length === 0 && project.fields.tree == null && project.fields.versions == null,
  };
}

/** A project's per-domain definition records (schema and seed per domain). */
export async function domainRecordsOf(db, pid) {
  return db.children(DOMAIN, pid);
}

/**
 * Save what a project is made of beyond its components: each domain's schema
 * and seed as its own record, the tree binding and version stamp on the project.
 *
 * A DIFF, like `saveCanvas`: a domain whose schema and seed are unchanged is
 * not written, a domain no longer defined loses its record, and the project
 * record is updated only if its binding or stamp moved. Returns what it did.
 */
export async function saveDefinition(db, pid, { schemas = {}, seed = {}, tree = null, versions = null } = {}) {
  const did = { added: 0, updated: 0, removed: 0, untouched: 0, project: false };
  const existing = new Map((await domainRecordsOf(db, pid)).map(r => [r.fields.domain, r]));
  const domains = new Set([...Object.keys(schemas), ...Object.keys(seed)]);
  for (const d of domains) {
    const want = { schema: enc(schemas[d] ?? null), seed: enc(seed[d] ?? null) };
    const rec = existing.get(d);
    if (!rec) {
      await db.put(DOMAIN, { pid, domain: d, ...want });
      did.added += 1;
    // `?? null` on the stored side: a field saved as null reads back ABSENT on
    // the SDK's Db (null removes it), and undefined !== null would rewrite an
    // unchanged record on every save.
    } else if ((rec.fields.schema ?? null) !== want.schema || (rec.fields.seed ?? null) !== want.seed) {
      await db.update(DOMAIN, rec.id, want);
      did.updated += 1;
    } else {
      did.untouched += 1;
    }
  }
  for (const [d, rec] of existing) {
    if (!domains.has(d)) { await db.delete(DOMAIN, rec.id); did.removed += 1; }
  }
  const p = await db.get(PROJECT, pid);
  const wantTree = enc(tree), wantVersions = enc(versions);
  if (p && ((p.fields.tree ?? null) !== wantTree || (p.fields.versions ?? null) !== wantVersions)) {
    await db.update(PROJECT, pid, { tree: wantTree, versions: wantVersions });
    did.project = true;
  }
  return did;
}

/** Record a publication of a project. History is these records (builder#26). */
/**
 * Open a project INTO something that holds a canvas, in the order that does not
 * lose data.
 *
 * The order is the whole function. Handing a canvas to the builder makes it
 * save, and saving writes into whichever project is currently open — so if the
 * open project is switched AFTER the handover, the project being left is
 * overwritten with the contents of the one being opened. Two projects, one
 * click, and the first is gone.
 *
 * So: switch first, hand over second. Extracted here rather than left inline in
 * the panel because it is the kind of ordering that reads as arbitrary and gets
 * "tidied" by the next person — and because a DOM is not needed to test it.
 */
export async function openInto(db, pid, { setLastOpened, handOver }) {
  const project = await openProject(db, pid);
  if (!project) return null;
  setLastOpened(pid);
  handOver(project);
  return project;
}

export async function recordPublication(db, pid, { seq, sdk_version = null, schema_block_ids = [], source_root = null, published_at = Date.now(), ...rest }) {
  // `bundle_hash` and `app_contract_id` are deliberately NOT recorded.
  // Publishing today connects to a node, provisions it and switches the
  // backend; it does not package the app, so there is no bundle and no app
  // address to record. They arrive with the builder half of
  // craftworks-sdk#108, and this record gains a FIELD then rather than being
  // rewritten.
  //
  // Writing them empty would be worse than leaving them out: an empty field
  // that later means something reads as "this publication had no bundle"
  // instead of "bundles did not exist yet", and every reader afterwards would
  // need to know which era a row came from to interpret it. So a caller that
  // tries is REFUSED rather than quietly storing a placeholder.
  for (const k of ["bundle_hash", "app_contract_id"]) {
    if (k in rest) throw new Error(`${k} cannot be recorded yet: apps carry no bundle until craftworks-sdk#108`);
  }
  return db.put(PUBLICATION, {
    pid, seq, sdk_version,
    schema_block_ids: enc(schema_block_ids),
    source_root, published_at,
  });
}

/** The next sequence number for a project's publications. */
export async function nextSeq(db, pid) {
  const hist = await publicationsOf(db, pid);
  return hist.length ? Math.max(...hist.map(h => h.seq ?? 0)) + 1 : 1;
}

/** A project's publications, newest first. */
export async function publicationsOf(db, pid) {
  const rows = await db.children(PUBLICATION, pid, { reverse: true });
  return rows
    .map(r => ({
      id: r.id,
      seq: r.fields.seq,
      sdk_version: r.fields.sdk_version,
      schema_block_ids: dec(r.fields.schema_block_ids) ?? [],
      source_root: r.fields.source_root,
      published_at: r.fields.published_at,
    }));
}

/**
 * DEVICE-scoped settings live in browser storage, never in the tree.
 *
 * "Last opened project" synced to a second device is wrong there, and a commit
 * per keystroke is not a setting. Identity-scoped settings (retention,
 * subscription budget, gateway) are tree records and are NOT these.
 */
export const DEVICE_SETTINGS_KEY = "craftec.builder.device.v1";

export function readDeviceSettings(storage) {
  try { return JSON.parse(storage.getItem(DEVICE_SETTINGS_KEY)) ?? {}; } catch { return {}; }
}

export function writeDeviceSettings(storage, patch) {
  const next = { ...readDeviceSettings(storage), ...patch };
  try { storage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(next)); } catch { /* private window */ }
  return next;
}
