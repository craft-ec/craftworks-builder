// The handoff has NO TIMER (rule 8): it waits for each row's END — saved, or
// rolled back by the node — however long that takes, reports progress as it
// goes, and fails only on a row the node answered lost, naming how far it got.
//
// The node confirms one write per commit, about 3.4 a second. On a live node
// a 100-row publish took 27–29 s of the old 30 s TOTAL, and a 300-row one
// could not pass at any speed; then a 30 s rule on PROGRESS failed a real-
// network publish the SDK would have finished (2026-09-23). A duration was
// standing in for a condition — twice.
//
// Driven on a FAKE clock: every poll is 250 ms, and the target confirms rows
// as a function of that clock — so 200 s runs in milliseconds and the moment
// of failure is exact.
import assert from "node:assert";
import { acknowledged } from "../handoff.js";
import { buttonFor } from "../publish.js";
// The handoff asks the SDK what a row state means (`row_saved`): load it.
{ const { readFileSync } = await import("node:fs"); const { loadSdk } = await import("../sdk-loader.js");
  await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url))); }

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

const POLL_MS = 250;

/**
 * `n` rows, and a target that has confirmed `confirmedBy(ms)` of them at
 * clock `ms` — and, past `lostAfter`, answers the rest ROLLED_BACK. The clock
 * moves one poll each time the tracker sleeps between passes (not on a row's
 * read: a row confirmed is never read again, builder#100).
 */
function node(n, confirmedBy, lostAfter = Infinity) {
  let clock = 0;
  const rows = Array.from({ length: n }, (_, i) => ({ domain: "notes", id: `r${i}` }));
  const target = {
    async get(_d, id) {
      const i = Number(id.slice(1));
      return { id, state: i < confirmedBy(clock) ? "CLEAN" : clock > lostAfter ? "ROLLED_BACK" : "PENDING" };
    },
  };
  return { rows, target, now: () => clock, sleep: async () => { clock += POLL_MS; } };
}

await t("**a target confirming one record every 2 s for 200 s: the handoff completes, reports progress, never fails**", async () => {
  const { rows, target, now, sleep } = node(100, ms => Math.floor(ms / 2000));
  const heard = [];
  await acknowledged(target, rows, { everyMs: 0, now, sleep, onProgress: p => heard.push(p) });
  assert.ok(now() >= 200_000, `finished at ${now()} ms: the run did not outlast the old 30 s total, so it tested nothing`);
  assert.deepStrictEqual(heard.at(-1), { confirmed: 100, total: 100 });
  const counts = heard.map(p => p.confirmed);
  assert.deepStrictEqual(counts, [...counts].sort((a, b) => a - b), "progress went backwards");
  assert.strictEqual(new Set(counts).size, counts.length, "the same count was reported twice");
  process.stdout.write(`  100 rows at one per 2 s: done at ${now() / 1000} s, ${heard.length} progress reports\n`);
});

await t("**a target that confirms 10 and then ANSWERS the rest lost: fails, naming it — whenever that answer comes**", async () => {
  const { rows, target, now, sleep } = node(50, ms => Math.min(10, Math.floor(ms / 2000)), 90_000);
  await assert.rejects(acknowledged(target, rows, { everyMs: 0, now, sleep }), /40 of 50 records did not reach the node; your data is still here/);
  assert.ok(now() > 90_000, `failed at ${now()} ms, before the node answered them lost (90 s)`);
});

await t("**no timer: a target that stays PENDING for ten minutes is waited on, and completes when it confirms**", async () => {
  const { rows, target, now, sleep } = node(5, ms => (ms < 600_000 ? 0 : 5));
  const heard = [];
  await acknowledged(target, rows, { everyMs: 0, now, sleep, onProgress: p => heard.push(p) });
  assert.ok(now() >= 600_000, `it finished at ${now()} ms, before the target confirmed`);
  assert.deepStrictEqual(heard, [{ confirmed: 0, total: 5 }, { confirmed: 5, total: 5 }], "progress reported what was not confirmed");
});

