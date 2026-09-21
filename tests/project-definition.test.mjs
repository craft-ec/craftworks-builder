// A project keeps ITS OWN definition — schemas, seed, tree binding, version
// stamp — not whatever the builder's one shared app object last held
// (builder#53).
//
// Run over BOTH backends a project can live on: the SDK's Db and LocalDb, the
// one the page actually uses. builder#59 was measured over one and broke the
// other; a test of what a project is made of runs over both or it is a test of
// one backend.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import { LocalDb } from "../local-db.js";
import {
  defineProjectDomains, createProject, openProject, saveDefinition, domainRecordsOf, DOMAIN, SCHEMAS,
} from "../projects.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const storage = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};

const schemaA = { type: "SchemaA", fields: [{ name: "title", kind: "text", required: true }] };
const schemaB = { type: "SchemaB", fields: [{ name: "name", kind: "text" }, { name: "n", kind: "int" }] };
const defA = { schemas: { tables: schemaA }, seed: { tables: [{ title: "a1" }] }, tree: { realm: "public", identity: null }, versions: { sdkRev: "aaa" } };
const defB = { schemas: { tables: schemaB }, seed: { tables: [{ name: "b1", n: 1 }, { name: "b2", n: 2 }] }, tree: { realm: "team", identity: "x" }, versions: { sdkRev: "bbb" } };

const backends = [
  ["the SDK's Db", () => new sdk.Db()],
  ["LocalDb", () => new LocalDb(storage())],
];

for (const [name, make] of backends) {
  const open = async () => {
    const db = make();
    await defineProjectDomains(db);
    return { db };
  };

  await t(`**[${name}] two projects, one domain name, different schemas and seeds: each keeps its own**`, async () => {
    const { db } = await open();
    const a = await createProject(db, { title: "Project 1" });
    const b = await createProject(db, { title: "Project 2" });
    await saveDefinition(db, a.id, defA);
    await saveDefinition(db, b.id, defB);

    const A = await openProject(db, a.id), B = await openProject(db, b.id);
    assert.deepStrictEqual(A.schemas, defA.schemas, "Project 1 reads SchemaA — it read SchemaB before (builder#53)");
    assert.deepStrictEqual(A.seed, defA.seed);
    assert.deepStrictEqual(A.tree, defA.tree);
    assert.deepStrictEqual(A.versions, defA.versions);
    assert.deepStrictEqual(B.schemas, defB.schemas);
    assert.deepStrictEqual(B.seed, defB.seed);
    assert.deepStrictEqual(B.versions, defB.versions);
  });

  await t(`[${name}] a new project carries NO definition from any other`, async () => {
    const { db } = await open();
    const a = await createProject(db, { title: "A" });
    await saveDefinition(db, a.id, defA);
    const fresh = await openProject(db, (await createProject(db, { title: "new" })).id);
    assert.deepStrictEqual(fresh.schemas, {});
    assert.deepStrictEqual(fresh.seed, {});
    assert.strictEqual(fresh.tree, null);
    assert.strictEqual(fresh.versions, null, "a new project must not inherit another project's stamp");
  });

  await t(`[${name}] saving is a DIFF: unchanged writes nothing, a changed domain one record, a dropped one is removed`, async () => {
    const { db } = await open();
    const a = await createProject(db, { title: "A" });
    const two = { ...defA, schemas: { ...defA.schemas, notes: schemaB }, seed: defA.seed };
    await saveDefinition(db, a.id, two);
    assert.deepStrictEqual(await saveDefinition(db, a.id, two),
      { added: 0, updated: 0, removed: 0, untouched: 2, project: false }, "a no-op save writes nothing");
    const changed = await saveDefinition(db, a.id, { ...two, schemas: { ...two.schemas, notes: schemaA } });
    assert.deepStrictEqual({ updated: changed.updated, untouched: changed.untouched }, { updated: 1, untouched: 1 });
    const dropped = await saveDefinition(db, a.id, defA);
    assert.strictEqual(dropped.removed, 1);
    assert.deepStrictEqual(Object.keys((await openProject(db, a.id)).schemas), ["tables"]);
  });

  await t(`[${name}] a project stored before #53 says it is LEGACY, and stops saying so once its definition is saved`, async () => {
    const { db } = await open();
    const a = await createProject(db, { title: "old" });
    assert.strictEqual((await openProject(db, a.id)).legacy, true,
      "no definition stored: the caller must not save an empty one over the working copy's");
    await saveDefinition(db, a.id, defA);
    assert.strictEqual((await openProject(db, a.id)).legacy, false);
  });

  await t(`[${name}] definition records are keyed under their project, and the domain declares its parent`, async () => {
    const { db } = await open();
    assert.strictEqual(SCHEMAS[DOMAIN].parent, "pid");
    const a = await createProject(db, { title: "A" }), b = await createProject(db, { title: "B" });
    await saveDefinition(db, a.id, defA);
    await saveDefinition(db, b.id, defB);
    assert.strictEqual((await domainRecordsOf(db, a.id)).length, 1, "A's definition read is A's records only");
  });
}

await t("[LocalDb] each project's definition survives a RELOAD", async () => {
  const s = storage();
  const db = new LocalDb(s);
  await defineProjectDomains(db);
  const a = await createProject(db, { title: "Project 1" });
  const b = await createProject(db, { title: "Project 2" });
  await saveDefinition(db, a.id, defA);
  await saveDefinition(db, b.id, defB);
  const again = new LocalDb(s);
  assert.deepStrictEqual((await openProject(again, a.id)).schemas, defA.schemas,
    "SchemaA was never stored with Project 1 before this change, so a reload could not recover it");
  assert.deepStrictEqual((await openProject(again, b.id)).seed, defB.seed);
});

console.log("\nproject definition: all ok");
