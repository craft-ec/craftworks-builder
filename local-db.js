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
//
// ONE KEY PER RECORD (builder#55). This used to keep the whole database in one
// storage key, read it once in the constructor, and rewrite ALL of it on every
// write. Two tabs therefore each held a snapshot and each wrote the whole of
// theirs back: the second tab's save of project B erased the first tab's save
// of project A, with no overlapping writes and no failure anywhere. Rereading
// before writing would only narrow that window — browsers propagate storage
// between tabs asynchronously, so a whole-blob read-modify-write can still
// lose a write made a moment earlier.
//
// So the unit of storage is the unit of change: every record and every
// domain's schema is its own key, `setItem` on one key is atomic, and two tabs
// editing different projects write different keys and cannot overwrite each
// other. Every read goes to storage, never to a snapshot, so a tab sees what
// another tab saved. Two tabs editing the SAME record still race, but they
// race on that record's fields, merged over what is stored now rather than
// over what this tab read at load.
//
// A WRITE THAT STORAGE REFUSES REJECTS (builder#56). It used to be swallowed:
// `put` resolved, `count` said 1, and a reload said 0 — a full quota or denied
// storage turned every save into a silent loss. Now nothing stored changes
// unless storage accepted it, and the caller gets `NotSaved` with the reason,
// so the person's in-memory work (the canvas) stays put and the UI can say it
// is unsaved.

const now = () => Date.now();

/** A durable write the browser refused. Nothing stored changed. */
export class NotSaved extends Error {
  constructor(what, cause) {
    super(`not saved: ${what} — ${cause?.name ?? "Error"}: ${cause?.message ?? cause}`);
    this.name = "NotSaved";
    this.cause = cause;
  }
}

export class LocalDb {
  #storage;
  #ns;
  #legacy;
  #tag;
  #seq = 0;

  constructor(storage = globalThis.localStorage, key = "craftec.builder.db.v1") {
    this.#storage = storage;
    // The old single-blob key doubles as the namespace, so two LocalDbs over
    // different keys stay apart exactly as they did.
    this.#legacy = key;
    this.#ns = `${key}/`;
    // Per INSTANCE, so two tabs minting an id in the same millisecond cannot
    // mint the same one. Opaque, like the rest of the id.
    this.#tag = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
    this.#migrate();
  }

  // ---- keys ----------------------------------------------------------------
  // The domain is ENCODED, so no domain name can contain the separator: a
  // domain "a/b" would otherwise sit inside domain "a"'s prefix and show up in
  // its scans.
  #schemaKey(d) { return `${this.#ns}s/${encodeURIComponent(d)}`; }
  #recordKey(d, id) { return `${this.#ns}r/${encodeURIComponent(d)}/${id}`; }
  #recordPrefix(d) { return `${this.#ns}r/${encodeURIComponent(d)}/`; }

  #get(key) {
    try {
      const raw = this.#storage?.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch { return null; /* private window, or corrupt: absent rather than a throw */ }
  }

  #set(key, value, what) {
    try { this.#storage.setItem(key, JSON.stringify(value)); }
    catch (e) { throw new NotSaved(what, e); }
  }

