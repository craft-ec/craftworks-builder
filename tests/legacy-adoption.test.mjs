// LEGACY ADOPTION: projects stored before builder#53 adopt the pre-upgrade
// working copy — once, from a snapshot, schema to every binder and seed rows to
// exactly one (the ruling on builder#67, after the architect's probe).
//
// Run in node with a stub DOM, the way the architect's probe runs, so no page
// and no fixed ports (builder#70). `mountProjects` is the real one.
import assert from "node:assert";
import { LocalDb } from "../local-db.js";
import { defineProjectDomains, createProject, openProject, addComponent } from "../projects.js";

const node = () => new Proxy({ hidden: false, style: {}, contains: () => false },
  { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
globalThis.document = { createElement: () => node(), addEventListener() {} };
const { mountProjects, toRecord, LEGACY_SNAPSHOT_KEY } = await import("../projects-panel.js");

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const storage = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};
const mount = (db, st, copy) => mountProjects(node(), { db, storage: st, getCanvas: () => [], setCanvas() {}, getDefinition: () => copy });
const lastOpened = (st, id) => st.setItem("craftec.builder.device.v1", JSON.stringify({ lastOpened: id }));
const fresh = async () => { const st = storage(), db = new LocalDb(st); await defineProjectDomains(db); return { st, db }; };
const legacyOn = async (db, title, domain) => {
  const p = await createProject(db, { title });   // stored the OLD way: no definition
  await addComponent(db, p.id, toRecord({ type: "table", domain }));
  return p;
};
const def = async (db, p) => { const o = await openProject(db, p.id); return { schemas: o.schemas, seed: o.seed }; };

const invoices = { fields: [{ name: "invoice_no", kind: "text" }] };
const rows = [{ invoice_no: "INV-7" }];

// ---- probe A: two legacy projects on the builder's DEFAULT domain name --------

await t("**probe A: two projects on the default `tables` both get the schema, and NEITHER gets the rows**", async () => {
  const { st, db } = await fresh();
  const p1 = await legacyOn(db, "P1 recipes", "tables");
  const p2 = await legacyOn(db, "P2 invoices", "tables");
  await mount(db, st, { schemas: { tables: invoices }, seed: { tables: rows } });
  const [a, b] = [await def(db, p1), await def(db, p2)];
  assert.deepStrictEqual(a.schemas, { tables: invoices }, "a schema describes records: every binder adopts it");
  assert.deepStrictEqual(b.schemas, { tables: invoices });
  assert.deepStrictEqual(a.seed, {}, "rows are one project's DATA: with two binders and neither last-opened, nobody gets them");
  assert.deepStrictEqual(b.seed, {});
  const snap = JSON.parse(st.getItem(LEGACY_SNAPSHOT_KEY));
  assert.deepStrictEqual(snap.copy.seed, { tables: rows }, "the rows stay in the snapshot, the recovery store");
});

await t("**probe A, with P2 last-opened: the rows go to P2 and ONLY to P2**", async () => {
  const { st, db } = await fresh();
  const p1 = await legacyOn(db, "P1 recipes", "tables");
  const p2 = await legacyOn(db, "P2 invoices", "tables");
  lastOpened(st, p2.id);
  await mount(db, st, { schemas: { tables: invoices }, seed: { tables: rows } });
  assert.deepStrictEqual((await def(db, p2)).seed, { tables: rows }, "the last-opened binder takes the rows");
  assert.deepStrictEqual((await def(db, p1)).seed, {}, "and P1 does NOT get P2's invoice as a recipe");
  assert.deepStrictEqual((await def(db, p1)).schemas, { tables: invoices }, "though it does get the schema");
});

await t("a SOLE binder of a domain takes its rows even when it was not last-opened", async () => {
  const { st, db } = await fresh();
  const p1 = await legacyOn(db, "P1", "a");
  const p2 = await legacyOn(db, "P2", "b");
  lastOpened(st, p2.id);
  await mount(db, st, { schemas: { a: invoices }, seed: { a: rows } });
  assert.deepStrictEqual((await def(db, p1)).seed, { a: rows });
});

// ---- probe B: a project made AFTER the upgrade must not leak in ---------------

await t("**probe B: a project created after the upgrade, sharing a domain name, does not leak in on a later mount**", async () => {
  const { st, db } = await fresh();
  const p1 = await legacyOn(db, "P1 legacy", "a");
  await mount(db, st, { schemas: {}, seed: {} });          // mount 1: the copy held nothing for `a`
  const after1 = await def(db, p1);
  // Later a NEW project Q uses a domain also called `a`; the working copy now holds Q's.
  const q = await createProject(db, { title: "Q new" });
  await addComponent(db, q.id, toRecord({ type: "table", domain: "a" }));
  const qCopy = { schemas: { a: { fields: [{ name: "patient", kind: "text" }] } }, seed: { a: [{ patient: "J. Doe" }] } };
  await mount(db, st, qCopy);                               // mount 2, with Q's copy live
  assert.deepStrictEqual(await def(db, p1), after1, "P1 must not adopt Q's patient schema or rows");
  assert.deepStrictEqual((await def(db, q)).schemas, {}, "and Q, made after the upgrade, is not a legacy project at all");
});

// ---- once, from a snapshot ------------------------------------------------------

await t("**mounting twice with a changed copy moves nothing**", async () => {
  const { st, db } = await fresh();
  const p1 = await legacyOn(db, "P1", "a");
  lastOpened(st, p1.id);
  await mount(db, st, { schemas: { a: invoices }, seed: {} });
  const after1 = await def(db, p1);
  await mount(db, st, { schemas: { a: { fields: [{ name: "changed", kind: "text" }] }, z: invoices }, seed: {} });
  assert.deepStrictEqual(await def(db, p1), after1, "the second mount adopts nothing: the snapshot, not the live copy");
});

await t("the snapshot is written once and KEPT, and a later copy does not overwrite it", async () => {
  const { st, db } = await fresh();
  await legacyOn(db, "P1", "a");
  await mount(db, st, { schemas: { a: invoices }, seed: {} });
  const first = st.getItem(LEGACY_SNAPSHOT_KEY);
  assert.ok(first, "taken at the first mount");
  await mount(db, st, { schemas: { a: { fields: [] } }, seed: {} });
  assert.strictEqual(st.getItem(LEGACY_SNAPSHOT_KEY), first, "never rewritten from a later working copy");
});

await t("**adoption is RECORDED even when a project adopted zero domains**", async () => {
  const { st, db } = await fresh();
  const p1 = await legacyOn(db, "P1", "a");
  await mount(db, st, { schemas: {}, seed: {} });
  const snap = JSON.parse(st.getItem(LEGACY_SNAPSHOT_KEY));
  assert.deepStrictEqual(snap.pending, [p1.id]);
  assert.deepStrictEqual(snap.adopted, [p1.id], "done is a recorded fact, not three nulls");
});

await t("the last-opened project keeps copy domains no listed project binds", async () => {
  const { st, db } = await fresh();
  const p1 = await legacyOn(db, "P1", "a");
  const p2 = await legacyOn(db, "P2", "b");
  lastOpened(st, p2.id);
  await mount(db, st, { schemas: { a: invoices, b: invoices, z: invoices }, seed: { z: rows } });
  assert.deepStrictEqual(Object.keys((await def(db, p2)).schemas).sort(), ["b", "z"]);
  assert.deepStrictEqual((await def(db, p2)).seed, { z: rows });
  assert.deepStrictEqual(Object.keys((await def(db, p1)).schemas), ["a"]);
});

await t("a refused snapshot write adopts NOTHING — never from the live copy by another name", async () => {
  const { st, db } = await fresh();
  const p1 = await legacyOn(db, "P1", "a");
  const set = st.setItem;
  st.setItem = (k, v) => { if (k === LEGACY_SNAPSHOT_KEY) throw new Error("QuotaExceededError"); return set(k, v); };
  await mount(db, st, { schemas: { a: invoices }, seed: {} });
  assert.deepStrictEqual((await def(db, p1)).schemas, {}, "no snapshot, no adoption");
});

console.log("\nlegacy adoption: all ok");
