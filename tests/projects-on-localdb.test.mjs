// projects.js THROUGH LocalDb — the backend the page actually keeps projects on.
//
// Every other projects test runs over the SDK's `Db`. builder#59 switched
// `componentsOf` and `publicationsOf` to `db.children`, measured there, and
// LocalDb had no `children`: in the real page every save and every panel paint
// threw `db.children is not a function`, and `app.js` swallowed it. Green
// suite, broken product — the defect the workspace rule "test through the
// ENTRY an app uses" exists for, missed again.
//
// So the panel's flows run here over LocalDb, and as the control over the
// LocalDb of `aef3994` — the last commit WITHOUT `children` — which must fail
// them. Pinned to a commit rather than `origin/main`, or the control would
// stop being a control the moment this fix merged.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDb } from "../local-db.js";
import {
  defineProjectDomains, createProject, listProjects, addComponent, componentsOf,
  setComponentProps, removeComponent, openProject, recordPublication, nextSeq, publicationsOf,
  restoreProject, restoreComponent,
} from "../projects.js";

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const storage = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};

/** The flows the projects panel runs, over whichever LocalDb it is given. */
async function panelFlows(Db) {
  const s = storage();
  const db = new Db(s);
  await defineProjectDomains(db);
  const a = await createProject(db, { title: "A" });
  const b = await createProject(db, { title: "B" });
  const c1 = await addComponent(db, a.id, { kind: "table", props: { i: 1 } });
  await addComponent(db, a.id, { kind: "form" });
  await addComponent(db, b.id, { kind: "list" });

  // paint(): one count per project row.
  const counts = {};
  for (const r of await listProjects(db)) counts[r.fields.title] = (await componentsOf(db, r.id)).length;
  assert.deepStrictEqual(counts, { A: 2, B: 1 }, "each project's count is its own components");

  await setComponentProps(db, c1.id, { i: 2 });
  await removeComponent(db, c1.id);
  assert.strictEqual((await componentsOf(db, a.id)).length, 1);

  // Publishing history: nextSeq reads publicationsOf.
  assert.strictEqual(await nextSeq(db, a.id), 1);
  await recordPublication(db, a.id, { seq: 1 });
  await recordPublication(db, b.id, { seq: 1 });
  assert.strictEqual(await nextSeq(db, a.id), 2, "B's publication does not count as A's");
  assert.strictEqual((await publicationsOf(db, a.id)).length, 1);

  // And it all survives a reload, which is LocalDb's whole reason to exist.
  const again = new Db(s);
  assert.strictEqual((await componentsOf(again, a.id)).length, 1);
  const opened = await openProject(again, a.id);
  assert.ok(opened, "the project opens after a reload");
}

await t("**the projects panel's flows run over LocalDb, the backend the page uses**", async () => {
  await panelFlows(LocalDb);
});

await t("THE CONTROL: over aef3994's LocalDb the same flows FAIL — this is the regression", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-localdb-main-"));
  const p = join(dir, "local-db.mjs");
  writeFileSync(p, execFileSync("git", ["show", "aef3994:local-db.js"], { cwd: new URL("..", import.meta.url).pathname }));
  const { LocalDb: MainDb } = await import(p);
  await assert.rejects(panelFlows(MainDb), /children is not a function/,
    "aef3994's LocalDb must fail on exactly the missing method, or this control proves nothing");
});

await t("children refuses a domain that declares no parent, as the SDK does", async () => {
  const db = new LocalDb(storage());
  await defineProjectDomains(db);
  await assert.rejects(db.children("project", "x"), /does not declare a parent/);
});

await t("**over the projects' store (LocalDb), a project and a component are restored under THEIR OWN ids** (builder#82)", async () => {
  const mk = async () => { const db = new LocalDb(storage()); await defineProjectDomains(db); return db; };
  const had = await mk();
  const p = await createProject(had, { title: "Kept" });
  const c = await addComponent(had, p.id, { kind: "table", props: { domain: "notes" } });
  const lost = await mk();                           // the store, gone
  const rp = await restoreProject(lost, p.id, (await openProject(had, p.id)).record);
  const rc = await restoreComponent(lost, p.id, c.id, { kind: "table", props: { domain: "notes" } });
  assert.deepStrictEqual([rp.outcome, rp.record.id], ["created", p.id]);
  assert.deepStrictEqual([rc.outcome, rc.record.id], ["created", c.id]);
  const back = await openProject(lost, p.id);
  assert.strictEqual(back.title, "Kept");
  assert.deepStrictEqual(back.components.map(x => x.id), [c.id]);
  assert.strictEqual((await restoreProject(lost, p.id, { title: "other" })).outcome, "exists", "and never overwrites");
  await assert.rejects(restoreProject(lost, "has space", {}), /is not a record id/, "an id outside the store's rule was written");
});

console.log("\nprojects on LocalDb: all ok");
