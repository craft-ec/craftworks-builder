// THE ASSETS TAB'S ROW, from the SDK's repairAll() report: the word is the report's `outcome` (the SDK's
// status.repairOutcome), each damaged group's word its `health` (status.groupHealth). The tab derives no health.
import assert from "node:assert/strict";
import { repairPass, treeRow } from "../assets.js";

let failures = 0;
const t = (name, fn) => {
  try { fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.stack}\n`); }
};
// The SDK's lists as the pinned SDK exports them (a test of the pinned build checks these against sdk.status).
const words = { repairOutcome: ["healthy", "repaired", "partial", "damaged", "cancelled"], groupHealth: ["whole", "degraded", "damaged"] };
const report = over => ({ rows: 100, outcome: "healthy", missing: 0, putBack: 0, rejected: 0, givenUp: 0, parityMismatched: 0, pending: 0, damaged: [], why: null, ...over });
const done = r => treeRow({ name: "t", address: "a", state: { phase: "done", report: r, at: 1 }, words, nowMs: 2 });

t("**the word IS the report's outcome, whatever the counts say: the tab derives nothing**", () => {
  for (const outcome of words.repairOutcome) assert.equal(done(report({ outcome })).word, outcome);
  // THE CONTROL: counts that would read "repaired" do not overrule the SDK's word.
  assert.equal(done(report({ outcome: "damaged", missing: 3, putBack: 3 })).word, "damaged");
});

t("**a word the SDK does not define is refused, never painted (outcome and a group's health)**", () => {
  assert.throws(() => done(report({ outcome: "fine" })), /not a word of status.repairOutcome/);
  assert.throws(() => done(report({ outcome: "damaged", damaged: [{ block: "b".repeat(64), present: 2, k: 4, health: "broken" }] })), /not a word of status.groupHealth/);
});

t("**a DAMAGED report lists each group with its SDK health word and what was found; given-up and refused are said**", () => {
  const r = done(report({ outcome: "damaged", missing: 5, putBack: 2, rejected: 1, givenUp: 1, why: "2 of 4 blocks left", damaged: [{ block: "ab".repeat(32), present: 2, k: 4, health: "damaged" }] }));
  assert.deepEqual(r.damaged, [{ block: "abababababab…", health: "damaged", text: "2 of 4 blocks found" }]);
  assert.ok(r.notes.some(n => /1 group could not be rebuilt: 2 of 4 blocks left/.test(n.text)));
  assert.ok(r.notes.some(n => /1 rebuilt block refused by the node/.test(n.text)));
  assert.equal(r.counts, "100 rows · 5 missing · 2 put back");
});

t("**pending put-backs and parity that re-encodes to another id are said, never hidden**", () => {
  const r = done(report({ outcome: "partial", missing: 3, putBack: 1, pending: 1, parityMismatched: 1 }));
  assert.ok(r.notes.some(n => /1 put-back not answered yet/.test(n.text)));
  assert.ok(r.notes.some(n => /1 parity block re-encoded to a different id/.test(n.text)));
});

t("**before a report: not checked; running: Repair off and Cancel on, until a cancel is asked; a failed pass is no health word**", () => {
  const never = treeRow({ name: "t", address: "a", state: { phase: "never" }, words, nowMs: 0 });
  assert.equal(never.word, "not checked");
  assert.equal(never.counts, null);
  const run = treeRow({ name: "t", address: "a", state: { phase: "running", since: 1_000 }, words, nowMs: 6_000 });
  assert.deepEqual([run.word, run.canRepair, run.canCancel], ["repairing", false, true]);
  assert.match(run.notes[0].text, /for 5 s/);
  const stopping = treeRow({ name: "t", address: "a", state: { phase: "running", since: 1_000, cancelling: true }, words, nowMs: 6_000 });
  assert.equal(stopping.canCancel, false, "Cancel asked twice");
  const failed = treeRow({ name: "t", address: "a", state: { phase: "failed", error: "no session", at: 1 }, words, nowMs: 2 });
  assert.equal(failed.word, "not checked");
  assert.ok(failed.notes.some(n => /could not run: no session/.test(n.text)));
});

// A stand-in owner's handle: its tree() resolves when the test says; its db counts repairAll / cancel calls.
const handleWith = () => {
  const calls = { repairAll: 0, cancel: 0, closed: 0 };
  let open;
  const tree = { db: { repairAll: async () => { calls.repairAll += 1; return report({ outcome: "healthy" }); }, repairAllCancel: () => { calls.cancel += 1; } }, close: () => { calls.closed += 1; } };
  return { calls, open: () => open(tree), handle: { headId: () => "ab".repeat(32), headSeq: () => 1, tree: () => new Promise(ok => { open = ok; }) } };
};

await (async () => {
  const name = "**a Cancel pressed while the cold page is still OPENING: repairAll is never called, the page is closed, the SDK's cancelled word**";
  try {
    const { calls, open, handle } = handleWith();
    const pass = repairPass(handle, { cancelled: "cancelled" });
    pass.cancel();
    open();
    const r = await pass.done;
    assert.equal(calls.repairAll, 0, "the pass ran after its Cancel");
    assert.equal(calls.closed, 1, "the cold page was left open");
    assert.equal(r.outcome, "cancelled");
    // THE CONTROL: no Cancel -> the pass runs once, and the page is closed after it.
    const h2 = handleWith();
    const p2 = repairPass(h2.handle, { cancelled: "cancelled" });
    h2.open();
    assert.equal((await p2.done).outcome, "healthy");
    assert.deepEqual([h2.calls.repairAll, h2.calls.closed], [1, 1]);
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.stack}\n`); }
})();

t("THE CONTROL: an unknown state is refused, not painted as something", () => {
  assert.throws(() => treeRow({ name: "t", address: "a", state: { phase: "later" }, words, nowMs: 0 }), /unknown repair state/);
});

if (failures) { process.stdout.write(`${failures} failed\n`); process.exit(1); }
