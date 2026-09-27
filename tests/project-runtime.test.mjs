// A project's runtime has ONE owner, and switching projects disposes it.
//
// builder#54, #57, #58 were one defect: the published backend, the in-flight
// mount, the publish phase and the mounted db were page globals, each reset on
// some paths and not others. These drive every path the three issues name,
// against `project-runtime.js` with injected fakes, so each one runs without a
// page or a node. The page-level screenshots are the other half of the gate.
import assert from "node:assert";
import { createProjectRuntime } from "../project-runtime.js";
import { publish } from "../publish.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSdk } from "../sdk-loader.js";
const { ids } = await loadSdk(readFileSync(fileURLToPath(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url))));

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

/** A deferred: a promise whose settling the test controls. */
const later = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

/** A fake mount that records what it was handed and whether it was stopped. */
function fakeMounts() {
  const calls = [];
  const mount = args => {
    const d = later();
    const call = { args, stopped: 0, d, db: { id: `db${calls.length}` } };
    calls.push(call);
    return d.p.then(() => ({ db: call.db, stop: () => { call.stopped += 1; } }));
  };
  return { calls, mount };
}

/** A fake SDK session, as `open()` returns it. */
function fakeSession() {
  const s = {
    closed: 0,
    // The session's db has the definition doors (the owner's tree holds the draft): an empty draft here.
    db: { root: () => "r", preload: async () => {}, definition: async () => [], draftPut: async () => {}, draftDelete: async () => true, watchDefinition: () => () => {} },
    close: () => { s.closed += 1; },
  };
  return s;
}

const tick = () => new Promise(r => setTimeout(r, 0));

// `publish` has NO default handoff or after (builder#73): each used to be a
// no-op that made a safety step look done. These tests drive the OWNER —
// sessions, generations, disposal — not the handoff, so they pass explicit
// no-ops and say so here. The handoff has its own tests (handoff.test.mjs),
// and the throw when one is missing is tested in no-unsafe-defaults.
const NO_HANDOFF = { handoff: async () => {}, after: async () => {} };

// ---- builder#54: nothing of A survives into B -----------------------------

await t("**after A publishes, a new project B is not Published and gets no backend**", async () => {
  const s = fakeSession();
  const A = createProjectRuntime({ mount: fakeMounts().mount, publish: async () => ({ session: s, db: s.db }) });
  await A.publish({}, {}, NO_HANDOFF);
  assert.strictEqual(A.phase, "published");
  assert.strictEqual(A.publishedDb, s.db);

  A.dispose();
  const m = fakeMounts();
  const B = createProjectRuntime({ mount: m.mount, publish: async () => { throw new Error("unused"); } });
  assert.strictEqual(B.phase, "idle", "B was never published and must not say so");
  assert.strictEqual(B.publishedDb, null);
  B.ensureMounted();
  await tick();
  assert.strictEqual(m.calls[0].args.backend, null,
    "a mount of B must not be handed A's backend — with a shared domain name it would read A's records");
  assert.strictEqual(s.closed, 1, "A's session closed when A was disposed");
});

await t("THE CONTROL: without a dispose, the old globals' behaviour is what you get", async () => {
  // The same runtime reused across a 'switch' is exactly the old page state:
  // it still says Published and still hands out A's backend. This is what the
  // test above would observe if app.js stopped creating a new runtime.
  const s = fakeSession();
  const m = fakeMounts();
  const shared = createProjectRuntime({ mount: m.mount, publish: async () => ({ session: s, db: s.db }) });
  await shared.publish({}, {}, NO_HANDOFF);
  shared.ensureMounted();
  await tick();
  assert.strictEqual(shared.phase, "published");
  assert.strictEqual(m.calls.at(-1).args.backend, s.db);
});

await t("**a delayed mount of A, finishing after the switch, is stopped and never adopted**", async () => {
  const m = fakeMounts();
  const A = createProjectRuntime({ mount: m.mount, publish: async () => ({}) });
  const pending = A.ensureMounted();
  await tick();
  A.dispose();
  m.calls[0].args.adopt({ id: "late" });   // its onData, arriving late
  m.calls[0].d.resolve();                  // and then it finishes
  assert.strictEqual(await pending, null, "a disowned mount resolves to nothing");
  assert.strictEqual(m.calls[0].stopped, 1, "its listeners were stopped rather than left attached");
  assert.strictEqual(A.db, null, "its db was never adopted");
  assert.strictEqual(m.calls[0].args.alive(), false, "and it can see it is no longer wanted");
});

