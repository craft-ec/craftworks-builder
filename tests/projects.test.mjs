// THIS DEVICE'S PROJECT LIST, and each project's publication history (projects.js).
//
// A project's definition is its draft in the owner's tree (tests/definition.test.mjs); the one-record-per-component
// shape that was measured here is the SDK's by type now (`DefKey`). What is kept here is what identifies a project.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import {
  openInto,
  PUBLIC_UNTIL_PHASE_7, SCHEMAS,
  defineProjectDomains, createProject, listProjects,
  openProject, saveProjectMeta, recordPublication, nextSeq,
  publicationsOf, readDeviceSettings, writeDeviceSettings,
} from "../projects.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const fresh = async () => { const db = new sdk.Db(); await defineProjectDomains(db); return db; };
const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

await t("two projects are created, listed, and reopened by id — each with its own binding and stamp", async () => {
  const db = await fresh();
  const a = await createProject(db, { now: 1000 });
  const b = await createProject(db, { now: 2000 });
  await saveProjectMeta(db, b.id, { tree: { realm: "public", identity: "me" }, versions: { sdkRev: "s1" } });
  const listed = await listProjects(db);
  assert.equal(listed.length, 2, "browse my projects is a scan over the project domain");
  const reopened = await openProject(db, b.id);
  assert.deepEqual([reopened.created, reopened.tree, reopened.versions], [2000, { realm: "public", identity: "me" }, { sdkRev: "s1" }]);
  const other = await openProject(db, a.id);
  assert.deepEqual([other.tree, other.versions], [null, null], "one project's binding and stamp are not another's");
  assert.equal(await saveProjectMeta(db, b.id, { tree: { realm: "public", identity: "me" }, versions: { sdkRev: "s1" } }), false, "an unchanged binding and stamp are not written again");
});

await t("**a project's NAME is not on the list record**: it is its draft's `meta.name` (rule 3)", async () => {
  assert.ok(!SCHEMAS.project.fields.some(f => f.name === "title"), "the list record keeps a second copy of the name");
  const db = await fresh();
  const p = await createProject(db, { title: "ignored" });
  assert.strictEqual((await db.get("project", p.id)).fields.title, undefined, "a title was stored on the list record");
});

await t("OPENING a project switches BEFORE handing over the canvas", async () => {
  // The regression: handing the canvas over makes the builder save, and saving
  // writes into whichever project is open. Switch after the handover and the
  // project you are LEAVING is overwritten with the one you opened — two
  // projects, one click, and the first is gone. Verified in the browser first;
  // pinned here so the order cannot be tidied away.
  const db = await fresh();
  const a = await createProject(db);
  const b = await createProject(db);

  const order = [];
  await openInto(db, b.id, {
    setLastOpened: id => order.push(`switch:${id}`),
    handOver: p => order.push(`handOver:${p.id}`),
  });

  assert.deepEqual(order, [`switch:${b.id}`, `handOver:${b.id}`],
    "the open project must be switched BEFORE the canvas is handed over");
  assert.equal(order.indexOf(`switch:${b.id}`), 0, "and switching must be first, not merely present");

  // The control: opening something that does not exist hands nothing over.
  const none = [];
  const missing = await openInto(db, "nope", {
    setLastOpened: id => none.push(`switch:${id}`),
    handOver: () => none.push("handOver"),
  });
  assert.equal(missing, null);
  assert.deepEqual(none, [], "a project that does not exist must not switch anything");
  assert.ok(a.id, "two projects existed, so this is not passing on an empty store");
});

await t("a project is publicly readable until phase 7, and says so in a stored field", async () => {
  const db = await fresh();
  const p = await createProject(db);
  const opened = await openProject(db, p.id);
  assert.equal(opened.visibility, PUBLIC_UNTIL_PHASE_7,
    "the UI's words and the stored value come from one constant so they cannot drift");
  assert.ok(opened.root_binding, "root_binding is stored from day one, read-only until phase 12");
});

