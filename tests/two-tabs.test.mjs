// TWO TABS ON ONE PROJECT: a tab that never touched a component must not
// revert another tab's edit to it (builder#74).
//
// `saveCanvas` diffed the canvas against what is STORED. With one holder that
// is the same as "against what I last loaded or wrote"; with two it is not —
// tab 2's untouched, stale copy of K differed from tab 1's fresh one and was
// written back. Now each component is dirty against its BASE: what it looked
// like when this tab last loaded or wrote it.
//
// Two tabs are two canvases, each with its own tab token, over ONE shared
// storage — node and LocalDb, no page and no ports, as the architect ran it.
import assert from "node:assert";
import { LocalDb } from "../local-db.js";
import { defineProjectDomains, createProject, openProject, addComponent } from "../projects.js";

const node = () => new Proxy({ hidden: false, style: {}, contains: () => false },
  { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
globalThis.document = { createElement: () => node(), addEventListener() {} };
const { saveCanvas, fromRecord, toRecord } = await import("../projects-panel.js");

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const storage = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};

/** A project with two components K and M, saved once, and two tabs that opened it. */
async function twoTabs() {
  const st = storage();
  const db = new LocalDb(st);
  await defineProjectDomains(db);
  const p = await createProject(db, { title: "shared" });
  const setup = [{ type: "table", domain: "k", label: "K v0" }, { type: "form", domain: "m", label: "M v0" }];
  await saveCanvas(db, p.id, setup, { by: "setup" });
  const open = async () => (await openProject(db, p.id)).components.map(c => fromRecord({ ...c, props: c.props }));
  return { db, pid: p.id, tab1: await open(), tab2: await open() };
}
const byDomain = (canvas, d) => canvas.find(c => c.domain === d);
const stored = async (db, pid, d) => (await openProject(db, pid)).components.find(c => c.props?.domain === d)?.props?.label;
const conflicts = [];
const opts = by => ({ by, onConflict: m => conflicts.push({ by, m }) });

await t("**the architect's scenario: tab 2 edits ONLY M, and tab 1's edit to K survives**", async () => {
  const { db, pid, tab1, tab2 } = await twoTabs();
  byDomain(tab1, "k").label = "K v1 (tab 1's edit)";
  await saveCanvas(db, pid, tab1, opts("tab1"));
  byDomain(tab2, "m").label = "M v1 (tab 2's edit)";
  const did = await saveCanvas(db, pid, tab2, opts("tab2"));
  assert.strictEqual(did.updated, 1, `tab 2 changed ONE component and must write one; it wrote ${did.updated}`);
  assert.strictEqual(await stored(db, pid, "k"), "K v1 (tab 1's edit)", "K in the STORE is still tab 1's");
  assert.strictEqual(byDomain(tab2, "k").label, "K v1 (tab 1's edit)", "and tab 2's CANVAS adopted it, rather than keeping a stale K");
  assert.strictEqual(byDomain(tab1, "k").label, "K v1 (tab 1's edit)", "tab 1's canvas is unchanged");
  assert.strictEqual(await stored(db, pid, "m"), "M v1 (tab 2's edit)");
});

await t("THE CONTROL: one holder editing K writes it ONCE — the fix cannot stop ordinary saves", async () => {
  const { db, pid, tab1 } = await twoTabs();
  byDomain(tab1, "k").label = "K v1";
  const did = await saveCanvas(db, pid, tab1, opts("tab1"));
  assert.deepStrictEqual({ updated: did.updated, untouched: did.untouched }, { updated: 1, untouched: 1 });
  assert.strictEqual(await stored(db, pid, "k"), "K v1");
  const again = await saveCanvas(db, pid, tab1, opts("tab1"));
  assert.strictEqual(again.updated, 0, "and a second save with nothing changed writes nothing");
});

await t("**both tabs edit the SAME component: last writer wins, and that person is TOLD — once**", async () => {
  conflicts.length = 0;
  const { db, pid, tab1, tab2 } = await twoTabs();
  byDomain(tab1, "k").label = "K from tab 1";
  await saveCanvas(db, pid, tab1, opts("tab1"));
  byDomain(tab2, "k").label = "K from tab 2";
  await saveCanvas(db, pid, tab2, opts("tab2"));
  assert.strictEqual(await stored(db, pid, "k"), "K from tab 2", "the last writer's version is kept");
  assert.strictEqual(conflicts.length, 1, `exactly one notice: ${JSON.stringify(conflicts)}`);
  assert.strictEqual(conflicts[0].by, "tab2", "told to the tab whose save met the other's change");
  assert.match(conflicts[0].m, /changed in another tab; your version was kept/);
  // And it is not repeated on the next save: tab 2's base is now its own write.
  await saveCanvas(db, pid, tab2, opts("tab2"));
  assert.strictEqual(conflicts.length, 1);
});

await t("**simultaneous saves from one base never silently revert: the other tab ADOPTS on its next save**", async () => {
  conflicts.length = 0;
  const { db, pid, tab1, tab2 } = await twoTabs();
  byDomain(tab1, "k").label = "K from tab 1";
  byDomain(tab2, "m").label = "M from tab 2";
  await Promise.all([saveCanvas(db, pid, tab1, opts("tab1")), saveCanvas(db, pid, tab2, opts("tab2"))]);
  // Each tab now saves anything again: neither may write the other's component back.
  await saveCanvas(db, pid, tab1, opts("tab1"));
  await saveCanvas(db, pid, tab2, opts("tab2"));
  assert.strictEqual(await stored(db, pid, "k"), "K from tab 1");
  assert.strictEqual(await stored(db, pid, "m"), "M from tab 2");
  assert.strictEqual(byDomain(tab1, "m").label, "M from tab 2", "tab 1 adopted M");
  assert.strictEqual(byDomain(tab2, "k").label, "K from tab 1", "tab 2 adopted K");
  assert.strictEqual(conflicts.length, 0, "different components: no conflict to tell anyone about");
});

await t("a conflict with no one to tell FAILS, naming what is missing — it is never silent", async () => {
  const { db, pid, tab1, tab2 } = await twoTabs();
  byDomain(tab1, "k").label = "a";
  await saveCanvas(db, pid, tab1, opts("tab1"));
  byDomain(tab2, "k").label = "b";
  await assert.rejects(saveCanvas(db, pid, tab2, { by: "tab2" }), /onConflict/);
});

await t("the base is NOT stored: a record's props carry no base, only the token", async () => {
  const { db, pid, tab1 } = await twoTabs();
  byDomain(tab1, "k").label = "K v1";
  await saveCanvas(db, pid, tab1, opts("tab1"));
  const props = (await openProject(db, pid)).components.find(c => c.props?.domain === "k").props;
  assert.deepStrictEqual(Object.keys(props._builder).sort(), ["by", "gen", "key"]);
  assert.ok(!JSON.stringify(toRecord(byDomain(tab1, "k"))).includes("K v0"), "the base content never rides in a record");
});

console.log("\ntwo tabs: all ok");
