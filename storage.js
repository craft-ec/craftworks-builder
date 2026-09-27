// THE ONE WAY THE BUILDER REACHES BROWSER STORAGE (the owner, 2026-09-27: the builder published on freenet runs in the
// node's sandboxed frame, origin null, and there READING `localStorage` throws a SecurityError -- app.js stopped at
// its first touch and the SDK never started). Every storage touch in the builder goes through `browserStorage`: the
// browser's own when this document may use it, otherwise an in-memory store with the same surface, and
// `storageNote()` says so. Since §19 P3b every PROJECT fact is in the owner's tree; what is left here is the device's
// conveniences (which project was open last, which `#app=` link it last imported), and without storage those last
// only as long as the tab.

/** In-memory `Storage`: what a sandboxed document gets. Lost when the tab closes. */
export class MemoryStorage {
  #m = new Map();
  get length() { return this.#m.size; }
  key(i) { return [...this.#m.keys()][i] ?? null; }
  getItem(k) { return this.#m.has(String(k)) ? this.#m.get(String(k)) : null; }
  setItem(k, v) { this.#m.set(String(k), String(v)); }
  removeItem(k) { this.#m.delete(String(k)); }
  clear() { this.#m.clear(); }
}

/** The browser's storage if this document may read AND write it, else null with the reason. */
export function probeStorage(global = globalThis) {
  try {
    const s = global.localStorage;
    if (!s) return { storage: null, why: "no localStorage in this document" };
    const k = "craftec.builder.storage-probe";
    s.setItem(k, "1");
    s.removeItem(k);
    return { storage: s, why: null };
  } catch (e) {
    return { storage: null, why: String(e?.message ?? e) };
  }
}

const probed = probeStorage();

/** The builder's storage: the browser's, or in-memory when the document has none it may use. */
export const browserStorage = probed.storage ?? new MemoryStorage();

/** What the person is told when there is no browser storage here; "" when there is. */
export const NO_STORAGE_NOTE = "no browser storage here: this device will not remember which project was open; your projects are in your tree";
export const storageNote = () => (probed.storage ? "" : NO_STORAGE_NOTE);
/** Why the browser's storage could not be used (the browser's own words), or null. */
export const storageWhy = () => probed.why;
