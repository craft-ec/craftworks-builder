// AN APP'S DEFINITION, AS DATA IN ITS OWNER'S TREE (ARCHITECTURE §19, app-as-data P3).
//
// The builder's canvas is written, edit by edit, as records of the app's DRAFT, through the SDK's definition doors
// (`draftPut` / `draftDelete`: the only writes of the reserved domains). One record per thing an edit touches:
//
//   meta          { name, order: [component key…] }
//   c/<key>       { type, …the component's own fields }     one per canvas component; <key> is its canvas key
//   d/<domain>    { schema, seed }                           one per data domain the app declares
//
// Nothing here keeps a second copy of the definition: the canvas is what the person is editing, the draft is the
// tree's, and what differs between them is DERIVED on each sync. "Changed since publish" is the same derivation,
// draft against `craftworks.app` (`draftChanged`). There is no merge here either: two tabs or two devices of one
// identity write the same `c/<key>` records, and the SDK merges per record (rule 15).

/** Where the builder keeps a canvas component's identity, never stored in its record. */
export const BUILDER = "_builder";

/** A canvas component's key: its `c/<key>` in the draft. */
export const keyOf = c => c?.[BUILDER]?.key ?? null;

/** A new component key: random, so two devices never mint the same one (and within `c/<id>`'s rule). */
export const newKey = () => globalThis.crypto.randomUUID();

/** Give every canvas component a key, unique on the canvas: a repeated one (a copy) is a new component. */
export function keyed(components) {
  const seen = new Set();
  for (const c of components) {
    const k = keyOf(c);
    if (!k || seen.has(k)) c[BUILDER] = { key: newKey() };
    seen.add(keyOf(c));
  }
  return components;
}

/** One spelling of a body, whatever order its fields arrived in, so two equal bodies compare equal. */
export const canonical = v =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v ?? null)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;

/**
 * The draft records a canvas IS: `Map<key, body>`. Every component must be keyed (`keyed`) first.
 * A domain gets a record when the app declares a schema or a seed for it.
 */
export function recordsOf({ name = "", components = [], schemas = {}, seed = {} }) {
  const out = new Map();
  const order = [];
  for (const c of components) {
    const key = keyOf(c);
    if (!key) throw new Error("definition: a component with no key cannot be written; key the canvas first");
    const { [BUILDER]: _id, rid: _rid, ...fields } = c;
    out.set(`c/${key}`, fields);
    order.push(key);
  }
  out.set("meta", { name, order });
  for (const d of new Set([...Object.keys(schemas ?? {}), ...Object.keys(seed ?? {})])) {
    out.set(`d/${d}`, { schema: schemas?.[d] ?? null, seed: seed?.[d] ?? null });
  }
  return out;
}

/** A definition read back (`[{ key, body }]`, or a Map) as the canvas and declarations it describes. */
export function appOf(records) {
  const byKey = records instanceof Map ? records : new Map(records.map(r => [r.key, r.body]));
  const meta = byKey.get("meta") ?? {};
  const components = new Map();
  const schemas = {}, seed = {};
  for (const [k, body] of byKey) {
    if (k.startsWith("c/")) components.set(k.slice(2), body);
    else if (k.startsWith("d/")) {
      if (body?.schema != null) schemas[k.slice(2)] = body.schema;
      if (body?.seed != null) seed[k.slice(2)] = body.seed;
    }
  }
  // meta's order first; a component it does not name (another device added it and its meta write is not here
  // yet) after, by key, so every open of the same records shows the same canvas.
  const order = [...(Array.isArray(meta.order) ? meta.order : []).filter(k => components.has(k))];
  const named = new Set(order);
  order.push(...[...components.keys()].filter(k => !named.has(k)).sort());
  return {
    name: typeof meta.name === "string" ? meta.name : "",
    components: order.map(k => ({ ...components.get(k), [BUILDER]: { key: k } })),
    schemas,
    seed,
  };
}

/** What turns `from` into `to`: `{ put: [[key, body]…], del: [key…] }`, bodies compared canonically. */
export function diff(from, to) {
  const put = [], del = [];
  for (const [k, body] of to) if (!from.has(k) || canonical(from.get(k)) !== canonical(body)) put.push([k, body]);
  for (const k of from.keys()) if (!to.has(k)) del.push(k);
  return { put, del };
}

