// A Db that survives a reload, with the SAME surface as the SDK's.
//
// `new sdk.Db()` is in memory: a page reload loses every project. Projects have
// to outlive a reload before a node is connected, so this implements the same
// async surface over browser storage and `projects.js` runs against either
// without knowing which — the same move `publish.js` makes when it switches
// backends.
//
// **It is not a second database.** It stores what `projects.js` writes, in the
// same records, so moving a project onto the engine-backed db later is a copy
// rather than a translation. Where the two surfaces would differ they are made
// to agree deliberately:
//
//   - every method is async, because the engine-backed one is (sdk#87: a
//     surface that answers a promise on one backend and a value on the other
//     put `[object Promise]` in front of a person);
//   - ids are monotonic and opaque, never positional;
//   - `stats()` is synchronous and reports what THIS store holds.
//
// What it does NOT do is pretend to be a tree: `root()` is null, because there
// is no root here and a fabricated one would be a lie a version panel would
// print.

const now = () => Date.now();

export class LocalDb {
  #key;
  #state;
  #storage;

  constructor(storage = globalThis.localStorage, key = "craftec.builder.db.v1") {
    this.#storage = storage;
    this.#key = key;
    this.#state = this.#read();
  }

  #read() {
    try {
      const raw = this.#storage?.getItem(this.#key);
      if (raw) return JSON.parse(raw);
    } catch { /* private window, or corrupt: start clean rather than throw */ }
    return { schemas: {}, records: {}, seq: 0 };
  }

  #write() {
    try { this.#storage?.setItem(this.#key, JSON.stringify(this.#state)); } catch { /* full or refused */ }
  }

  #id() {
    this.#state.seq += 1;
    // Monotonic and opaque. Not an index: a positional id would make a future
    // key derived from it move when something before it is deleted.
    return `r${now().toString(36)}${this.#state.seq.toString(36)}`;
  }

  async define(domain, schema) {
    this.#state.schemas[domain] = schema;
    this.#state.records[domain] ??= {};
    this.#write();
  }

  async schema(domain) { return this.#state.schemas[domain] ?? null; }
  async domains() { return Object.keys(this.#state.schemas); }

  async put(domain, fields) {
    const id = this.#id();
    const rec = { id, created: now(), updated: now(), fields: { ...fields } };
    (this.#state.records[domain] ??= {})[id] = rec;
    this.#write();
    return structuredClone(rec);
  }

  async update(domain, id, patch) {
    const rec = this.#state.records[domain]?.[id];
    if (!rec) return null;
    rec.fields = { ...rec.fields, ...patch };
    rec.updated = now();
    this.#write();
    return structuredClone(rec);
  }

  async get(domain, id) {
    const rec = this.#state.records[domain]?.[id];
    return rec ? structuredClone(rec) : null;
  }

  async delete(domain, id) {
    const had = Boolean(this.#state.records[domain]?.[id]);
    if (had) { delete this.#state.records[domain][id]; this.#write(); }
    return had;
  }

  async scan(domain, { reverse = false, limit = 0 } = {}) {
    const all = Object.values(this.#state.records[domain] ?? {})
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const rows = reverse ? all.reverse() : all;
    return structuredClone(limit ? rows.slice(0, limit) : rows);
  }

  async count(domain) { return Object.keys(this.#state.records[domain] ?? {}).length; }

  /** There is no tree here, and saying so is better than inventing a root. */
  root() { return null; }

  stats() {
    const bytes = JSON.stringify(this.#state).length;
    const records = Object.values(this.#state.records).reduce((n, d) => n + Object.keys(d).length, 0);
    return { blocks: null, bytes, height: null, records };
  }
}
