// THE BUILDER'S DRAFT, AS RECORDS IN THE OWNER'S TREE (ARCHITECTURE §19, app-as-data P3).
//
// Driven over the REAL SDK's in-tab `Db` (its definition doors are the ones a session has), wrapped so each door
// call is counted and a refusal can be planted.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import { BUILDER, appOf, diff, draftChanged, draftWriter, keyed, readDraft, recordsOf } from "../definition.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

/** A real Db, every door call counted, and a door that can be made to refuse. */
function counted() {
  const db = new sdk.Db();
  const calls = [];
  let refuse = null;
  const door = name => async (...a) => {
    calls.push([name, a[0]]);
    if (refuse?.(name, a[0])) throw new Error(`refused: ${name} ${a[0]}`);
    return db[name](...a);
  };
  return {
    db,
    calls,
    set refuse(fn) { refuse = fn; },
    tree: {
      draftPut: door("draftPut"),
      draftDelete: door("draftDelete"),
      definition: w => db.definition(w),
      publishDefinition: () => db.publishDefinition(),
    },
  };
}

const SCHEMA = { type: "Task", fields: [{ name: "title", kind: "text", required: true }] };
const canvas = () => ({
  name: "Tasks",
  components: keyed([{ type: "form", domain: "tasks", mode: "owned" }, { type: "table", domain: "tasks", mode: "owned" }]),
  schemas: { tasks: SCHEMA },
  seed: { tasks: [{ title: "one" }] },
});
// The canvas's definition, without its keys and without what identifies the project (its meta's other fields,
// checked on their own below).
const strip = ({ created: _c, forkedFrom: _f, tree: _t, versions: _v, ...app }) => ({ ...app, components: app.components.map(({ [BUILDER]: _k, ...c }) => c) });

await t("**a canvas is its records, and the records are the canvas**: meta, c/<key> per component, d/<domain> per domain; order and keys survive", async () => {
  const app = canvas();
  const recs = recordsOf(app);
  assert.deepStrictEqual([...recs.keys()].sort(), ["c/" + app.components[0][BUILDER].key, "c/" + app.components[1][BUILDER].key, "d/tasks", "meta"].sort());
  const back = appOf(recs);
  assert.deepStrictEqual(strip(back), strip(app));
  assert.deepStrictEqual(back.components.map(c => c[BUILDER].key), app.components.map(c => c[BUILDER].key));
});

await t("**through the doors and back**: the writer writes the canvas; a reopen (a read of the draft) shows the same canvas", async () => {
  const c = counted();
  const w = draftWriter();
  await w.attach(c.tree);
  const app = canvas();
  await w.sync(app);
  await w.idle();
  const reopened = appOf(await readDraft(c.db));
  assert.deepStrictEqual(strip(reopened), strip(app));
  assert.strictEqual(w.state().pending, 0);
});

await t("**one edit is one record**: changing one component writes its c/<key> and nothing else", async () => {
  const c = counted();
  const w = draftWriter();
  await w.attach(c.tree);
  const app = canvas();
  await w.sync(app);
  await w.idle();
  c.calls.length = 0;
  app.components[1].label = "My tasks";
  await w.sync(app);
  await w.idle();
  assert.deepStrictEqual(c.calls, [["draftPut", `c/${app.components[1][BUILDER].key}`]]);
});

await t("**a removal is a delete of its record**, and the reopened canvas does not have it", async () => {
  const c = counted();
  const w = draftWriter();
  await w.attach(c.tree);
  const app = canvas();
  await w.sync(app);
  await w.idle();
  const gone = app.components[0][BUILDER].key;
  app.components.splice(0, 1);
  c.calls.length = 0;
  await w.sync(app);
  await w.idle();
  assert.deepStrictEqual(c.calls.map(x => x.join(" ")).sort(), [`draftDelete c/${gone}`, "draftPut meta"].sort());
  assert.deepStrictEqual(appOf(await readDraft(c.db)).components.map(x => x[BUILDER].key), [app.components[0][BUILDER].key]);
});

