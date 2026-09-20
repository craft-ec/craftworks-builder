// Publishing: the phases, what the button says, and the three ways it ends.
//
// No node and no browser. The point of keeping the decisions out of the DOM
// is that they can be checked like this, on any machine, every run.

import assert from "node:assert/strict";
import { buttonFor, rowStateFor, publish, waitFor, PHASES } from "../publish.js";
import { UNPUBLISHED } from "../publish-state.js";

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`ok ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`FAIL ${name}\n  ${e.message}\n`); }
};

await t("every phase has a button, and no two working phases share a label", () => {
  const labels = PHASES.map(p => buttonFor(p).label);
  assert.equal(new Set(labels).size, labels.length,
    "two phases show the same label, so a person cannot tell them apart: " + labels.join(" / "));
  for (const p of PHASES) {
    const b = buttonFor(p, { error: "why" });
    assert.ok(b.label, `${p} has no label`);
    assert.ok(b.hint, `${p} has no hint saying what it MEANS`);
  }
});

await t("only idle and failed can be pressed", () => {
  assert.equal(buttonFor("idle").enabled, true);
  assert.equal(buttonFor("failed").enabled, true, "a failure a retry can fix must be retryable");
  for (const p of ["connecting", "provisioning", "opening", "published"]) {
    assert.equal(buttonFor(p).enabled, false, `${p} is pressable`);
  }
});

await t("an unpublished project's rows say so; a published one's do not", () => {
  for (const p of ["idle", "connecting", "provisioning", "opening", "failed"]) {
    assert.equal(rowStateFor(p), UNPUBLISHED,
      `${p} rows claim to be saved while the data is in this tab only`);
  }
  assert.equal(rowStateFor("published"), null, "a published row must carry its OWN write state");
});

// ---- waitFor: three distinct ends, never one timeout ----

const fakeSession = over => ({
  provisioned: () => false, refused: () => "", exhausted: () => false, ...over,
});

await t("waitFor returns when the node says it is provisioned", async () => {
  let asked = 0;
  const s = fakeSession({ provisioned: () => ++asked > 2 });
  assert.equal(await waitFor(s, { everyMs: 1 }), "provisioned");
});

await t("a REFUSAL ends it with the node's own words, not a timeout", async () => {
  const s = fakeSession({ refused: () => "delegate code rejected" });
  await assert.rejects(() => waitFor(s, { everyMs: 1 }), e => {
    assert.match(e.message, /delegate code rejected/);
    return true;
  });
});

await t("EXHAUSTED ends it as its own fact, not as a refusal or a timeout", async () => {
  const s = fakeSession({ exhausted: () => true });
  await assert.rejects(() => waitFor(s, { everyMs: 1 }), e => {
    assert.match(e.message, /accepted everything and still cannot write/);
    return true;
  });
});

await t("a node that never answers ends on the BUDGET and says what to check", async () => {
  let clock = 0;
  const s = fakeSession({});
  await assert.rejects(
    () => waitFor(s, { everyMs: 1, budgetMs: 10, now: () => (clock += 8) }),
    e => {
      assert.match(e.message, /still running/);
      return true;
    });
});

await t("THE CONTROL: the budget does not fire on a node that answers", async () => {
  let clock = 0;
  const s = fakeSession({ provisioned: () => true });
  assert.equal(
    await waitFor(s, { everyMs: 1, budgetMs: 10, now: () => (clock += 8) }),
    "provisioned",
    "the budget fired on a healthy node, so the test above proves nothing about timing");
});

// ---- publish: the phases happen in order ----

await t("publish reports each phase, in order, and hands back the engine db", async () => {
  const seen = [];
  const session = { provisioned: () => true, refused: () => "", exhausted: () => false };
  const { db } = await publish({}, {
    open: async () => ({ ...session, db: { marker: "engine" } }),
  }, p => seen.push(p));
  assert.deepEqual(seen, ["connecting", "provisioning", "opening"]);
  assert.equal(db.marker, "engine", "publish did not switch the backend");
});

await t("a node that is not there fails with advice, not a stack trace", async () => {
  const seen = [];
  await assert.rejects(() => publish({}, {
    open: async () => { throw new Error("ECONNREFUSED"); },
  }, (p, e) => seen.push([p, e])));
  const failed = seen.find(([p]) => p === "failed");
  assert.ok(failed, "no failed phase was reported");
  assert.match(failed[1], /node running locally|running locally|needs one running/,
    "the failure does not say what to do about it");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
