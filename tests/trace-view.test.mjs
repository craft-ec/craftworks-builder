import assert from "node:assert/strict";
import { rows, summary, MEANS } from "../trace-view.js";

let failures = 0;
const t = (name, fn) => { try { fn(); console.log("ok", name); } catch (e) { failures++; console.log("FAIL", name, "\n  " + e.message); } };

t("a trace becomes rows with indents and plain-words meanings", () => {
  const r = rows({ steps: [
    { step: "Began", depth: 0, n: 1, atMs: 0 },
    { step: "Put", depth: 1, n: 3, atMs: 12 },
  ]});
  assert.equal(r.length, 2);
  assert.equal(r[1].depth, 1);
  assert.equal(r[1].n, 3);
  assert.equal(r[1].means, MEANS.Put);
});

t("a step this build does not know is SHOWN, not hidden", () => {
  // Hiding it would make a newer engine's trace look shorter than it is,
  // which is a diagnosis of the wrong thing.
  const r = rows({ steps: [{ step: "SomethingNewer", depth: 0, n: 1, atMs: 0 }] });
  assert.equal(r.length, 1, "an unknown step was dropped");
  assert.equal(r[0].step, "SomethingNewer");
  assert.match(r[0].means, /no description/);
});

t("TRUNCATED is said, not implied by a short tree", () => {
  assert.match(summary({ steps: [{}], totalMs: 5, truncated: true }), /TRUNCATED/);
  assert.doesNotMatch(summary({ steps: [{}], totalMs: 5, truncated: false }), /TRUNCATED/,
    "a complete trace claims to be truncated");
});

t("no trace at all says what to do, not nothing", () => {
  const s = summary(null);
  assert.match(s, /tracing on/i, "an empty viewer that says nothing is indistinguishable from a broken one");
});

t("rows survives a malformed trace rather than throwing", () => {
  // It comes across a boundary. A viewer that throws takes the page with it.
  assert.deepEqual(rows(null), []);
  assert.deepEqual(rows({}), []);
  assert.deepEqual(rows({ steps: "nonsense" }), []);
});

t("THE CONTROL: nothing in the vocabulary carries user content", () => {
  // Every field the viewer reads is a step NAME, a depth, a count or an
  // offset. If this ever needs a key or a value to be useful, that is a
  // change to what a support bundle contains and is not a viewer decision.
  const r = rows({ steps: [{ step: "Put", depth: 0, n: 3, atMs: 1 }] })[0];
  assert.deepEqual(Object.keys(r).sort(), ["atMs", "depth", "means", "n", "step"]);
});

process.exit(failures ? 1 : 0);
