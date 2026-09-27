// THE PROJECT LIST IS THE OWNER'S TREE's (project-list.js, ARCHITECTURE §19, app-as-data P3b), and all this device
// remembers is which project was open last (projects.js). Driven over a list db shaped as a session's: apps that
// hold a draft (`definitionApps`), and each app's definitions (`definition(which, app)`).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import * as projects from "../projects.js";
import { LIST_APP, listProjects, metaOf, publishedOf, newest, newProjectId } from "../project-list.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const { readDeviceSettings, writeDeviceSettings, DEVICE_SETTINGS_KEY } = projects;
const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

/** A list db: `{ app: { draft: [{ key, body }], app: [...] } }`, read as a session reads its tree. */
const tree = apps => ({
  definitionApps: async () => Object.keys(apps).sort(),
  definition: async (which, app) => apps[app]?.[which] ?? [],
});
const meta = (name, created, extra = {}) => ({ key: "meta", body: { name, order: [], created, ...extra } });

await t("**the list is the tree's apps that hold a draft**, the list app itself excepted", async () => {
  const db = tree({ [LIST_APP]: { draft: [] }, aaa: { draft: [meta("A", 1)] }, bbb: { draft: [meta("B", 2)] } });
  assert.deepStrictEqual(await listProjects(db), ["aaa", "bbb"]);
});

await t("**each project is named, dated and told apart by its own draft's meta**", async () => {
  const db = tree({ aaa: { draft: [meta("Notes", 5, { forked_from: { project: "zzz" }, tree: { realm: "public" }, versions: { sdkRev: "s" } }), { key: "c/k", body: {} }] } });
  assert.deepStrictEqual(await metaOf(db, "aaa"), { name: "Notes", order: [], created: 5, forked_from: { project: "zzz" }, tree: { realm: "public" }, versions: { sdkRev: "s" } });
  assert.strictEqual(await metaOf(db, "nope"), null);
});

await t("**published? is DERIVED**: the project's published definition holds anything", async () => {
  const db = tree({ aaa: { draft: [meta("A", 1)], app: [meta("A", 1)] }, bbb: { draft: [meta("B", 1)], app: [] } });
  assert.strictEqual(await publishedOf(db, "aaa"), true);
  assert.strictEqual(await publishedOf(db, "bbb"), false);
});

await t("**the newest project by meta.created** is what opens with nothing remembered; ties fall to the id (every device picks the same)", () => {
  assert.strictEqual(newest([]), null);
  assert.strictEqual(newest([{ id: "a", meta: { created: 1 } }, { id: "b", meta: { created: 3 } }, { id: "c", meta: { created: 2 } }]).id, "b");
  assert.strictEqual(newest([{ id: "a", meta: { created: 3 } }, { id: "b", meta: { created: 3 } }]).id, "b");
  assert.strictEqual(newest([{ id: "a", meta: null }, { id: "b", meta: { created: 1 } }]).id, "b", "a project with no date outranked a dated one");
});

await t("**a new project's id IS its app id**: 32 hex, which the SDK's app rule takes as it is", () => {
  const ids = new Set(Array.from({ length: 50 }, newProjectId));
  assert.strictEqual(ids.size, 50);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.doesNotThrow(() => sdk.ids.app(id), id);
  }
});

await t("device settings stay on the device: lastOpened and importedFrom, and a storage that refuses does not take the builder down", () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  writeDeviceSettings(storage, { lastOpened: "p1" });
  writeDeviceSettings(storage, { importedFrom: "{}" });
  assert.deepStrictEqual(readDeviceSettings(storage), { lastOpened: "p1", importedFrom: "{}" });
  assert.ok(store.has(DEVICE_SETTINGS_KEY));
  const refusing = { getItem: () => null, setItem: () => { throw new Error("private window"); } };
  assert.deepStrictEqual(writeDeviceSettings(refusing, { lastOpened: "p1" }), { lastOpened: "p1" }, "the caller still gets the value it set");
  for (const gone of ["SCHEMAS", "PROJECT", "createProject", "listProjects", "openProject", "recordPublication"]) {
    assert.ok(!(gone in projects), `projects.js still exports ${gone}: a device-side project store is back`);
  }
});

process.stdout.write("\nprojects: all ok\n");
