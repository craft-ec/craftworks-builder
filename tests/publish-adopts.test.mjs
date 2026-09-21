// PUBLISH WITH NO PROJECT OPEN KEEPS THE APP AS ONE (builder#83).
//
// A publish is keyed by its project, so an app opened from a link — no
// project open — is kept as a project first, and published under its id.
// `adopt` is that step. The page test (owner-page, scenario A) drives it end
// to end; this pins the rules: never a second project, one at a time, and a
// stale `lastOpened` is no project.
import assert from "node:assert";
import { LocalDb } from "../local-db.js";
import { listProjects, openProject, DEVICE_SETTINGS_KEY } from "../projects.js";

const node = () => new Proxy({ hidden: false, style: {}, contains: () => false },
  { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
globalThis.document = { createElement: () => node(), addEventListener() {} };
const { mountProjects, fromRecord } = await import("../projects-panel.js");

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const storage = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};
const canvas = [{ type: "table", domain: "tasks", label: "Tasks" }];
const definition = { schemas: { tasks: { type: "Task", fields: [{ name: "title", kind: "text" }] } }, seed: {}, tree: { realm: "public", identity: null } };
const panel = async st => {
  const db = new LocalDb(st);
  const handed = [];
  const p = await mountProjects(node(), {
    db, storage: st, getCanvas: () => canvas, getDefinition: () => definition,
    setCanvas: (c, project) => handed.push(project.id), onConflict: () => {},
  });
  return { db, p, handed };
};
const open = st => JSON.parse(st.getItem(DEVICE_SETTINGS_KEY) ?? "{}").lastOpened ?? null;

await t("**no project open: adopt keeps the app as ONE project, opens it, and saves what is on screen**", async () => {
  const st = storage();
  const { db, p, handed } = await panel(st);
  const a = await p.adopt({ title: "From a link" });
  assert.deepStrictEqual((await listProjects(db)).map(r => r.fields.title), ["From a link"]);
  assert.strictEqual(open(st), a.id, "it is the open project");
  assert.strictEqual(typeof a.created, "number", "the project record's created field, for the seed slots");
  const stored = await openProject(db, a.id);
  assert.deepStrictEqual(stored.components.map(fromRecord).map(c => c.domain), ["tasks"], "the canvas on screen, saved");
  assert.deepStrictEqual(Object.keys(stored.schemas), ["tasks"], "and its definition");
  assert.deepStrictEqual(handed, [], "never handed over: that would dispose the Preview being published");
});

await t("THE CONTROL: with a project open, adopt makes NO second project", async () => {
  const st = storage();
  const { db, p } = await panel(st);
  await p.adopt({ title: "first" });
  assert.strictEqual(await p.adopt({ title: "second" }), null);
  assert.strictEqual((await listProjects(db)).length, 1);
});

await t("**two Publish presses at once adopt ONE project**", async () => {
  const st = storage();
  const { db, p } = await panel(st);
  const [a, b] = await Promise.all([p.adopt({ title: "x" }), p.adopt({ title: "x" })]);
  assert.strictEqual((await listProjects(db)).length, 1);
  assert.strictEqual(a.id, b.id);
});

await t("a `lastOpened` naming a project that no longer exists is no project: adopt keeps one", async () => {
  const st = storage();
  st.setItem(DEVICE_SETTINGS_KEY, JSON.stringify({ lastOpened: "rgone0000000001" }));
  const { db, p } = await panel(st);
  const a = await p.adopt({ title: "kept" });
  assert.ok(a, "a stale id is not an open project");
  assert.strictEqual((await listProjects(db)).length, 1);
});

console.log("\npublish adopts: all ok");
