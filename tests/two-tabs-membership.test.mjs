// TWO TABS, MEMBERSHIP: a tab that never saw a component must not DELETE it,
// and a tab still holding one deleted elsewhere must not RESURRECT it
// (builder#78).
//
// builder#74 made a component's CONTENT dirty against a base; MEMBERSHIP was
// still diffed against storage. The removal pass deleted every stored record
// not on MY canvas — including ones another tab added that I never saw — and a
// component whose record was gone was treated as new and re-added. Now the
// canvas carries a base SET: the record ids this tab last loaded or wrote.
//
// Node and LocalDb over ONE shared storage, as the architect ran it.
import assert from "node:assert";
import { LocalDb } from "../local-db.js";
import { defineProjectDomains, createProject, openProject, componentsOf, listProjects, saveDefinition, PROJECT } from "../projects.js";

const node = () => new Proxy({ hidden: false, style: {}, contains: () => false },
  { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
globalThis.document = { createElement: () => node(), addEventListener() {} };
const panel = await import(process.env.PANEL ?? "../projects-panel.js");
const { saveCanvas, fromRecord, mountProjects } = panel;
// `canvasOf` assembles a canvas AND records its base set. Code before this
// change has no such thing and assembles with a bare map, which is exactly
// what it did — so the same file runs as its own control against it.
const canvasOf = panel.canvasOf ?? (p => p.components.map(fromRecord));

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const storage = () => {
  const m = new Map();
  return { m, get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};
const told = [];
const opts = by => ({ by, onConflict: m => told.push({ by, m }) });
const labels = canvas => canvas.map(c => c.label).sort();
const storedLabels = async (db, pid) => (await openProject(db, pid)).components.map(c => c.props?.label).sort();
// The components stored under a project id, read directly — what is in storage
// whether or not the project record is.
const rawLabels = async (db, pid) => (await componentsOf(db, pid)).map(r => JSON.parse(r.fields.props).label).sort();

async function twoTabs() {
  const st = storage();
  const db = new LocalDb(st);
  await defineProjectDomains(db);
  const p = await createProject(db, { title: "shared" });
  await saveCanvas(db, p.id, [{ type: "table", domain: "k", label: "K v0" }, { type: "form", domain: "m", label: "M v0" }], { by: "setup" });
  const open = async () => canvasOf(await openProject(db, p.id));
  return { st, db, pid: p.id, tab1: await open(), tab2: await open() };
}

await t("**A: tab 1 ADDS N, tab 2 edits only M — tab 2 must not delete N; it ADOPTS it**", async () => {
  told.length = 0;
  const { db, pid, tab1, tab2 } = await twoTabs();
  tab1.push({ type: "list", domain: "n", label: "N (tab 1)" });
  await saveCanvas(db, pid, tab1, opts("tab1"));
  tab2.find(c => c.domain === "m").label = "M v1 (tab 2)";
  const did = await saveCanvas(db, pid, tab2, opts("tab2"));
  assert.strictEqual(did.removed, 0, `tab 2 never saw N and must not remove it: ${JSON.stringify(did)}`);
  assert.deepStrictEqual(await storedLabels(db, pid), ["K v0", "M v1 (tab 2)", "N (tab 1)"], "N is still in the STORE");
  assert.deepStrictEqual(labels(tab2), ["K v0", "M v1 (tab 2)", "N (tab 1)"], "and tab 2's CANVAS adopted it");
  assert.deepStrictEqual(labels(tab1), ["K v0", "M v0", "N (tab 1)"], "tab 1's canvas is as tab 1 left it");
  assert.strictEqual(told.length, 0);
});

await t("**B: tab 1 DELETES K, tab 2 edits only M — tab 2 must not resurrect K; it DROPS it**", async () => {
  told.length = 0;
  const { db, pid, tab1, tab2 } = await twoTabs();
  tab1.splice(tab1.findIndex(c => c.domain === "k"), 1);
  await saveCanvas(db, pid, tab1, opts("tab1"));
  tab2.find(c => c.domain === "m").label = "M v1 (tab 2)";
  const did = await saveCanvas(db, pid, tab2, opts("tab2"));
  assert.strictEqual(did.added, 0, `a clean K deleted elsewhere must not be re-added: ${JSON.stringify(did)}`);
  assert.deepStrictEqual(await storedLabels(db, pid), ["M v1 (tab 2)"], "K stays deleted in the STORE");
  assert.deepStrictEqual(labels(tab2), ["M v1 (tab 2)"], "and tab 2's CANVAS dropped it");
  assert.strictEqual(told.length, 0, "a clean copy dropped is not a conflict");
});

await t("**deleted elsewhere while DIRTY here: the person's version is kept (re-added) and they are TOLD, once**", async () => {
  told.length = 0;
  const { db, pid, tab1, tab2 } = await twoTabs();
  tab1.splice(tab1.findIndex(c => c.domain === "k"), 1);
  await saveCanvas(db, pid, tab1, opts("tab1"));
  tab2.find(c => c.domain === "k").label = "K edited in tab 2";
  const did = await saveCanvas(db, pid, tab2, opts("tab2"));
  assert.strictEqual(did.added, 1, "the edited K comes back — it is the person's work");
  assert.ok((await storedLabels(db, pid)).includes("K edited in tab 2"));
  assert.strictEqual(told.length, 1, `told once: ${JSON.stringify(told)}`);
  assert.match(told[0].m, /deleted in another tab/);
  await saveCanvas(db, pid, tab2, opts("tab2"));
  assert.strictEqual(told.length, 1, "and not again");
});

await t("THE CONTROL: one tab adding, deleting and editing writes exactly what it always did", async () => {
  const { db, pid, tab1 } = await twoTabs();
  const seq = [];
  tab1.push({ type: "list", domain: "n", label: "N" });
  seq.push(await saveCanvas(db, pid, tab1, opts("tab1")));
  tab1.splice(tab1.findIndex(c => c.domain === "k"), 1);
  seq.push(await saveCanvas(db, pid, tab1, opts("tab1")));
  tab1.find(c => c.domain === "m").label = "M v1";
  seq.push(await saveCanvas(db, pid, tab1, opts("tab1")));
  seq.push(await saveCanvas(db, pid, tab1, opts("tab1")));
  const w = d => [d.added, d.updated, d.removed];
  assert.deepStrictEqual(seq.map(w), [[1, 0, 0], [0, 0, 1], [0, 1, 0], [0, 0, 0]],
    "add one, remove one, update one, then nothing — the fix cannot change an ordinary tab's writes");
  assert.deepStrictEqual(await storedLabels(db, pid), ["M v1", "N"]);
});

await t("**the panel RE-RENDERS after a membership adopt, through what mountProjects returns**", async () => {
  if (!panel.canvasOf) throw new assert.AssertionError({ message: "no canvasOf: this code has no base set" });
  const st = storage();
  const db = new LocalDb(st);
  await defineProjectDomains(db);
  const p = await createProject(db, { title: "shared" });
  await saveCanvas(db, p.id, [{ type: "table", domain: "k", label: "K" }], { by: "setup" });
  st.setItem("craftec.builder.device.v1", JSON.stringify({ lastOpened: p.id }));
  let canvas = [], renders = 0;
  const x = await mountProjects(node(), { db, storage: st, getCanvas: () => canvas, setCanvas: c => { canvas = c; },
    onChange: () => { renders += 1; }, onConflict: () => {} });
  const other = canvasOf(await openProject(db, p.id));
  other.push({ type: "list", domain: "n", label: "N from the other tab" });
  await saveCanvas(db, p.id, other, { by: "other", onConflict: () => {} });
  const before = renders;
  await x.persist();
  assert.strictEqual(renders - before, 1, "a membership adopt changed the canvas under the person: drawn again");
  assert.ok(canvas.some(c => c.label === "N from the other tab"));
});

await t("**the panel RE-RENDERS after a membership DROP, too**", async () => {
  if (!panel.canvasOf) throw new assert.AssertionError({ message: "no canvasOf: this code has no base set" });
  const st = storage();
  const db = new LocalDb(st);
  await defineProjectDomains(db);
  const p = await createProject(db, { title: "shared" });
  await saveCanvas(db, p.id, [{ type: "table", domain: "k", label: "K" }, { type: "form", domain: "m", label: "M" }], { by: "setup" });
  st.setItem("craftec.builder.device.v1", JSON.stringify({ lastOpened: p.id }));
  let canvas = [], renders = 0;
  const x = await mountProjects(node(), { db, storage: st, getCanvas: () => canvas, setCanvas: c => { canvas = c; },
    onChange: () => { renders += 1; }, onConflict: () => {} });
  const other = canvasOf(await openProject(db, p.id));
  other.splice(other.findIndex(c => c.domain === "k"), 1);
  await saveCanvas(db, p.id, other, { by: "other", onConflict: () => {} });
  const before = renders;
  await x.persist();
  assert.strictEqual(renders - before, 1, "a component deleted elsewhere left this canvas: drawn again");
  assert.deepStrictEqual(canvas.map(c => c.label), ["M"]);
});

// ---- Clear, and a canvas with no base set (review of #79) -------------------

await t("**a canvas with NO base set deletes nothing it cannot show it held** (a Clear that replaced the array)", async () => {
  const { db, pid, tab1 } = await twoTabs();
  tab1.push({ type: "list", domain: "n", label: "N (tab 1)" });
  await saveCanvas(db, pid, tab1, opts("tab1"));
  // The old Clear: a FRESH array, with no record of what this tab held.
  const did = await saveCanvas(db, pid, [], opts("tab2"));
  assert.strictEqual(did.removed, 0, `a fresh canvas must not delete what another tab added: ${JSON.stringify(did)}`);
  assert.deepStrictEqual(await storedLabels(db, pid), ["K v0", "M v0", "N (tab 1)"]);
});

await t("**Clear in place removes what THIS tab held, and adopts what another tab added since**", async () => {
  const { db, pid, tab1, tab2 } = await twoTabs();
  tab1.push({ type: "list", domain: "n", label: "N (tab 1)" });
  await saveCanvas(db, pid, tab1, opts("tab1"));
  tab2.length = 0;                                   // app.js's Clear, now in place
  const did = await saveCanvas(db, pid, tab2, opts("tab2"));
  assert.strictEqual(did.removed, 2, "K and M, which this tab held and cleared");
  assert.deepStrictEqual(await storedLabels(db, pid), ["N (tab 1)"], "N, which it never saw, survives");
  assert.deepStrictEqual(labels(tab2), ["N (tab 1)"], "and arrives on the cleared canvas");
});

// ---- the store LOST under an open tab (architect's probe of #78) ------------

await t("**the store is LOST under an open tab: nothing is dropped; the components are saved again and the person is TOLD**", async () => {
  told.length = 0;
  const { st, db, pid, tab1 } = await twoTabs();
  st.m.clear();                                       // cleared site data, with the tab still open
  await defineProjectDomains(db);
  const did = await saveCanvas(db, pid, tab1, opts("tab1"));
  assert.strictEqual(did.dropped, 0, "deleted-elsewhere presumes the project is still there; it is not");
  assert.strictEqual(did.restored, 2);
  assert.deepStrictEqual(labels(tab1), ["K v0", "M v0"], "the canvas — the only copy left — is intact");
  assert.deepStrictEqual(await rawLabels(db, pid), ["K v0", "M v0"], "and it is back in storage");
  assert.deepStrictEqual(told.map(x => x.m), ["This device's saved copy of this project was missing; it has been saved again from this tab."],
    "told once, and told what is TRUE: the same project, saved again");
});

// ---- builder#82: a restore a reload can OPEN ---------------------------------

/**
 * The store lost under an open tab, then that tab's save — through
 * `mountProjects`' own save chain, so the definition follows the canvas as it
 * does in the product — then a RELOAD: a fresh LocalDb over the same storage.
 */
async function lostThenReload() {
  told.length = 0;
  const { st, db, pid, tab1 } = await twoTabs();
  const definition = { schemas: { k: { type: "K", fields: [{ name: "title", kind: "text" }] } }, seed: {}, tree: { realm: "public", identity: null } };
  await saveDefinition(db, pid, definition);
  const before = await openProject(db, pid);
  const tab = canvasOf(before);
  st.m.clear();                                       // cleared site data, with the tab still open
  await defineProjectDomains(db);
  const did = await saveCanvas(db, pid, tab, opts("tab1"));
  await saveDefinition(db, pid, definition);          // what the panel's save does next
  const reloaded = new LocalDb(st);
  return { did, before, pid, reloaded, st };
}

await t("**after a restore, a RELOAD opens THE SAME project — listed, its components under their own ids, its schemas**", async () => {
  const { did, before, pid, reloaded } = await lostThenReload();
  assert.strictEqual(did.restoredProject, true);
  assert.deepStrictEqual((await listProjects(reloaded)).map(p => p.id), [pid], "listed, under its own id");
  const after = await openProject(reloaded, pid);
  assert.ok(after, "openProject opens it: on the code before this change it returned null");
  assert.strictEqual(after.title, before.title);
  assert.deepStrictEqual(after.record, before.record, "the record the tab held, put back exactly");
  assert.deepStrictEqual(after.components.map(c => c.id).sort(), before.components.map(c => c.id).sort(),
    "the components under THEIR OWN ids, not new ones");
  assert.deepStrictEqual(Object.keys(after.schemas), ["k"], "and its definition");
});

await t("THE CONTROL: an ORDINARY save writes nothing to the project record", async () => {
  const { st, db, pid, tab1 } = await twoTabs();
  const projectKey = k => k.includes(`/r/${PROJECT}/`);
  const writes = [];
  const set = st.setItem;
  st.setItem = (k, v) => { if (projectKey(k)) writes.push(k); return set.call(st, k, v); };
  tab1.find(c => c.domain === "k").label = "K v1";
  const did = await saveCanvas(db, pid, tab1, opts("tab1"));
  assert.strictEqual(did.updated, 1);
  assert.strictEqual(did.restoredProject, false);
  assert.deepStrictEqual(writes, [], "the restore path must not run on a store that is intact");
});

await t("a canvas that never read the record cannot put it back: the components return, and the save FAILS loudly", async () => {
  told.length = 0;
  const { st, db, pid, tab1 } = await twoTabs();
  // A base set with no record copy: what a canvas assembled some other way holds.
  const bare = canvasOf({ id: pid, components: (await openProject(db, pid)).components });
  st.m.clear();
  await defineProjectDomains(db);
  await assert.rejects(saveCanvas(db, pid, bare, opts("tab1")), /holds no copy of the project record/);
  assert.deepStrictEqual(await rawLabels(db, pid), ["K v0", "M v0"], "the components are back before the error");
  assert.deepStrictEqual(told, [], "and nobody was told it was saved");
});

await t("with no one to tell, a lost store is still saved again FIRST, then the save fails loudly", async () => {
  const { st, db, pid, tab1 } = await twoTabs();
  st.m.clear();
  await defineProjectDomains(db);
  await assert.rejects(saveCanvas(db, pid, tab1, { by: "tab1" }), /stored copy was lost.*no onConflict/);
  assert.deepStrictEqual(await rawLabels(db, pid), ["K v0", "M v0"], "the data is back before the error");
});

console.log("\ntwo tabs, membership: all ok");
