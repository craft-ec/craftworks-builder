// Projects as records, and the measurement that chose the record shape.
//
// The shape is ONE record per project, canvas as a MAP KEYED BY COMPONENT ID.
// The measurement below is why, and it is kept executable rather than quoted:
// if the substrate ever makes per-component cheaper, this goes red and the
// decision in projects.js gets re-opened deliberately.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import {
  PROJECT, PUBLICATION, PUBLIC_UNTIL_PHASE_7, SCHEMAS, componentId,
  defineProjectDomains, createProject, listProjects, openProject,
  addComponent, setComponentProps, removeComponent,
  recordPublication, publicationsOf,
  readDeviceSettings, writeDeviceSettings,
} from "../projects.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const fresh = async () => { const db = new sdk.Db(); await defineProjectDomains(db); return db; };
const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

await t("two projects are created, listed, and reopened by id", async () => {
  const db = await fresh();
  const a = await createProject(db, { title: "Notes", now: 1000 });
  const b = await createProject(db, { title: "Tasks", now: 2000 });
  await addComponent(db, a.id, { kind: "table", props: { domain: "notes" } });
  await addComponent(db, b.id, { kind: "list", props: { domain: "tasks" } });
  await addComponent(db, b.id, { kind: "form", props: { domain: "tasks" } });

  assert.equal((await listProjects(db)).length, 2, "browse my projects is a scan over one domain");

  const reopened = await openProject(db, b.id);
  assert.equal(reopened.title, "Tasks");
  assert.equal(Object.keys(reopened.components).length, 2, "a project opens with its own canvas and nobody else's");
  assert.equal(Object.keys((await openProject(db, a.id)).components).length, 1);
});

await t("THE MEASUREMENT, both built the way a person builds", async () => {
  // CORRECTED. My first version of this built the whole-canvas record in ONE
  // put while building the per-component store incrementally, and reported that
  // per-component cost 8-20x more storage. That comparison was not
  // apples-to-apples: a person adds components one at a time, and each add
  // rewrites the whole canvas value. Measured that way the storage result
  // REVERSES. The tweak result does not.
  const sizes = [[12, 20], [200, 20], [600, 200]];
  const rows = [];
  for (const [n, propSize] of sizes) {
    const props = i => ({ domain: `d${i}`, blob: "x".repeat(propSize) });
    const mid = Math.floor(n / 2);

    const pc = new sdk.Db();
    await pc.define("comp", {
      type: "Comp",
      fields: [{ name: "pid", kind: "text", required: true }, { name: "props", kind: "text" }],
    });
    const ids = [];
    for (let i = 0; i < n; i++) ids.push((await pc.put("comp", { pid: "p", props: JSON.stringify(props(i)) })).id);
    const pcBuild = pc.stats().bytes;
    const b0 = pc.stats().blocks;
    await pc.update("comp", ids[mid], { props: JSON.stringify({ ...props(mid), w: 1 }) });
    const pcTweak = pc.stats().blocks - b0;

    const wc = await fresh();
    const proj = await createProject(wc, { title: "x" });
    const cids = [];
    for (let i = 0; i < n; i++) cids.push(await addComponent(wc, proj.id, { kind: "table", props: props(i) }));
    const wcBuild = wc.stats().bytes;
    const c0 = wc.stats().blocks;
    await setComponentProps(wc, proj.id, cids[mid], { ...props(mid), w: 1 });
    const wcTweak = wc.stats().blocks - c0;

    rows.push({ n, propSize, pcBuild, wcBuild, pcTweak, wcTweak });
  }

  for (const r of rows) {
    process.stdout.write(
      `   ${String(r.n).padStart(4)} components: building costs ${r.pcBuild} B per-component vs ` +
      `${r.wcBuild} B whole-canvas; one tweak ${r.pcTweak} vs ${r.wcTweak} block(s)\n`,
    );
  }

  // WHAT IS TRUE, stated as the numbers give it rather than as either side
  // would like it:
  //
  // 1. Tweak cost is a WASH. Whole-canvas costs more at 12 components (2 vs 1)
  //    and fewer at 600 (2 vs 3); neither wins consistently, and both stay
  //    within one block. So write-cost-per-edit is an argument for NEITHER
  //    shape — which is what killed the issue's original rationale, and does
  //    not resurrect it in the other direction.
  // 2. Whole-canvas costs substantially MORE STORAGE TO BUILD, at every size
  //    measured, because every add rewrites the whole value and the superseded
  //    versions stay in the store.
  assert.ok(rows.every(r => r.wcTweak >= 1), "a tweak must write something, or this measures nothing");
  assert.ok(
    rows.every(r => Math.abs(r.wcTweak - r.pcTweak) <= 1),
    "tweak cost is no longer a wash — one shape now wins per-edit by more than " +
    "a block, and the decision in projects.js should be re-opened: " + JSON.stringify(rows),
  );
  assert.ok(
    rows.every(r => r.wcBuild > r.pcBuild),
    "whole-canvas no longer costs more to BUILD — the storage leg of the " +
    "decision has changed and should be re-opened: " + JSON.stringify(rows),
  );
});

