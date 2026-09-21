// COMMITS PER SAVE — the number main asked for.
//
// A head bump is observable directly: `Db.root()` is a content hash, so the
// head moved exactly when that string changes. Sampling it after every
// mutating call counts commits without trusting a reading of `Db::write`.
//
// Operations are counted alongside, because per F30 a PUT's cost is mostly
// per-PUT — a bytes-only comparison understates a defect that is 2N writes.
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import {
  defineProjectDomains, createProject, componentsOf,
  addComponent, removeComponent, setComponentProps,
} from "../projects.js";
import { saveCanvas, toRecord } from "../projects-panel.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));

/** Count operations and head bumps around any db. */
function meter(db) {
  const ops = { put: 0, update: 0, delete: 0, get: 0, scan: 0 };
  let bumps = 0, last = db.root();
  const mutating = new Set(["put", "delete", "update"]);
  const proxy = new Proxy(db, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (typeof v !== "function") return v;
      return (...a) => {
        if (k in ops) ops[k] += 1;
        const out = v.apply(t, a);
        const after = () => {
          if (mutating.has(k)) { const r = t.root(); if (r !== last) { bumps += 1; last = r; } }
        };
        if (out && typeof out.then === "function") return out.then(r => (after(), r));
        after();
        return out;
      };
    },
  });
  return { proxy, ops, bumps: () => bumps };
}

/** THE BROKEN ARM, as it stood: every record deleted, then every one re-added. */
async function brokenSave(db, pid, components) {
  for (const r of await componentsOf(db, pid)) await removeComponent(db, r.id);
  for (const c of components) await addComponent(db, pid, toRecord(c));
}

const canvasOf = n =>
  Array.from({ length: n }, (_, i) => ({ type: "table", domain: `d${i}`, title: `c${i}` }));

async function run(n, arm) {
  const db = new sdk.Db();
  await defineProjectDomains(db);
  const p = await createProject(db, { title: `n=${n}` });
  const canvas = canvasOf(n);
  const save = arm === "diff"
    ? (d, c) => saveCanvas(d, p.id, c)
    : (d, c) => brokenSave(d, p.id, c);

  // BUILD: the first save, from an empty project.
  const b = meter(db);
  await save(b.proxy, canvas);
  const build = { ops: { ...b.ops }, bumps: b.bumps() };

  // TWEAK: one component's property changes. The interesting save.
  canvas[Math.floor(n / 2)].title = "changed";
  const t = meter(db);
  await save(t.proxy, canvas);
  const tweak = { ops: { ...t.ops }, bumps: t.bumps() };

  return { build, tweak };
}

import assert from "node:assert";

const w = (o) => `${o.put + o.update}w/${o.delete}d`;
const rows = [];
console.log("                 BUILD (first save)        TWEAK (one component changes)");
console.log(" N  arm       writes  commits            writes  commits");
for (const n of [3, 20]) {
  const got = {};
  for (const arm of ["diff", "broken"]) {
    const r = await run(n, arm);
    got[arm] = r;
    console.log(
      ` ${String(n).padEnd(2)} ${arm.padEnd(8)}  ${w(r.build.ops).padEnd(7)} ${String(r.build.bumps).padEnd(18)} ` +
      `${w(r.tweak.ops).padEnd(7)} ${r.tweak.bumps}`,
    );
  }
  rows.push({ n, ...got });
}

// THE SHAPE, not the constant. Every write is its own head bump — measured,
// not read off `Db::write` — so a save that rewrites the set commits 2N times
// and a save that writes what changed commits once. That is the whole cost
// argument, and it is the thing that must not quietly come back.
for (const { n, diff, broken } of rows) {
  assert.equal(
    diff.tweak.bumps, 1,
    `a one-component tweak must cost ONE commit at n=${n}, not ${diff.tweak.bumps}: ` +
    `the save writes what changed, so its cost cannot scale with the canvas`,
  );
  assert.equal(
    broken.tweak.bumps, 2 * n,
    `the rewrite-everything shape costs 2N commits at n=${n} (${2 * n}), measured ${broken.tweak.bumps}`,
  );
}
console.log("\ncommit count: all ok");
