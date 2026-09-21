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
    ],
  },
  [COMPONENT]: {
    type: "ProjectComponent",
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
    fields: [
      { name: "pid", kind: "text", required: true },
      { name: "seq", kind: "int", required: true },
      { name: "sdk_version", kind: "text" },
      { name: "schema_block_ids", kind: "text" },
      { name: "published_at", kind: "time" },
      { name: "source_root", kind: "text" },
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

/** Add one component to a project. ONE record. */
export async function addComponent(db, pid, { kind, layout = null, binding = null, props = null }) {
  return db.put(COMPONENT, { pid, kind, layout: enc(layout), binding: enc(binding), props: enc(props) });
}

/** A project's components, in stored order. */
export async function componentsOf(db, pid) {
  const all = await db.scan(COMPONENT);
  return all.filter(r => r.fields.pid === pid);
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

/** Open a project: its record and its components, decoded. */
export async function openProject(db, pid) {
  // `db.get` THROWS on an id it cannot parse rather than answering "not
  // found", and the ids reaching here come from outside this module: a stale
  // `lastOpened` in device storage, a link, a project someone deleted on
  // another device. A builder that cannot open its last project should show an
  // empty canvas, not fail to start.
  let project = null;
  try { project = await db.get(PROJECT, pid); } catch { return null; }
  if (!project) return null;
  const components = (await componentsOf(db, pid)).map(r => ({
    id: r.id,
    kind: r.fields.kind,
    layout: dec(r.fields.layout),
    binding: dec(r.fields.binding),
    props: dec(r.fields.props),
  }));
  return {
    id: project.id,
    title: project.fields.title,
    created: project.fields.created,
    updated: project.fields.updated,
    root_binding: project.fields.root_binding,
    visibility: project.fields.visibility,
    forked_from: dec(project.fields.forked_from),
    components,
  };
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
  const all = await db.scan(PUBLICATION, { reverse: true });
  return all
    .filter(r => r.fields.pid === pid)
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