await t("**a publish of A finishing after the switch closes its session and records nothing**", async () => {
  const s = fakeSession();
  const d = later();
  let afterRan = 0;
  const A = createProjectRuntime({ mount: fakeMounts().mount, publish: () => d.p.then(() => ({ session: s, db: s.db })) });
  const pending = A.publish({}, {}, { ...NO_HANDOFF, after: async () => { afterRan += 1; } });
  A.dispose();
  d.resolve();
  assert.strictEqual(await pending, null);
  assert.strictEqual(s.closed, 1, "the session a late publish produced is closed, not orphaned");
  assert.strictEqual(afterRan, 0, "history for A must not be written into whichever project is open now");
  assert.strictEqual(A.publishedDb, null);
});

// ---- builder#57: a mount can always happen again --------------------------

await t("**preview -> design -> preview mounts again**", async () => {
  const m = fakeMounts();
  const rt = createProjectRuntime({ mount: m.mount, publish: async () => ({}) });
  rt.ensureMounted(); await tick(); m.calls[0].d.resolve(); await tick();
  assert.strictEqual(rt.mountState, "mounted");

  rt.invalidate();                          // back to design
  assert.strictEqual(m.calls[0].stopped, 1, "leaving the preview stops its listeners");
  assert.strictEqual(rt.mountState, "none");

  rt.ensureMounted(); await tick();         // preview again
  assert.strictEqual(m.calls.length, 2, "the second preview MOUNTED — it used to be skipped for good");
});

await t("**a second render while a mount is starting does not mount twice**", async () => {
  const m = fakeMounts();
  const rt = createProjectRuntime({ mount: m.mount, publish: async () => ({}) });
  rt.ensureMounted();
  assert.strictEqual(rt.ensureMounted(), null);
  assert.strictEqual(rt.ensureMounted(), null);
  await tick();
  assert.strictEqual(m.calls.length, 1, "what the old sentinel was for still holds");
});

await t("**a rejected mount is recoverable, not terminal until reload**", async () => {
  const m = fakeMounts();
  const rt = createProjectRuntime({ mount: m.mount, publish: async () => ({}) });
  const first = rt.ensureMounted();
  await tick();
  m.calls[0].d.reject(new Error("mount failed"));
  await assert.rejects(first, /mount failed/);
  assert.strictEqual(rt.mountState, "none");
  rt.ensureMounted(); await tick();
  assert.strictEqual(m.calls.length, 2, "the next render tried again");
});

await t("an edit between previews disowns the mount in flight", async () => {
  const m = fakeMounts();
  const rt = createProjectRuntime({ mount: m.mount, publish: async () => ({}) });
  const first = rt.ensureMounted(); await tick();
  rt.invalidate();                          // the definition changed mid-mount
  const second = rt.ensureMounted(); await tick();
  m.calls[0].d.resolve(); m.calls[1].d.resolve();
  assert.strictEqual(await first, null);
  assert.deepStrictEqual(await second, m.calls[1].db);
  assert.strictEqual(m.calls[0].stopped, 1, "the stale mount's bindings do not linger beside the new ones");
  assert.strictEqual(m.calls[1].stopped, 0);
  assert.strictEqual(rt.db, m.calls[1].db);
});

await t("publishing remounts on the new backend", async () => {
  const s = fakeSession();
  const m = fakeMounts();
  const rt = createProjectRuntime({ mount: m.mount, publish: async () => ({ session: s, db: s.db }) });
  rt.ensureMounted(); await tick(); m.calls[0].d.resolve(); await tick();
  await rt.publish({}, {}, NO_HANDOFF);
  assert.strictEqual(m.calls[0].stopped, 1, "the preview mount is stopped");
  rt.ensureMounted(); await tick();
  assert.strictEqual(m.calls[1].args.backend, s.db);
  assert.strictEqual(m.calls[1].args.phase, "published");
});

// ---- builder#58: no session outlives its owner -----------------------------
//
// A failed `open()` closes its OWN session (the SDK's, tested there: "a REFUSAL
// ends it in the node's words, and the session is closed"), and publish holds
// no handle until open() has one to hand over (builder#173). So what is the
// builder's is the SUCCESSFUL one: owned by the runtime, closed when replaced
// or disposed.

/** An `open()` as the SDK's behaves: on failure it closes the session it made, then rejects. */
const ART = { signer: "s.wasm", block: "b.wasm", register: "r.wasm" };
const sdkOpen = (s, fail) => async () => { if (fail) { s.close(); throw new Error(fail); } return s; };

