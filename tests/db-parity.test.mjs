// EVERY METHOD THE BUILDER CALLS ON A DB EXISTS ON EVERY BACKEND IT CAN BE
// HANDED — with the same shape (builder#64).
//
// Three implementations of the database surface reach this code: LocalDb
// (projects, in the page), the SDK's in-memory Db (Preview), and the
// engine-backed Db (a published app). The SDK keeps its two in step
// (`js-surfaces-agree`); LocalDb was in no parity check at all, so when
// `projects.js` began calling `db.children`, nothing failed until a page ran
// it. "Test through the entry the app uses" failed three times as a RULE
// (#46, #51, #59); this is the gate.
//
// The call list is DERIVED from the source, never hand-kept: a new `db.x(`
// in any file below is checked against every backend that file can be
// handed, without anyone updating a list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import { LocalDb } from "../local-db.js";
import { previewDb } from "../handoff.js";
import { engineDb } from "../sdk/engine-db.js";

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const storage = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};

/** A session that answers every call with an empty JSON list — shapes only. */
const anySession = () => new Proxy({}, { get: (_, k) => (k === "take_stale" || k === "take_loads" ? () => "[]" : () => "[]") });

/** One fresh instance of each backend. */
const BACKENDS = {
  LocalDb: () => new LocalDb(storage()),
  "SDK Db": () => new sdk.Db(),
  "engine Db": () => engineDb({ session: anySession() }),
  "Preview Db": () => previewDb(new sdk.Db()),
};

/**
 * Which backends each file's receivers are handed. Where a db comes from is
 * a fact about the CALLER, so this is the one hand-written table — the calls
 * themselves are read from the source.
 */
const HANDED = {
  "projects.js": { db: ["LocalDb", "SDK Db"] },
  "projects-panel.js": { db: ["LocalDb", "SDK Db"] },
  "runtime.js": { db: ["Preview Db", "engine Db"] },
  "runtime-logic.js": { db: ["Preview Db", "engine Db"] },
  "app.js": { db: ["Preview Db", "engine Db"] },
  "handoff.js": { source: ["Preview Db"], target: ["engine Db", "SDK Db"] },
};

/**
 * DECLARED differences, each with its reason — never silently absent.
 * `method: { backends it may be missing from: reason }`.
 */
const DECLARED = {
  markSeed: { "engine Db": "optional: runtime-logic.js calls it only after `typeof db.markSeed === \"function\"`, and only a Preview seeds" },
  preload: { "Preview Db": "app.js preloads only the PUBLISHED backend; an in-memory Preview has nothing to preload" },
};

/** `receiver.method(` calls in a source text, per receiver. */
export function callsIn(src, receivers) {
  const out = {};
  for (const r of receivers) {
    const re = new RegExp(`\\b${r}\\.([A-Za-z_][A-Za-z0-9_]*)\\(`, "g");
    out[r] = [...new Set([...src.matchAll(re)].map(m => m[1]))].sort();
  }
  return out;
}

/** Missing methods: `[file, receiver, method, backend]` not declared. */
function missing(backends) {
  const out = [];
  let compared = 0;
  for (const [file, receivers] of Object.entries(HANDED)) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const calls = callsIn(src, Object.keys(receivers));
    for (const [receiver, names] of Object.entries(receivers)) {
      for (const method of calls[receiver]) {
        for (const b of names) {
          compared += 1;
          if (typeof backends[b][method] === "function") continue;
          if (DECLARED[method]?.[b]) continue;
          out.push([file, receiver, method, b]);
        }
      }
    }
  }
  return { out, compared };
}

const live = () => Object.fromEntries(Object.entries(BACKENDS).map(([k, f]) => [k, f()]));

await t("**every db call the builder makes exists on every backend its file is handed**", async () => {
  const { out, compared } = missing(live());
  console.log(`   ${compared} (file, method, backend) pairs compared`);
  assert.ok(compared > 30, `only ${compared} pairs: the derivation found almost nothing`);
  assert.deepEqual(out, [], "a backend lacks a method its caller uses:\n  " + out.map(x => x.join(" · ")).join("\n  "));
});

