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
// Driven on a FAKE clock that moves 250 ms per PASS over the rows, and the target confirms rows as a function of that
// clock -- so 200 s runs in milliseconds and the moment of failure is exact. The handoff itself keeps no clock
// (builder#175): it is WOKEN by its bindings, here after every read (tests/waking-target.mjs).
import assert from "node:assert";
import { acknowledged } from "../handoff.js";
import { wakingOnRead } from "./waking-target.mjs";
import { readFileSync as readSrc } from "node:fs";
import { buttonFor } from "../publish.js";
// The handoff asks the SDK what a row state means (`row_saved`): load it.
{ const { readFileSync } = await import("node:fs"); const { loadSdk } = await import("../sdk-loader.js");
  await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url))); }

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

const POLL_MS = 250;

/**
 * `n` rows, and a target that has confirmed `confirmedBy(ms)` of them at
 * clock `ms` — and, past `lostAfter`, answers the rest ROLLED_BACK. The clock
 * moves one poll each time row 0 is read — once per pass over the rows.
 */
function node(n, confirmedBy, lostAfter = Infinity) {
  let clock = 0;
  const rows = Array.from({ length: n }, (_, i) => ({ domain: "notes", id: `r${i}` }));
  const target = {
    async get(_d, id) {
      const i = Number(id.slice(1));
      if (i === 0) clock += POLL_MS;
      return { id, state: i < confirmedBy(clock) ? "CLEAN" : clock > lostAfter ? "ROLLED_BACK" : "PENDING" };
    },
  };
  return { rows, target: wakingOnRead(target), now: () => clock };
}

await t("**a target confirming one record every 2 s for 200 s: the handoff completes, reports progress, never fails**", async () => {
  const { rows, target, now } = node(100, ms => Math.floor(ms / 2000));
  const heard = [];
  await acknowledged(target, rows, { onProgress: p => heard.push(p) });
  assert.ok(now() >= 200_000, `finished at ${now()} ms: the run did not outlast the old 30 s total, so it tested nothing`);
  assert.deepStrictEqual(heard.at(-1), { confirmed: 100, total: 100 });
  const counts = heard.map(p => p.confirmed);
  assert.deepStrictEqual(counts, [...counts].sort((a, b) => a - b), "progress went backwards");
  assert.strictEqual(new Set(counts).size, counts.length, "the same count was reported twice");
  process.stdout.write(`  100 rows at one per 2 s: done at ${now() / 1000} s, ${heard.length} progress reports\n`);
});

await t("**a target that confirms 10 and then ANSWERS the rest lost: fails, naming it — whenever that answer comes**", async () => {
  const { rows, target, now } = node(50, ms => Math.min(10, Math.floor(ms / 2000)), 90_000);
  await assert.rejects(acknowledged(target, rows, {}), /40 of 50 records did not reach the node; your data is still here/);
  assert.ok(now() > 90_000, `failed at ${now()} ms, before the node answered them lost (90 s)`);
});

await t("**no timer: a target that stays PENDING for ten minutes is waited on, and completes when it confirms**", async () => {
  const { rows, target, now } = node(5, ms => (ms < 600_000 ? 0 : 5));
  const heard = [];
  await acknowledged(target, rows, { onProgress: p => heard.push(p) });
  assert.ok(now() >= 600_000, `it finished at ${now()} ms, before the target confirmed`);
  assert.deepStrictEqual(heard, [{ confirmed: 0, total: 5 }, { confirmed: 5, total: 5 }], "progress reported what was not confirmed");
});

await t("**a count that dips and recovers is not progress: only the HIGHEST count is reported**", async () => {
  const { rows, target, now } = node(10, ms => (ms < 1000 ? 0 : ms < 2000 ? 5 : ms < 20_000 ? 3 : ms < 40_000 ? 5 : 10));
  const heard = [];
  await acknowledged(target, rows, { onProgress: p => heard.push(p.confirmed) });
  assert.deepStrictEqual(heard, [0, 5, 10], `reported ${JSON.stringify(heard)}`);
});

await t("**the old total budget, passed by name, is refused rather than silently ignored**", async () => {
  const { rows, target, now } = node(1, () => 1);
  await assert.rejects(acknowledged(target, rows, { budgetMs: 30_000 }), /`budgetMs` and `stallMs` are gone/);
  await assert.rejects(acknowledged(target, rows, { stallMs: 30_000 }), /`budgetMs` and `stallMs` are gone/);
  // NO CLOCK AT ALL (builder#175): the old poll's knobs are refused by name too.
  for (const k of ["everyMs", "now", "sleep"]) {
    await assert.rejects(acknowledged(target, rows, { [k]: 0 }), new RegExp(`\\\`${k}\\\` is gone`), `${k} was silently accepted`);
  }
});

await t("**NO DEFAULT: a target with no bind() is refused by name** -- nothing would ever wake the wait (builder#73)", async () => {
  const { rows } = node(1, () => 1);
  await assert.rejects(acknowledged({ get: async () => ({ state: "PENDING" }) }, rows, {}), /has no bind\(\) -- nothing would wake the wait/);
});

await t("**ONE WAIT, THE SDK'S (builder#175)**: handoff.js keeps no room loop and no clock of its own -- no roomFor, NO_ROOM, retryable, everyMs poll, sleep or setTimeout; control: each planted copy is caught", async () => {
  const code = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const shapes = [/\broomFor\b/, /\bNO_ROOM\b/, /\.retryable\b/, /\beveryMs\s*=/, /\bpollIfDue\b/, /\bsetTimeout\b/, /\bsleep\s*\(/];
  const copies = src => shapes.filter(re => re.test(code(src))).map(String);
  const src = readSrc(new URL("../handoff.js", import.meta.url), "utf8");
  assert.deepEqual(copies(src), [], "handoff.js waits on its own clock, or retries for room, beside the SDK");
  for (const planted of ["async function roomFor(fn) {}", "if (e.code === NO_ROOM) {}", "if (e.retryable === true) {}", "let everyMs = 250;", "await t.pollIfDue();", "setTimeout(r, 250);", "await sleep(250);"]) {
    assert.equal(copies(src + "\n" + planted).length, 1, `THE CONTROL: the planted \`${planted}\` was not caught`);
  }
});

await t("**the publish button says how far the records have got**", async () => {
  assert.strictEqual(buttonFor("migrating", { progress: { confirmed: 120, total: 302 } }).label, "Moving your records… 120 of 302 confirmed");
  assert.strictEqual(buttonFor("migrating").label, "Moving your records…", "before the first count, no number is invented");
});