  /** Every key in storage starting with `prefix`. */
  #keys(prefix) {
    const out = [];
    const s = this.#storage;
    if (!s) return out;
    try {
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i);
        if (k != null && k.startsWith(prefix)) out.push(k);
      }
    } catch { /* storage unavailable: nothing to enumerate */ }
    return out;
  }

  /**
   * The single-blob format, split into per-key entries — ONCE, and the blob is
   * removed only after every entry was written. A write refused halfway leaves
   * the blob in place, and the next load tries again; entries already written
   * are rewritten with the same content, so a retry cannot double anything.
   */
  #migrate() {
    const old = this.#get(this.#legacy);
    if (!old || typeof old !== "object") return;
    try {
      for (const [d, schema] of Object.entries(old.schemas ?? {})) this.#set(this.#schemaKey(d), schema, `schema ${d}`);
      for (const [d, recs] of Object.entries(old.records ?? {})) {
        for (const [id, rec] of Object.entries(recs)) this.#set(this.#recordKey(d, id), rec, `record ${d}/${id}`);
      }
      this.#storage.removeItem(this.#legacy);
    } catch { /* stays in the old format until a load where storage accepts it */ }
  }

  #id() {
    this.#seq += 1;
    // Monotonic within this instance and time-ordered across them. Not an
    // index: a positional id would make a future key derived from it move when
    // something before it is deleted.
    return `r${now().toString(36)}${this.#tag}${this.#seq.toString(36).padStart(4, "0")}`;
  }

  // ---- the surface -----------------------------------------------------------
  async define(domain, schema) {
    this.#set(this.#schemaKey(domain), schema, `schema ${domain}`);
  }

  async schema(domain) { return this.#get(this.#schemaKey(domain)); }

  async domains() {
    const p = `${this.#ns}s/`;
    return this.#keys(p).map(k => decodeURIComponent(k.slice(p.length)));
  }

  async put(domain, fields) {
    const id = this.#id();
    const rec = { id, created: now(), updated: now(), fields: { ...fields } };
    this.#set(this.#recordKey(domain, id), rec, `${domain} record`);
    return structuredClone(rec);
  }

  async update(domain, id, patch) {
    // Over what is stored NOW, so a field another tab changed since this tab
    // loaded is kept unless this patch names it.
    const rec = this.#get(this.#recordKey(domain, id));
    if (!rec) return null;
    const next = { ...rec, fields: { ...rec.fields, ...patch }, updated: now() };
    this.#set(this.#recordKey(domain, id), next, `${domain} record ${id}`);
    return structuredClone(next);
  }

  async get(domain, id) { return this.#get(this.#recordKey(domain, id)); }

  async delete(domain, id) {
    const key = this.#recordKey(domain, id);
    if (this.#get(key) == null) return false;
    try { this.#storage.removeItem(key); }
    catch (e) { throw new NotSaved(`delete ${domain}/${id}`, e); }
    return true;
  }

  async scan(domain, { reverse = false, limit = 0 } = {}) {
    const all = this.#keys(this.#recordPrefix(domain))
      .map(k => this.#get(k))
      .filter(Boolean)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const rows = reverse ? all.reverse() : all;
    return limit ? rows.slice(0, limit) : rows;
  }

  /**
   * The children of one parent, for a domain whose schema declares one.
   *
   * The same call the SDK's `Db` answers, because `projects.js` uses it for
   * `componentsOf` and `publicationsOf` and runs against either backend. When
   * #59 made that switch, LocalDb had no such method — so every save and every
   * paint of the projects panel threw `db.children is not a function`, hidden
   * by the `.catch(() => {})` that #56 removes. This is the backend the page
   * actually keeps projects on; the switch was measured over the SDK's.
   *
   * Honest about its cost: `localStorage` has no range read, so this is a
   * filter over THIS domain's keys, not a band read. It does not grow with
   * other domains; within a domain it is what a scan costs.
   *
   * A domain that declares no parent is refused, as the SDK refuses it:
   * "none" and "the question does not apply here" are different answers.
   */
  async children(domain, parent, { reverse = false, limit = 0, after = "" } = {}) {
    const schema = this.#get(this.#schemaKey(domain));
    const field = schema?.parent;
    if (!field) {
      throw new Error(`domain \`${domain}\` does not declare a parent, so it has no children to read`);
    }
    let rows = (await this.scan(domain)).filter(r => r.fields?.[field] === parent);
    if (reverse) rows.reverse();
    if (after) {
      const i = rows.findIndex(r => r.id === after);
      rows = i < 0 ? rows : rows.slice(i + 1);
    }
    return limit ? rows.slice(0, limit) : rows;
  }

  async count(domain) { return this.#keys(this.#recordPrefix(domain)).length; }

  /** There is no tree here, and saying so is better than inventing a root. */
  root() { return null; }

  stats() {
    let bytes = 0;
    for (const k of this.#keys(this.#ns)) bytes += (this.#storage.getItem(k) ?? "").length;
    return { blocks: null, bytes, height: null, records: this.#keys(`${this.#ns}r/`).length };
  }
}
