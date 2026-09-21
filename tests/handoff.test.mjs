// Publish carries the records a person made in Preview (builder#52).
//
// Driven over two REAL SDK databases — the preview's and the one Publish
// switches to — which is how the audit reproduced it: old count 1, new
// count 0, button Published. Acknowledgement is driven with a target whose
// rows report the states the engine reports: PENDING, then CLEAN, or
// ROLLED_BACK, or never confirmed.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSdk } from "../sdk-loader.js";
import { handoff, previewDb } from "../handoff.js";
import { openApp, schemasOf } from "../runtime-logic.js";
import { createProjectRuntime } from "../project-runtime.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

const SCHEMA = { type: "Task", fields: [{ name: "title", kind: "text", required: true }, { name: "done", kind: "bool" }] };
const app = {
  components: [{ type: "form", domain: "tasks", mode: "owned" }, { type: "table", domain: "tasks", mode: "owned" }],
  schemas: { tasks: SCHEMA },
  seed: { tasks: [{ title: "seed one" }, { title: "seed two" }] },
};
const titles = async (db, d = "tasks") => (await db.scan(d)).map(r => r.fields.title).sort();

const PID = "r0projectid0000";
const SEED_MS = Date.now() - 86_400_000;
/** The preview database exactly as a mount makes it: defined, seeded, recording deletes. */
const preview = async () => (await openApp(sdk, app, previewDb(new sdk.Db()))).db;
/**
 * A first attempt that copied everything and was NOT confirmed: the publish
 * did not complete, so the domain is not live (builder#86) and the next
 * attempt still carries Preview's edits and deletes.
 */
async function unconfirmedAttempt(src, dst) {
  const pending = new Proxy(dst, { get(o, k) {
    const v = Reflect.get(o, k);
    if (k === "get") return async (...a) => { const r = await v.apply(o, a); return r && { ...r, state: "PENDING" }; };
    return typeof v === "function" ? v.bind(o) : v;
  } });
  await assert.rejects(handoff({ source: src, target: pending, ...ctx, confirm: { everyMs: 0, budgetMs: 10 } }), /not confirmed/);
}
/** What the page supplies besides the two databases (builder#83). */
const ctx = { app, schemas: schemasOf(app), slotFrom: sdk.slotFrom, namespace: PID, seedMs: SEED_MS, onNotice: () => {} };

await t("**the audit's reproduction: a row entered in Preview reaches the published backend**", async () => {
  const src = await preview();
  await src.put("tasks", { title: "entered" });
  const dst = new sdk.Db();
  const did = await handoff({ source: src, target: dst, ...ctx });
  assert.deepStrictEqual(await titles(dst), ["entered", "seed one", "seed two"],
    "it was 0 rows: the preview db was dropped and nothing copied it");
  // The two seed rows are the definition's, handed off at their seed slots (builder#83).
  assert.deepStrictEqual(did, { copied: 1, updated: 0, kept: 0, removed: 0, seeded: 2 });
});

await t("**an EDITED and a DELETED seed row stay edited and deleted**", async () => {
  const src = await preview();
  const [one, two] = await src.scan("tasks");
  await src.update("tasks", one.id, { title: "seed one, edited" });
  await src.delete("tasks", two.id);
  const dst = new sdk.Db();
  await handoff({ source: src, target: dst, ...ctx });
  assert.deepStrictEqual(await titles(dst), ["seed one, edited"]);

  // And MOUNTING the published backend does not bring the deleted seed row
  // back: a mount of a real backend does not seed (it used to, on every mount).
  await openApp(sdk, app, dst, { seed: false });
  assert.deepStrictEqual(await titles(dst), ["seed one, edited"], "a remount re-seeded the published backend");
});

await t("THE CONTROL: the default mount DOES seed, so the line above is doing something", async () => {
  const dst = new sdk.Db();
  await openApp(sdk, app, dst);
  assert.deepStrictEqual(await titles(dst), ["seed one", "seed two"]);
  await openApp(sdk, app, dst);
  assert.strictEqual((await titles(dst)).length, 4, "seeding on every mount duplicates — why a published backend must not");
});

await t("**never previewed: the seed is written once, and a retry does not write it twice**", async () => {
  const dst = new sdk.Db();
  await handoff({ source: null, target: dst, ...ctx });
  await handoff({ source: null, target: dst, ...ctx });
  assert.deepStrictEqual(await titles(dst), ["seed one", "seed two"]);
});

