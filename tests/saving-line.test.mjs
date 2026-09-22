// "SAVING N…" UNTIL THE LAST WRITE PUBLISHES (craftworks-sdk#163, the builder half).
//
// The session reports `{ kind: "saving", count }` — every write not yet
// PUBLISHED, held ones included (sdk#188). The generated runtime shows
// "saving N…" while that count is above 0 and clears it ONLY at 0: a line that
// cleared at the first decrease, or at `Accepted`, would tell a person their
// work is safe while closing the tab would still lose it.
//
// Four layers, each with its control: the label, `publish` forwarding the
// session's count, `project-runtime` carrying it into (and across) mounts, and
// the canvas `mountApp` actually paints.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import { savingLabel } from "../runtime-logic.js";
import { publish } from "../publish.js";
import { createProjectRuntime } from "../project-runtime.js";

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const tick = () => new Promise(r => setTimeout(r, 0));

// A DOM just big enough for mountApp, and one that can be READ back.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.hidden = false; this.dataset = {}; }
  append(...k) { this.children.push(...k.flat(Infinity).filter(x => x !== "" && x != null)); }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(k, v) { this[k] = v; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains() { return false; }
  focus() {}
}
globalThis.document = { createElement: tag => new Node(tag), addEventListener() {}, removeEventListener() {} };
const { mountApp } = await import("../runtime.js");
const find = (n, cls) => (n?.className === cls ? n : (n?.children ?? []).map(c => find(c, cls)).find(Boolean));

await t("the label: 'saving N…' for every N above 0, nothing at 0, and only a count is taken", async () => {
  assert.strictEqual(savingLabel(0), null);
  assert.strictEqual(savingLabel(1), "saving 1…");
  assert.strictEqual(savingLabel(84), "saving 84…");
  for (const bad of [-1, 1.5, undefined, "3"]) assert.throws(() => savingLabel(bad), /a count of unsaved writes/);
});

await t("publish hands every count the session reports to onSaving, in order", async () => {
  let emit;
  const seen = [];
  await publish({}, {
    appId: "proj1",
    port: 18080,
    onSaving: n => seen.push(n),
    open: async ({ onEvent }) => { emit = onEvent; onEvent({ kind: "open" }); return { provisioned: () => true, db: {}, close() {} }; },
  });
  for (const n of [3, 2, 1, 0]) emit({ kind: "saving", count: n });
  emit({ kind: "open" }); // not a saving event: not forwarded
  assert.deepStrictEqual(seen, [3, 2, 1, 0]);
});

await t("publish without onSaving is refused BEFORE anything opens — never a page that looks saved", async () => {
  let opened = 0;
  const phases = [];
  await assert.rejects(publish({}, { port: 18080, open: async () => { opened++; return {}; } }, (p, why) => phases.push([p, why])), /no `onSaving`/);
  assert.strictEqual(opened, 0);
  assert.strictEqual(phases[0][0], "failed", "the refusal was not shown as a failed phase");
});

await t("project-runtime carries the count into the mount — one reported BEFORE the mount included", async () => {
  const mounts = [];
  const mount = async () => { const h = { db: {}, set: [], stop() {}, setSaving(n) { h.set.push(n); } }; mounts.push(h); return h; };
  let report;
  const rt = createProjectRuntime({
    mount,
    publish: async (app, deps) => { report = deps.onSaving; deps.onSaving(5); return { session: { close() {} }, db: {} }; },
  });
  await rt.publish({}, {}, { handoff: async () => {}, after: async () => {} });
  assert.strictEqual(rt.saving, 5, "the count reported during publish was dropped");
  await rt.ensureMounted();
  assert.deepStrictEqual(mounts[0].set, [5], "the published mount started at 0 while 5 writes were unsaved");
  report(2); report(0);
  assert.deepStrictEqual(mounts[0].set, [5, 2, 0]);
  rt.dispose();
  assert.strictEqual(rt.saving, 0);
});

await t("**the canvas says 'saving N…' at 3, 2 and 1, and clears ONLY at 0**", async () => {
  const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
  const app = { components: [{ type: "form", domain: "notes" }],
    schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } } };
  const root = new Node("div");
  const h = await mountApp(root, sdk, app, () => {}, null, "published", { alive: () => true });
  assert.strictEqual(find(root, "rt-saving"), undefined, "a line was shown with nothing unsaved");
  for (const n of [3, 2, 1]) {
    h.setSaving(n);
    const line = find(root, "rt-saving");
    assert.ok(line, `the line CLEARED at ${n} — ${n} write(s) not yet published`);
    assert.strictEqual(line.textContent, `saving ${n}…`);
  }
  h.setSaving(0);
  assert.strictEqual(find(root, "rt-saving"), undefined, "the line stayed after the last write published");
  // THE CONTROL: the canvas is really being repainted — its component is there.
  assert.ok(find(root, "rt-comp"), "nothing was painted, so the absence of the line proves nothing");
  h.stop();
});

console.log("\nsaving line: all ok");
