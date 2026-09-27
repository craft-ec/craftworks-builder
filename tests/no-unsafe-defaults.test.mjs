// THREE INJECTED DEPENDENCIES WITH NO DEFAULT (builder#73; a fourth, LocalDb's `onNotice`, went with LocalDb in P3b).
//
// Each used to default to a no-op that made a safety step look DONE:
//   handoff  — publish copied nothing, adopted the new backend, said Published
//   after    — the publication was never recorded
//   alive    — a disposed runtime's late mount was never refused
//   onNotice — storage and older-builder notices were swallowed
// A default is safe when omitting it makes the feature absent or LOUD; these
// made it look done. Now each is required, and a caller that omits one gets a
// throw at the call that needed it, naming what is missing. Each test here
// also passes the dependency explicitly — the control that the requirement is
// the only thing refusing.
import assert from "node:assert";
import { createProjectRuntime } from "../project-runtime.js";

const node = () => new Proxy({ hidden: false, style: {}, contains: () => false, replaceChildren() {} },
  { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
globalThis.document = { createElement: () => node(), addEventListener() {} };
const { mountApp } = await import("../runtime.js");

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const session = { close() {}, db: { root: () => "r", preload: async () => {}, definition: async () => [], draftPut: async () => {}, draftDelete: async () => true, watchDefinition: () => () => {} } };
const runtime = () => createProjectRuntime({ mount: async () => ({ db: {}, stop() {} }), publish: async () => ({ session, db: session.db }) });

await t("**publish without a handoff throws, naming it — it never adopts a backend with nothing copied**", async () => {
  const rt = runtime();
  await assert.rejects(rt.publish({}, {}, { after: async () => {} }), /no `handoff`/);
  assert.strictEqual(rt.phase, "failed", "the refusal is SHOWN as a failed publish, with its reason");
  assert.match(rt.error, /no `handoff`/);
  assert.strictEqual(rt.publishedDb, null, "and no backend was adopted");
  await rt.publish({}, {}, { after: async () => {}, handoff: async () => {} });   // THE CONTROL
  assert.strictEqual(rt.phase, "published");
});

await t("**publish without `after` throws, naming it — a publication is never silently unrecorded**", async () => {
  const rt = runtime();
  await assert.rejects(rt.publish({}, {}, { handoff: async () => {} }), /no `after`/);
  assert.strictEqual(rt.phase, "failed");
  assert.match(rt.error, /no `after`/);
  let recorded = 0;
  await rt.publish({}, {}, { handoff: async () => {}, after: async () => { recorded += 1; } });   // THE CONTROL
  assert.strictEqual(recorded, 1);
});

await t("**mountApp without `alive` throws, naming it — the guard never fails open**", async () => {
  const db = { define: async () => {}, put: async () => ({}), bind: () => ({ limit: 50, reverse: false, subscribe: () => () => {}, reload: async () => {}, getSnapshot: () => [], status: () => ({ state: "ready" }) }), root: () => "", stats: () => ({}), scan: async () => [] };
  const app = { components: [], schemas: {} };
  await assert.rejects(mountApp(node(), {}, app, () => {}, db, "published"), /no `alive`/);
  const h = await mountApp(node(), {}, app, () => {}, db, "published", { alive: () => true });   // THE CONTROL
  assert.ok(h && typeof h.stop === "function");
});

