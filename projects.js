// THIS DEVICE'S LIST OF PROJECTS, and each project's publication history.
//
// A project's DEFINITION is not here: it is records of the app's draft in its owner's tree (`definition.js`,
// ARCHITECTURE §19), written through the SDK's doors, one record per component. The one-record-per-component shape
// was measured here first (whole-canvas records cost up to 20x at 600 components and hit the 256 KiB record wall at
// ~1,200; builder `projects.js` before §19 P3); it is now the SDK's by type (`DefKey`: `meta`, `c/<id>`, `d/<domain>`).
//
// What stays on the device is what IDENTIFIES a project — its id (its app's id derives from it), when it was made,
// what it was forked from, its tree binding and version stamp — and what it has published. Not its NAME: that is the
// draft's `meta.name` (rule 3), read for the list through the normal read.
export const PROJECT = "project";
export const PUBLICATION = "project.publication";

/** Every domain a project lives in, with its schema. */
export const SCHEMAS = {
  [PROJECT]: {
    type: "Project",
    fields: [
      { name: "created", kind: "time" },
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
      // What was PUT (builder#104): the bundle's hash, the app's address (its
      // web container's key, served at /v1/contract/web/<address>/), and the
      // head its data is read from. All three or none.
      { name: "bundle_hash", kind: "text" },
      { name: "app_contract_id", kind: "text" },
      { name: "head", kind: "text" },
      // The seq of that head when the app was PUT (craftworks-sdk#349): the
      // version its app.json names, which a view reads no older than.
      { name: "head_seq", kind: "int" },
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

/** A new project. Returns the stored record. Its name is its draft's (`meta.name`), not this record's. */
export async function createProject(db, { builder_rev = null, sdk_version = null, forked_from = null, now = Date.now() } = {}) {
  return db.put(PROJECT, {
    created: now,
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

/** Open a project: what this device holds of it. Its definition is its draft (`definition.js`). */
export async function openProject(db, pid) {
  // The ids reaching here come from outside this module: a stale `lastOpened` in device storage, a link. `db.get`
  // answers null for an id it cannot address (craftworks-sdk#118), so no catch: a read that FAILED is not "no such
  // project".
  const project = await db.get(PROJECT, pid);
  if (!project) return null;
  return {
    id: project.id,
    created: project.fields.created,
    root_binding: project.fields.root_binding,
    visibility: project.fields.visibility,
    forked_from: dec(project.fields.forked_from),
    tree: dec(project.fields.tree),
    versions: dec(project.fields.versions),
  };
}

/** Keep a project's tree binding and version stamp, if either moved. Returns whether it wrote. */
export async function saveProjectMeta(db, pid, { tree = null, versions = null } = {}) {
  const p = await db.get(PROJECT, pid);
  const wantTree = enc(tree), wantVersions = enc(versions);
  if (!p || ((p.fields.tree ?? null) === wantTree && (p.fields.versions ?? null) === wantVersions)) return false;
  await db.update(PROJECT, pid, { tree: wantTree, versions: wantVersions });
  return true;
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

export async function recordPublication(db, pid, { seq, sdk_version = null, schema_block_ids = [], source_root = null, published_at = Date.now(), bundle_hash = null, app_contract_id = null, head = null, head_seq = null, ...rest }) {
  // WHAT WAS PUT, all three or none (builder#104). A bundle hash with no
  // address is a publication nobody can open, and an address with no head
  // opens onto no data; recording half would read as a complete one. A row
  // from before apps were packaged simply has none of them.
  const put = [bundle_hash, app_contract_id, head];
  if (put.some(v => v !== null) && put.some(v => v === null)) {
    throw new Error("a publication records its bundle_hash, app_contract_id and head together, or none of them");
  }
  for (const k of Object.keys(rest)) throw new Error(`${k} is not a field a publication records`);
  return db.put(PUBLICATION, {
    pid, seq, sdk_version,
    schema_block_ids: enc(schema_block_ids),
    source_root, published_at,
    ...(bundle_hash === null ? {} : { bundle_hash, app_contract_id, head }),
    ...(head_seq === null ? {} : { head_seq }),
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
      bundle_hash: r.fields.bundle_hash ?? null,
      app_contract_id: r.fields.app_contract_id ?? null,
      head: r.fields.head ?? null,
      head_seq: r.fields.head_seq ?? null,
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
