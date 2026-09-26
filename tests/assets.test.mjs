// THE ASSETS TAB'S VIEW (assets.js), no DOM and no node: each row the design shows (builder#164's mock), from the
// SDK's answers as agreed with engineer2 -- and the view derives nothing the SDK reports (the word, the warning and
// the counts are passed through; a changed SDK answer changes the row).
import assert from "node:assert/strict";
import { ago, assetsView, repairWords } from "../assets.js";

let failures = 0;
const t = async (name, f) => {
  try { await f(); process.stdout.write(`  ok  ${name}\n`); } catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

const NOW = 1_790_400_000_000;
const at = minsAgo => Math.floor(NOW / 1000) - minsAgo * 60;
const health = (word, whole, degraded, damaged) => ({ word, groups: whole + degraded + damaged, whole, degraded, damaged });
const asset = (target, kind, repair, auditedAt, h, warning = null) => ({ target, kind, policy: { repair, warn_below: 2 }, audited_at: auditedAt, health: h, warning });

await t("**the identity's own tree**: named 'Your data', its record's health, groups and last audit as the SDK says", () => {
  const { rows, running } = assetsView({ assets: [asset("7bb29b3b2fcae053", "identity", "always", at(2), health("whole", 14, 0, 0))], nowMs: NOW });
  assert.equal(running, null);
  assert.deepEqual(
    { name: rows[0].name, sub: rows[0].sub, word: rows[0].word, groups: rows[0].groups, last: rows[0].last, repair: rows[0].repair, canAudit: rows[0].canAudit, notes: rows[0].notes },
    { name: "Your data", sub: "your identity's tree", word: "whole", groups: "14 · 0 · 0", last: "2 min ago", repair: "always (keep backed up)", canAudit: true, notes: [] },
  );
});

await t("**a published app**: named by the builder's own project, the SDK's warning shown as it is", () => {
  const { rows } = assetsView({ assets: [asset("2uhMr27dFXXW", "app", { below: 2 }, at(5), health("degraded", 12, 1, 0), "1 group has fewer than 2 blocks to spare (lowest: 1)")], labels: new Map([["2uhMr27dFXXW", "Notes"]]), nowMs: NOW });
  assert.equal(rows[0].name, "Notes");
  assert.equal(rows[0].sub, "your published app");
  assert.equal(rows[0].repair, "below 2");
  assert.deepEqual(rows[0].notes, [{ kind: "warn", text: "1 group has fewer than 2 blocks to spare (lowest: 1)" }]);
});

await t("**a pass finished this session**: its damaged groups, its refused blocks and its silent GETs are named", () => {
  const report = { state: "done", pass: "full", health: "damaged", whole: 9, degraded: 0, damaged: ["8c1f00aa11223344"], rejected: ["b1"], pending: 2, warning: null };
  const { rows } = assetsView({ assets: [asset("71XasNUMRjJw", "app", "always", at(12), health("whole", 10, 0, 0))], reports: new Map([["71XasNUMRjJw", report]]), nowMs: NOW });
  assert.equal(rows[0].word, "damaged", "the record's older word was shown over this session's pass");
  assert.equal(rows[0].groups, "9 · 0 · 1");
  assert.deepEqual(rows[0].notes.map(n => n.text), [
    "group 8c1f00aa1122…: fewer than k blocks anywhere — cannot be rebuilt",
    "1 block refused by the node (encoding, or a node on another contract epoch)",
  ]);
  assert.equal(rows[0].lastNote, "2 blocks pending (silent) — asked again next pass");
});

await t("**a pass running**: the row says auditing with asked/of and keeps the last result; the top line names it, with the audit's silence", () => {
  const report = { state: "running", pass: "full", asked: 212, of: 318 };
  const { rows, running } = assetsView({
    assets: [asset("9D9bAjjKSVoHRTtB", "app", { below: 3 }, at(60 * 26), health("whole", 3, 0, 0))],
    reports: new Map([["9D9bAjjKSVoHRTtB", report]]), waiting: { what: "the assets audit", ms: 14_200 }, nowMs: NOW,
  });
  assert.deepEqual({ word: rows[0].word, groups: rows[0].groups, canAudit: rows[0].canAudit, lastNote: rows[0].lastNote, name: rows[0].name, sub: rows[0].sub },
    { word: "auditing", groups: "— · — · —", canAudit: false, lastNote: "last result: whole", name: "9D9bAjjKSVoH…", sub: "an app you keep" });
  assert.deepEqual(rows[0].notes, [{ kind: "progress", text: "212 of 318 blocks asked" }]);
  assert.deepEqual(running, { target: "9D9bAjjKSVoHRTtB", name: "9D9bAjjKSVoH…", pass: "full", asked: 212, of: 318, waiting: "node not answering the assets audit for 14 s — asked again, still waiting" });
});

await t("THE CONTROL: another request's silence is NOT the audit's (the line shows only the assets audit's waits)", () => {
  const { running } = assetsView({ assets: [asset("x", "app", "always", 0, null)], reports: new Map([["x", { state: "running", pass: "full", asked: 1, of: 2 }]]), waiting: { what: "a GET of the head", ms: 9000 }, nowMs: NOW });
  assert.equal(running.waiting, null);
});

await t("**unmeasured**: said as nothing asked, never as absent; no audit offered; a never-audited asset reads 'never'", () => {
  const { rows } = assetsView({ assets: [asset("4BgcWjAqDWBNzjDg", "app", "off", 0, null)], reports: new Map([["4BgcWjAqDWBNzjDg", { state: "unmeasured" }]]), nowMs: NOW });
  assert.deepEqual({ word: rows[0].word, last: rows[0].last, canAudit: rows[0].canAudit, repair: rows[0].repair }, { word: "unmeasured", last: "never", canAudit: false, repair: "off (watch only)" });
  assert.match(rows[0].notes[0].text, /nothing was asked, nothing assumed missing/);
});

await t("the SDK's word is passed through, never re-derived: a record whose counts say 'damaged' but whose word is 'whole' shows 'whole'", () => {
  const { rows } = assetsView({ assets: [asset("y", "app", "always", at(1), health("whole", 0, 0, 1))], nowMs: NOW });
  assert.equal(rows[0].word, "whole");
});

await t("the small words: repair policies and ages", () => {
  assert.deepEqual(["always", "off", { below: 3 }].map(repairWords), ["always (keep backed up)", "off (watch only)", "below 3"]);
  assert.deepEqual([0, at(0), at(5), at(120), at(60 * 30), at(60 * 72)].map(a => ago(a, NOW)), ["never", "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago"]);
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nall ok\n");
process.exit(failures ? 1 : 0);
