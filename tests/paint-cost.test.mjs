// PAINTING THE PROJECT LIST, and what it costs.
//
// `paint()` shows a component count on every project row, so it calls
// `componentsOf` once per row. While that was a scan of the whole COMPONENT
// domain followed by a filter on `pid`, painting a list of P projects handed
// the app P x (every component of every project) records — quadratic in the
// library, on a path a person waits for.
//
// craftworks-sdk#122 keys a component under its project, so `componentsOf` is
// a bounded read of one band. This measures that end to end, through the same
// functions the panel calls.
//
// THE INSTRUMENT: records handed back, counted at the SDK boundary. Not a
// timing — a BTreeMap of this size would time as noise, and what actually
// changed is how many records cross the boundary.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import {
  defineProjectDomains, createProject, addComponent,
  componentsOf, listProjects, SCHEMAS, COMPONENT,
} from "../projects.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

/** Count the records each read hands back, and how it was asked for. */
function counting(db) {
  const seen = { scan: 0, children: 0, calls: { scan: 0, children: 0 } };
  const wrap = (name, fn) => async (...a) => {
    const out = await fn.apply(db, a);
    seen.calls[name] += 1;
    seen[name] += Array.isArray(out) ? out.length : 0;
    return out;
  };
  const proxy = new Proxy(db, {
    get(target, k) {
      const v = Reflect.get(target, k);
      if (k === "scan" || k === "children") return wrap(k, v);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: proxy, seen };
}

/** Build P projects with C components each. */
async function library(db, P, C) {
  const ids = [];
  for (let p = 0; p < P; p += 1) {
    const proj = await createProject(db, { title: `p${p}` });
    ids.push(proj.id);
    for (let c = 0; c < C; c += 1) {
      await addComponent(db, proj.id, { kind: "table", props: { i: c } });
    }
  }
  return ids;
}

const fresh = async () => {
  const db = new sdk.Db();
  await defineProjectDomains(db);
  return db;
};

await t("the COMPONENT domain declares its parent, so records are keyed under the project", async () => {
  assert.strictEqual(SCHEMAS[COMPONENT].parent, "pid");
  const db = await fresh();
  const p = await createProject(db, { title: "one" });
  const c = await addComponent(db, p.id, { kind: "table" });
  // 64 hex: the project's id leads the component's.
  assert.match(c.id, /^[0-9a-f]{64}$/);
  assert.strictEqual(c.id.slice(0, 32), p.id, "a component's key sits under its project");
});

await t("**a project's components do not grow with the OTHER projects' components**", async () => {
  const db = await fresh();
  const [small] = await library(db, 1, 5);
  await library(db, 1, 400);            // a second, much larger project

  const { db: c, seen } = counting(db);
  const mine = await componentsOf(c, small);

  assert.strictEqual(mine.length, 5);
  // The READ handed back five records, not the 405 in the domain, and it went
  // through `children` rather than a scan. Both halves matter: the same five
  // could have come from scanning 405 and filtering.
  assert.strictEqual(seen.children, 5, "the band read handed back this project's components only");
  assert.strictEqual(seen.scan, 0, "and nothing scanned the domain");
  assert.strictEqual(seen.calls.children, 1);
});

await t("**painting the list is linear in the library, not quadratic**", async () => {
  // Two libraries with the same total number of components, differing only in
  // how they are split. Under scan-and-filter the cost of a paint is
  // P x total, so splitting the SAME components across more projects made it
  // dramatically more expensive; under a band read it is just the total.
  const shapes = [{ P: 4, C: 25 }, { P: 20, C: 5 }];
  const measured = [];

  for (const { P, C } of shapes) {
    const db = await fresh();
    await library(db, P, C);
    const { db: c, seen } = counting(db);

    // Exactly what `paint()` does: list the projects, then one count per row.
    const rows = await listProjects(c);
    let handed = 0;
    for (const r of rows) handed += (await componentsOf(c, r.id)).length;

    // `listProjects` is itself a scan, of the PROJECT domain — P records. That
    // is the one scan a paint legitimately does, and it is why `scan` is not
    // asserted to be zero here.
    assert.strictEqual(seen.scan, P, "the only scan is the project list itself");
    assert.strictEqual(seen.children, P * C, "every component read came from a band");
    measured.push({ P, C, total: P * C, handed });
    assert.strictEqual(rows.length, P);
    assert.strictEqual(handed, P * C, "each row reads its own band and no more");
  }

  const [a, b] = measured;
  console.log(`
    shape                    components   records handed to paint
    ${a.P} projects x ${a.C} components${" ".repeat(Math.max(0, 6 - String(a.C).length))}${String(a.total).padStart(8)}${String(a.handed).padStart(26)}
    ${b.P} projects x ${b.C} components${" ".repeat(Math.max(0, 6 - String(b.C).length))}${String(b.total).padStart(8)}${String(b.handed).padStart(26)}
      scan-and-filter would have handed back P x total:
      ${a.P} x ${a.total} = ${a.P * a.total}   and   ${b.P} x ${b.total} = ${b.P * b.total}`);

  // THE POINT: the same 100 components cost the same paint whether they sit in
  // 4 projects or 20. Under scan-and-filter the 20-project library cost five
  // times the 4-project one for the same data.
  assert.strictEqual(a.handed, b.handed,
    "the same components must cost the same paint however they are split");
  assert.strictEqual(a.handed, a.total);
});

await t("THE CONTROL: the counter really is watching the reads", async () => {
  // Without this, a counter that returned 0 for everything would make the
  // assertions above pass by measuring nothing.
  const db = await fresh();
  await library(db, 2, 3);
  const { db: c, seen } = counting(db);
  const rows = await listProjects(c);
  assert.strictEqual(rows.length, 2);
  const kids = await componentsOf(c, rows[0].id);
  assert.strictEqual(kids.length, 3, "the instrumented db returns real rows");
  // And the counter MOVED. A counter stuck at zero would make every assertion
  // above pass by measuring nothing.
  assert.strictEqual(seen.scan, 2, "the project scan was counted");
  assert.strictEqual(seen.children, 3, "the band read was counted");
});

console.log("\npaint cost: all ok");
