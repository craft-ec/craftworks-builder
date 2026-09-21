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
function fakeSession({ provisioned = true, refused = null, exhausted = false, closeThrows = false } = {}) {
  const s = {
    closed: 0,
    db: { root: () => "r", preload: async () => {} },
    provisioned: () => provisioned,
    refused: () => refused,
    exhausted: () => exhausted,
    close: () => { s.closed += 1; if (closeThrows) throw new Error("close blew up"); },
  };
  return s;
}

const tick = () => new Promise(r => setTimeout(r, 0));

// ---- builder#54: nothing of A survives into B -----------------------------

await t("**after A publishes, a new project B is not Published and gets no backend**", async () => {
  const s = fakeSession();
  const A = createProjectRuntime({ mount: fakeMounts().mount, publish: async () => ({ session: s, db: s.db }) });
  await A.publish({}, {});
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
  await shared.publish({}, {});
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
  const pending = A.publish({}, {}, { after: async () => { afterRan += 1; } });
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
  await rt.publish({}, {});
  assert.strictEqual(m.calls[0].stopped, 1, "the preview mount is stopped");
  rt.ensureMounted(); await tick();
  assert.strictEqual(m.calls[1].args.backend, s.db);
  assert.strictEqual(m.calls[1].args.phase, "published");
});

// ---- builder#58: no session outlives its owner -----------------------------

await t("**the issue's own reproduction: a refused publish closes the session it opened**", async () => {
  let closed = 0;
  await publish({}, {
    port: 18080,
    open: async () => ({ provisioned: () => false, refused: () => "test refusal", close: () => { closed++; } }),
  }).catch(() => {});
  assert.strictEqual(closed, 1, "it was 0: the handle was dropped with its socket and timers running");
});

for (const [why, opts, msg] of [
  ["refusal", { provisioned: false, refused: "no room" }, /refused to set up: no room/],
  ["exhaustion", { provisioned: false, exhausted: true }, /still cannot write/],
]) {
  await t(`a ${why} closes the session and keeps the ORIGINAL error, even when close throws`, async () => {
    const s = fakeSession({ ...opts, closeThrows: true });
    await assert.rejects(publish({}, { port: 18080, open: async () => s }), msg,
      "the close's own failure must not replace the reason that explains what went wrong");
    assert.strictEqual(s.closed, 1);
  });
}

await t("waitFor times out, and ANY error out of the wait closes the session", async () => {
  // `waitFor` itself, driven with a clock that has already run out.
  const s = fakeSession({ provisioned: false });
  const { waitFor } = await import("../publish.js");
  let now = 0;
  await assert.rejects(waitFor(s, { everyMs: 0, budgetMs: 10, now: () => (now += 100) }), /in time/);
  // `publish` does not expose the budget, so the close is proved for any
  // error the wait throws — which is the property that matters: every exit
  // that is not a handover closes the handle.
  const s2 = fakeSession({ provisioned: false, refused: null });
  s2.exhausted = () => { throw new Error("did not finish setting up in time"); };
  await assert.rejects(publish({}, { port: 18080, open: async () => s2 }), /in time/);
  assert.strictEqual(s2.closed, 1);
});

await t("**retrying after failures leaves exactly one session open**", async () => {
  const sessions = [];
  let attempt = 0;
  const open = async () => {
    attempt += 1;
    const s = fakeSession(attempt < 3 ? { provisioned: false, refused: "busy" } : {});
    sessions.push(s);
    return s;
  };
  const rt = createProjectRuntime({ mount: fakeMounts().mount, publish });
  for (let i = 0; i < 3; i += 1) await rt.publish({}, { port: 18080, open }).catch(() => {});
  assert.strictEqual(rt.phase, "published");
  assert.deepStrictEqual(sessions.map(s => s.closed), [1, 1, 0],
    "the two failed attempts closed theirs; the one that succeeded is OWNED, not orphaned");
  rt.dispose();
  assert.deepStrictEqual(sessions.map(s => s.closed), [1, 1, 1], "and switching away closes that one too");
});

await t("a second successful publish closes the session it replaces", async () => {
  const a = fakeSession(), b = fakeSession();
  const queue = [a, b];
  const rt = createProjectRuntime({ mount: fakeMounts().mount, publish: async () => { const s = queue.shift(); return { session: s, db: s.db }; } });
  await rt.publish({}, {});
  await rt.publish({}, {});
  assert.strictEqual(a.closed, 1);
  assert.strictEqual(b.closed, 0);
  assert.strictEqual(rt.session, b);
});

console.log("\nproject runtime: all ok");