await t("**a refused publish leaves nothing open**: the SDK closed its session, and publish never held it", async () => {
  const s = fakeSession();
  const seen = [];
  await assert.rejects(publish({}, { appId: "proj1", ids, onSaving: () => {}, port: 18080, artefacts: ART, open: sdkOpen(s, "the node refused to set up: no room") }, (p, e) => seen.push([p, e])),
    /refused to set up: no room/);
  assert.strictEqual(s.closed, 1, "closed twice (or never): the builder must not close a session it never held");
  assert.deepStrictEqual(seen.at(-1)[0], "failed");
});

await t("**retrying after failures leaves exactly one session open**", async () => {
  const sessions = [];
  let attempt = 0;
  const open = async () => {
    attempt += 1;
    const s = fakeSession();
    sessions.push(s);
    return sdkOpen(s, attempt < 3 ? "the node refused to set up: busy" : null)();
  };
  const rt = createProjectRuntime({ mount: fakeMounts().mount, publish });
  for (let i = 0; i < 3; i += 1) await rt.publish({}, { appId: "proj1", ids, port: 18080, artefacts: ART, open }, NO_HANDOFF).catch(() => {});
  assert.strictEqual(rt.phase, "published");
  assert.deepStrictEqual(sessions.map(s => s.closed), [1, 1, 0],
    "the two failed attempts closed theirs; the one that succeeded is OWNED, not orphaned");
  rt.dispose();
  assert.deepStrictEqual(sessions.map(s => s.closed), [1, 1, 1], "and switching away closes that one too");
});

// §19 P3: the owner's tree is opened ONCE, with the project; a Publish uses that connection and never opens another.
await t("**one connection per project**: creation opens the tree, and a Publish (and a second) opens nothing more", async () => {
  const a = fakeSession(), b = fakeSession();
  const queue = [a, b];
  let opened = 0;
  const rt = createProjectRuntime({ mount: fakeMounts().mount, publish: async () => { opened += 1; const s = queue.shift(); return { session: s, db: s.db }; } });
  await rt.connect({});
  assert.strictEqual(rt.connection, "open");
  await rt.publish({}, {}, NO_HANDOFF);
  await rt.publish({}, {}, NO_HANDOFF);
  assert.strictEqual(opened, 1, "a Publish opened a second connection");
  assert.strictEqual(rt.session, a);
  assert.strictEqual(a.closed, 0);
  rt.dispose();
  assert.strictEqual(a.closed, 1, "switching away closes the one connection");
});

await t("**a Publish while the tree is still opening joins that open**, and says how far it got", async () => {
  const s = fakeSession();
  const d = later();
  let opened = 0;
  const phases = [];
  const rt = createProjectRuntime({ mount: fakeMounts().mount, publish: (_app, _deps, report) => { opened += 1; report("provisioning"); return d.p.then(() => ({ session: s, db: s.db })); } });
  const conn = rt.connect({});
  const pub = rt.publish({}, {}, { ...NO_HANDOFF, onPhase: p => phases.push(p) });
  d.resolve();
  await conn;
  await pub;
  assert.strictEqual(opened, 1);
  assert.strictEqual(rt.phase, "published");
  assert.ok(phases.includes("provisioning"), `the button never said how far the open had got: ${phases}`);
});

await t("**a failed open is retried on its own** (rule 8, doubling, never given up), and a project switch stops the retry", async () => {
  const timers = [];
  const schedule = (fn, ms) => { const tmr = { fn, ms, cancelled: false }; timers.push(tmr); return () => { tmr.cancelled = true; }; };
  let attempt = 0;
  const s = fakeSession();
  const rt = createProjectRuntime({ mount: fakeMounts().mount, schedule, publish: async () => { attempt += 1; if (attempt < 3) throw new Error("no node on port 18080"); return { session: s, db: s.db }; } });
  await rt.connect({}).catch(() => {});
  assert.strictEqual(rt.connection, "failed");
  assert.match(rt.connectionError, /no node on port 18080/);
  timers.at(-1).fn();
  await new Promise(r => setImmediate(r));
  timers.at(-1).fn();
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(timers.map(x => x.ms), [1_000, 2_000], "the waits did not double");
  assert.strictEqual(rt.connection, "open");
  const rt2 = createProjectRuntime({ mount: fakeMounts().mount, schedule, publish: async () => { throw new Error("down"); } });
  await rt2.connect({}).catch(() => {});
  rt2.dispose();
  assert.strictEqual(timers.at(-1).cancelled, true, "a disposed project kept retrying");
});

