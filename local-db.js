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
  #onNotice;
  /**
   * Things a person can act on that are not errors of any one call: another
   * tab running an older builder, a legacy store that cannot be read. Each is
   * `{ kind, message }`; `onNotice` hears each as it is added.
   */
  notices = [];

  constructor(storage = globalThis.localStorage, key = "craftec.builder.db.v1", { onNotice } = {}) {
    this.#storage = storage;
    // The old single-blob key doubles as the namespace, so two LocalDbs over
    // different keys stay apart exactly as they did.
    this.#legacy = key;
    this.#ns = `${key}/`;
    this.#onNotice = onNotice;
    // Per INSTANCE, so two tabs minting an id in the same millisecond cannot
    // mint the same one. Opaque, like the rest of the id.
    this.#tag = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
    this.#migrate();
    // An older tab rewrites the blob on ANY edit it makes. The `storage` event
    // fires in the other tabs of this origin, so its writes are merged here as
    // they happen rather than only at the next load.
    globalThis.addEventListener?.("storage", e => {
      if (e.storageArea === this.#storage && e.key === this.#legacy && e.newValue != null) this.#migrate();
    });
  }

  #notice(kind, message) {
    if (this.notices.some(n => n.kind === kind)) return;
    const n = { kind, message };
    this.notices.push(n);
    // NO DEFAULT (builder#73). `() => {}` swallowed exactly the things a person
    // must hear — another tab on an older builder, a store that cannot be read
    // — so a store built with no one to tell FAILS at the notice, naming it,
    // rather than keeping it to itself. Most stores never raise one, so most
    // callers never need to pass it.
    if (typeof this.#onNotice !== "function") {
      throw new Error(`LocalDb: a notice with no \`onNotice\` to tell the person — ${kind}: ${message}`);
    }
    try { this.#onNotice(n); } catch { /* a listener's failure is not the store's */ }
  }

  // ---- keys ----------------------------------------------------------------
  // The domain is ENCODED, so no domain name can contain the separator: a
  // domain "a/b" would otherwise sit inside domain "a"'s prefix and show up in
  // its scans.
  #schemaKey(d) { return `${this.#ns}s/${encodeURIComponent(d)}`; }
  #recordKey(d, id) { return `${this.#ns}r/${encodeURIComponent(d)}/${id}`; }
  #recordPrefix(d) { return `${this.#ns}r/${encodeURIComponent(d)}/`; }
  // When a record was deleted. Without it, a record deleted here is simply
  // ABSENT per-key and present in a resurrected blob, and "fill if absent"
  // would bring it back.
  #tombKey(d, id) { return `${this.#ns}t/${encodeURIComponent(d)}/${id}`; }
  // Set once the single-blob store has been split. A blob seen AFTER it was
  // not a first load: an older tab wrote it back.
  get #markerKey() { return `${this.#ns}migrated`; }

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
   * The single-blob store, merged into per-key entries.
   *
   * FILL, NEVER OVERWRITE. A tab opened before the deploy still runs the old
   * LocalDb and rewrites its whole stale snapshot into the blob on any edit,
   * so the blob can come BACK after it was migrated. The first version of this
   * wrote every blob record over its per-key entry on every load, and so
   * reverted an edit made here the moment the old tab touched anything —
   * builder#55 reintroduced by the migration away from its cause (found in
   * review of builder#66). Now a blob record is written only when:
   *   - there is no per-key entry and no tombstone for it (a first load, or a
   *     record the old tab created), or
   *   - its `updated` is STRICTLY newer than the entry's, or than the
   *     tombstone's — an edit genuinely made in the old tab, which is a
   *     person's work and is kept.
   * Anything older loses, so a stale snapshot cannot undo a newer edit or
   * resurrect a deleted record.
   *
   * The blob is removed only after every entry was written: a refusal halfway
   * keeps the only complete copy, and the next load finishes it. A blob that
   * appears after the `migrated` marker is reported, and one that cannot be
   * parsed is KEPT and reported rather than read as "no blob".
   */
  #migrate() {
    let raw;
    try { raw = this.#storage?.getItem(this.#legacy); } catch { return; }
    if (raw == null) return;
    let old;
    try { old = JSON.parse(raw); } catch { old = null; }
    if (!old || typeof old !== "object") {
      this.#notice("unreadable-legacy",
        "Projects saved by an older version of the builder could not be read; they have been left in place, not deleted.");
      return;
    }
    const resurrected = this.#get(this.#markerKey) != null;
    try {
      for (const [d, schema] of Object.entries(old.schemas ?? {})) {
        if (this.#get(this.#schemaKey(d)) == null) this.#set(this.#schemaKey(d), schema, `schema ${d}`);
      }
      for (const [d, recs] of Object.entries(old.records ?? {})) {
        for (const [id, rec] of Object.entries(recs)) {
          const have = this.#get(this.#recordKey(d, id));
          const tomb = this.#get(this.#tombKey(d, id));
          const floor = Math.max(have?.updated ?? -Infinity, tomb?.at ?? -Infinity);
          // NOTHING HERE YET is its own branch (builder#68): with no entry and
          // no tombstone the record is written whatever it carries. Folded into
          // the comparison, a record with no `updated` read `-Infinity >
          // -Infinity`, was not written — and the blob was then removed.
          const first = have == null && tomb == null;
          if (first || (rec?.updated ?? -Infinity) > floor) this.#set(this.#recordKey(d, id), rec, `record ${d}/${id}`);
        }
      }
      if (!resurrected) this.#set(this.#markerKey, { at: now() }, "migration marker");
      this.#storage.removeItem(this.#legacy);
    } catch { return; /* stays in the old format until a load where storage accepts it */ }
    if (resurrected) {
      this.#notice("older-tab",
        "Another tab is running an older version of the builder. Its edits were merged, but reload that tab so it stops writing the old format.");
    }
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

  /**
   * Create a record AT an id the caller names, or answer the one already
   * there: `{ outcome: "created" | "exists", record }` — the SDK's `createAt`,
   * so code over either backend makes the same call (craftworks-sdk#149).
   *
   * What it is for here: putting a record back under ITS OWN id after the
   * store was lost under an open tab (builder#82). `put` mints, so a restore
   * through it made a different project than the one the person had open.
   *
   * A create, never an overwrite; and never a RESURRECTION. An id with a
   * tombstone was deleted on purpose, and a create does not bring it back —
   * the check the day project deletion ships will rely on.
   */
  async createAt(domain, id, fields) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`createAt: \`${id}\` is not a record id`);
    }
    const key = this.#recordKey(domain, id);
    const held = this.#get(key);
    if (held) return { outcome: "exists", record: structuredClone(held) };
    if (this.#get(this.#tombKey(domain, id)) != null) {
      throw new Error(`createAt: ${domain}/${id} was deleted; a create does not bring it back`);
    }
    const rec = { id, created: now(), updated: now(), fields: { ...fields } };
    this.#set(key, rec, `${domain} record ${id}`);
    return { outcome: "created", record: structuredClone(rec) };
  }

  async delete(domain, id) {
    const key = this.#recordKey(domain, id);
    if (this.#get(key) == null) return false;
    // The tombstone FIRST: if it cannot be written the record is not removed,
    // so a refused delete leaves storage exactly as it was.
    this.#set(this.#tombKey(domain, id), { at: now() }, `delete ${domain}/${id}`);
    try { this.#storage.removeItem(key); }
    catch (e) {
      // The record is still here, so its tombstone must not be: left behind it
      // would out-date a genuine later edit from an older tab.
      try { this.#storage.removeItem(this.#tombKey(domain, id)); } catch { /* best effort */ }
      throw new NotSaved(`delete ${domain}/${id}`, e);
    }
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
