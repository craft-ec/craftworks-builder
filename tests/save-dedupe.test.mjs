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
import { defineProjectDomains, createProject, componentsOf, openProject, COMPONENT } from "../projects.js";
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
/** Refuses the first component delete outright: a save stopped before its removals. */
const refusesDeleteOnce = db => {
  let armed = true;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "delete") {
        return async (domain, ...rest) => {
          if (armed && domain === COMPONENT) { armed = false; throw new Error("refused"); }
          return target.delete(domain, ...rest);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
};

for (const [name, make] of Object.entries(BACKENDS)) {
  await t(`${name}: an add whose answer was lost is shown ONCE on reload, and the next save removes the extra`, async () => {
    const db = await fresh(make);
    const p = await createProject(db, { title: "lost answer" });
    const canvas = [{ type: "table", domain: "notes" }];
    await assert.rejects(saveCanvas(failsAfterOnce(db, "put", "the answer was lost"), p.id, canvas), /answer was lost/);
    assert.strictEqual(canvas[0].rid, undefined, "setup: the canvas never learnt the record's id");
    // The next save adds it again, and would remove the orphan in its removal
    // pass — which is refused, so the save stops partway: the superset state.
    await assert.rejects(saveCanvas(refusesDeleteOnce(db), p.id, canvas), /refused/);
    const stored = await componentsOf(db, p.id);
    assert.strictEqual(stored.length, 2, "setup: the store now holds two records for one component");
    const opened = await openProject(db, p.id);
    assert.strictEqual(opened.components.length, 1, `reload shows ${opened.components.length} components for one`);
    assert.strictEqual(opened.components[0].id, canvas[0].rid, "the record kept is the one the canvas holds");
    // THE HEAL IS REAL, not merely hidden: the next save from the reloaded
    // canvas leaves one record in the store.
    await saveCanvas(db, p.id, opened.components.map(fromRecord));
    assert.strictEqual((await componentsOf(db, p.id)).length, 1, "the extra record survived the next save");
  });

  await t(`${name}: two saves that overlap store the new component ONCE`, async () => {
    const db = await fresh(make);
    const p = await createProject(db, { title: "overlap" });
    const canvas = [{ type: "table", domain: "notes" }];
    const save = serialSaves((pid, c) => saveCanvas(db, pid, c));
    await Promise.all([save(p.id, canvas), save(p.id, canvas)]);
    assert.strictEqual((await componentsOf(db, p.id)).length, 1, "the serial save let two adds through");
  });

  await t(`${name}: CONTROL — without the serial save, the overlap still stores two, and reload still shows one`, async () => {
    // The audit's reproduction, unchanged: `saveCanvas` called twice at once.
    // The store gets two records; the key assigned before the first await is
    // what lets the load path know they are one component.
    const db = await fresh(make);
    const p = await createProject(db, { title: "raw overlap" });
    const canvas = [{ type: "table", domain: "notes" }];
    await Promise.all([saveCanvas(db, p.id, canvas), saveCanvas(db, p.id, canvas)]);
    assert.strictEqual((await componentsOf(db, p.id)).length, 2, "setup: the raw overlap still double-adds — the serial save is what prevents it");
    assert.strictEqual((await openProject(db, p.id)).components.length, 1, "reload showed the overlapped component twice");
  });

  await t(`${name}: CONTROL — components that merely LOOK alike are all kept`, async () => {
    const db = await fresh(make);
    const p = await createProject(db, { title: "twins" });
    const canvas = [{ type: "table", domain: "notes" }, { type: "table", domain: "notes" }, { type: "list", domain: "notes" }];
    await saveCanvas(db, p.id, canvas);
    const opened = await openProject(db, p.id);
    assert.strictEqual(opened.components.length, 3, "two identical-looking components were collapsed into one");
  });

  await t(`${name}: the same stored state resolves the same way on every open`, async () => {
    const db = await fresh(make);
    const p = await createProject(db, { title: "deterministic" });
    const canvas = [{ type: "table", domain: "notes" }];
    await Promise.all([saveCanvas(db, p.id, canvas), saveCanvas(db, p.id, canvas)]);
    const ids = await componentsOf(db, p.id).then(rs => rs.map(r => r.id));
    const a = (await openProject(db, p.id)).components.map(c => c.id);
    const b = (await openProject(db, p.id)).components.map(c => c.id);
    assert.deepStrictEqual(a, b);
    // The rule is "larger id wins". That the larger id is the record added
    // LATER is checked independently in the lost-answer test above, where the
    // kept record must be the one the canvas holds — the second add.
    assert.deepStrictEqual(a, [ids.reduce((x, y) => (y > x ? y : x))], "the kept record is not the larger id");
  });
}

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