await t("**a count that dips and recovers is not progress: only the HIGHEST count is reported**", async () => {
  const { rows, target, now, sleep } = node(10, ms => (ms < 1000 ? 0 : ms < 2000 ? 5 : ms < 20_000 ? 3 : ms < 40_000 ? 5 : 10));
  const heard = [];
  await acknowledged(target, rows, { everyMs: 0, now, sleep, onProgress: p => heard.push(p.confirmed) });
  assert.deepStrictEqual(heard, [0, 5, 10], `reported ${JSON.stringify(heard)}`);
});

await t("**the old total budget, passed by name, is refused rather than silently ignored**", async () => {
  const { rows, target, now, sleep } = node(1, () => 1);
  await assert.rejects(acknowledged(target, rows, { everyMs: 0, now, sleep, budgetMs: 30_000 }), /`budgetMs` and `stallMs` are gone/);
  await assert.rejects(acknowledged(target, rows, { everyMs: 0, now, sleep, stallMs: 30_000 }), /`budgetMs` and `stallMs` are gone/);
});

await t("**the publish button says how far the records have got**", async () => {
  assert.strictEqual(buttonFor("migrating", { progress: { confirmed: 120, total: 302 } }).label, "Moving your records… 120 of 302 confirmed");
  assert.strictEqual(buttonFor("migrating").label, "Moving your records…", "before the first count, no number is invented");
});

// builder#100: a row read CLEAN after the handoff's own write of it STAYS
// published — a published write does not un-publish. What `get` answers later
// can change: a foreign delta DELETES it (Ok(None)), or its range is forgotten.
// Re-reading it counted the missing row as LOST and failed a publish that had
// succeeded. So a confirmed row is remembered and never read again. The clock
// here moves on the tracker's own `sleep`, not on a row's read — a remembered
// row is not read, so it cannot drive a clock.
await t("**a row confirmed, then deleted by another tab mid-publish: the handoff completes**", async () => {
  let clock = 0;
  const rows = [{ domain: "notes", id: "r0" }, { domain: "notes", id: "r1" }];
  const target = {
    async get(_d, id) {
      // r0 confirmed at once; a foreign delete removes it from the next poll on.
      if (id === "r0") return clock === 0 ? { id, state: "CLEAN" } : null;
      return { id, state: clock >= 5 * POLL_MS ? "CLEAN" : "PENDING" };
    },
  };
  const heard = [];
  await acknowledged(target, rows, { everyMs: POLL_MS, now: () => clock, sleep: async ms => { clock += ms; }, onProgress: p => heard.push(p.confirmed) });
  assert.ok(clock >= 5 * POLL_MS, `finished at ${clock} ms, before r1 confirmed`);
  assert.deepStrictEqual(heard, [1, 2], `reported ${JSON.stringify(heard)}`);
});

await t("**a row that answered saved is never read again**", async () => {
  const n = 300;
  let clock = 0;
  let after = 0;
  const answeredSaved = new Set();
  const rows = Array.from({ length: n }, (_, i) => ({ domain: "notes", id: `r${i}` }));
  // One more row confirms each poll. Rows still waiting are read each poll
  // (that is the wait); a row read after it answered saved is the defect.
  const target = {
    async get(_d, id) {
      if (answeredSaved.has(id)) after += 1;
      const state = Number(id.slice(1)) < clock / POLL_MS ? "CLEAN" : "PENDING";
      if (state === "CLEAN") answeredSaved.add(id);
      return { id, state };
    },
  };
  await acknowledged(target, rows, { everyMs: POLL_MS, now: () => clock, sleep: async ms => { clock += ms; } });
  assert.strictEqual(answeredSaved.size, n);
  assert.strictEqual(after, 0, `${after} reads of rows that had already answered saved`);
});
