// Projects as records — ONE record per project, whose canvas is a MAP KEYED BY
// COMPONENT ID.
//
// # The decision, and the measurement behind it
//
// The issue specified one record per COMPONENT, because record granularity is
// conflict, undo, write-cost and read granularity at once. I measured the
// write-cost leg before building it — and then had to measure it AGAIN,
// because my first comparison was not apples-to-apples.
//
// **The first table was wrong and is recorded here so nobody quotes it.** It
// built the whole-canvas record in ONE put while building the per-component
// store incrementally, and concluded that per-component cost 8-20x more
// storage. A person adds components one at a time, and each add rewrites the
// whole canvas value. Measured that way the storage result REVERSES:
//
//     components   building: per-component   building: whole-canvas   one tweak
//             12                  13,733 B                 27,217 B     1 vs 2
//            200                 514,648 B              2,583,797 B     2 vs 2
//            600               2,636,352 B             54,110,709 B     3 vs 2
//
// What the corrected numbers say:
//
//   - TWEAK COST IS A WASH. Whole-canvas costs more at 12 components and fewer
//     at 600; neither wins consistently and both stay within one block. So
//     write-cost-per-edit argues for NEITHER shape. That is what killed the
//     issue's original rationale, and it does not resurrect it in reverse.
//   - BUILDING costs whole-canvas 2-22x MORE STORAGE, at every size measured,
//     because every add rewrites the whole value and the superseded versions
//     stay in the store.
//
// The shape here is nonetheless ONE RECORD PER PROJECT (core dev, 2026-09-21),
// decided on the remaining legs rather than on storage:
//
//   - CONFLICT is per-component's real structural win — two devices editing
//     different components write different keys and merge cleanly. But two
//     devices on one project is phase 6 and the substrate does not exist: an
//     engine does not adopt a head it did not write (craftworks-sdk#78). It
//     buys a merge that cannot happen yet.
//   - READ favours whole-canvas for the common case: the builder loads the
//     whole canvas to render it, one value rather than an N-record scan.
//
// **The storage leg was part of that decision and is now refuted by the
// corrected table above.** It is flagged to the core dev rather than quietly
// left in place. The assertions in `tests/projects.test.mjs` fail if either
// result moves, so a change of substrate re-opens this deliberately.
//
// UNDO works from `changes_since` over the project's range either way. What
// whole-canvas costs is SELECTIVE undo — putting back one component's change
// from five edits ago. We do not have that, it is not in phase 3, and it is not
// worth paying for now.
//
// # The hedge, which costs nothing
//
// The canvas is a MAP KEYED BY COMPONENT ID, never an array. Splitting into
// per-component records later is then a RE-CHUNK rather than a RE-KEY: every
// component already has a stable identity that a future key can be built from,
// and no project needs its components renamed or renumbered. That is the
// expensive part of the architect's warning, and this neutralises it.
//
// So a future split is a considered change with this note in front of it,
// rather than a rediscovery.

export const PROJECT = "project";
export const PUBLICATION = "project.publication";

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
      { name: "forked_from", kind: "text" },
      // The canvas: a map of component id -> component. See the hedge above.
      { name: "components", kind: "text" },
    ],
  },
  [PUBLICATION]: {
    type: "ProjectPublication",
    fields: [
      { name: "pid", kind: "text", required: true },
      { name: "seq", kind: "int", required: true },
      { name: "app_contract_id", kind: "text" },
      { name: "sdk_version", kind: "text" },
      { name: "schema_block_ids", kind: "text" },
      { name: "bundle_hash", kind: "text" },
      { name: "published_at", kind: "time" },
      { name: "source_root", kind: "text" },
    ],
  },
};

/**
 * Until private domains exist (phase 7), everything here is publicly readable.
 * The UI says this in words; the constant is here so the words and the stored
 * value cannot drift apart.
 */
export const PUBLIC_UNTIL_PHASE_7 = "public";

export async function defineProjectDomains(db) {
  for (const [domain, schema] of Object.entries(SCHEMAS)) await db.define(domain, schema);
}

const enc = v => (v === undefined || v === null ? null : JSON.stringify(v));
const dec = v => {
  if (v === undefined || v === null || v === "") return null;
  try { return JSON.parse(v); } catch { return null; }
};

/**
 * A component id that is stable for the life of the component.
 *
 * Stable is the whole point of the hedge: a future per-component key is built
 * FROM this, so it must not be a position or an index. Monotonic and unique
 * within a project is enough.
 */
export const componentId = (n, seed = Date.now()) => `c${seed.toString(36)}${n.toString(36)}`;

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
    components: enc({}),
  });
}

/** Every project, newest first — "browse my projects". */
export const listProjects = db => db.scan(PROJECT, { reverse: true });

/** One project, decoded, with its canvas as a map. */
export async function openProject(db, pid) {
  const r = await db.get(PROJECT, pid);
  if (!r) return null;
  return {
    id: r.id,
    title: r.fields.title,
    created: r.fields.created,
    updated: r.fields.updated,
    builder_rev: r.fields.builder_rev,
    sdk_version: r.fields.sdk_version,
    root_binding: r.fields.root_binding,
    visibility: r.fields.visibility,
    forked_from: dec(r.fields.forked_from),
    components: dec(r.fields.components) ?? {},
  };
}

/** The canvas as it is stored, for callers that only need to change it. */
async function canvasOf(db, pid) {
  const r = await db.get(PROJECT, pid);
  if (!r) throw new Error(`no project ${pid}`);
  return dec(r.fields.components) ?? {};
}

/** Add one component. Returns its id, which is stable for its life. */
export async function addComponent(db, pid, { kind, layout = null, binding = null, props = null }, id = null) {
  const canvas = await canvasOf(db, pid);
  const cid = id ?? componentId(Object.keys(canvas).length);
  canvas[cid] = { kind, layout, binding, props };
  await db.update(PROJECT, pid, { components: enc(canvas), updated: Date.now() });
  return cid;
}

/**
 * Change ONE component's props, by id.
 *
 * The map is what makes this addressable: the caller names a component, never a
 * position, so the same call works unchanged if the canvas is later split into
 * per-component records.
 */
export async function setComponentProps(db, pid, cid, props) {
  const canvas = await canvasOf(db, pid);
  if (!canvas[cid]) throw new Error(`no component ${cid} in ${pid}`);
  canvas[cid] = { ...canvas[cid], props };
  return db.update(PROJECT, pid, { components: enc(canvas), updated: Date.now() });
}

export async function removeComponent(db, pid, cid) {
  const canvas = await canvasOf(db, pid);
  delete canvas[cid];
  return db.update(PROJECT, pid, { components: enc(canvas), updated: Date.now() });
}

/** Record a publication. History is these records (builder#26). */
export async function recordPublication(db, pid, { seq, app_contract_id, sdk_version = null, schema_block_ids = [], bundle_hash, source_root, published_at = Date.now() }) {
  return db.put(PUBLICATION, {
    pid, seq, app_contract_id, sdk_version,
    schema_block_ids: enc(schema_block_ids),
    bundle_hash, source_root, published_at,
  });
}

/** A project's publications, newest first. */
export async function publicationsOf(db, pid) {
  const all = await db.scan(PUBLICATION, { reverse: true });
  return all.filter(r => r.fields.pid === pid).map(r => ({
    id: r.id,
    seq: r.fields.seq,
    app_contract_id: r.fields.app_contract_id,
    sdk_version: r.fields.sdk_version,
    schema_block_ids: dec(r.fields.schema_block_ids) ?? [],
    bundle_hash: r.fields.bundle_hash,
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
