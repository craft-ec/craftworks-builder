// LocalDb: two tabs cannot erase each other's saves (builder#55), and a save
// storage refuses is never reported as saved (builder#56).
//
// Every case runs against the FIXED LocalDb and — as the control — against the
// LocalDb of `aef3994`, the last commit with the single-blob store
// (`CONTROL=<path>` to point it elsewhere), so each defect is shown red before
// the fix is shown green. Pinned to a commit, not `origin/main`, or the control
// would stop being a control the moment this merged.
//
// The storage is a faithful Storage: getItem, setItem, removeItem, key(i),
// length. The audit's fake had only getItem/setItem; real localStorage has all
// five and a per-key store needs to enumerate, so its reproduction is run over
// this one — same calls, same order.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDb, NotSaved } from "../local-db.js";

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

/** A Storage, over a Map. `refuse` makes setItem throw, as a full quota does. */
function storage() {
  const m = new Map();
  const s = {
    refuse: null,
    get length() { return m.size; },
    key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (s.refuse) { const e = new Error(s.refuse); e.name = s.refuse; throw e; }
      m.set(k, String(v));
    },
    removeItem: k => { m.delete(k); },
    raw: m,
  };
  return s;
}

// THE CONTROL: the single-blob LocalDb of aef3994.
const ctlPath = process.env.CONTROL ?? (() => {
  const dir = mkdtempSync(join(tmpdir(), "cw-localdb-ctl-"));
  const src = execFileSync("git", ["show", "aef3994:local-db.js"], { cwd: new URL("..", import.meta.url).pathname }).toString();
  const p = join(dir, "local-db.js");
  writeFileSync(p, src);
  return p;
})();
const { LocalDb: OldDb } = await import(ctlPath);

/**
 * Run `fn` against the old class and report whether it failed there FOR THE
 * DEFECT — an assertion, not any exception. A control that counted a crash as
 * "red" would pass whether or not the old code had the bug.
 */
const failsOnOld = async fn => {
  try { await fn(OldDb); return false; }
  catch (e) {
    if (e instanceof assert.AssertionError) return true;
    throw new Error(`the control crashed instead of showing the defect: ${e.message}`);
  }
};

const titles = async (db, d = "projects") => (await db.scan(d)).map(r => r.fields.title).sort();

// ---- builder#55 -----------------------------------------------------------

const twoTabs = async Db => {
  const s = storage();
  const a = new Db(s);
  const b = new Db(s);           // loaded before A saves anything
  await a.put("projects", { title: "A" });
  await b.put("projects", { title: "B" });
  assert.deepStrictEqual(await titles(new Db(s)), ["A", "B"], "A's successful save was lost");
};
await t("**the audit's reproduction: two tabs, two projects, both survive a reload**", async () => {
  await twoTabs(LocalDb);
  assert.ok(await failsOnOld(twoTabs), "CONTROL: aef3994's LocalDb must lose A here, or this proves nothing");
});

const interleaved = async Db => {
  const s = storage();
  const a = new Db(s);
  const pa = await a.put("projects", { title: "A" });
  const b = new Db(s);
  const pb = await b.put("projects", { title: "B" });
  await a.update("projects", pa.id, { title: "A2" });
  await b.update("projects", pb.id, { title: "B2" });
  await a.put("projects.component", { pid: pa.id, kind: "table" });
  await b.put("projects.component", { pid: pb.id, kind: "form" });
  const r = new Db(s);
  assert.deepStrictEqual(await titles(r), ["A2", "B2"]);
  assert.strictEqual(await r.count("projects.component"), 2);
};
await t("**interleaved edits to distinct projects in two tabs all survive**", async () => {
  await interleaved(LocalDb);
  assert.ok(await failsOnOld(interleaved), "CONTROL: aef3994's LocalDb must lose edits here");
});

const secondTabOpens = async Db => {
  const s = storage();
  const a = new Db(s);
  await a.define("projects", { type: "Project", fields: [] });
  const b = new Db(s);                                   // a second tab opens...
  await a.put("projects", { title: "saved in A" });      // ...A saves...
  await b.define("projects", { type: "Project", fields: [] }); // ...B runs its startup defines
  assert.deepStrictEqual(await titles(new Db(s)), ["saved in A"], "opening a second tab erased a save");
};
await t("**a second tab's startup `define` does not erase what the first tab saved**", async () => {
  await secondTabOpens(LocalDb);
  assert.ok(await failsOnOld(secondTabOpens), "CONTROL: aef3994's LocalDb must lose it here");
});

await t("a tab READS what another tab saved, not a snapshot from its load", async () => {
  const s = storage();
  const a = new LocalDb(s), b = new LocalDb(s);
  await a.put("projects", { title: "from A" });
  assert.deepStrictEqual(await titles(b), ["from A"]);
});

