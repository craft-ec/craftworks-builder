// A TAB LEFT OPEN ACROSS THE DEPLOY must not revert newer edits.
//
// The per-key LocalDb migrates the single-blob format on load. A tab opened
// BEFORE the deploy still runs the old LocalDb, which rewrites its whole stale
// snapshot into the blob on any edit — so the blob can come BACK after it was
// migrated away. The first version of this migration overwrote every per-key
// entry from the blob on every load, and the sequence below reverted an edit
// made in the new tab: builder#55 reintroduced by the migration away from the
// format that caused it, firing on LOAD (found in review of builder#66).
//
// The old tab is the REAL old LocalDb, pinned by commit — aef3994, the last
// single-blob one — not a fake, and not `origin/main`, which would stop being
// the old code the moment this merged.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDb } from "../local-db.js";

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };
const storage = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), raw: m };
};
const dir = mkdtempSync(join(tmpdir(), "cw-olddb-"));
const oldPath = join(dir, "local-db.mjs");
writeFileSync(oldPath, execFileSync("git", ["show", "aef3994:local-db.js"], { cwd: new URL("..", import.meta.url).pathname }));
const { LocalDb: OldDb } = await import(oldPath);
const LEGACY = "craftec.builder.db.v1";
// LocalDb has no default `onNotice` (builder#73): a store that raises a notice
// with no one to tell fails. These tests READ `db.notices`, so they pass a
// listener that keeps them — explicitly.
const heard = [];
const NEW = s => new LocalDb(s, undefined, { onNotice: n => heard.push(n) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const title = async (db, id) => (await db.get("projects", id))?.fields.title;

await t("**the review's four steps: an edit in the new tab survives the old tab resurrecting the blob**", async () => {
  const s = storage();
  const old = new OldDb(s);                        // a tab opened before the deploy
  const rec = await old.put("projects", { title: "original" });
  const fresh = NEW(s);                    // the deploy; a new tab migrates
  assert.strictEqual(s.getItem(LEGACY), null, "1. the blob is migrated away");
  await sleep(2);
  await fresh.update("projects", rec.id, { title: "EDITED in the new tab" });
  assert.strictEqual(await title(fresh, rec.id), "EDITED in the new tab", "2. the new tab reads its edit");
  await old.put("projects", { title: "an ordinary edit in the old tab" });
  assert.ok(s.getItem(LEGACY), "3. the old tab resurrects the blob, as it will");
  const later = NEW(s);                    // any later load
  assert.strictEqual(await title(later, rec.id), "EDITED in the new tab",
    "4. the newer edit must NOT be reverted to the old tab's stale copy");
  assert.strictEqual((await later.scan("projects")).length, 2, "and the old tab's own new project is kept, not dropped");
});

await t("**a record DELETED in the new tab stays deleted when the blob comes back**", async () => {
  const s = storage();
  const old = new OldDb(s);
  const gone = await old.put("projects", { title: "delete me" });
  const fresh = NEW(s);
  await sleep(2);
  await fresh.delete("projects", gone.id);
  await old.put("projects", { title: "old tab edits something else" });   // resurrects `gone` in the blob
  const later = NEW(s);
  assert.strictEqual(await later.get("projects", gone.id), null, "a resurrected blob must not bring a deleted record back");
});

await t("an edit made in the OLD tab after the deploy is kept, not discarded", async () => {
  const s = storage();
  const old = new OldDb(s);
  const rec = await old.put("projects", { title: "v1" });
  NEW(s);
  await sleep(2);
  await old.update("projects", rec.id, { title: "v2 in the old tab" });  // genuinely newer
  assert.strictEqual(await title(NEW(s), rec.id), "v2 in the old tab");
});

await t("**a resurrected blob is RECOGNISED and reported: another tab runs an older builder**", async () => {
  const s = storage();
  const old = new OldDb(s);
  await old.put("projects", { title: "x" });
  const first = NEW(s);
  assert.deepStrictEqual(first.notices, [], "a genuine first-load migration is not a warning");
  await old.put("projects", { title: "y" });
  const later = NEW(s);
  assert.ok(later.notices.some(n => n.kind === "older-tab"), `expected an older-tab notice, got ${JSON.stringify(later.notices)}`);
});

await t("THE CONTROL: a genuine first-load migration still moves EVERYTHING", async () => {
  // Without this, a migration that never wrote anything would pass every case
  // above: nothing overwritten, nothing resurrected, nothing reverted.
  const s = storage();
  const old = new OldDb(s);
  await old.define("projects", { type: "Project", fields: [] });
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push((await old.put("projects", { title: `p${i}` })).id);
  await old.delete("projects", ids[4]);
  const fresh = NEW(s);
  assert.deepStrictEqual((await fresh.scan("projects")).map(r => r.fields.title), ["p0", "p1", "p2", "p3"]);
  assert.deepStrictEqual(await fresh.schema("projects"), { type: "Project", fields: [] });
  assert.strictEqual(s.getItem(LEGACY), null);
});

await t("an UNREADABLE blob is kept and reported, not silently treated as no blob", async () => {
  const s = storage();
  s.setItem(LEGACY, "{not json");
  const db = NEW(s);
  assert.strictEqual(s.getItem(LEGACY), "{not json", "the only copy of whatever it held is not deleted");
  assert.ok(db.notices.some(n => n.kind === "unreadable-legacy"), `got ${JSON.stringify(db.notices)}`);
});

console.log("\nlocal db across a deploy: all ok");