await t("publications are history, newest first (builder#26 reads these)", async () => {
  const db = await fresh();
  const p = await createProject(db);
  await recordPublication(db, p.id, { seq: 1, source_root: "r1", sdk_version: "aaa1111", published_at: 1 });
  await recordPublication(db, p.id, { seq: 2, source_root: "r2", sdk_version: "aaa1111", published_at: 2 });
  const other = await createProject(db);
  await recordPublication(db, other.id, { seq: 1, source_root: "rx", published_at: 3 });

  const hist = await publicationsOf(db, p.id);
  assert.equal(hist.length, 2, "one project's history is its own");
  assert.deepEqual(hist.map(h => h.seq), [2, 1], "newest first");
  assert.equal(hist[0].source_root, "r2", "it records the tree root it published FROM");
  assert.equal(hist[0].sdk_version, "aaa1111");

  // Rows from before apps were packaged carry none of what was PUT.
  assert.deepEqual([hist[1].bundle_hash, hist[1].app_contract_id, hist[1].head], [null, null, null]);
  // WHAT WAS PUT (builder#104) is recorded all together, or not at all: half
  // of it would read as a publication somebody could open.
  for (const half of [{ bundle_hash: "h3" }, { app_contract_id: "c3" }, { bundle_hash: "h3", app_contract_id: "c3" }]) {
    await assert.rejects(() => recordPublication(db, p.id, { seq: 3, ...half }), /together, or none of them/);
  }
  await assert.rejects(() => recordPublication(db, p.id, { seq: 3, bundel_hash: "typo" }), /is not a field a publication records/);
  assert.equal((await publicationsOf(db, p.id)).length, 2, "and nothing was written");
  assert.equal(await nextSeq(db, p.id), 3, "the next publication follows the highest recorded seq");
  await recordPublication(db, p.id, { seq: 3, bundle_hash: "h3", app_contract_id: "c3", head: "ab".repeat(32) });
  const top = (await publicationsOf(db, p.id))[0];
  assert.deepEqual([top.seq, top.bundle_hash, top.app_contract_id, top.head], [3, "h3", "c3", "ab".repeat(32)], "what was PUT is read back");
});

await t("device settings stay on the device, never in the tree", async () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  writeDeviceSettings(storage, { lastOpened: "p1", theme: "dark" });
  assert.deepEqual(readDeviceSettings(storage), { lastOpened: "p1", theme: "dark" });

  // A synced "last opened" is wrong on a second device, so it must not be a
  // tree field. The schemas are the enforcement: if it ever appears in one,
  // this fails.
  for (const [domain, schema] of Object.entries(SCHEMAS)) {
    const names = schema.fields.map(f => f.name);
    for (const deviceOnly of ["lastOpened", "theme", "layout_pref"]) {
      assert.ok(!names.includes(deviceOnly), `${deviceOnly} must not be a ${domain} field`);
    }
  }
});

await t("storage that refuses to write does not take the builder down", async () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error("private window"); } };
  const next = writeDeviceSettings(storage, { lastOpened: "p1" });
  assert.deepEqual(next, { lastOpened: "p1" }, "the caller still gets the value it set");
});

await t("**a stale or malformed project id opens NOTHING, with no catch around the read** (sdk#118)", async () => {
  const db = await fresh();
  for (const id of ["not-an-id", "a".repeat(31), "b".repeat(64), "0".repeat(32)]) {
    assert.strictEqual(await openProject(db, id), null, id);
  }
});

await t("**a read that FAILS is reported, not taken for \"no such project\"**", async () => {
  const db = await fresh();
  const p = await createProject(db);
  const down = new Proxy(db, { get(o, k) {
    if (k === "get") return async () => { const e = new Error("the range could not be loaded"); e.code = "UNAVAILABLE"; throw e; };
    const v = Reflect.get(o, k);
    return typeof v === "function" ? v.bind(o) : v;
  } });
  await assert.rejects(openProject(down, p.id), /could not be loaded/,
    "swallowed, the builder opened an empty canvas as if the project had been deleted");
  assert.ok(await openProject(db, p.id), "THE CONTROL: the same project over a working db opens");
});

process.stdout.write("\nprojects: all ok\n");
