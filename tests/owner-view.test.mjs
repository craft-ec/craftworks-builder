// THE PUBLISHER OPENS THEIR OWN PUBLISHED APP EDITABLE (the owner's ruling):
// on the node that holds the publisher's key the published page is the same
// table with Add/Edit/Delete; everyone else gets the read-only view.
//
// ONE decision (`openPublished`): the node's signer is asked whose it is (the
// asking session stays open and reads a visitor's view); its
// head equal to the app's publisher head → the builder's own `open({ app })`,
// writable; anything else → the publisher's tree as a view. On the REAL
// `mountApp` canvas with the real in-memory Db; the SDK's node calls are the
// only thing faked, and each fake says what it would be.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import { openApp, openPublished } from "../runtime-logic.js";

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

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
const APP = { name: "Notes", components: [{ type: "form", domain: "notes" }, { type: "table", domain: "notes" }] };
const HEAD = "a".repeat(64);

/** The publisher's data, in a real Db. */
async function publisherDb() {
  const db = new sdk.Db();
  await openApp(sdk, APP, db, { seed: false });
  await db.put("notes", { title: "one" });
  return db;
}

/** A read-only view of it, refusing writes as the SDK's reader does (sdk#239). */
function viewOf(db) {
  const refuse = () => Promise.reject(Object.assign(new Error("read-only: another person's data"), { code: "REFUSED" }));
  return new Proxy(db, { get: (d, k) => (["put", "update", "delete", "define"].includes(k) ? refuse : typeof d[k] === "function" ? d[k].bind(d) : d[k]) });
}

/** An SDK whose NODE is faked: `whoseNode` answers `mine`, and every open is recorded. */
async function nodeSdk(mine) {
  const db = await publisherDb();
  const opens = [];
  return {
    opens,
    db,
    sdk: {
      ...sdk,
      // The asking session: it answers `mine`, reads trees, and is closed
      // when the page opens its own writable session instead.
      openAsked: async opts => {
        opens.push({ ...opts, provision: "ask" });
        return { ...mine, why: mine.why ?? null, close: () => opens.push({ closed: true }), tree: async head => ({ db: head === HEAD ? viewOf(db) : null }) };
      },
      open: async opts => {
        opens.push(opts);
        return { db };
      },
    },
  };
}

const ARGS = { head: HEAD, app: "rmudrr4a4q14w0001", port: 7509, artefacts: { signer: "s", block: "b", register: "r" } };

async function mounted(opened) {
  const root = new Node("div");
  await mountApp(root, sdk, APP, () => {}, opened.db, "published", { alive: () => true, seed: false, readOnly: opened.readOnly });
  return all(root);
}

await t("**the PUBLISHER's node: the published app opens EDITABLE — inputs and Add, and a write lands**", async () => {
  const n = await nodeSdk({ head: HEAD });
  const opened = await openPublished(n.sdk, ARGS);
  assert.strictEqual(opened.readOnly, false, `the publisher got a view: ${opened.why}`);
  assert.deepStrictEqual(n.opens.map(o => o.closed ? "closed" : o.provision), ["ask", undefined], "not opened through the builder's own writable open({ app }) after asking");
  assert.strictEqual(opened.asked?.head, HEAD, "the asking session — the identity — was not handed back");
  const nodes = await mounted(opened);
  assert.ok(nodes.some(x => x.tag === "input"), "no input on the publisher's page");
  assert.ok(nodes.some(x => x.tag === "button" && x.textContent === "Add"), "no Add on the publisher's page");
  await opened.db.put("notes", { title: "from the publisher" });
  const rows = (await n.db.scan("notes")).map(r => r.fields.title).sort();
  assert.deepStrictEqual(rows, ["from the publisher", "one"], "the publisher's write did not land in the tree");
});

for (const [who, mine] of [["a VISITOR's node (no signer)", { head: null, why: "no signer on this node" }], ["ANOTHER person's key", { head: "b".repeat(64) }]]) {
  await t(`${who}: the read-only VIEW — no inputs, and a write is refused`, async () => {
    const n = await nodeSdk(mine);
    const opened = await openPublished(n.sdk, ARGS);
    assert.strictEqual(opened.readOnly, true);
    assert.deepStrictEqual(n.opens.map(o => o.closed ? "closed" : o.provision), ["ask"], "a visitor's node was provisioned, or read through a second session");
    assert.strictEqual(typeof opened.asked?.tree, "function", "the asking session was not handed back");
    const nodes = await mounted(opened);
    assert.ok(!nodes.some(x => x.tag === "input"), "a visitor's page painted an input");
    await assert.rejects(opened.db.put("notes", { title: "intruder" }), /read-only/);
    assert.deepStrictEqual((await n.db.scan("notes")).map(r => r.fields.title), ["one"], "a visitor's write reached the tree");
  });
}

if (failures) { process.stdout.write(`${failures} failing\n`); process.exit(1); }
process.stdout.write("\nok owner view\n");
