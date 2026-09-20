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
// # WRITE COST IS NOT ONE OF THEM — measured, against the stated rationale
//
// The issue argues that "a whole-canvas record makes every property tweak a
// full-canvas rewrite". On this substrate that is FALSE, and the numbers are in
// `tests/projects.test.mjs`. One property tweak, blocks written:
//
//     components   prop bytes   per-component   whole-canvas   per-comp store
//             12           20               1              1         42,385 B
//            200           20               2              2        570,992 B
//            600          200               3              2      2,610,580 B
//
// Per-component never costs FEWER blocks, at 600 it costs more, and the store
// is 8-20x larger. The reason is that the tree's leaf is the write unit and is
// coarser than a record: a whole canvas is one value that re-chunks into a
// couple of blocks, while per-component records spread over many leaves and
// each carries its own overhead.
//
// So the shape is kept for CONFLICT, UNDO and READ granularity — which the
// neighbour test demonstrates directly — and NOT for write cost. Recording that
// here because the next person to read the issue will otherwise re-derive a
// justification the substrate does not support.
//
// # The key shape, and what the SDK can express today
//
// The issue specifies `d/project.component/<pid>‖<cid>` — a composite key, so
// one project's components are a RANGE. This SDK generates record ids and has
// no caller-chosen key, so a project's components carry `pid` as a FIELD and a
// read filters on it. The granularity — one record per component — is exactly
// as specified and is the part that is expensive to change; the key layout is
// an efficiency the SDK can grant later without migrating anything, because it
// does not change what a record IS.

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

/** Open a project: its record and its components, decoded. */
export async function openProject(db, pid) {
  const project = await db.get(PROJECT, pid);
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
export async function recordPublication(db, pid, { seq, app_contract_id, sdk_version, schema_block_ids = [], bundle_hash, source_root, published_at = Date.now() }) {
  return db.put(PUBLICATION, {
    pid, seq, app_contract_id, sdk_version,
    schema_block_ids: enc(schema_block_ids),
    bundle_hash, source_root, published_at,
  });
}

/** A project's publications, newest first. */
export async function publicationsOf(db, pid) {
  const all = await db.scan(PUBLICATION, { reverse: true });
  return all
    .filter(r => r.fields.pid === pid)
    .map(r => ({
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
