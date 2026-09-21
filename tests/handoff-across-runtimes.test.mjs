// A HANDOFF IS DETERMINISTIC: however often, from however many runtimes, it
// is run, each row is published once (builder#83).
//
// The handoff's memory of what it had copied was a ledger in the runtime, and
// a reload between a failed publish and the retry, or a second tab, started
// with an empty one: the published backend held every row twice. Now a copy's
// key is a FUNCTION of its source — `slotFrom(created, project id, source id)`
// — written with `createAt`, which never overwrites. Nothing is remembered.
//
// Every case here runs a handoff in a NEW runtime (a fresh call, nothing
// carried between them but the two databases), because that is the case the
// ledger got wrong.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { loadSdk } from "../sdk-loader.js";
import { handoff, previewDb, SlotCollision, PUBLISHED_DOMAIN, sameFields } from "../handoff.js";
import { openApp, schemasOf, preloadManifest } from "../runtime-logic.js";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const SCHEMA = { type: "Task", fields: [{ name: "title", kind: "text", required: true }] };
const app = { components: [{ type: "table", domain: "tasks", mode: "owned" }], schemas: { tasks: SCHEMA }, seed: { tasks: [{ title: "seed" }] } };
const titles = async db => (await db.scan("tasks")).map(r => r.fields.title).sort();
const confirm = { everyMs: 0, budgetMs: 1000 };

const PID = "r0projectid0000";
const SEED_MS = Date.now() - 86_400_000;

/** A Preview exactly as a mount of this project makes one: fresh, seeded, recording deletes. */
const preview = async () => (await openApp(sdk, app, previewDb(new sdk.Db()))).db;

/** One handoff, in a runtime of its own. */
const run = (source, target, over = {}) => {
  const heard = [];
  const p = handoff({
    source, target, app, schemas: schemasOf(app), slotFrom: sdk.slotFrom,
    namespace: PID, seedMs: SEED_MS, onNotice: m => heard.push(m), confirm, ...over,
  });
  return Object.assign(p, { heard });
};

/** A Preview with two rows besides the seed, and a target that has had ONE COMPLETED publish from it: live. */
const once = async () => {
  const src = await preview();
  await src.put("tasks", { title: "first" });
  await src.put("tasks", { title: "second" });
  const dst = new sdk.Db();
  await run(src, dst);
  return { src, dst };
};

/**
 * The same, but the publish did NOT complete: every copy landed and none was
 * confirmed by the node, so the domain is not live — the failed-publish case.
 */
const attempted = async () => {
  const src = await preview();
  await src.put("tasks", { title: "first" });
  await src.put("tasks", { title: "second" });
  const dst = new sdk.Db();
  const unconfirmed = new Proxy(dst, { get(o, k) {
    const v = Reflect.get(o, k);
    if (k === "get") return async (...a) => { const r = await v.apply(o, a); return r && { ...r, state: "PENDING" }; };
    return typeof v === "function" ? v.bind(o) : v;
  } });
  await assert.rejects(run(src, unconfirmed, { confirm: { everyMs: 0, budgetMs: 10 } }), /not confirmed/);
  return { src, dst };
};

await t("**a second handoff in a NEW runtime holds each row ONCE**", async () => {
  const { src, dst } = await once();
  await run(src, dst);
  assert.deepStrictEqual(await titles(dst), ["first", "second", "seed"],
    "every row twice was the defect: ['first','first','second','second','seed','seed']");
});

await t("**two handoffs started TOGETHER leave each row once**", async () => {
  const src = await preview();
  await src.put("tasks", { title: "first" });
  const dst = new sdk.Db();
  await Promise.all([run(src, dst), run(src, dst)]);
  assert.deepStrictEqual(await titles(dst), ["first", "seed"]);
});

await t("**a RELOAD between two handoffs: the seed is on the target once**", async () => {
  const dst = new sdk.Db();
  await run(await preview(), dst);
  await run(await preview(), dst);   // a fresh Preview, seeded again, as a reload makes it
  assert.deepStrictEqual(await titles(dst), ["seed"]);
});

await t("**the Preview store WIPED between two handoffs: nothing is removed**", async () => {
  const { dst } = await once();
  const did = await run(await preview(), dst);
  assert.strictEqual(did.removed, 0, "absent is not deleted: reading it so emptied the published backend");
  assert.deepStrictEqual(await titles(dst), ["first", "second", "seed"]);
});