await t("the derived call list is non-empty and includes `children`", () => {
  const src = readFileSync(new URL("../projects.js", import.meta.url), "utf8");
  const { db } = callsIn(src, ["db"]);
  assert.ok(db.length > 5, `derived ${db}`);
  assert.ok(db.includes("children"), "the derivation did not find `children`, so it could not catch its absence");
});

await t("**THE MUTANT: `children` removed from LocalDb FAILS, naming the method and the backend**", () => {
  const backends = live();
  const bare = backends.LocalDb;
  backends.LocalDb = new Proxy(bare, { get: (o, k) => (k === "children" ? undefined : Reflect.get(o, k)) });
  const { out } = missing(backends);
  assert.ok(out.some(([, , m, b]) => m === "children" && b === "LocalDb"), `not caught: ${JSON.stringify(out)}`);
});

await t("THE CONTROL: a NEW call one backend lacks fails without updating any list", () => {
  const calls = callsIn("await db.children(a); db.frobnicate(x); target.get(k)", ["db", "target"]);
  assert.deepEqual(calls, { db: ["children", "frobnicate"], target: ["get"] });
  assert.equal(typeof new LocalDb(storage()).frobnicate, "undefined", "so a real `db.frobnicate(` in projects.js would be reported");
});

// ---- SHAPE, not just name: sync vs async ---------------------------------

/** Arguments that let each method be CALLED on a fresh backend. A method the
 *  derivation finds with no entry here FAILS the shape check: a method this
 *  gate cannot call is one it does not check. */
const ARGS = {
  define: ["d", { type: "D", fields: [{ name: "t", kind: "text" }] }],
  schema: ["d"], put: ["d", { t: "x" }], get: ["d", "0".repeat(32)], update: ["d", "0".repeat(32), { t: "y" }],
  delete: ["d", "0".repeat(32)], scan: ["d"], count: ["d"], children: ["d", "0".repeat(32)],
  createAt: ["d", "0".repeat(32), { t: "x" }], bind: ["d"], deleted: ["d"], seedOf: ["d", "x"],
  markSeed: ["d", "x", 0], preload: [[]],
};
const kindOf = (obj, name) => {
  try {
    const v = obj[name](...ARGS[name]);
    if (typeof v?.then === "function") { v.catch(() => {}); return "promise"; }
    return "value";
  } catch (e) {
    return `threw: ${e?.message ?? e}`;
  }
};

await t("**each method has the SAME SHAPE on every backend it is called on**", async () => {
  const backends = live();
  const seen = new Map();   // method -> Set of backends it is called on
  for (const [file, receivers] of Object.entries(HANDED)) {
    const calls = callsIn(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), Object.keys(receivers));
    for (const [r, names] of Object.entries(receivers)) for (const m of calls[r]) {
      if (!seen.has(m)) seen.set(m, new Set());
      for (const b of names) if (typeof backends[b][m] === "function") seen.get(m).add(b);
    }
  }
  const noArgs = [...seen.keys()].filter(m => !(m in ARGS));
  assert.deepEqual(noArgs, [], "methods this gate cannot call, so it does not check: give them ARGS");
  const differ = [];
  for (const [m, bs] of seen) {
    const kinds = [...bs].map(b => [b, kindOf(live()[b], m)]);
    const shapes = new Set(kinds.map(([, k]) => (k.startsWith("threw") ? "threw" : k)));
    // `bind` answers a binding (a value) everywhere; everything else a promise.
    if (shapes.size > 1) differ.push(`${m}: ${kinds.map(k => k.join("=")).join(", ")}`);
  }
  console.log(`   ${seen.size} methods compared by shape`);
  const threw = [...seen].flatMap(([m, bs]) => [...bs].map(b => [m, b, kindOf(live()[b], m)])).filter(([, , k]) => k.startsWith("threw"));
  // A comparison where the call THREW compares nothing: none may.
  assert.deepEqual(threw, [], "these could not be called, so their shape was not compared");
  assert.deepEqual(differ, [], "a method answers a different SHAPE on different backends:\n  " + differ.join("\n  "));
});

await t("THE CONTROL: a method that is sync on one backend and async on another is FOUND", () => {
  const sync = { count: () => 0 }, async_ = { count: async () => 0 };
  assert.notEqual(kindOf(sync, "count"), kindOf(async_, "count"));
});
