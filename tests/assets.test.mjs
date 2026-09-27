// THE ASSETS TAB'S WORD, from the SDK's repairAll() report (the owner's first repair goal): DAMAGED when a group could
// not be rebuilt, REPAIRED when every missing block was put back, HEALTHY when nothing was missing, PARTIAL otherwise.
import assert from "node:assert/strict";
import { health, treeRow } from "../assets.js";

let failures = 0;
const t = (name, fn) => {
  try { fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.stack}\n`); }
};
const report = over => ({ rows: 100, missing: 0, putBack: 0, rejected: 0, givenUp: 0, why: null, ...over });

t("**the word: damaged / repaired / healthy / partial, from the report alone**", () => {
  assert.equal(health(report({})), "healthy");
  assert.equal(health(report({ missing: 3, putBack: 3 })), "repaired");
  assert.equal(health(report({ missing: 3, putBack: 2 })), "partial");
  assert.equal(health(report({ missing: 3, putBack: 3, givenUp: 1 })), "damaged", "a group given up is DAMAGED whatever else was put back");
  assert.equal(health(report({ missing: 0, givenUp: 1 })), "damaged");
});

t("**a DAMAGED row names the group count and why; a REPAIRED row says what was put back**", () => {
  const dmg = treeRow({ name: "t", address: "a", state: { phase: "done", report: report({ missing: 5, putBack: 2, givenUp: 1, why: "3 of 4 needed" }), at: 1 }, nowMs: 2 });
  assert.equal(dmg.word, "damaged");
  assert.ok(dmg.notes.some(n => n.kind === "damaged" && /1 group could not be rebuilt.*3 of 4 needed/.test(n.text)), JSON.stringify(dmg.notes));
  assert.equal(dmg.counts, "100 rows · 5 missing · 2 put back");
  const rep = treeRow({ name: "t", address: "a", state: { phase: "done", report: report({ missing: 2, putBack: 2 }), at: 1 }, nowMs: 2 });
  assert.equal(rep.word, "repaired");
  assert.ok(rep.notes.some(n => /2 missing blocks rebuilt from parity and put back/.test(n.text)));
});

t("**a REFUSED put-back is said, never hidden inside 'partial'**", () => {
  const r = treeRow({ name: "t", address: "a", state: { phase: "done", report: report({ missing: 2, putBack: 1, rejected: 1 }), at: 1 }, nowMs: 2 });
  assert.equal(r.word, "partial");
  assert.ok(r.notes.some(n => n.kind === "damaged" && /1 rebuilt block refused by the node/.test(n.text)));
});

t("**nothing is claimed before a pass: never checked says so; running disables the button; a failed pass is not a health word**", () => {
  const never = treeRow({ name: "t", address: "a", state: { phase: "never" }, nowMs: 0 });
  assert.equal(never.word, "not checked");
  assert.equal(never.counts, null);
  const run = treeRow({ name: "t", address: "a", state: { phase: "running", since: 1_000 }, nowMs: 6_000 });
  assert.equal(run.word, "repairing");
  assert.equal(run.canRepair, false);
  assert.match(run.notes[0].text, /for 5 s/);
  const failed = treeRow({ name: "t", address: "a", state: { phase: "failed", error: "no session", at: 1 }, nowMs: 2 });
  assert.equal(failed.word, "not checked");
  assert.ok(failed.notes.some(n => /could not run: no session/.test(n.text)));
});

t("THE CONTROL: an unknown state is refused, not painted as something", () => {
  assert.throws(() => treeRow({ name: "t", address: "a", state: { phase: "later" }, nowMs: 0 }), /unknown repair state/);
});

if (failures) { process.stdout.write(`${failures} failed\n`); process.exit(1); }