const asMap = rs => new Map(rs.map(r => [r.key, r.body]));

/** Does the draft differ from the published definition? Derived from both, every time (`publishedApp` is gone). */
export async function draftChanged(db) {
  const [draft, app] = await Promise.all([db.definition("draft"), db.definition("app")]);
  const { put, del } = diff(asMap(app), asMap(draft));
  return put.length + del.length > 0;
}

/** The draft as it stands: `Map<key, body>`. */
export const readDraft = async db => asMap(await db.definition("draft"));

/**
 * THE DRAFT WRITER: one per open project. The canvas is edited at once; `sync(app)` records what the draft must
 * become, and the writer makes it so through the doors, writing the LATEST body per key.
 *
 * It WAITS for the owner's tree (rule 9: no cap, no deadline): until `attach(db)` hands it the session's db, every
 * change is held and `state()` says so; a person sees "not saved yet: waiting for your node". Once attached, it
 * writes the difference between what the canvas is and what the draft holds (`base`, read from the tree when it
 * attaches, then kept as it writes). A write the SDK refuses ends the pass with its reason; the next `sync` tries
 * again. Nothing here times anything out.
 */
export function draftWriter({ onState = () => {}, now = () => Date.now() } = {}) {
  let db = null;
  let base = null;            // what the draft holds, as far as this writer knows
  let want = null;            // what the canvas says the draft must be
  let running = null;         // the write pass in flight
  let error = null;
  let waitingSince = null;
  let disposed = false;

  const pending = () => (want && base ? (({ put, del }) => put.length + del.length)(diff(base, want)) : want ? 1 : 0);
  const state = () => ({
    attached: Boolean(db),
    pending: pending(),
    waitingSince: db ? null : waitingSince,
    error,
  });
  const tell = () => { if (!disposed) onState(state()); };

  async function pass() {
    // The latest `want` is re-read after every write, so an edit made while a write is in flight is written next,
    // and a key changed twice is written once with its last body.
    for (;;) {
      if (disposed || !db || !want) return;
      const { put, del } = diff(base, want);
      const next = put[0] ?? (del.length ? [del[0], undefined] : null);
      if (!next) return;
      const [key, body] = next;
      if (body === undefined) await db.draftDelete(key);
      else await db.draftPut(key, body);
      if (disposed) return;
      if (body === undefined) base.delete(key); else base.set(key, body);
      error = null;
      tell();
    }
  }

  function kick() {
    if (running || disposed || !db) return running;
    running = pass().catch(e => { error = String(e?.message ?? e); }).finally(() => { running = null; tell(); });
    return running;
  }

  return {
    state,
    /** The canvas as it now is. Written when the tree is attached; held until then. */
    sync(app) {
      if (disposed) return null;
      want = recordsOf(app);
      if (!db && waitingSince === null) waitingSince = now();
      tell();
      return kick();
    },
    /**
     * The owner's tree is open: read what its draft holds, and write what the canvas says. Resolves to the draft as
     * it was read (`Map<key, body>`), before anything was written, for a canvas that is to show it.
     */
    async attach(treeDb) {
      if (disposed) return null;
      const held = await readDraft(treeDb);
      if (disposed) return null;
      db = treeDb;
      base = new Map(held);
      waitingSince = null;
      tell();
      await kick();
      return held;
    },
    /**
     * THE TREE MOVED UNDER THIS TAB (rule 15: another session's write won, and the loser reloads): `held` is the
     * draft as the tree now has it. Every key this writer is NOT still holding an edit for takes the tree's version;
     * a key it holds keeps this tab's edit, and is written again. Returns the canvas the merged draft describes, or
     * null when nothing the canvas shows changed. The base becomes the tree's, so nothing stale is written back.
     */
    rebase(held) {
      if (disposed || !db) return null;
      const merged = new Map(held);
      if (want) {
        const { put, del } = diff(base, want);
        for (const [k, body] of put) merged.set(k, body);
        for (const k of del) merged.delete(k);
      }
      const before = want ?? base;
      base = new Map(held);
      want = merged;
      const moved = diff(before, merged);
      tell();
      kick();
      return moved.put.length + moved.del.length ? appOf(merged) : null;
    },
    /** Resolves when nothing is being written (it may still be holding changes for a tree not attached). */
    async idle() { while (running) await running; },
    dispose() { disposed = true; db = null; },
  };
}