await t("two tabs editing DIFFERENT fields of one record keep both", async () => {
  const s = storage();
  const a = new LocalDb(s);
  const rec = await a.put("projects", { title: "t", note: "n" });
  const b = new LocalDb(s);
  await a.update("projects", rec.id, { title: "t2" });
  await b.update("projects", rec.id, { note: "n2" });   // merged over what is stored NOW
  assert.deepStrictEqual((await new LocalDb(s).get("projects", rec.id)).fields, { title: "t2", note: "n2" });
});

await t("ids minted by two tabs in the same millisecond do not collide", async () => {
  const s = storage();
  const a = new LocalDb(s), b = new LocalDb(s);
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    ids.add((await a.put("x", {})).id);
    ids.add((await b.put("x", {})).id);
  }
  assert.strictEqual(ids.size, 400);
  assert.strictEqual(await new LocalDb(s).count("x"), 400);
});

await t("a domain whose name holds the separator does not leak into another's scan", async () => {
  const s = storage();
  const db = new LocalDb(s);
  await db.put("a", { title: "in a" });
  await db.put("a/b", { title: "in a/b" });
  assert.deepStrictEqual(await titles(db, "a"), ["in a"]);
  assert.deepStrictEqual((await db.domains()).length, 0, "no schemas were defined");
});

// ---- builder#56 -----------------------------------------------------------

const quota = async Db => {
  const s = storage();
  s.refuse = "QuotaExceededError";
  const db = new Db(s);
  await assert.rejects(db.put("projects", { title: "lost" }));
};
await t("**the audit's reproduction: a put storage refuses REJECTS, and nothing claims it saved**", async () => {
  const s = storage();
  s.refuse = "QuotaExceededError";
  const db = new LocalDb(s);
  await assert.rejects(db.put("projects", { title: "lost" }), e => e instanceof NotSaved && /QuotaExceededError/.test(e.message));
  assert.strictEqual(await db.count("projects"), 0, "the same instance must not report a record storage refused");
  assert.strictEqual(await new LocalDb(s).count("projects"), 0);
  assert.ok(await failsOnOld(quota), "CONTROL: aef3994's LocalDb resolves this put");
});

await t("denied storage is reported the same way, and names why", async () => {
  const s = storage();
  s.refuse = "SecurityError";
  await assert.rejects(new LocalDb(s).define("projects", { type: "P", fields: [] }), /not saved: schema projects — SecurityError/);
});

await t("**a refused update or delete leaves what is stored exactly as it was**", async () => {
  const s = storage();
  const db = new LocalDb(s);
  const rec = await db.put("projects", { title: "kept" });
  s.refuse = "QuotaExceededError";
  await assert.rejects(db.update("projects", rec.id, { title: "not kept" }), NotSaved);
  assert.strictEqual((await new LocalDb(s).get("projects", rec.id)).fields.title, "kept",
    "the saved state must not advance until storage succeeds");
  s.removeItem = () => { const e = new Error("denied"); e.name = "SecurityError"; throw e; };
  await assert.rejects(db.delete("projects", rec.id), NotSaved);
  assert.ok(await new LocalDb(s).get("projects", rec.id));
});

await t("**a retry after the quota frees up saves, once**", async () => {
  const s = storage();
  const db = new LocalDb(s);
  s.refuse = "QuotaExceededError";
  await assert.rejects(db.put("projects", { title: "retry me" }));
  s.refuse = null;
  await db.put("projects", { title: "retry me" });
  assert.deepStrictEqual(await titles(new LocalDb(s)), ["retry me"]);
});

// ---- migration from the single-blob format --------------------------------

const legacy = () => ({
  schemas: { projects: { type: "Project", fields: [] } },
  records: { projects: { r1: { id: "r1", created: 1, updated: 1, fields: { title: "old" } } } },
  seq: 1,
});

await t("**projects saved in the old format survive the upgrade, and the blob is removed**", async () => {
  const s = storage();
  s.setItem("craftec.builder.db.v1", JSON.stringify(legacy()));
  const db = new LocalDb(s);
  assert.deepStrictEqual(await titles(db), ["old"]);
  assert.deepStrictEqual(await db.schema("projects"), { type: "Project", fields: [] });
  assert.strictEqual(s.getItem("craftec.builder.db.v1"), null, "the old blob is gone once split");
  assert.deepStrictEqual(await titles(new LocalDb(s)), ["old"], "and nothing doubles on the next load");
});

await t("a migration storage refuses halfway keeps the blob, and the next load completes it", async () => {
  const s = storage();
  s.setItem("craftec.builder.db.v1", JSON.stringify(legacy()));
  let writes = 0;
  const set = s.setItem;
  s.setItem = (k, v) => { if (++writes === 2) { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; } set(k, v); };
  new LocalDb(s);
  assert.ok(s.getItem("craftec.builder.db.v1"), "a partial split must not delete the only complete copy");
  s.setItem = set;
  const db = new LocalDb(s);
  assert.deepStrictEqual(await titles(db), ["old"]);
  assert.strictEqual(s.getItem("craftec.builder.db.v1"), null);
});

console.log("\nlocal db: all ok");