// builder#71: a removal refused mid-save came back on reload, and the NEXT save kept it (the store had no merge and
// saves ran adds first, removals last). Here a refused write is SAID, stays pending, and is retried by the next sync;
// once it lands, a reopen does not bring the component back.
await t("**builder#71: a refused removal is said and retried**, never kept: once it lands, a reopen does not bring it back", async () => {
  const c = counted();
  const states = [];
  const w = draftWriter({ onState: s => states.push(s) });
  await w.attach(c.tree);
  const app = canvas();
  await w.sync(app);
  await w.idle();
  const gone = app.components[0][BUILDER].key;
  c.refuse = (name, key) => name === "draftDelete" && key === `c/${gone}`;
  app.components.splice(0, 1);
  await w.sync(app);
  await w.idle();
  assert.match(w.state().error ?? "", /refused: draftDelete/, "the refusal was not said");
  assert.ok(w.state().pending > 0, "a refused removal counted as written");
  assert.ok(appOf(await readDraft(c.db)).components.some(x => x[BUILDER].key === gone), "THE CONTROL: the refused delete did not land");
  c.refuse = null;
  app.name = "Tasks, renamed";
  await w.sync(app);
  await w.idle();
  assert.strictEqual(w.state().error, null);
  assert.strictEqual(w.state().pending, 0);
  assert.ok(!appOf(await readDraft(c.db)).components.some(x => x[BUILDER].key === gone), "the removed component came back on reopen");
});

await t("**a domain is its own record**: a schema change writes d/<domain> only; an undeclared domain loses its record", async () => {
  const c = counted();
  const w = draftWriter();
  await w.attach(c.tree);
  const app = canvas();
  await w.sync(app);
  await w.idle();
  c.calls.length = 0;
  app.schemas.tasks = { ...SCHEMA, fields: [...SCHEMA.fields, { name: "done", kind: "bool" }] };
  await w.sync(app);
  await w.idle();
  assert.deepStrictEqual(c.calls, [["draftPut", "d/tasks"]]);
  c.calls.length = 0;
  delete app.schemas.tasks; delete app.seed.tasks;
  await w.sync(app);
  await w.idle();
  assert.deepStrictEqual(c.calls, [["draftDelete", "d/tasks"]]);
});

await t("**no tree yet: the writer WAITS** (rule 9) and says so; nothing is lost, and all of it is written when the tree opens", async () => {
  let clock = 1_000;
  const c = counted();
  const w = draftWriter({ now: () => clock });
  const app = canvas();
  w.sync(app);
  clock = 61_000;
  app.components[0].label = "later edit";
  w.sync(app);
  const s = w.state();
  assert.strictEqual(s.attached, false);
  assert.strictEqual(s.waitingSince, 1_000, "the wait is counted from the first held edit");
  assert.ok(s.pending > 0);
  assert.strictEqual(c.calls.length, 0);
  await w.attach(c.tree);
  await w.idle();
  assert.deepStrictEqual(strip(appOf(await readDraft(c.db))), strip(app), "the held edits were not all written");
  assert.strictEqual(w.state().waitingSince, null);
});

await t("**a reopened project writes nothing it did not change**: attach reads the draft as its base", async () => {
  const c = counted();
  const first = draftWriter();
  await first.attach(c.tree);
  const app = canvas();
  await first.sync(app);
  await first.idle();
  c.calls.length = 0;
  const second = draftWriter();
  await second.attach(c.tree);
  await second.sync(appOf(await readDraft(c.db)));
  await second.idle();
  assert.deepStrictEqual(c.calls, []);
});

await t("**changed since publish is DERIVED**: draft vs app — false when equal, true after an edit, false again after a publish", async () => {
  const c = counted();
  const w = draftWriter();
  await w.attach(c.tree);
  assert.strictEqual(await draftChanged(c.db), false, "an empty draft and an empty app");
  const app = canvas();
  await w.sync(app);
  await w.idle();
  assert.strictEqual(await draftChanged(c.db), true);
  await c.db.publishDefinition();
  assert.strictEqual(await draftChanged(c.db), false);
  app.components[0].label = "x";
  await w.sync(app);
  await w.idle();
  assert.strictEqual(await draftChanged(c.db), true);
});

// Two tabs of one identity on one tree: each writes only the keys IT changed, so neither writes a stale copy back
// over the other's edit (what builder#74's tokens were for, on a store with no merge).
await t("**two tabs: each writes only what it changed** — no stale copy written back over the other's edit", async () => {
  const c = counted();
  const a = draftWriter(), b = draftWriter();
  await a.attach(c.tree);
  const appA = canvas();
  await a.sync(appA);
  await a.idle();
  await b.attach(c.tree);
  const appB = appOf(await readDraft(c.db));
  appA.components[0].label = "from A";
  await a.sync(appA);
  await a.idle();
  appB.components[1].label = "from B";
  await b.sync(appB);
  await b.idle();
  const now = appOf(await readDraft(c.db)).components;
  assert.strictEqual(now[0].label, "from A", "B wrote its stale copy over A's edit");
  assert.strictEqual(now[1].label, "from B");
});