await t("THE CONTROL: a row DELETED in this Preview is removed from the target (not yet live)", async () => {
  const { src, dst } = await attempted();
  const [row] = (await src.scan("tasks")).filter(r => r.fields.title === "second");
  await src.delete("tasks", row.id);
  const did = await run(src, dst);
  assert.deepStrictEqual(await titles(dst), ["first", "seed"]);
  assert.strictEqual(did.removed, 1);
});

await t("**not yet live: a row EDITED between two handoffs is carried — updated, not skipped**", async () => {
  const { src, dst } = await attempted();
  const [row] = (await src.scan("tasks")).filter(r => r.fields.title === "first");
  await src.update("tasks", row.id, { title: "first, edited" });
  const did = await run(src, dst);
  assert.deepStrictEqual(await titles(dst), ["first, edited", "second", "seed"]);
  assert.deepStrictEqual({ updated: did.updated, copied: did.copied }, { updated: 1, copied: 0 });
});

await t("**a SEED row edited in Preview before the first completed publish is carried**", async () => {
  const { src, dst } = await attempted();
  const [seed] = (await src.scan("tasks")).filter(r => r.fields.title === "seed");
  await src.update("tasks", seed.id, { title: "seed, edited" });
  await run(src, dst);
  assert.deepStrictEqual(await titles(dst), ["first", "second", "seed, edited"]);
});

await t("**a failed publish, an edit, the retry: the edit is on the target**", async () => {
  const src = await preview();
  await src.put("tasks", { title: "draft" });
  const dst = new sdk.Db();
  let refused = false;
  const flaky = new Proxy(dst, { get(o, k) {
    const v = Reflect.get(o, k);
    if (k === "createAt") return async (...a) => { const r = await v.apply(o, a); if (!refused) { refused = true; throw new Error("Busy"); } return r; };
    return typeof v === "function" ? v.bind(o) : v;
  } });
  await assert.rejects(run(src, flaky), /Busy/);
  const [row] = (await src.scan("tasks")).filter(r => r.fields.title === "draft");
  await src.update("tasks", row.id, { title: "draft, edited" });
  await run(src, flaky);
  assert.deepStrictEqual(await titles(dst), ["draft, edited", "seed"]);
});

await t("**once LIVE, a stale Preview's differing row is KEPT as published — and the person is told once**", async () => {
  const { src, dst } = await once();
  const [row] = (await dst.scan("tasks")).filter(r => r.fields.title === "first");
  await dst.update("tasks", row.id, { title: "first, edited in the published app" });
  const p = run(src, dst);
  const did = await p;
  assert.strictEqual(did.kept, 1);
  assert.deepStrictEqual(await titles(dst), ["first, edited in the published app", "second", "seed"]);
  assert.deepStrictEqual(p.heard, ["1 record differs from the published app and was kept as published."]);
});

await t("THE CONTROL: the same handoff into a domain NOT yet live updates it — liveness is what decides", async () => {
  const { src, dst } = await attempted();
  const [row] = (await dst.scan("tasks")).filter(r => r.fields.title === "first");
  await dst.update("tasks", row.id, { title: "changed on the target" });
  const p = run(src, dst);
  assert.strictEqual((await p).kept, 0);
  assert.deepStrictEqual(await titles(dst), ["first", "second", "seed"]);
  assert.deepStrictEqual(p.heard, [], "nothing kept, nothing to tell");
});

await t("once LIVE, a stale Preview deletes nothing live", async () => {
  const { src, dst } = await once();
  const [row] = (await src.scan("tasks")).filter(r => r.fields.title === "second");
  await src.delete("tasks", row.id);
  assert.strictEqual((await run(src, dst)).removed, 0);
  assert.deepStrictEqual(await titles(dst), ["first", "second", "seed"]);
});

await t("**a SECOND publication makes zero new rows** — the slots are the project's, not the publication's", async () => {
  const { src, dst } = await once();
  const did = await run(src, dst);
  assert.deepStrictEqual({ copied: did.copied, seeded: did.seeded }, { copied: 0, seeded: 0 });
  assert.deepStrictEqual(await titles(dst), ["first", "second", "seed"]);
});

await t("**two Preview rows on ONE slot: a named error, and the target is untouched**", async () => {
  const src = await preview();
  await src.put("tasks", { title: "first" });
  const dst = new sdk.Db();
  const forced = () => "000001977420dc00cd196ed3a1c3f054";   // every row derives the same slot
  await assert.rejects(run(src, dst, { slotFrom: forced }), e => e instanceof SlotCollision && /same place/.test(e.message));
  assert.deepStrictEqual(await dst.domains(), [], "nothing was written: not even a schema");
});