await t("**a partial failure, then a retry: nothing lost, nothing doubled, later edits carried**", async () => {
  const src = await preview();
  await src.put("tasks", { title: "a" });
  await src.put("tasks", { title: "b" });
  const dst = new sdk.Db();
  let puts = 0;
  // The target refuses its third write, as a busy engine would.
  const flaky = new Proxy(dst, { get(o, k) {
    const v = Reflect.get(o, k);
    if (k === "createAt") return async (...a) => { if (++puts === 3) throw new Error("Busy"); return v.apply(o, a); };
    return typeof v === "function" ? v.bind(o) : v;
  } });
  await assert.rejects(handoff({ source: src, target: flaky, ...ctx }), /Busy/);
  assert.strictEqual((await titles(src)).length, 4, "the source is untouched by a failed handoff");
  assert.strictEqual((await titles(dst)).length, 2, "two copies landed before the refusal");

  // Between the attempts the person keeps working in the preview.
  const [first] = await src.scan("tasks");
  await src.update("tasks", first.id, { title: "edited between attempts" });
  await src.put("tasks", { title: "added between attempts" });

  const did = await handoff({ source: src, target: flaky, ...ctx });
  assert.deepStrictEqual(await titles(dst), (await titles(src)), "the target matches the preview exactly");
  assert.strictEqual(did.copied, 3, "only the three missing rows were copied");
  assert.strictEqual(did.updated, 1, "the edit made between attempts was carried");

  // And a THIRD run with nothing changed writes nothing.
  const again = await handoff({ source: src, target: dst, ...ctx });
  assert.deepStrictEqual(again, { copied: 0, updated: 0, kept: 0, removed: 0, seeded: 0 });
});

await t("**an edit in the SAME MILLISECOND as the write before it is still carried**", async () => {
  // Deterministic, rather than left to timing: every row the source scans is
  // made to report the SAME `updated` it had at the first handoff, which is
  // what an edit landing in the same millisecond looks like. Detecting change
  // by `updated` missed exactly this, in 10 of 20 runs of the retry test.
  const src = await preview();
  const dst = new sdk.Db();
  await unconfirmedAttempt(src, dst);
  const [first] = await src.scan("tasks");
  const frozen = first.updated;
  await src.update("tasks", first.id, { title: "edited within the same ms" });
  const sameMs = new Proxy(src, { get(o, k) {
    const v = Reflect.get(o, k);
    if (k === "scan") return async (...a) => (await v.apply(o, a)).map(r => (r.id === first.id ? { ...r, updated: frozen } : r));
    return typeof v === "function" ? v.bind(o) : v;
  } });
  const did = await handoff({ source: sameMs, target: dst, ...ctx });
  assert.strictEqual(did.updated, 1, "the edit must be seen even though `updated` did not move");
  assert.deepStrictEqual(await titles(dst), await titles(src));
});

await t("a row deleted in the preview after an earlier attempt is removed from the target", async () => {
  const src = await preview();
  const dst = new sdk.Db();
  await unconfirmedAttempt(src, dst);
  const [gone] = await src.scan("tasks");
  await src.delete("tasks", gone.id);
  const did = await handoff({ source: src, target: dst, ...ctx });
  assert.strictEqual(did.removed, 1);
  assert.deepStrictEqual(await titles(dst), await titles(src));
});

// ---- acknowledgement ------------------------------------------------------

/** A target over a real Db whose rows report `states()` for their state. */
function acking(states) {
  const db = new sdk.Db();
  let reads = 0;
  return new Proxy(db, { get(o, k) {
    const v = Reflect.get(o, k);
    if (k === "get") return async (...a) => { const r = await v.apply(o, a); return r && { ...r, state: states(++reads) }; };
    return typeof v === "function" ? v.bind(o) : v;
  } });
}
const fast = { everyMs: 0, budgetMs: 50 };

await t("**PENDING is not done: the handoff waits until the node says CLEAN**", async () => {
  const src = await preview();
  let clean = false;
  const dst = acking(n => (n > 4 ? (clean = true, "CLEAN") : "PENDING"));
  await handoff({ source: src, target: dst, ...ctx, confirm: { everyMs: 0, budgetMs: 5_000 } });
  assert.ok(clean, "it returned before any row read CLEAN");
});

await t("**a ROLLED_BACK write fails the handoff, and says the data is still here**", async () => {
  const src = await preview();
  const dst = acking(() => "ROLLED_BACK");
  await assert.rejects(handoff({ source: src, target: dst, ...ctx, confirm: fast }),
    /did not reach the node; your data is still here/);
});

await t("**never confirmed fails at the deadline instead of waiting for ever**", async () => {
  const src = await preview();
  const dst = acking(() => "PENDING");
  await assert.rejects(handoff({ source: src, target: dst, ...ctx, confirm: fast }),
    /not confirmed by the node yet/);
});

// ---- rollback, then retry (found in review of builder#61) -------------------

/**
 * A node over a real Db that ACCEPTS a put and later LOSES it: the `n`-th put
 * of the first attempt resolves, then the node drops the row — which is how a
 * real rollback looks, since a put resolves when the copy is queued and the
 * refusal arrives afterwards. Counts every put.
 */
