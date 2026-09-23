// A PUBLISHED APP IS A NORMAL WEBSITE (the owner; DATA-SOURCE). ONE session,
// asked whose node this is, and ONE decision, the SDK's `canWrite`:
// * on the PUBLISHER's node, `publisher` components are the same tree,
//   editable (Add/Edit/Delete), and a write lands in it;
// * anywhere else they are a read-only view: no inputs, a write refused, and
//   nothing opened or minted for a reader;
// * `viewer` components are the VISITOR's own tree, with inputs for everyone,
//   opened on the visitor's node (`openOwn`), and a write lands THERE --
//   never in the publisher's tree.
// On the REAL `mountApp` canvas with the real in-memory Db; the SDK's node
// calls are the only thing faked, and each fake says what it would be.
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

/**
 * An SDK whose NODE is faked: `openAsked` answers as a node whose signer signs
 * for `signsFor` (null: none), holding `own` as that identity's tree; the
 * publisher's tree is `pub`. Records what was opened.
 */
async function nodeSdk(signsFor, ownAnswer = { answer: "yes", why: "" }) {
  const pub = await publisherDb();
  const own = signsFor === HEAD ? pub : await emptyDb();
  const opens = [];
  return {
    opens,
    pub,
    own,
    sdk: {
      ...sdk,
      openAsked: async opts => {
        opens.push({ ...opts, provision: "ask" });
        return {
          head: signsFor,
          why: signsFor ? null : "no signer on this node",
          db: own,
          canWrite: head => ({ answer: head === "" || head === signsFor ? "yes" : "no", why: "" }),
          openOwn: async () => { opens.push("openOwn"); return ownAnswer; },
          tree: async head => { opens.push("tree"); return { db: head === HEAD ? viewOf(pub) : null }; },
        };
      },
    },
  };
}

/** A visitor's own tree before they write anything. */
async function emptyDb() {
  const db = new sdk.Db();
  await openApp(sdk, VIEWER_APP, db, { seed: false });
  return db;
}

const ARGS = { head: HEAD, app: "rmudrr4a4q14w0001", port: 7509, artefacts: { signer: "s", block: "b", register: "r" } };
const VIEWER_APP = { name: "Guestbook", components: [{ type: "form", domain: "notes", source: "viewer" }, { type: "table", domain: "notes", source: "viewer" }] };

async function mounted(app, opened) {
  const root = new Node("div");
  await mountApp(root, sdk, app, () => {}, opened.backends, "published", { alive: () => true, seed: false, canWrite: opened.canWrite });
  return all(root);
}

await t("**the PUBLISHER's node: `publisher` components open EDITABLE -- inputs and Add, and a write lands in the publisher's tree**", async () => {
  const n = await nodeSdk(HEAD);
  const opened = await openPublished(n.sdk, { ...ARGS, viewer: false });
  assert.strictEqual(opened.canWrite("publisher").answer, "yes", "the publisher's own node was not asked to write its tree");
  assert.strictEqual(opened.backends.publisher, n.pub, "the publisher's node reads a VIEW of its own tree, not the tree");
  const nodes = await mounted(APP, opened);
  assert.ok(nodes.some(x => x.tag === "input"), "no input on the publisher's page");
  assert.ok(nodes.some(x => x.tag === "button" && x.textContent === "Add"), "no Add on the publisher's page");
  await opened.backends.publisher.put("notes", { title: "from the publisher" });
  assert.deepStrictEqual((await n.pub.scan("notes")).map(r => r.fields.title).sort(), ["from the publisher", "one"]);
});

for (const [who, signsFor] of [["a VISITOR's node (no signer)", null], ["ANOTHER person's key", "b".repeat(64)]]) {
  await t(`${who}: \`publisher\` components are a VIEW -- no inputs, a write refused, nothing opened for a reader`, async () => {
    const n = await nodeSdk(signsFor);
    const opened = await openPublished(n.sdk, { ...ARGS, viewer: false });
    assert.strictEqual(opened.canWrite("publisher").answer, "no");
    assert.ok(!n.opens.includes("openOwn"), "a reader of publisher-only data had its own tree opened (a key minted)");
    const nodes = await mounted(APP, opened);
    assert.ok(!nodes.some(x => x.tag === "input"), "a visitor's page painted an input on the publisher's data");
    await assert.rejects(opened.backends.publisher.put("notes", { title: "intruder" }), /read-only/);
    assert.deepStrictEqual((await n.pub.scan("notes")).map(r => r.fields.title), ["one"], "a visitor's write reached the publisher's tree");
  });
}

await t("**a VISITOR on a `viewer` app gets working INPUTS, and their entry lands in THEIR OWN tree, never the publisher's** (the demo)", async () => {
  const n = await nodeSdk(null);
  const opened = await openPublished(n.sdk, { ...ARGS, viewer: true });
  assert.ok(n.opens.includes("openOwn"), "the visitor's own tree was never opened");
  assert.strictEqual(opened.canWrite("viewer").answer, "yes", "a visitor may not write their own tree");
  const nodes = await mounted(VIEWER_APP, opened);
  assert.ok(nodes.some(x => x.tag === "input" && !x.disabled), "a visitor's page has no working input");
  assert.ok(nodes.some(x => x.tag === "button" && x.textContent === "Add" && !x.disabled), "a visitor's page has no Add");
  await opened.backends.viewer.put("notes", { title: "from a visitor" });
  assert.deepStrictEqual((await n.own.scan("notes")).map(r => r.fields.title), ["from a visitor"], "the entry is not in the visitor's own tree");
  assert.deepStrictEqual((await n.pub.scan("notes")).map(r => r.fields.title), ["one"], "the visitor's entry reached the publisher's tree");
});

await t("**the publisher's node whose own tree does NOT open says so by name, never falls back to a view**", async () => {
  const n = await nodeSdk(HEAD, { answer: "no", why: "the signer refused the register" });
  await assert.rejects(openPublished(n.sdk, { ...ARGS, viewer: false }), /its tree did not open: the signer refused the register/);
  assert.ok(!n.opens.includes("tree"), "a publisher whose tree failed was quietly shown a view");
});

if (failures) { process.stdout.write(`${failures} failing\n`); process.exit(1); }
process.stdout.write("\nok owner view\n");
