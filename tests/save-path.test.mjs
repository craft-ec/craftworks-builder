// THE PATH THE APP TAKES.
//
// `tests/projects.test.mjs` drives `setComponentProps` and proves the DATA
// MODEL keeps a neighbour byte-identical. The app does not call that: it calls
// `saveCanvas`, which used to delete every component record and re-add them
// all. So the claim was true underneath and FALSE through the product —
// nothing was byte-identical because nothing survived.
//
// Measured on the broken version, one tweak of three components:
//
//     setComponentProps   ids surviving 3 of 3   neighbour byte-identical
//     saveCanvas          ids surviving 0 of 3   neighbour GONE, new id
//
// Four things rested on that and none of them held: neighbour isolation (the
// leg the record shape rests on), stable ids for phase-6 conflict granularity,
// `changes_since` seeing one component change rather than the project, and the
// dedup that makes per-component cheap — new ids are new keys are new leaves.
//
// This file drives the entry the app uses. It is the workspace rule *test
// through the ENTRY an app uses, not past it*, and it is here because a green
// suite agreed with a claim the running code did not support.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import { defineProjectDomains, createProject, componentsOf, openProject } from "../projects.js";
import { saveCanvas, fromRecord } from "../projects-panel.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const fresh = async () => { const db = new sdk.Db(); await defineProjectDomains(db); return db; };
const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

/** The stored shape of a project's components, for comparing before/after. */
const snapshot = async (db, pid) =>
  (await componentsOf(db, pid)).map(r => ({ id: r.id, kind: r.fields.kind, props: r.fields.props }));

await t("a tweak through saveCanvas keeps every id and touches ONE record", async () => {
  const db = await fresh();
  const p = await createProject(db, { title: "Three" });
  const canvas = [
    { type: "table", domain: "a" },
    { type: "list", domain: "b" },
    { type: "form", domain: "c" },
  ];
  const first = await saveCanvas(db, p.id, canvas);
  assert.equal(first.added, 3, "the first save adds all three");
  assert.ok(canvas.every(c => c.rid), "and each canvas component learns its record id");

  const before = await snapshot(db, p.id);
  canvas[1].domain = "b2";
  const did = await saveCanvas(db, p.id, canvas);
  const after = await snapshot(db, p.id);

  assert.deepEqual(
    { ...did, untouched: did.untouched },
    { added: 0, updated: 1, removed: 0, untouched: 2 , adopted: 0, conflicts: 0, dropped: 0 },
    "one component changed, so one record is written and two are left alone",
  );
  assert.deepEqual(
    before.map(r => r.id).sort(), after.map(r => r.id).sort(),
    "EVERY id survives the save — this is what phase-6 conflict granularity needs",
  );

  const neighbours = ids => ids.filter(r => r.id !== canvas[1].rid);
  assert.deepEqual(
    neighbours(before), neighbours(after),
    "the neighbours are byte-identical THROUGH THE APP'S PATH, not just the model's",
  );
});

await t("THE CONTROL: a save that changes nothing writes nothing", async () => {
  const db = await fresh();
  const p = await createProject(db, { title: "Idle" });
  const canvas = [{ type: "table", domain: "a" }, { type: "list", domain: "b" }];
  await saveCanvas(db, p.id, canvas);

  const before = await snapshot(db, p.id);
  const blocksBefore = db.stats().blocks;
  const did = await saveCanvas(db, p.id, canvas);

  assert.deepEqual(did, { added: 0, updated: 0, removed: 0, untouched: 2 , adopted: 0, conflicts: 0, dropped: 0 },
    "a no-op save must write nothing; without this a diff that rewrote everything would pass the test above");
  assert.deepEqual(await snapshot(db, p.id), before, "and the records are untouched");
  assert.equal(db.stats().blocks, blocksBefore, "and no block was written");
});

await t("adding and removing components does not disturb the others", async () => {
  const db = await fresh();
  const p = await createProject(db, { title: "Churn" });
  const canvas = [{ type: "table", domain: "a" }, { type: "list", domain: "b" }];
  await saveCanvas(db, p.id, canvas);
  const keptId = canvas[0].rid;
  const goneId = canvas[1].rid;

  canvas.splice(1, 1);                       // remove the middle one
  canvas.push({ type: "form", domain: "c" }); // and add a new one
  const did = await saveCanvas(db, p.id, canvas);

  assert.deepEqual(did, { added: 1, updated: 0, removed: 1, untouched: 1 , adopted: 0, conflicts: 0, dropped: 0 });
  const ids = (await snapshot(db, p.id)).map(r => r.id);
  assert.ok(ids.includes(keptId), "the untouched component keeps its id");
  assert.ok(!ids.includes(goneId), "the removed one is gone");
  assert.equal(ids.length, 2);
});

