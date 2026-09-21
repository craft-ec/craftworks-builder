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
  openInto,
  PROJECT, COMPONENT, PUBLICATION, PUBLIC_UNTIL_PHASE_7, SCHEMAS,
  defineProjectDomains, createProject, listProjects, addComponent,
  componentsOf, setComponentProps, openProject, recordPublication, nextSeq,
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

await t("THE MEASUREMENT, with both sides built the way a person builds", async () => {
  // This was wrong once and the wrong version is worth naming: it built the
  // whole-canvas record in ONE put while building per-component incrementally,
  // and reported per-component costing 8-20x more storage. A person adds
  // components one at a time and each add rewrites the whole canvas value.
  // Fair, the result reverses — which is why the shape is per-component.
  const sizes = [[5, 200], [20, 200], [60, 200], [200, 200]];
  const rows = [];
  for (const [n, propSize] of sizes) {
    const props = i => ({ domain: `d${i}`, blob: "x".repeat(propSize) });
    const mid = Math.floor(n / 2);

    const pc = await fresh();
    const p = await createProject(pc, { title: "x" });
    const ids = [];
    for (let i = 0; i < n; i++) ids.push((await addComponent(pc, p.id, { kind: "table", props: props(i) })).id);
    const pcBuild = pc.stats().bytes;
    const b0 = pc.stats().blocks;
    await setComponentProps(pc, ids[mid], { ...props(mid), w: 1 });
    const pcTweak = pc.stats().blocks - b0;

    const wc = new sdk.Db();
    await wc.define("canvas", {
      type: "Canvas",
      fields: [{ name: "title", kind: "text", required: true }, { name: "components", kind: "text" }],
    });
    const rec = await wc.put("canvas", { title: "x", components: "{}" });
    const canvas = {};
    for (let i = 0; i < n; i++) {
      canvas[`c${i}`] = { kind: "table", props: props(i) };
      await wc.update("canvas", rec.id, { components: JSON.stringify(canvas) });
    }
    const wcBuild = wc.stats().bytes;
    const c0 = wc.stats().blocks;
    canvas[`c${mid}`].props.w = 1;
    await wc.update("canvas", rec.id, { components: JSON.stringify(canvas) });
    const wcTweak = wc.stats().blocks - c0;

    rows.push({ n, pcBuild, wcBuild, pcTweak, wcTweak });
  }

  for (const r of rows) {
    process.stdout.write(
      `   ${String(r.n).padStart(4)} components: building ${r.pcBuild} B per-component vs ` +
      `${r.wcBuild} B whole-canvas; one tweak ${r.pcTweak} vs ${r.wcTweak} block(s)\n`,
    );
  }

  assert.ok(rows.every(r => r.pcTweak >= 1), "a tweak must write something, or this measures nothing");
  // Tweak cost is a WASH — neither shape wins by more than a block. The
  // issue's original rationale is dead and does not return in reverse.
  assert.ok(
    rows.every(r => Math.abs(r.pcTweak - r.wcTweak) <= 1),
    "tweak cost stopped being a wash — one shape now wins per edit, and the " +
    "rationale in projects.js should be re-opened: " + JSON.stringify(rows),
  );
  // THE LEG THAT DECIDES, and it has a CROSSOVER — stated rather than hidden
  // by picking one size. Whole-canvas is cheaper for a small canvas and loses
  // quadratically as the canvas grows, because every add rewrites the whole
  // value. Measured crossover: about 25 components.
  const small = rows.find(r => r.n === 5);
  const large = rows.find(r => r.n === 200);
  assert.ok(
    small.wcBuild < small.pcBuild,
    "whole-canvas is no longer cheaper for a SMALL canvas — the crossover moved " +
    "and the note in projects.js should be corrected: " + JSON.stringify(rows),
  );
  assert.ok(
    large.wcBuild > large.pcBuild * 3,
    "whole-canvas no longer costs multiples more at scale — the leg this record " +
    "shape rests on has changed and must be re-opened: " + JSON.stringify(rows),
  );
});

await t("WHY it is quadratic: a big value is ONE block, so an add shares nothing", async () => {
  // The proposed cause was broken content-defined chunk boundaries. That is
  // refuted: the canvas is never chunked. A value over MAX_INLINE is a single
  // content-addressed block, so changing any byte makes a whole new one.
  const canvasOf = n => {
    const c = {};
    for (let i = 0; i < n; i++) c[`c${i}`] = { kind: "table", props: { domain: `d${i}`, blob: "x".repeat(200) } };
    return c;
  };
  const alone = async n => {
    const db = new sdk.Db();
    await db.define("k", { type: "K", fields: [{ name: "t", kind: "text", required: true }, { name: "c", kind: "text" }] });
    const before = db.stats().blocks;
    await db.put("k", { t: "x", c: JSON.stringify(canvasOf(n)) });
    return db.stats().blocks - before;
  };
  const oneVersion = await alone(601);

  const db = new sdk.Db();
  await db.define("k", { type: "K", fields: [{ name: "t", kind: "text", required: true }, { name: "c", kind: "text" }] });
  const rec = await db.put("k", { t: "x", c: JSON.stringify(canvasOf(600)) });
  const b0 = db.stats().blocks;
  await db.update("k", rec.id, { c: JSON.stringify(canvasOf(601)) });
  const added = db.stats().blocks - b0;
  const shared = oneVersion - added;

  process.stdout.write(
    `   a 601-component canvas is ${oneVersion} block(s); one add writes ${added} new, ` +
    `sharing ${shared} with the previous version\n`,
  );

  assert.ok(oneVersion <= 4, `a whole canvas should be a couple of blocks, got ${oneVersion}`);
  assert.equal(shared, 0,
    "the canvas shared blocks with its previous version — dedup is holding, so " +
    "the quadratic cost has a different cause than 'a big value is one block' " +
    "and projects.js should be corrected");
});

