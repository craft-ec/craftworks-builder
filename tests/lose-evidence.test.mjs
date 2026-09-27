// AN ARM COUNTS ONLY WHEN THE READER HELD EVERYTHING THE NETWORK HAS (tools/lose-evidence.mjs; the architect on
// craftworks-sdk#541). Judged on the lines ws-lose logs, for a group of k = 21 with m = 8 parity. The control Codex
// found: a reader that asks all 21 data members and NO parity reached the old "asked >= k" with every loss observed,
// so a repair path that never starts passed the m + 1 control. It must be VOID.
import assert from "node:assert/strict";
import { evidence, happened, held, voidHeld } from "../tools/lose-evidence.mjs";

let failures = 0;
const t = (name, f) => {
  try { f(); process.stdout.write(`  ok  ${name}\n`); } catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

const K = 21, M = 8;
const data = Array.from({ length: K }, (_, i) => `d${String(i).padStart(15, "0")}`);
const parity = Array.from({ length: M }, (_, i) => `p${String(i).padStart(15, "0")}`);
const slots = [...data, ...parity];
/** The lines a run logs: the choice (the first `n` slots lost, data first), then each id answered. */
function run(n, { notFound = [], bytes = [], survivors = true } = {}) {
  const lost = slots.slice(0, n);
  const chosen = { chosen: "data", k: K, slots: slots.length, lost: [...lost].sort(), lost_data: lost.filter(id => data.includes(id)).sort() };
  if (survivors) chosen.survivors = slots.slice(n).sort();
  const lines = [chosen];
  notFound.forEach((id, i) => lines.push({ not_found: id, not_found_total: i + 1 }));
  bytes.forEach((id, i) => lines.push({ answered: id, answered_total: i + 1 }));
  return evidence(lines);
}

t("THE SETUP: m + 1 lost leaves k - 1 survivors, m lost leaves k", () => {
  assert.equal(run(M + 1).chosen.survivors.length, K - 1);
  assert.equal(run(M).chosen.survivors.length, K);
});

t("**m + 1: a reader that asked every DATA member and NO parity is VOID** (Codex), though every loss was observed", () => {
  const ev = run(M + 1, { notFound: data.slice(0, M + 1), bytes: data.slice(M + 1) });
  assert.ok(happened(ev), "THE SETUP: the loss happened");
  assert.equal(held(ev), false, "no parity was asked, and the arm counted");
  assert.match(voidHeld("data, m + 1 lost: THE CONTROL", ev), /bytes for 12 of the group's 20 surviving slots/);
});

t("CONTROL: m + 1 with every survivor answered with bytes (the k - 1 left, parity included) counts", () => {
  const ev = run(M + 1, { notFound: data.slice(0, M + 1), bytes: [...data.slice(M + 1), ...parity] });
  assert.ok(happened(ev) && held(ev));
});

t("a survivor NOT answered with bytes (the node's own NotFound, or never asked) is VOID -- one short is enough", () => {
  const ev = run(M + 1, { notFound: data.slice(0, M + 1), bytes: [...data.slice(M + 1), ...parity.slice(1)] });
  assert.equal(held(ev), false);
});

t("m: the floor holds too -- exactly the k survivors answered counts; one short is VOID", () => {
  assert.ok(held(run(M, { notFound: data.slice(0, M), bytes: [...data.slice(M), ...parity] })));
  assert.equal(held(run(M, { notFound: data.slice(0, M), bytes: [...data.slice(M), ...parity.slice(0, M - 1)] })), false);
});

t("a proxy that names no survivors (an older ws-lose) is VOID, never a pass", () => {
  assert.equal(held(run(M + 1, { notFound: data.slice(0, M + 1), bytes: slots.slice(M + 1), survivors: false })), false);
});

t("NON-VACUITY stays: a lost data member never answered NotFound is not a loss that happened", () => {
  assert.equal(happened(run(M + 1, { notFound: data.slice(1, M + 1), bytes: slots.slice(M + 1) })), false);
});

if (failures) { process.stdout.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall ok\n");
