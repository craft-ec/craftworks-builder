// Projects as records, and the MEASUREMENT behind the record shape.
//
// The issue says one record per COMPONENT because record granularity is
// conflict, undo, write-cost and read granularity at once. That is an argument;
// this file is the number. The same property tweak is applied to a
// per-component store and to a whole-canvas store, and the blocks written are
// compared — so the decision can be re-checked by anyone, rather than believed.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import {
  PROJECT, COMPONENT, PUBLICATION, PUBLIC_UNTIL_PHASE_7, SCHEMAS,
  defineProjectDomains, createProject, listProjects, addComponent,
  componentsOf, setComponentProps, openProject, recordPublication,
  publicationsOf, readDeviceSettings, writeDeviceSettings, DEVICE_SETTINGS_KEY,
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

  const listed = await listProjects(db);
  assert.equal(listed.length, 2, "browse my projects is a scan over the project domain");

  const reopened = await openProject(db, b.id);
  assert.equal(reopened.title, "Tasks");
  assert.equal(reopened.components.length, 2, "a project opens with its own components and nobody else's");
  assert.deepEqual(reopened.components.map(c => c.kind).sort(), ["form", "list"]);

  const other = await openProject(db, a.id);
  assert.equal(other.components.length, 1);
});

await t("THE MEASUREMENT: write cost does NOT favour per-component records", async () => {
  // The issue's stated rationale is that a whole-canvas record makes every
  // tweak a full-canvas rewrite. This measures it instead of believing it, and
  // the answer is no — so the assertion below is the one the numbers support,
  // not the one the argument wanted.
  const sizes = [[12, 20], [200, 20], [600, 200]];
  const rows = [];
  for (const [n, propSize] of sizes) {
    const props = i => ({ domain: `d${i}`, blob: "x".repeat(propSize) });

    const pc = new sdk.Db();
    await defineProjectDomains(pc);
    const p = await createProject(pc, { title: "x" });
    const ids = [];
    for (let i = 0; i < n; i++) ids.push((await addComponent(pc, p.id, { kind: "table", props: props(i) })).id);
    const b0 = pc.stats().blocks;
    const mid = Math.floor(n / 2);
    await setComponentProps(pc, ids[mid], { ...props(mid), w: 1 });
    const perComponent = pc.stats().blocks - b0;

    const wc = new sdk.Db();
    await wc.define("canvas", {
      type: "Canvas",
      fields: [{ name: "title", kind: "text", required: true }, { name: "components", kind: "text" }],
    });
    const canvas = [...Array(n)].map((_, i) => ({ kind: "table", props: props(i) }));
    const rec = await wc.put("canvas", { title: "x", components: JSON.stringify(canvas) });
    const c0 = wc.stats().blocks;
    canvas[mid].props.w = 1;
    await wc.update("canvas", rec.id, { components: JSON.stringify(canvas) });
    const wholeCanvas = wc.stats().blocks - c0;

    rows.push({ n, propSize, perComponent, wholeCanvas, pcBytes: pc.stats().bytes, wcBytes: wc.stats().bytes });
  }

  for (const r of rows) {
    process.stdout.write(
      `   ${String(r.n).padStart(4)} components, ${String(r.propSize).padStart(3)} B props: ` +
      `per-component ${r.perComponent} block(s), whole-canvas ${r.wholeCanvas} block(s), ` +
      `store ${r.pcBytes} B vs ${r.wcBytes} B\n`,
    );
  }

  assert.ok(rows.every(r => r.perComponent >= 1), "a tweak must write something, or this measures nothing");
  // The finding, asserted so it cannot quietly stop being true: per-component
  // does NOT write fewer blocks. If this ever fails, the substrate changed and
  // the rationale in projects.js should be revisited.
  assert.ok(
    rows.every(r => r.perComponent >= r.wholeCanvas),
    "per-component wrote FEWER blocks than a whole-canvas rewrite — the write-cost " +
    "argument the issue makes would then be true, and projects.js says it is not: " +
    JSON.stringify(rows),
  );
  assert.ok(
    rows.every(r => r.pcBytes > r.wcBytes),
    "per-component storage is larger at every size measured: " + JSON.stringify(rows),
  );
});

await t("a tweak touches ONE component and leaves its neighbours alone", async () => {
  const db = await fresh();
  const p = await createProject(db, { title: "Three" });
  const a = await addComponent(db, p.id, { kind: "table", props: { w: 1 } });
  const b = await addComponent(db, p.id, { kind: "list", props: { w: 2 } });
  const before = (await componentsOf(db, p.id)).map(r => `${r.id}:${r.fields.props}`);

  await setComponentProps(db, a.id, { w: 99 });

  const after = (await componentsOf(db, p.id)).map(r => `${r.id}:${r.fields.props}`);
  assert.notDeepEqual(before, after, "something must have changed, or the control below is vacuous");
  const untouched = after.find(s => s.startsWith(b.id));
  assert.equal(untouched, before.find(s => s.startsWith(b.id)),
    "the neighbour's record is byte-identical: that is what per-component granularity BUYS");
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

process.stdout.write("\nprojects: all ok\n");