// The draft lives in the owner's tree. For a project from before, the TREE is the definition: the canvas gets it,
// and nothing is written until it has -- an empty canvas diffed against the draft would delete it all. For a project
// made in this tab (fresh), the canvas is the definition, and edits made before the tree opens are held and written.
const treeWith = records => {
  const held = new Map(records);
  const writes = [];
  return {
    held, writes,
    definition: async w => (w === "draft" ? [...held].map(([key, body]) => ({ key, body })) : []),
    draftPut: async (k, b) => { writes.push(["put", k]); held.set(k, b); },
    draftDelete: async k => { writes.push(["del", k]); return held.delete(k); },
    // The draft's live watch: the test fires it as a head move would (`fire(rows)` or `fire(null, { error })`).
    watchers: new Set(),
    watchDefinition(which, cb) { this.watchers.add(cb); return () => this.watchers.delete(cb); },
    fire(...a) { for (const cb of this.watchers) cb(...a); },
  };
};

await t("**an existing project opens FROM its draft**: the canvas is handed what the tree holds, and an edit before that is refused", async () => {
  const tree = treeWith([["meta", { name: "Old", order: ["k1"] }], ["c/k1", { type: "table", domain: "tasks" }]]);
  const s = { ...fakeSession(), db: tree };
  let shown = null;
  const rt = createProjectRuntime({ mount: fakeMounts().mount, publish: async () => ({ session: s, db: tree }), onDraft: app => { shown = app; } });
  assert.throws(() => rt.edit({ name: "", components: [] }), /still being read from your node/);
  await rt.connect({});
  assert.strictEqual(shown.name, "Old");
  assert.deepStrictEqual(shown.components.map(c => c.type), ["table"]);
  assert.deepStrictEqual(tree.writes, [], "opening a project wrote into its draft");
  rt.dispose();
});

await t("**a fresh project's edits made before the tree opens are written when it does**", async () => {
  const tree = treeWith([]);
  const s = { ...fakeSession(), db: tree };
  const d = later();
  let shown = 0;
  const rt = createProjectRuntime({ mount: fakeMounts().mount, fresh: true, publish: () => d.p.then(() => ({ session: s, db: tree })), onDraft: () => { shown += 1; } });
  const conn = rt.connect({});
  rt.edit({ name: "New", components: [{ type: "form", _builder: { key: "k9" } }] });
  assert.strictEqual(rt.draft.attached, false);
  assert.ok(rt.draft.pending > 0);
  d.resolve();
  await conn;
  await new Promise(r => setImmediate(r));
  assert.strictEqual(shown, 0, "a fresh canvas was replaced by the tree's (empty) draft");
  assert.deepStrictEqual([...tree.held.keys()].sort(), ["c/k9", "meta"]);
  rt.dispose();
});

await t("**the canvas follows its draft with no reopen**: the draft's watch re-reads, the canvas takes the tree's version; a failed re-read is said; dispose unwatches", async () => {
  const tree = treeWith([["meta", { name: "Mine", order: ["k1"] }], ["c/k1", { type: "table", label: "old" }]]);
  const s = { ...fakeSession(), db: tree };
  const shown = [];
  const rt = createProjectRuntime({ mount: fakeMounts().mount, publish: async () => ({ session: s, db: tree }),
    onDraft: app => shown.push(app.components.map(c => c.label)) });
  await rt.connect({});
  assert.deepStrictEqual(shown, [["old"]]);
  assert.strictEqual(tree.watchers.size, 1, "the draft is not watched");
  // Another session of this identity changed k1 (or this tab lost it): the head moved, the watch re-read.
  tree.fire([{ key: "meta", body: { name: "Mine", order: ["k1"] } }, { key: "c/k1", body: { type: "table", label: "the other device's" } }]);
  assert.deepStrictEqual(shown.at(-1), ["the other device's"], "the canvas did not follow its draft");
  tree.fire(null, { error: new Error("the draft's block could not be loaded") });
  assert.strictEqual(rt.draft.watchError, "the draft's block could not be loaded", "a failed re-read was not said");
  assert.strictEqual(shown.length, 2, "a failed re-read changed the canvas");
  tree.fire([{ key: "meta", body: { name: "Mine", order: ["k1"] } }, { key: "c/k1", body: { type: "table", label: "the other device's" } }]);
  assert.strictEqual(rt.draft.watchError, null, "the failure was still said after a re-read landed");
  rt.dispose();
  assert.strictEqual(tree.watchers.size, 0, "a disposed project kept its draft watched");
});

await t("**a tree that cannot be watched is refused by name**, never a canvas that silently goes stale", async () => {
  const tree = treeWith([]);
  delete tree.watchDefinition;
  const rt = createProjectRuntime({ mount: fakeMounts().mount, schedule: () => () => {}, publish: async () => ({ session: fakeSession(), db: tree }) });
  await assert.rejects(rt.connect({}), /offers no `watchDefinition`/);
  rt.dispose();
});

console.log("\nproject runtime: all ok");
