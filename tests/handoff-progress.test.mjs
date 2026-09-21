// The handoff fails on NO PROGRESS, not on total time (builder#94).
//
// The node confirms one write per commit, about 3.4 a second. On a live node
// a 100-row publish took 27–29 s of the old 30 s TOTAL, and a 300-row one
// could not pass at any speed — nothing wrong with it except that it was not
// finished (craftworks-sdk#176's L4 runs). A duration was standing in for a
// condition.
//
// Driven on a FAKE clock: every poll is 250 ms, and the target confirms rows
// as a function of that clock — so 200 s runs in milliseconds and the moment
// of failure is exact.
import assert from "node:assert";
import { acknowledged } from "../handoff.js";
import { buttonFor } from "../publish.js";

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

const POLL_MS = 250;

/**
 * `n` rows, and a target that has confirmed `confirmedBy(ms)` of them at
 * clock `ms`. The clock moves one poll each time row 0 is read — once per
 * pass over the rows.
 */
function node(n, confirmedBy) {
  let clock = 0;
  const rows = Array.from({ length: n }, (_, i) => ({ domain: "notes", id: `r${i}` }));
  const target = {
    async get(_d, id) {
      const i = Number(id.slice(1));
      if (i === 0) clock += POLL_MS;
      return { id, state: i < confirmedBy(clock) ? "CLEAN" : "PENDING" };
    },
  };
  return { rows, target, now: () => clock };
}

await t("**a target confirming one record every 2 s for 200 s: the handoff completes, reports progress, never fails**", async () => {
  const { rows, target, now } = node(100, ms => Math.floor(ms / 2000));
  const heard = [];
  await acknowledged(target, rows, { everyMs: 0, now, onProgress: p => heard.push(p) });
  assert.ok(now() >= 200_000, `finished at ${now()} ms: the run did not outlast the old 30 s total, so it tested nothing`);
  assert.deepStrictEqual(heard.at(-1), { confirmed: 100, total: 100 });
  const counts = heard.map(p => p.confirmed);
  assert.deepStrictEqual(counts, [...counts].sort((a, b) => a - b), "progress went backwards");
  assert.strictEqual(new Set(counts).size, counts.length, "the same count was reported twice");
  process.stdout.write(`  100 rows at one per 2 s: done at ${now() / 1000} s, ${heard.length} progress reports\n`);
});

await t("**a target that confirms 10 then stops: fails 30 s after the LAST confirmation, naming how many were confirmed**", async () => {
  const { rows, target, now } = node(50, ms => Math.min(10, Math.floor(ms / 2000)));
  await assert.rejects(acknowledged(target, rows, { everyMs: 0, now }), e => {
    assert.match(e.message, /40 of 50 records are not confirmed by the node yet — 10 confirmed, and none newly in 30 s; your data is still here/);
    return true;
  });
  // The tenth confirmation lands at 20 s; the failure is the first poll past 30 s after it.
  assert.ok(now() > 50_000 && now() <= 50_000 + 2 * POLL_MS, `failed at ${now()} ms, not 30 s after the last confirmation (20 s)`);
});

await t("**control: a target that never confirms fails at 30 s, as before**", async () => {
  const { rows, target, now } = node(5, () => 0);
  const heard = [];
  await assert.rejects(acknowledged(target, rows, { everyMs: 0, now, onProgress: p => heard.push(p) }),
    /5 of 5 records are not confirmed by the node yet — 0 confirmed/);
  assert.ok(now() > 30_000 && now() <= 30_000 + 2 * POLL_MS, `failed at ${now()} ms`);
  assert.deepStrictEqual(heard, [{ confirmed: 0, total: 5 }], "nothing may be reported confirmed that was not");
});

await t("**a count that dips and recovers is not progress: the deadline runs from the HIGHEST count**", async () => {
  // 5 confirmed at 1 s; reads say 3 from 2 s to 20 s; 5 again after — never above 5.
  const { rows, target, now } = node(10, ms => (ms < 1000 ? 0 : ms < 2000 ? 5 : ms < 20_000 ? 3 : 5));
  await assert.rejects(acknowledged(target, rows, { everyMs: 0, now }), /5 confirmed, and none newly in 30 s/);
  assert.ok(now() > 31_000 && now() <= 31_000 + 2 * POLL_MS, `failed at ${now()} ms: the deadline should run from 1 s`);
});

await t("**the old total budget, passed by name, is refused rather than silently ignored**", async () => {
  const { rows, target, now } = node(1, () => 1);
  await assert.rejects(acknowledged(target, rows, { everyMs: 0, now, budgetMs: 30_000 }), /`budgetMs` is gone/);
});

await t("**the publish button says how far the records have got**", async () => {
  assert.strictEqual(buttonFor("migrating", { progress: { confirmed: 120, total: 302 } }).label, "Moving your records… 120 of 302 confirmed");
  assert.strictEqual(buttonFor("migrating").label, "Moving your records…", "before the first count, no number is invented");
});
