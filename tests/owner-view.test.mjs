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
/** The seq of the app's head on the faked node. */
const NODE_SEQ = 5;

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
async function nodeSdk(signsFor, ownAnswer = { answer: "yes", why: "" }, { traces = true } = {}) {
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
          ...(traces ? { pageTrace: () => "the ASKED page's dump" } : {}),
          // THE SDK's PUBLISHED-VERSION FLOOR (craftworks-sdk#354), as its reader
          // keeps it: the node holds the app's head at NODE_SEQ; asked for a
          // newer one, every read WAITS (never an older answer) and
          // `waitingFor()` says what for.
          tree: async (head, { seq = 0 } = {}) => {
            opens.push({ tree: seq });
            if (head !== HEAD) return { db: null };
            const below = seq > NODE_SEQ;
            const waiting = new Proxy(pub, { get: (d, k) => (typeof d[k] === "function" ? () => new Promise(() => {}) : d[k]) });
            return { db: below ? waiting : viewOf(pub), waitingFor: () => (below ? `waiting for the published version (seq ${seq}); the node answered seq ${NODE_SEQ} (1 times)` : ""), ...(traces ? { pageTrace: () => "the TREE's page's dump" } : {}) };
          },
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
  assert.ok(!n.opens.some(o => o.tree !== undefined), "an app owner whose tree failed was quietly shown a view");
});

await t("**PUBLISHED AT A NEWER VERSION than the node holds: the view WAITS for it and says so — no rows from the older head** (craftworks-sdk#349)", async () => {
  const n = await nodeSdk(null);
  const opened = await openPublished(n.sdk, { ...ARGS, seq: NODE_SEQ + 4, ownData: false });
  assert.deepStrictEqual(n.opens.filter(o => o.tree !== undefined), [{ tree: NODE_SEQ + 4 }], "the app's tree was not opened at the published seq");
  assert.match(opened.waitingFor(), /waiting for the published version \(seq 9\); the node answered seq 5/);
  const read = await Promise.race([opened.backends.publisher.scan("notes").then(r => r.map(x => x.fields.title)), new Promise(ok => setTimeout(() => ok("pending"), 50))]);
  assert.strictEqual(read, "pending", "a view below the published version showed the older head's rows");
});

await t("THE CONTROLS: published at or below the node's head, or by an app.json from before the seq, the view reads at once and waits for nothing", async () => {
  for (const [what, seq] of [["the node's own seq", NODE_SEQ], ["an older seq", 1], ["no seq (an older app.json)", undefined]]) {
    const n = await nodeSdk(null);
    const opened = await openPublished(n.sdk, { ...ARGS, ...(seq === undefined ? {} : { seq }), ownData: false });
    assert.strictEqual(opened.waitingFor(), "", `${what}: the view says it waits`);
    assert.deepStrictEqual((await opened.backends.publisher.scan("notes")).map(r => r.fields.title), ["one"], what);
  }
});

await t("the app owner's own node reads its own tree (that version or newer): it waits for nothing", async () => {
  const n = await nodeSdk(HEAD);
  const opened = await openPublished(n.sdk, { ...ARGS, seq: NODE_SEQ + 4, ownData: false });
  assert.strictEqual(opened.waitingFor(), "");
  assert.strictEqual(opened.backends.publisher, n.pub);
});

// THE OPENER'S TWO PAGES, TWO READERS (builder#160): a visitor's reads run on the TREE's own page, so its dump is the
// tree's, never the asked page's; an owner has no view page; an SDK without a reader is said by name.
await t("**a visitor's page recordings are TWO: the asked page's and the tree's own -- an owner's view is said, an old SDK named**", async () => {
  const visitor = await openPublished((await nodeSdk(null)).sdk, { ...ARGS, ownData: false });
  assert.deepStrictEqual(visitor.pageTrace(), { asked: "the ASKED page's dump", view: "the TREE's page's dump" }, "a visitor's reads were not recorded from the tree's own page");
  const owner = await openPublished((await nodeSdk(HEAD)).sdk, { ...ARGS, ownData: false });
  assert.strictEqual(owner.pageTrace().asked, "the ASKED page's dump");
  assert.match(owner.pageTrace().view, /^\(none: this node holds the key/, "an owner's missing view page was not said");
  const old = await openPublished((await nodeSdk(null, undefined, { traces: false })).sdk, { ...ARGS, ownData: false });
  assert.deepStrictEqual(old.pageTrace(), { asked: "(this SDK's session handle has no pageTrace(): craftworks-sdk#434)", view: "(this SDK's tree has no pageTrace(): builder#160)" });
});

if (failures) { process.stdout.write(`${failures} failing\n`); process.exit(1); }
process.stdout.write("\nok owner view\n");
