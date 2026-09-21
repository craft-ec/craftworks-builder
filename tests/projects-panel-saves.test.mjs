// THE PANEL'S OWN SAVES, driven through what `mountProjects` hands the app.
//
// `serialSaves` is tested as a function in `save-dedupe.test.mjs`, and review
// showed that is not enough: reverting `persist` to call `saveCanvas` directly
// left every suite green (builder#49) — the chain existed and nothing noticed
// the panel had stopped using it. So this file mounts the real panel over the
// real `LocalDb` and uses its `persist` and its Duplicate button.
//
// The DOM is a stand-in exactly as large as the panel needs — `createElement`,
// `append`, `replaceChildren` and one document listener — so it runs in node
// and needs no browser, no port and no page server.
import assert from "node:assert";
import { LocalDb } from "../local-db.js";
import { createProject, componentsOf, defineProjectDomains, writeDeviceSettings, DEVICE_SETTINGS_KEY, COMPONENT } from "../projects.js";
import { mountProjects } from "../projects-panel.js";

class El {
  constructor(tag) { this.tag = tag; this.children = []; }
  append(...kids) { for (const k of kids) if (k && typeof k === "object") this.children.push(k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  setAttribute() {}
  contains() { return false; }
}
globalThis.document = { createElement: tag => new El(tag), addEventListener() {} };
const find = (node, id) => {
  if (node.id === id) return node;
  for (const k of node.children ?? []) { const f = find(k, id); if (f) return f; }
  return null;
};

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const storage = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};

/** Mount the panel over a project that is open, with `canvas` as the builder's canvas. */
const mount = async (db, canvas) => {
  await defineProjectDomains(db);
  const p = await createProject(db, { title: "open" });
  const device = storage();
  writeDeviceSettings(device, { lastOpened: p.id });
  const host = new El("div");
  const panel = await mountProjects(host, {
    db, storage: device,
    getCanvas: () => canvas,
    setCanvas: () => {},
  });
  return { p, host, panel, device };
};

await t("the panel's persist, called twice without waiting, stores a new component ONCE", async () => {
  const db = new LocalDb(storage());
  const canvas = [];
  const { p, panel } = await mount(db, canvas);
  canvas.push({ type: "table", domain: "notes" });
  // Two canvas changes in a row; the app does not await `persist`.
  await Promise.all([panel.persist(), panel.persist()]);
  const n = (await componentsOf(db, p.id)).length;
  assert.strictEqual(n, 1, `the panel's persist stored ${n} records for one component — its saves overlapped`);
});

await t("Duplicate while a save is still in flight: the canvas ends up naming the NEW project's record", async () => {
  // The first project's write is SLOW, so an unchained Duplicate finishes its
  // own save first and the late answer then points the canvas back at the
  // project it just left.
  const inner = new LocalDb(storage());
  let slowPid = null;
  const db = new Proxy(inner, {
    get(target, prop) {
      if (prop === "put") {
        return async (domain, fields) => {
          if (domain === COMPONENT && fields.pid === slowPid) await new Promise(r => setTimeout(r, 50));
          return target.put(domain, fields);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const canvas = [];
  const { p, host, panel, device } = await mount(db, canvas);
  slowPid = p.id;
  canvas.push({ type: "table", domain: "notes" });
  const saving = panel.persist();
  const dup = find(host, "projects-dup");
  assert.ok(dup && typeof dup.onclick === "function", "setup: the Duplicate button is on the panel");
  await Promise.all([saving, dup.onclick()]);
  const opened = JSON.parse(device.getItem(DEVICE_SETTINGS_KEY)).lastOpened;
  assert.notStrictEqual(opened, p.id, "setup: Duplicate opened the copy");
  const ids = (await componentsOf(db, opened)).map(r => r.id);
  assert.ok(
    ids.includes(canvas[0].rid),
    `the canvas names ${canvas[0].rid}, which is not a record of the open project (${ids.join(", ")}) — Duplicate's save overlapped persist's`
  );
});

await t("the project list counts what opening the project would show, not raw records", async () => {
  const { saveCanvas } = await import("../projects-panel.js");
  const db = new LocalDb(storage());
  const canvas = [];
  const { p, host, panel } = await mount(db, canvas);
  canvas.push({ type: "table", domain: "notes" });
  // Two records for one component: the raw overlap the chain now prevents.
  await Promise.all([saveCanvas(db, p.id, canvas), saveCanvas(db, p.id, canvas)]);
  assert.strictEqual((await componentsOf(db, p.id)).length, 2, "setup: two records for one component");
  await panel.refresh();
  const texts = [];
  const walk = n => { if (n.tag === "small" && typeof n.textContent === "string") texts.push(n.textContent); (n.children ?? []).forEach(walk); };
  walk(host);
  const row = texts.find(s => s.includes("open"));
  assert.ok(row, `setup: the open project's row is listed (${JSON.stringify(texts)})`);
  assert.match(row, /^1 component\b/, `the list says "${row}" for a project that opens with one component`);
});
