// A VIEW RENDERS NO WRITE CONTROLS (builder#104, the owner's ruling).
//
// Published data is readable by default and writing is access control. A
// visitor with view access sees a VIEW: the runtime, given a read-only
// session, paints no input and no button that writes — no Form, no Edit, no
// Delete — rather than controls that would fail. (The SDK refuses a write on
// a read-only session anyway, sdk#239: that is the net under this, and no
// control here can reach it.)
//
// On the REAL `mountApp` canvas, read back. The control is the same app on a
// writable backend, which HAS every one of those controls — so "none found"
// is a check that can fail.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import { openApp } from "../runtime-logic.js";

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

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
const all = n => [n, ...((n?.children ?? []).flatMap(all))].filter(x => x instanceof Node);

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const APP = { name: "Notes", components: [
  { type: "form", domain: "notes" },
  { type: "table", domain: "notes" },
  { type: "list", domain: "notes" },
] };

/** The publisher's data: the app's domains, with rows in them. */
async function published() {
  const db = new sdk.Db();
  await openApp(sdk, APP, db, { seed: false });
  for (const title of ["one", "two", "three"]) await db.put("notes", { title });
  return db;
}

async function canvas(readOnly) {
  const root = new Node("div");
  await mountApp(root, sdk, APP, () => {}, await published(), "published", { alive: () => true, seed: false, readOnly });
  return all(root);
}
const WRITES = ["Add", "Save changes", "Edit", "Delete", "Cancel"];
const writingButtons = nodes => nodes.filter(n => n.tag === "button" && WRITES.includes(n.textContent));

await t("**a VIEW paints no input and no button that writes — and still shows the publisher's rows**", async () => {
  const nodes = await canvas(true);
  assert.deepStrictEqual(nodes.filter(n => n.tag === "input").map(n => n.name), [], "a view painted inputs");
  assert.deepStrictEqual(writingButtons(nodes).map(n => n.textContent), [], "a view painted writing buttons");
  const cells = nodes.filter(n => n.tag === "td").map(n => n.textContent);
  for (const text of ["one", "two", "three"]) assert.ok(cells.includes(text), `the view does not show “${text}”: ${cells}`);
  assert.ok(nodes.some(n => n.className === "rt-view"), "the view does not say it is one");
});

await t("THE CONTROL: the same app on a WRITABLE session has every one of those controls", async () => {
  const nodes = await canvas(false);
  assert.ok(nodes.some(n => n.tag === "input"), "no input on a writable canvas — the check above could not fail");
  const found = new Set(writingButtons(nodes).map(n => n.textContent));
  for (const b of ["Add", "Edit", "Delete"]) assert.ok(found.has(b), `no ${b} on a writable canvas`);
  assert.ok(!nodes.some(n => n.className === "rt-view"));
});

await t("a view seeds nothing: asking it to is refused", async () => {
  await assert.rejects(
    () => mountApp(new Node("div"), sdk, APP, () => {}, null, "idle", { alive: () => true, readOnly: true }),
    /a view seeds nothing/,
  );
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok view mode\n");
process.exit(failures ? 1 : 0);