await t("THE HEDGE: a component is addressed by a STABLE ID, never a position", async () => {
  const db = await fresh();
  const p = await createProject(db, { title: "Hedge" });
  const first = await addComponent(db, p.id, { kind: "table", props: { w: 1 } });
  const second = await addComponent(db, p.id, { kind: "list", props: { w: 2 } });
  const third = await addComponent(db, p.id, { kind: "form", props: { w: 3 } });

  // Remove the one in the MIDDLE. Under an array this renumbers everything
  // after it; under a map nothing else moves — which is what makes a future
  // split into per-component records a re-chunk rather than a re-key.
  await removeComponent(db, p.id, second);
  const after = (await openProject(db, p.id)).components;

  assert.deepEqual(Object.keys(after).sort(), [first, third].sort(), "only the removed one is gone");
  assert.equal(after[third].props.w, 3, "the survivor keeps its id AND its value");

  await setComponentProps(db, p.id, third, { w: 99 });
  const tweaked = (await openProject(db, p.id)).components;
  assert.equal(tweaked[third].props.w, 99, "addressed by id, after a neighbour was deleted");
  assert.equal(tweaked[first].props.w, 1, "and the other component is untouched");
});

await t("component ids are unique and not positional", async () => {
  const seen = new Set([componentId(0, 1), componentId(1, 1), componentId(2, 1)]);
  assert.equal(seen.size, 3, "ids must be distinct");
  assert.notEqual(componentId(0, 1), componentId(0, 2), "a new project does not reuse the first id");
  // The control: a positional scheme would give the SAME id for index 0 twice.
  assert.ok(![...seen].some(id => /^c?0$/.test(id)), "an id must not be a bare index");
});

await t("a project is publicly readable until phase 7, and says so in a stored field", async () => {
  const db = await fresh();
  const p = await createProject(db, { title: "Open" });
  const opened = await openProject(db, p.id);
  assert.equal(opened.visibility, PUBLIC_UNTIL_PHASE_7,
    "the UI's words and the stored value come from one constant so they cannot drift");
  assert.ok(opened.root_binding, "root_binding is stored from day one, read-only until phase 12");
});

await t("publications are history, newest first (builder#26 reads these)", async () => {
  const db = await fresh();
  const p = await createProject(db, { title: "Shipped" });
  await recordPublication(db, p.id, { seq: 1, app_contract_id: "c1", bundle_hash: "h1", source_root: "r1", published_at: 1 });
  await recordPublication(db, p.id, { seq: 2, app_contract_id: "c2", bundle_hash: "h2", source_root: "r2", published_at: 2 });
  const other = await createProject(db, { title: "Elsewhere" });
  await recordPublication(db, other.id, { seq: 1, app_contract_id: "x", bundle_hash: "hx", source_root: "rx", published_at: 3 });

  const hist = await publicationsOf(db, p.id);
  assert.equal(hist.length, 2, "one project's history is its own");
  assert.deepEqual(hist.map(h => h.seq), [2, 1], "newest first");
  assert.equal(hist[0].bundle_hash, "h2");
});

await t("device settings stay on the device, never in the tree", async () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  writeDeviceSettings(storage, { lastOpened: "p1", theme: "dark" });
  assert.deepEqual(readDeviceSettings(storage), { lastOpened: "p1", theme: "dark" });
  for (const [domain, schema] of Object.entries(SCHEMAS)) {
    const names = schema.fields.map(f => f.name);
    for (const deviceOnly of ["lastOpened", "theme", "layout_pref"]) {
      assert.ok(!names.includes(deviceOnly), `${deviceOnly} must not be a ${domain} field`);
    }
  }
});

await t("storage that refuses to write does not take the builder down", async () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error("private window"); } };
  assert.deepEqual(writeDeviceSettings(storage, { lastOpened: "p1" }), { lastOpened: "p1" });
});

process.stdout.write("\nprojects: all ok\n");
