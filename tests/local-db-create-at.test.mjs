// LocalDb.createAt: a record at an id the caller names — the SDK's createAt,
// so code over either backend makes the same call (craftworks-sdk#149,
// builder#82). A create, never an overwrite, and never a resurrection.
import assert from "node:assert";
import { LocalDb } from "../local-db.js";

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const storage = () => {
  const m = new Map();
  return { m, get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};
const snapshot = st => JSON.stringify([...st.m].sort());

await t("**a second createAt at one id answers `exists` with the stored record, and storage does not change**", async () => {
  const st = storage();
  const db = new LocalDb(st);
  const first = await db.createAt("tasks", "rkeep0001", { title: "first" });
  assert.strictEqual(first.outcome, "created");
  assert.strictEqual(first.record.id, "rkeep0001");
  const before = snapshot(st);
  const again = await db.createAt("tasks", "rkeep0001", { title: "other" });
  assert.strictEqual(again.outcome, "exists");
  assert.strictEqual(again.record.fields.title, "first", "the STORED record");
  assert.strictEqual(snapshot(st), before, "nothing was written");
  assert.strictEqual((await db.get("tasks", "rkeep0001")).fields.title, "first");
});

await t("**an id that was DELETED is not brought back by a create**", async () => {
  const db = new LocalDb(storage());
  const r = await db.put("tasks", { title: "gone" });
  await db.delete("tasks", r.id);
  await assert.rejects(db.createAt("tasks", r.id, { title: "back" }), /was deleted; a create does not bring it back/);
  assert.strictEqual(await db.get("tasks", r.id), null);
});

await t("THE CONTROL: an id never used is created, and reads back", async () => {
  const db = new LocalDb(storage());
  await db.createAt("tasks", "rfresh0001", { title: "new" });
  assert.strictEqual((await db.get("tasks", "rfresh0001")).fields.title, "new");
  assert.deepStrictEqual((await db.scan("tasks")).map(r => r.id), ["rfresh0001"]);
});

await t("an id that is not an id is refused, not written under a key it could escape", async () => {
  const db = new LocalDb(storage());
  for (const bad of ["", "a/b", "x".repeat(65), 7]) {
    await assert.rejects(db.createAt("tasks", bad, {}), /is not a record id/, String(bad));
  }
});

console.log("\nlocal db createAt: all ok");