await t("a project reopened round-trips its ids, so the NEXT save is a diff too", async () => {
  const db = await fresh();
  const p = await createProject(db, { title: "Reopen" });
  const canvas = [{ type: "table", domain: "a" }];
  await saveCanvas(db, p.id, canvas);
  const originalId = canvas[0].rid;

  // What opening a project does: read the records back into canvas shape —
  // through `openProject`, as the panel does. This used to map `fromRecord`
  // over `componentsOf`'s RAW records, whose props are still a JSON string, and
  // "reopened" a component of `{ type: undefined, rid }`; it passed only
  // because the old storage-diff wrote that broken component back (found when
  // builder#74 compared against a base instead).
  const reopened = (await openProject(db, p.id)).components.map(fromRecord);
  assert.equal(reopened[0].type, "table", "the reopened component is the component, not its raw record");
  assert.equal(reopened[0].rid, originalId, "fromRecord carries the id back");

  reopened[0].domain = "a2";
  const did = await saveCanvas(db, p.id, reopened);
  assert.deepEqual(did, { added: 0, updated: 1, removed: 0, untouched: 0 , adopted: 0, conflicts: 0, dropped: 0 },
    "a save after a reopen is a diff, not a re-key — without the id round-tripping it would add and remove");
});

process.stdout.write("\nsave path: all ok\n");

// A REFUSAL MUST NOT LOSE THE USER'S WORK.
//
// The save is 2N writes with 2N chances to be refused, and the engine answers
// `Busy` as TERMINAL — nothing was applied, and nothing here retries. So the
// question is not whether a save can fail; it is what the project looks like
// when one does.
//
// Under delete-all-then-add-all every delete completes before the first add,
// so the project passes through a state with ZERO components and a refusal in
// that window loses work the user cannot get back. Ordering adds and updates
// FIRST and removals LAST does not make the save atomic — it is still N
// separate writes — but it makes every intermediate state a SUPERSET of what
// the user should see. A refusal leaves stale extras, which the next save
// removes; it never leaves a hole.
//
// Driven by refusing at EVERY position, because the window is what matters and
// a single injected failure would land in one spot and prove nothing about the
// rest.
await t("no refusal, at any point in the save, can lose a component", async () => {
  const db = await fresh();
  const p = await createProject(db, { title: "Durable" });
  const canvas = [
    { type: "table", domain: "a" },
    { type: "list", domain: "b" },
    { type: "form", domain: "c" },
  ];
  await saveCanvas(db, p.id, canvas);
  const before = await componentsOf(db, p.id);
  assert.equal(before.length, 3);

  // Refuse the k-th mutating call, for every k the save could reach.
  for (let k = 0; k < 12; k += 1) {
    const db2 = await fresh();
    const p2 = await createProject(db2, { title: "Durable" });
    const c2 = canvas.map(c => ({ ...c, rid: undefined }));
    await saveCanvas(db2, p2.id, c2);
    const had = (await componentsOf(db2, p2.id)).map(r => r.id).sort();

    let n = 0;
    const refusing = new Proxy(db2, {
      get(target, key) {
        const v = Reflect.get(target, key);
        if (typeof v !== "function") return v;
        if (key !== "put" && key !== "update" && key !== "delete") return v.bind(target);
        return (...a) => {
          if (n++ === k) throw new Error("Busy");   // terminal, as the engine answers it
          return v.apply(target, a);
        };
      },
    });

    c2[1].domain = "b2";
    c2.push({ type: "chart", domain: "d" });
    try { await saveCanvas(refusing, p2.id, c2); } catch { /* the refusal under test */ }

    const still = (await componentsOf(db2, p2.id)).map(r => r.id);
    for (const id of had) {
      assert.ok(
        still.includes(id),
        `refusing write #${k} lost component ${id}: a save must never pass ` +
        `through a state with fewer components than the user had`,
      );
    }
  }
});