await t("never previewed, then previewed: the seed is copied ONCE across the two paths", async () => {
  const dst = new sdk.Db();
  await run(null, dst);
  await run(null, dst);
  assert.deepStrictEqual(await titles(dst), ["seed"]);
  await run(await preview(), dst);
  assert.deepStrictEqual(await titles(dst), ["seed"], "Preview's seed rows reach the slots a never-previewed seed did");
});

await t("every input a handoff decides from is REQUIRED, and a missing one is refused by name", async () => {
  const src = await preview();
  for (const [what, over] of [
    ["slotFrom", { slotFrom: undefined }],
    ["namespace", { namespace: undefined }],
    ["seedMs", { seedMs: undefined }],
    ["onNotice", { onNotice: undefined }],
  ]) {
    await assert.rejects(run(src, new sdk.Db(), over), new RegExp(`no \`${what}\``), what);
  }
  await assert.rejects(run(new sdk.Db(), new sdk.Db()), /no `source.deleted/, "a Preview that cannot say what was deleted");
  await run(src, new sdk.Db());   // THE CONTROL: with all of them, it runs
});

// ---- LIVENESS IS THE TARGET'S FACT, per domain (builder#86) -----------------

/**
 * A domain published and then USED: seed edited live, a row added live. What
 * a person would lose if anything re-seeded or overwrote it.
 */
const used = async () => {
  const { dst } = await once();
  const [seed] = (await dst.scan("tasks")).filter(r => r.fields.title === "seed");
  await dst.update("tasks", seed.id, { title: "seed, edited live" });
  await dst.put("tasks", { title: "added live" });
  return dst;
};
const LIVE_ROWS = ["added live", "first", "second", "seed, edited live"];

await t("**S1: another browser — no history, a new project id — publishing into a LIVE domain writes no seed**", async () => {
  const dst = await used();
  const did = await run(await preview(), dst, { namespace: "r0otherbrowser0" });
  assert.strictEqual(did.seeded, 0, "the seed the person edited away must not come back");
  assert.deepStrictEqual(await titles(dst), LIVE_ROWS);
});

await t("**S1': a second PROJECT on the same domain name, same device: no seed into the live domain**", async () => {
  const dst = await used();
  const did = await run(await preview(), dst, { namespace: "r0secondproject" });
  assert.strictEqual(did.seeded, 0);
  assert.deepStrictEqual(await titles(dst), LIVE_ROWS);
});

await t("**S2: the SAME project id from a device with no history: the live edit is KEPT, and the person told**", async () => {
  const dst = await used();
  const p = run(await preview(), dst);   // device B: A's pid, a pristine Preview
  const did = await p;
  assert.strictEqual(did.kept, 1, "B's pristine seed differs from the live row, and the live row wins");
  assert.strictEqual(did.updated, 0, "overwritten silently was the defect");
  assert.deepStrictEqual(await titles(dst), LIVE_ROWS);
  assert.deepStrictEqual(p.heard, ["1 record differs from the published app and was kept as published."]);
});

// ---- the marker is ACKNOWLEDGED, like any row (builder#88) -------------------

/** A node over a real Db that accepts the MARKER write and then loses it — once. Counts writes. */
function losesTheMarker() {
  const db = new sdk.Db();
  let lose = true;
  const writes = { rows: 0, markers: 0 };
  const target = new Proxy(db, { get(o, k) {
    const v = Reflect.get(o, k);
    if (k === "createAt") return async (d, ...a) => {
      const r = await v.call(o, d, ...a);
      if (d === PUBLISHED_DOMAIN) {
        writes.markers += 1;
        if (lose) await o.delete(d, r.record.id);   // the node rolled it back
      } else writes.rows += 1;
      return r;
    };
    return typeof v === "function" ? v.bind(o) : v;
  } });
  return { db, target, writes, heal: () => { lose = false; } };
}

await t("**a marker the node LOSES fails the publish — it is not reported done over a domain that reads not-live**", async () => {
  const src = await preview();
  await src.put("tasks", { title: "first" });
  const node = losesTheMarker();
  await assert.rejects(run(src, node.target), /did not reach the node/);
  assert.strictEqual(await node.db.get(PUBLISHED_DOMAIN, sdk.slotFrom(0, "domain", "tasks")), null, "and indeed nothing marks it live");
  // Through the runtime: the phase says so.
  const { createProjectRuntime } = await import("../project-runtime.js");
  const lost = losesTheMarker();
  const rt = createProjectRuntime({ mount: async () => ({ db: src, stop() {} }), publish: async () => ({ session: { close() {} }, db: lost.target }) });
  await rt.ensureMounted();
  await assert.rejects(rt.publish(app, {}, { after: async () => {}, handoff: ({ source, target }) => run(source, target) }));
  assert.strictEqual(rt.phase, "failed");
  assert.strictEqual(rt.publishedDb, null, "the backend is not adopted");
});

await t("**the retry writes the marker ONCE, and the domain is live**", async () => {
  const src = await preview();
  await src.put("tasks", { title: "first" });
  const node = losesTheMarker();
  await assert.rejects(run(src, node.target), /did not reach the node/);
  node.heal();
  await run(src, node.target);
  assert.strictEqual((await node.db.scan(PUBLISHED_DOMAIN)).length, 1);
  assert.deepStrictEqual(await titles(node.db), ["first", "seed"], "and the rows are each there once");
});

await t("THE CONTROL: a normal publish writes each row once and ONE marker, and returns", async () => {
  const src = await preview();
  await src.put("tasks", { title: "first" });
  const node = losesTheMarker();
  node.heal();
  await run(src, node.target);
  assert.deepStrictEqual(node.writes, { rows: 2, markers: 1 });
});

await t("a SECOND completion leaves ONE marker per domain", async () => {
  const { src, dst } = await once();
  await run(src, dst);
  assert.strictEqual((await dst.scan(PUBLISHED_DOMAIN)).length, 1);
});

await t("THE CONTROL: a publish that did not complete marks nothing live", async () => {
  const { dst } = await attempted();
  assert.strictEqual(await dst.schema(PUBLISHED_DOMAIN), null, "no marker domain before a completion");
});

await t("**the reserved domain is never an APP's**: not preloaded, not bound by the published app — though it IS in the tree", async () => {
  const { dst } = await once();
  assert.ok((await dst.domains()).includes(PUBLISHED_DOMAIN), "THE CONTROL: the marker exists, so what follows is not vacuous");
  assert.ok(!preloadManifest(app).includes(PUBLISHED_DOMAIN), "not in the preload");
  // The published app, mounted over the target, binds only its own domains.
  const node = () => new Proxy({ hidden: false, style: {}, contains: () => false, replaceChildren() {} },
    { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
  globalThis.document ??= { createElement: () => node(), addEventListener() {} };
  const { mountApp } = await import("../runtime.js");
  const bound = new Set();
  const watched = new Proxy(dst, { get(o, k) {
    const v = Reflect.get(o, k);
    if (k === "bind" || k === "scan" || k === "count") return (d, ...a) => { bound.add(d); return v.call(o, d, ...a); };
    return typeof v === "function" ? v.bind(o) : v;
  } });
  const h = await mountApp(node(), sdk, app, () => {}, watched, "published", { alive: () => true });
  h?.stop?.();
  assert.ok(bound.size > 0, "the mount read something, or the check below proves nothing");
  assert.ok(!bound.has(PUBLISHED_DOMAIN), `the published app read the reserved domain: ${[...bound]}`);
});

await t("an app that NAMES the reserved domain is refused by name, before anything is written", async () => {
  const bad = { ...app, components: [...app.components, { type: "table", domain: PUBLISHED_DOMAIN, mode: "owned" }],
    schemas: { ...app.schemas, [PUBLISHED_DOMAIN]: SCHEMA } };
  const dst = new sdk.Db();
  await assert.rejects(run(await preview(), dst, { app: bad, schemas: schemasOf(bad) }), /is reserved/);
  assert.deepStrictEqual(await dst.domains(), []);
});

await t("fields are compared STRUCTURALLY: key order, nested included, is not a difference", async () => {
  assert.ok(sameFields({ a: 1, b: { x: 1, y: [1, 2] } }, { b: { y: [1, 2], x: 1 }, a: 1 }), "nested key order read as a change");
  assert.ok(!sameFields({ a: { x: 1 } }, { a: { x: 2 } }), "THE CONTROL: a real difference is one");
  assert.ok(!sameFields({ a: [1, 2] }, { a: [2, 1] }), "and array order IS content");
});

console.log("\nhandoff across runtimes: all ok");