await t("THE WALL: a whole-canvas project would eventually be UNABLE to save", async () => {
  // The slope ends in a refusal, not just a big number. A record is capped and
  // there is no blob path behind it, so this is the argument that does not
  // depend on how much storage anyone thinks is acceptable.
  const db = new sdk.Db();
  await db.define("k", { type: "K", fields: [{ name: "t", kind: "text", required: true }, { name: "c", kind: "text" }] });
  const canvasOf = n => {
    const c = {};
    for (let i = 0; i < n; i++) c[`c${i}`] = { kind: "table", props: { domain: `d${i}`, blob: "x".repeat(200) } };
    return c;
  };

  const ok = JSON.stringify(canvasOf(1000));
  await db.put("k", { t: "x", c: ok });   // accepted

  const tooBig = JSON.stringify(canvasOf(1200));
  let refused = null;
  try { await db.put("k", { t: "x", c: tooBig }); } catch (e) { refused = String(e.message ?? e); }

  process.stdout.write(
    `   ${ok.length} B canvas accepted; ${tooBig.length} B canvas refused\n`,
  );
  assert.ok(refused, "a canvas past the record limit must be REFUSED, not silently truncated");
  assert.match(refused, /limit is \d+/, `the refusal must name the limit: ${refused}`);
  // The refusal advises a blob, and there is no blob path (freenet-prolly#50).
  // Pinned so that if one ever lands, this test says the advice became real.
  assert.match(refused, /blob/, "the refusal still advises a blob path that does not exist");
}, );

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

await t("OPENING a project switches BEFORE handing over the canvas", async () => {
  // The regression: handing the canvas over makes the builder save, and saving
  // writes into whichever project is open. Switch after the handover and the
  // project you are LEAVING is overwritten with the one you opened — two
  // projects, one click, and the first is gone. Verified in the browser first;
  // pinned here so the order cannot be tidied away.
  const db = await fresh();
  const a = await createProject(db, { title: "A" });
  const b = await createProject(db, { title: "B" });
  await addComponent(db, b.id, { kind: "list", props: { w: 1 } });

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
  const p = await createProject(db, { title: "Open" });
  const opened = await openProject(db, p.id);
  assert.equal(opened.visibility, PUBLIC_UNTIL_PHASE_7,
    "the UI's words and the stored value come from one constant so they cannot drift");
  assert.ok(opened.root_binding, "root_binding is stored from day one, read-only until phase 12");
});

await t("publications are history, newest first (builder#26 reads these)", async () => {
  const db = await fresh();
  const p = await createProject(db, { title: "Shipped" });
  await recordPublication(db, p.id, { seq: 1, source_root: "r1", sdk_version: "aaa1111", published_at: 1 });
  await recordPublication(db, p.id, { seq: 2, source_root: "r2", sdk_version: "aaa1111", published_at: 2 });
  const other = await createProject(db, { title: "Elsewhere" });
  await recordPublication(db, other.id, { seq: 1, source_root: "rx", published_at: 3 });

  const hist = await publicationsOf(db, p.id);
  assert.equal(hist.length, 2, "one project's history is its own");
  assert.deepEqual(hist.map(h => h.seq), [2, 1], "newest first");
  assert.equal(hist[0].source_root, "r2", "it records the tree root it published FROM");
  assert.equal(hist[0].sdk_version, "aaa1111");

  // A bundle hash cannot be recorded yet, and the refusal is the point: an
  // empty field that later means something reads as "this publication had no
  // bundle" instead of "bundles did not exist yet".
  await assert.rejects(
    () => recordPublication(db, p.id, { seq: 3, bundle_hash: "h3" }),
    /apps carry no bundle until craftworks-sdk#108/,
  );
  await assert.rejects(
    () => recordPublication(db, p.id, { seq: 3, app_contract_id: "c3" }),
    /apps carry no bundle until craftworks-sdk#108/,
  );
  assert.equal((await publicationsOf(db, p.id)).length, 2, "and nothing was written");
  assert.equal(await nextSeq(db, p.id), 3, "the next publication follows the highest recorded seq");
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
