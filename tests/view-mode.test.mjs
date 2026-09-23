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

/** `live` as each binding was ASKED for, in order. */
let asked = [];
/**
 * The published app, mounted per source (DATA-SOURCE), with the SDK's one
 * decision answering `answer` for every source -- "no" is a view, "yes" is
 * writable, "unknown" is the signer not answering.
 */
async function canvas(readOnly, answer = readOnly ? "no" : "yes") {
  const root = new Node("div");
  const db = await published();
  const bind = db.bind.bind(db);
  asked = [];
  db.bind = (domain, opts = {}) => { asked.push(opts.live === true); return bind(domain, opts); };
  const canWrite = () => ({ answer, why: answer === "unknown" ? "this node's signer is not answering" : "" });
  await mountApp(root, sdk, APP, () => {}, { publisher: db, viewer: null }, "published", { alive: () => true, seed: false, canWrite });
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

await t("**a VIEW binds every component LIVE though the app declares no `live` (the owner's ruling: update live)**", async () => {
  assert.ok(APP.components.every(c => c.live === undefined), "the app under test declares live — the check would prove nothing");
  await canvas(true);
  assert.ok(asked.length > 0, "the view bound nothing — the spy saw no read");
  assert.deepStrictEqual(asked, asked.map(() => true), `a view bound a component NOT live: ${JSON.stringify(asked)}`);
});

await t("THE CONTROL: the same app on a WRITABLE canvas binds as it DECLARES (not live) — the check above can fail", async () => {
  await canvas(false);
  assert.ok(asked.length > 0 && asked.every(l => l === false), `a writable canvas bound live without being asked: ${JSON.stringify(asked)}`);
});

await t("**a read that ENDED is said on its component, by name — never a silent empty table (the stalled \"Reading…\" on the real network)**", async () => {
  const root = new Node("div");
  const db = await published();
  const bind = db.bind.bind(db);
  const WHY = "the range this read needed could not be loaded: block 00ced61a could not be had";
  db.bind = (domain, opts = {}) => { const b = bind(domain, opts); return new Proxy(b, { get: (o, k) => (k === "status" ? () => ({ state: "unreachable", why: WHY, code: "UNAVAILABLE" }) : typeof o[k] === "function" ? o[k].bind(o) : o[k]) }); };
  await mountApp(root, sdk, APP, () => {}, db, "published", { alive: () => true, seed: false, readOnly: true });
  const said = all(root).filter(n => n.className === "rt-err rt-read").map(n => n.textContent);
  assert.ok(said.length > 0 && said.every(x => x.includes(WHY)), `the read's end was not said: ${JSON.stringify(said)}`);
});

await t("THE CONTROL: a read that did NOT end says nothing of the kind", async () => {
  const nodes = await canvas(true);
  assert.deepStrictEqual(nodes.filter(n => n.className === "rt-err rt-read").map(n => n.textContent), []);
});

await t("THE CONTROL: the same app on a WRITABLE session has every one of those controls", async () => {
  const nodes = await canvas(false);
  assert.ok(nodes.some(n => n.tag === "input"), "no input on a writable canvas — the check above could not fail");
  const found = new Set(writingButtons(nodes).map(n => n.textContent));
  for (const b of ["Add", "Edit", "Delete"]) assert.ok(found.has(b), `no ${b} on a writable canvas`);
  assert.ok(!nodes.some(n => n.className === "rt-view"));
});

await t("a published app seeds nothing: asking it to is refused", async () => {
  const db = await published();
  await assert.rejects(
    () => mountApp(new Node("div"), sdk, APP, () => {}, { publisher: db }, "published", { alive: () => true, seed: true, canWrite: () => ({ answer: "no" }) }),
    /a published app seeds nothing/,
  );
});

await t("**a published app with NO `canWrite` is refused: no default could be safe** (builder#73)", async () => {
  const db = await published();
  await assert.rejects(
    () => mountApp(new Node("div"), sdk, APP, () => {}, { publisher: db }, "published", { alive: () => true, seed: false }),
    /needs `canWrite`/,
  );
});

await t("**UNKNOWN (the signer not answering): the inputs are shown DISABLED, with the reason** (rules 6, 8)", async () => {
  const nodes = await canvas(false, "unknown");
  const inputs = nodes.filter(n => n.tag === "input");
  assert.ok(inputs.length > 0, "an unknown answer hid the form: it is not known to be a view");
  assert.ok(inputs.every(n => n.disabled === true), "an unknown answer left an input enabled");
  assert.ok(writingButtons(nodes).every(n => n.disabled === true), "an unknown answer left a writing button enabled");
  assert.ok(nodes.some(n => n.className === "rt-why" && /not answering/.test(n.textContent)), "the reason is not shown");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok view mode\n");
process.exit(failures ? 1 : 0);
