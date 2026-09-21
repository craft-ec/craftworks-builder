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
import { handoff, previewDb, SlotCollision } from "../handoff.js";
import { openApp, schemasOf } from "../runtime-logic.js";

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
    namespace: PID, seedMs: SEED_MS, published: false, onNotice: m => heard.push(m), confirm, ...over,
  });
  return Object.assign(p, { heard });
};

/** A Preview with two rows besides the seed, and a target that has had ONE handoff from it. */
const once = async () => {
  const src = await preview();
  await src.put("tasks", { title: "first" });
  await src.put("tasks", { title: "second" });
  const dst = new sdk.Db();
  await run(src, dst);
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

await t("THE CONTROL: a row DELETED in this Preview is removed from the target", async () => {
  const { src, dst } = await once();
  const [row] = (await src.scan("tasks")).filter(r => r.fields.title === "second");
  await src.delete("tasks", row.id);
  const did = await run(src, dst);
  assert.deepStrictEqual(await titles(dst), ["first", "seed"]);
  assert.strictEqual(did.removed, 1);
});

await t("**never published: a row EDITED between two handoffs is carried — updated, not skipped**", async () => {
  const { src, dst } = await once();
  const [row] = (await src.scan("tasks")).filter(r => r.fields.title === "first");
  await src.update("tasks", row.id, { title: "first, edited" });
  const did = await run(src, dst);
  assert.deepStrictEqual(await titles(dst), ["first, edited", "second", "seed"]);
  assert.deepStrictEqual({ updated: did.updated, copied: did.copied }, { updated: 1, copied: 0 });
});

await t("**a SEED row edited in Preview before the first completed publish is carried**", async () => {
  const src = await preview();
  const dst = new sdk.Db();
  await run(src, dst);
  const [seed] = await src.scan("tasks");
  await src.update("tasks", seed.id, { title: "seed, edited" });
  await run(src, dst);
  assert.deepStrictEqual(await titles(dst), ["seed, edited"]);
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

await t("**once PUBLISHED, a stale Preview's differing row is KEPT as published — and the person is told once**", async () => {
  const { src, dst } = await once();
  const [row] = (await dst.scan("tasks")).filter(r => r.fields.title === "first");
  await dst.update("tasks", row.id, { title: "first, edited in the published app" });
  const p = run(src, dst, { published: true });
  const did = await p;
  assert.strictEqual(did.kept, 1);
  assert.deepStrictEqual(await titles(dst), ["first, edited in the published app", "second", "seed"]);
  assert.deepStrictEqual(p.heard, ["1 record differs from the published app and was kept as published."]);
});

await t("THE CONTROL: the same handoff NOT yet published updates it — `published` is what decides", async () => {
  const { src, dst } = await once();
  const [row] = (await dst.scan("tasks")).filter(r => r.fields.title === "first");
  await dst.update("tasks", row.id, { title: "changed on the target" });
  const p = run(src, dst, { published: false });
  assert.strictEqual((await p).kept, 0);
  assert.deepStrictEqual(await titles(dst), ["first", "second", "seed"]);
  assert.deepStrictEqual(p.heard, [], "nothing kept, nothing to tell");
});

await t("once PUBLISHED, a stale Preview deletes nothing live", async () => {
  const { src, dst } = await once();
  const [row] = (await src.scan("tasks")).filter(r => r.fields.title === "second");
  await src.delete("tasks", row.id);
  assert.strictEqual((await run(src, dst, { published: true })).removed, 0);
  assert.deepStrictEqual(await titles(dst), ["first", "second", "seed"]);
});

await t("**a SECOND publication makes zero new rows** — the slots are the project's, not the publication's", async () => {
  const { src, dst } = await once();
  const did = await run(src, dst, { published: true });
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
    ["published", { published: undefined }],
    ["seedMs", { seedMs: undefined }],
    ["onNotice", { onNotice: undefined }],
  ]) {
    await assert.rejects(run(src, new sdk.Db(), over), new RegExp(`no \`${what}\``), what);
  }
  await assert.rejects(run(new sdk.Db(), new sdk.Db()), /no `source.deleted/, "a Preview that cannot say what was deleted");
  await run(src, new sdk.Db());   // THE CONTROL: with all of them, it runs
});

console.log("\nhandoff across runtimes: all ok");
