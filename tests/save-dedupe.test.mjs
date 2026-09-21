// builder#49: ONE COMPONENT, ONE ENTRY ON RELOAD.
//
// Two ways a project came to hold two records for one canvas component:
//   * an add that LANDED but whose answer was lost — the save failed, the
//     canvas never learnt the record's id, and the next save added it again;
//   * two saves that OVERLAPPED — both read the project before either had
//     added the new component, and both added it. No failure needed: the audit
//     reproduced it with two successful saves.
// Reload then showed the component twice.
//
// Driven through the entries the app uses — `saveCanvas`, the panel's serial
// save, `openProject` — over BOTH backends the builder writes to: `LocalDb`
// (an unpublished project) and the SDK's `Db`.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import { LocalDb } from "../local-db.js";
import { defineProjectDomains, createProject, componentsOf, openProject, recordPerComponentKey, COMPONENT } from "../projects.js";
import { saveCanvas, serialSaves, fromRecord } from "../projects-panel.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const storage = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};
const BACKENDS = {
  LocalDb: () => new LocalDb(storage()),
  "sdk Db": () => new sdk.Db(),
};
const fresh = async make => { const db = make(); await defineProjectDomains(db); return db; };

/** A db whose FIRST call to `method` on a component does its work, then reports failure. */
const failsAfterOnce = (db, method, message) => {
  let armed = true;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === method) {
        return async (domain, ...rest) => {
          const out = await target[method](domain, ...rest);
          if (armed && domain === COMPONENT) { armed = false; throw new Error(message); }
          return out;
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
};

/** Refuses every component delete: a save stopped before its removals. */
const refusesDeletes = db => new Proxy(db, {
  get(target, prop) {
    if (prop === "delete") {
      return async (domain, ...rest) => {
        if (domain === COMPONENT) throw new Error("refused");
        return target.delete(domain, ...rest);
      };
    }
    const v = target[prop];
    return typeof v === "function" ? v.bind(target) : v;
  },
});

/** Two records for ONE component: saveCanvas raced against itself. */
const twoRecordsOneKey = async (db, pid, canvas) => {
  await Promise.all([saveCanvas(db, pid, canvas), saveCanvas(db, pid, canvas)]);
  const rs = await componentsOf(db, pid);
  assert.strictEqual(rs.length, 2, "setup: the raw overlap stores two records for one component");
  return rs;
};

for (const [name, make] of Object.entries(BACKENDS)) {
  await t(`${name}: after an add whose answer was lost, the next save ADOPTS that record — no second one`, async () => {
    const db = await fresh(make);
    const p = await createProject(db, { title: "lost answer" });
    const canvas = [{ type: "table", domain: "notes" }];
    await assert.rejects(saveCanvas(failsAfterOnce(db, "put", "the answer was lost"), p.id, canvas), /answer was lost/);
    assert.strictEqual(canvas[0].rid, undefined, "setup: the canvas never learnt the record's id");
    const [orphan] = await componentsOf(db, p.id);
    const did = await saveCanvas(db, p.id, canvas);
    assert.strictEqual(did.added, 0, `the next save added ${did.added} record(s) for a component that already had one`);
    assert.strictEqual(canvas[0].rid, orphan.id, "the canvas did not adopt the record carrying its key");
    assert.strictEqual((await componentsOf(db, p.id)).length, 1);
  });

  await t(`${name}: CONTROL — components with DIFFERENT keys are all added, adopt or not`, async () => {
    const db = await fresh(make);
    const p = await createProject(db, { title: "adopt control" });
    const canvas = [{ type: "table", domain: "notes" }, { type: "table", domain: "notes" }, { type: "list", domain: "notes" }];
    const did = await saveCanvas(db, p.id, canvas);
    assert.strictEqual(did.added, 3);
    assert.strictEqual((await openProject(db, p.id)).components.length, 3, "look-alikes were collapsed");
  });

  await t(`${name}: two records for one component show ONCE on reload, and the next save leaves one`, async () => {
    const db = await fresh(make);
    const p = await createProject(db, { title: "backstop" });
    await twoRecordsOneKey(db, p.id, [{ type: "table", domain: "notes" }]);
    const opened = await openProject(db, p.id);
    assert.strictEqual(opened.components.length, 1, `reload shows ${opened.components.length} components for one`);
    await saveCanvas(db, p.id, opened.components.map(fromRecord));
    assert.strictEqual((await componentsOf(db, p.id)).length, 1, "the extra record survived the next save");
  });

  await t(`${name}: the record written MOST wins — a holder's edit to the older copy survives reload and the next save`, async () => {
    // The review's case: a tab still holding the OLDER record edits it after
    // the newer one exists, with its removal refused. "Largest id wins" showed
    // the stale copy, and the next clean save deleted the edit.
    const db = await fresh(make);
    const p = await createProject(db, { title: "stale" });
    const rs = await twoRecordsOneKey(db, p.id, [{ type: "table", domain: "notes", title: "v1" }]);
    const older = rs.reduce((a, b) => (a.id < b.id ? a : b));
    const holder = [fromRecord({ ...older, props: JSON.parse(older.fields.props), kind: older.fields.kind })];
    holder[0].title = "v2";
    await assert.rejects(saveCanvas(refusesDeletes(db), p.id, holder), /refused/);
    assert.strictEqual((await componentsOf(db, p.id)).length, 2, "setup: both records remain");
    const opened = await openProject(db, p.id);
    assert.deepStrictEqual(opened.components.map(c => c.props.title), ["v2"], "reload showed the stale copy");
    await saveCanvas(db, p.id, opened.components.map(fromRecord));
    const left = await componentsOf(db, p.id);
    assert.deepStrictEqual(left.map(r => JSON.parse(r.fields.props).title), ["v2"], "the next save deleted the edit");
  });

  await t(`${name}: overlapping saves through serialSaves store the new component ONCE`, async () => {
    const db = await fresh(make);
    const p = await createProject(db, { title: "overlap" });
    const canvas = [{ type: "table", domain: "notes" }];
    const save = serialSaves((pid, c) => saveCanvas(db, pid, c));
    await Promise.all([save(p.id, canvas), save(p.id, canvas)]);
    assert.strictEqual((await componentsOf(db, p.id)).length, 1, "the serial save let two adds through");
  });

  await t(`${name}: a component repeating another's key on the canvas is a NEW component`, async () => {
    const db = await fresh(make);
    const p = await createProject(db, { title: "copy" });
    const canvas = [{ type: "table", domain: "notes" }];
    await saveCanvas(db, p.id, canvas);
    canvas.push({ ...canvas[0] });   // a copy: same key AND same rid
    await saveCanvas(db, p.id, canvas);
    assert.notStrictEqual(canvas[0]._builder.key, canvas[1]._builder.key, "the copy kept the original's key");
    assert.strictEqual((await openProject(db, p.id)).components.length, 2, "the copy was lost");
  });

  await t(`${name}: the same stored state resolves the same way on every open`, async () => {
    const db = await fresh(make);
    const p = await createProject(db, { title: "deterministic" });
    await twoRecordsOneKey(db, p.id, [{ type: "table", domain: "notes" }]);
    const a = (await openProject(db, p.id)).components.map(c => c.id);
    const b = (await openProject(db, p.id)).components.map(c => c.id);
    assert.deepStrictEqual(a, b);
  });
}

await t("the winner is the highest generation; ties fall to `updated`, then id, the same way in any order", async () => {
  const rec = (id, gen, updated) => ({ id, updated, fields: { props: JSON.stringify({ _builder: { key: "k", gen } }) } });
  const pick = rs => [recordPerComponentKey(rs).get("k").id, recordPerComponentKey([...rs].reverse()).get("k").id];
  // gen outranks updated AND id, even when both point the other way.
  assert.deepStrictEqual(pick([rec("a1", 3, 100), rec("b2", 2, 900)]), ["a1", "a1"]);
  // equal gen: updated decides.
  assert.deepStrictEqual(pick([rec("a1", 2, 200), rec("b2", 2, 100)]), ["a1", "a1"]);
  // equal gen AND updated (one millisecond): id decides.
  assert.deepStrictEqual(pick([rec("a1", 2, 100), rec("b2", 2, 100)]), ["b2", "b2"]);
});

await t("LocalDb: the clock stepping BACK does not make a stale copy win", async () => {
  // The architect's case: LocalDb ids and times are Date.now(), unguarded. A
  // holder's edit made while the clock reads 5 s EARLIER gets the smaller id
  // and the smaller `updated` — only the generation says it is the fresh one.
  const realNow = Date.now;
  try {
    const db = await fresh(BACKENDS.LocalDb);
    const p = await createProject(db, { title: "clock" });
    const rs = await twoRecordsOneKey(db, p.id, [{ type: "table", domain: "notes", title: "v1" }]);
    const target = rs.reduce((a, b) => (a.id < b.id ? a : b));
    const base = realNow();
    Date.now = () => base - 5000;
    const holder = [fromRecord({ ...target, props: JSON.parse(target.fields.props), kind: target.fields.kind })];
    holder[0].title = "v2";
    await assert.rejects(saveCanvas(refusesDeletes(db), p.id, holder), /refused/);
    Date.now = realNow;
    const edited = (await componentsOf(db, p.id)).find(r => JSON.parse(r.fields.props).title === "v2");
    const other = (await componentsOf(db, p.id)).find(r => r !== edited && r.id !== edited.id);
    assert.ok(edited.updated < other.updated, "setup: the edit carries the EARLIER clock");
    assert.deepStrictEqual((await openProject(db, p.id)).components.map(c => c.props.title), ["v2"], "the clock decided, not the generation");
  } finally {
    Date.now = realNow;
  }
});

await t("a component with a `key` field of its OWN is never taken for the builder's key", async () => {
  const db = await fresh(BACKENDS.LocalDb);
  const p = await createProject(db, { title: "own key" });
  // Legacy records whose component happens to have `key: "same"`.
  for (let i = 0; i < 2; i += 1) {
    await db.put(COMPONENT, { pid: p.id, kind: "form", props: JSON.stringify({ domain: "notes", key: "same" }) });
  }
  assert.strictEqual((await openProject(db, p.id)).components.length, 2, "two components with their own `key` prop collapsed");
  // And saved fresh: two components whose own `key` is equal stay two.
  const canvas = [{ type: "form", key: "same" }, { type: "form", key: "same" }];
  const q = await createProject(db, { title: "own key, saved" });
  await saveCanvas(db, q.id, canvas);
  assert.strictEqual((await openProject(db, q.id)).components.length, 2);
  assert.deepStrictEqual(canvas.map(c => c.key), ["same", "same"], "the component's own field was rewritten");
});

await t("LocalDb: two devices reading one stored state keep the same record", async () => {
  const s = storage();
  const one = new LocalDb(s);
  await defineProjectDomains(one);
  const p = await createProject(one, { title: "two devices" });
  const canvas = [{ type: "table", domain: "notes" }];
  await Promise.all([saveCanvas(one, p.id, canvas), saveCanvas(one, p.id, canvas)]);
  const two = new LocalDb(s);
  await defineProjectDomains(two);
  assert.deepStrictEqual(
    (await openProject(one, p.id)).components.map(c => c.id),
    (await openProject(two, p.id)).components.map(c => c.id),
  );
});

await t("records saved before keys existed are never collapsed", async () => {
  const db = await fresh(BACKENDS.LocalDb);
  const p = await createProject(db, { title: "legacy" });
  // Written the old way: props with no key.
  for (let i = 0; i < 2; i += 1) {
    await db.put(COMPONENT, { pid: p.id, kind: "table", props: JSON.stringify({ domain: "notes" }) });
  }
  assert.strictEqual((await openProject(db, p.id)).components.length, 2, "two keyless records were collapsed");
});