function losesOne(lose = 2) {
  const db = new sdk.Db();
  let puts = 0, healthy = false;
  const target = new Proxy(db, { get(o, k) {
    const v = Reflect.get(o, k);
    if (k === "createAt") return async (...a) => {
      const r = await v.apply(o, a);
      if (a[0] !== "tasks") return r;   // the liveness marker (builder#86) is not a copy
      puts += 1;
      if (!healthy && puts === lose) await o.delete(a[0], r.record.id);   // the node rolled it back
      return r;
    };
    return typeof v === "function" ? v.bind(o) : v;
  } });
  return { target, puts: () => puts, heal: () => { healthy = true; } };
}

async function rollbackThenRetry(run) {
  const src = await preview();
  await src.put("tasks", { title: "row 3" });
  const node = losesOne(2);
  const go = () => run({ source: src, target: node.target, ...ctx, confirm: fast });
  await assert.rejects(go(), /did not reach the node/);
  const after1 = node.puts();
  node.heal();
  const did = await go();                             // the retry, on a healthy node
  return { after1, extra: node.puts() - after1, createdOnRetry: did.copied + did.seeded, onNode: await titles(node.target), inPreview: await titles(src) };
}

await t("**a copy the node ROLLED BACK is re-copied by the retry, and the retry succeeds**", async () => {
  const r = await rollbackThenRetry(handoff);
  // Every row is ASKED for again — `createAt` is how a retry finds what is
  // there — and only the lost one is created: the others answer `exists`.
  assert.strictEqual(r.extra, 3, "the retry asks for each of the three slots once");
  assert.strictEqual(r.createdOnRetry, 1, "and creates exactly ONE: the lost row");
  assert.deepStrictEqual(r.onNode, r.inPreview, "all three rows are on the node after the retry");
});

await t("THE CONTROL: a copy merely PENDING at the deadline is NOT forgotten", async () => {
  // Or a slow node would get every row twice on the retry.
  const src = await preview();
  const db = new sdk.Db();
  let puts = 0, slow = true;
  const target = new Proxy(db, { get(o, k) {
    const v = Reflect.get(o, k);
    if (k === "createAt") return async (...a) => { const r = await v.apply(o, a); if (a[0] === "tasks" && r.outcome === "created") puts += 1; return r; };
    if (k === "get") return async (...a) => { const r = await v.apply(o, a); return r && { ...r, state: slow ? "PENDING" : "CLEAN" }; };
    return typeof v === "function" ? v.bind(o) : v;
  } });
  const go = () => handoff({ source: src, target, ...ctx, confirm: fast });
  await assert.rejects(go(), /not confirmed by the node yet/);
  const before = puts;
  slow = false;
  await go();
  assert.strictEqual(puts - before, 0, "the retry creates nothing again: the pending copies are found at their slots");
});

await t("**a record reporting NO state is not counted as confirmed**", async () => {
  const src = await preview();
  const dst = acking(() => undefined);
  await assert.rejects(handoff({ source: src, target: dst, ...ctx, confirm: fast }),
    /not confirmed by the node yet/, "absent is UNKNOWN, and unknown waits — it does not say Published");
});

// ---- through the runtime: the UI does not claim what did not happen -------

await t("**a failed handoff leaves the preview in use and the phase 'failed', not 'published'**", async () => {
  const src = await preview();
  const closed = { n: 0 };
  const target = new sdk.Db();
  const rt = createProjectRuntime({
    mount: async () => ({ db: src, stop: () => {} }),
    publish: async () => ({ session: { close: () => { closed.n += 1; } }, db: target }),
  });
  await rt.ensureMounted();
  await assert.rejects(rt.publish(app, {}, { after: async () => {} /* not under test: history */, handoff: async () => { throw new Error("2 of 3 records are not confirmed"); } }));
  assert.strictEqual(rt.phase, "failed");
  assert.match(rt.error, /not confirmed/);
  assert.strictEqual(rt.publishedDb, null, "the half-copied backend is not adopted");
  assert.strictEqual(rt.db, src, "the preview db is still the one in use");
  assert.strictEqual(rt.mountState, "mounted", "and it was not torn down");
});

await t("and a successful one adopts the backend", async () => {
  const src = await preview();
  const target = new sdk.Db();
  const rt = createProjectRuntime({
    mount: async () => ({ db: src, stop: () => {} }),
    publish: async () => ({ session: { close() {} }, db: target }),
  });
  await rt.ensureMounted();
  await rt.publish(app, {}, { after: async () => {} /* not under test: history */, handoff: ({ source, target: to }) =>
    handoff({ source, target: to, ...ctx }) });
  assert.strictEqual(rt.phase, "published");
  assert.strictEqual(rt.publishedDb, target);
  assert.deepStrictEqual(await titles(target), ["seed one", "seed two"]);
});

console.log("\nhandoff: all ok");
