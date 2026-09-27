// THE PROJECT LIST, IN THE OWNER'S TREE (ARCHITECTURE §19, app-as-data P3b; core dev's rulings 1-5).
//
// A project IS an app of the person's tree, and its id IS its app id. The list is the tree's apps that hold a draft
// (the SDK's `definitionApps`), each named -- and dated, and told apart -- by its own draft's `meta`. Nothing about a
// project is kept on this device: which one was open last (`lastOpened`) is a convenience, read and written behind
// the storage guard, and without it the builder opens the newest project by `meta.created`, or makes one.
//
// The list is read through a session of the fixed LIST APP: a session is scoped to one app, and the list is read
// before any project is open. That app holds no data of its own and is never listed.

/** The app the builder lists projects through (and nothing else). */
export const LIST_APP = "craftworks-builder";

/** A new project's id: 32 hex (128 random bits), which is its app id as it is (the SDK's app rule, `sdk.ids.app`). */
export const newProjectId = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");

/** Every project of the tree: the apps that hold a draft, the list app excepted. */
export async function listProjects(db) {
  return (await db.definitionApps()).filter(app => app !== LIST_APP);
}

/** A project's `meta`, from its draft (`{ name, order, created, forked_from, tree, versions }`), or null. */
export async function metaOf(db, id) {
  return (await db.definition("draft", id)).find(r => r.key === "meta")?.body ?? null;
}

/** Has the project been published: does its published definition hold anything (§19: "published?" is derived). */
export async function publishedOf(db, id) {
  return (await db.definition("app", id)).length > 0;
}

/** The newest project by `meta.created`, of `[{ id, meta }]`; null for none. Ties fall to the id, so every device picks the same. */
export function newest(projects) {
  let best = null;
  for (const p of projects) {
    const c = Number.isFinite(p.meta?.created) ? p.meta.created : -Infinity;
    const b = best && (Number.isFinite(best.meta?.created) ? best.meta.created : -Infinity);
    if (!best || c > b || (c === b && p.id > best.id)) best = p;
  }
  return best;
}