await t("**a component meta does not name yet is still shown**, after the named ones, the same way on every open", async () => {
  const app = canvas();
  const recs = recordsOf(app);
  recs.set("c/zz-added-elsewhere", { type: "text" });
  recs.set("c/aa-added-elsewhere", { type: "text" });
  const keys = appOf(recs).components.map(c => c[BUILDER].key);
  assert.deepStrictEqual(keys, [...app.components.map(c => c[BUILDER].key), "aa-added-elsewhere", "zz-added-elsewhere"]);
});

await t("**keys are unique on a canvas**: a copied component is a new one", async () => {
  const app = canvas();
  const copy = { ...app.components[0] };
  app.components.push(copy);
  keyed(app.components);
  assert.notStrictEqual(app.components[2][BUILDER].key, app.components[0][BUILDER].key);
  assert.strictEqual(recordsOf(app).size, 5);
});

await t("**what identifies a project rides in its meta** (P3b): created, forked_from, tree, versions, and back", async () => {
  const app = { ...canvas(), created: 1700000000000, forkedFrom: { project: "src" }, tree: { realm: "public", identity: null }, versions: { sdkRev: "s1" } };
  const recs = recordsOf(app);
  assert.deepStrictEqual(Object.keys(recs.get("meta")).sort(), ["created", "forked_from", "name", "order", "tree", "versions"]);
  const back = appOf(recs);
  assert.deepStrictEqual([back.created, back.forkedFrom, back.tree, back.versions], [app.created, app.forkedFrom, app.tree, app.versions]);
  const bare = appOf(recordsOf(canvas()));
  assert.deepStrictEqual([bare.created, bare.forkedFrom, bare.tree, bare.versions], [null, null, null, null], "a meta without them reads back invented values");
});

await t("diff compares bodies canonically: field order is not a change", async () => {
  const { put, del } = diff(new Map([["meta", { name: "a", order: [] }]]), new Map([["meta", { order: [], name: "a" }]]));
  assert.deepStrictEqual([put, del], [[], []]);
});

// RULE 15 AT THE CANVAS: another session's write to the draft wins, and this tab (the loser) reloads -- the tree's
// version for every key it is not still holding, its own held edit kept and written.
await t("**the loser reloads**: a rebase takes the tree's version of what this tab is not holding, and keeps what it is", async () => {
  const c = counted();
  const b = draftWriter();
  // Tab A's door to the tree, with its writes HELD until the test lets them go (an edit still in flight).
  let release, gate = null;
  const aTree = { ...c.tree, draftPut: async (k, v) => { if (gate) await gate; return c.tree.draftPut(k, v); } };
  const a = draftWriter();
  await a.attach(aTree);
  const appA = canvas();
  await a.sync(appA);
  await a.idle();
  const [x, y] = appA.components.map(k => k[BUILDER].key);
  await b.attach(c.tree);
  const appB = appOf(await readDraft(c.db));

  // A edits X; its write is held in flight. B changes Y, and it lands.
  gate = new Promise(r => { release = r; });
  appA.components[0].label = "A's X, held";
  a.sync(appA);
  appB.components[1].label = "B's Y";
  await b.sync(appB);
  await b.idle();

  // The session says the tree moved under A (superseded / conflict): A re-reads its draft and rebases.
  const shown = a.rebase(await readDraft(c.db));
  assert.ok(shown, "the canvas was not handed the tree's version");
  const byKey = Object.fromEntries(shown.components.map(k => [k[BUILDER].key, k.label]));
  assert.strictEqual(byKey[y], "B's Y", "the loser's canvas did not reload the winner's Y");
  assert.strictEqual(byKey[x], "A's X, held", "a held edit was dropped by the reload");
  gate = null;
  release();
  await a.idle();
  const tree = Object.fromEntries(appOf(await readDraft(c.db)).components.map(k => [k[BUILDER].key, k.label]));
  assert.deepStrictEqual([tree[x], tree[y]], ["A's X, held", "B's Y"], "after the rebase the tree holds both; A wrote no stale Y back");
  assert.strictEqual(a.rebase(await readDraft(c.db)), null, "an unchanged tree reloaded the canvas");
});
