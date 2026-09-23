// A PUBLISHED APP IS A NORMAL WEBSITE where everyone is a USER (the owner;
// DATA-SOURCE). ONE session, asked whose node this is, and ONE decision, the
// SDK's `canWrite`:
// * on the node that signs for the APP's data, `publisher` components are
//   the same tree, editable (Add/Edit/Delete), and a write lands in it;
// * anywhere else they are a read-only view: no inputs, a write refused, and
//   nothing opened or minted for a reader;
// * `mine` components are each USER's own tree, with inputs for everyone,
//   opened on the user's node (`openOwn`), and a write lands THERE --
//   never in the app's tree.
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

/** The app's data, in a real Db. */
async function appDb() {
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
 * app's tree is `pub`. Records what was opened.
 */
async function nodeSdk(signsFor, ownAnswer = { answer: "yes", why: "" }) {
  const pub = await appDb();
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

/** A user's own tree before they write anything. */
async function emptyDb() {
  const db = new sdk.Db();
  await openApp(sdk, OWN_DATA_APP, db, { seed: false });
  return db;
}

const ARGS = { head: HEAD, app: "rmudrr4a4q14w0001", port: 7509, artefacts: { signer: "s", block: "b", register: "r" } };
const OWN_DATA_APP = { name: "Guestbook", components: [{ type: "form", domain: "notes", source: "mine" }, { type: "table", domain: "notes", source: "mine" }] };

async function mounted(app, opened) {
  const root = new Node("div");
  await mountApp(root, sdk, app, () => {}, opened.backends, "published", { alive: () => true, seed: false, canWrite: opened.canWrite });
  return all(root);
}

await t("**the node that signs for the APP's data: `publisher` components open EDITABLE -- inputs and Add, and a write lands in the app's tree**", async () => {
  const n = await nodeSdk(HEAD);
  const opened = await openPublished(n.sdk, { ...ARGS, ownData: false });
  assert.strictEqual(opened.canWrite("publisher").answer, "yes", "the app owner's own node was not asked to write its tree");
  assert.strictEqual(opened.backends.publisher, n.pub, "the app owner's node reads a VIEW of its own tree, not the tree");
  const nodes = await mounted(APP, opened);
  assert.ok(nodes.some(x => x.tag === "input"), "no input on the app owner's page");
  assert.ok(nodes.some(x => x.tag === "button" && x.textContent === "Add"), "no Add on the app owner's page");
  await opened.backends.publisher.put("notes", { title: "from the app's owner" });
  assert.deepStrictEqual((await n.pub.scan("notes")).map(r => r.fields.title).sort(), ["from the app's owner", "one"]);
});

for (const [who, signsFor] of [["another user's node (no signer)", null], ["ANOTHER person's key", "b".repeat(64)]]) {
  await t(`${who}: \`publisher\` components are a VIEW -- no inputs, a write refused, nothing opened for a reader`, async () => {
    const n = await nodeSdk(signsFor);
    const opened = await openPublished(n.sdk, { ...ARGS, ownData: false });
    assert.strictEqual(opened.canWrite("publisher").answer, "no");
    assert.ok(!n.opens.includes("openOwn"), "a reader of the app's data only had its own tree opened (a key minted)");
    const nodes = await mounted(APP, opened);
    assert.ok(!nodes.some(x => x.tag === "input"), "a user's page painted an input on the app's data");
    await assert.rejects(opened.backends.publisher.put("notes", { title: "intruder" }), /read-only/);
    assert.deepStrictEqual((await n.pub.scan("notes")).map(r => r.fields.title), ["one"], "another user's write reached the app's tree");
  });
}

await t("**a USER of an app with `mine` components gets working INPUTS, and their entry lands in THEIR OWN tree, never the app's** (the demo)", async () => {
  const n = await nodeSdk(null);
  const opened = await openPublished(n.sdk, { ...ARGS, ownData: true });
  assert.ok(n.opens.includes("openOwn"), "the user's own tree was never opened");
  assert.strictEqual(opened.canWrite("mine").answer, "yes", "a user may not write their own tree");
  const nodes = await mounted(OWN_DATA_APP, opened);
  assert.ok(nodes.some(x => x.tag === "input" && !x.disabled), "a user's page has no working input");
  assert.ok(nodes.some(x => x.tag === "button" && x.textContent === "Add" && !x.disabled), "a user's page has no Add");
  await opened.backends.mine.put("notes", { title: "from a user" });
  assert.deepStrictEqual((await n.own.scan("notes")).map(r => r.fields.title), ["from a user"], "the entry is not in the user's own tree");
  assert.deepStrictEqual((await n.pub.scan("notes")).map(r => r.fields.title), ["one"], "the user's entry reached the app's tree");
});

await t("**the node that signs for the app's data, whose tree does NOT open, says so by name, never falls back to a view**", async () => {
  const n = await nodeSdk(HEAD, { answer: "no", why: "the signer refused the register" });
  await assert.rejects(openPublished(n.sdk, { ...ARGS, ownData: false }), /its tree did not open: the signer refused the register/);
  assert.ok(!n.opens.includes("tree"), "an app owner whose tree failed was quietly shown a view");
});

if (failures) { process.stdout.write(`${failures} failing\n`); process.exit(1); }
process.stdout.write("\nok owner view\n");
