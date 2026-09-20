// THE TREE PANEL AGAINST BOTH BACKENDS' REAL ANSWERS.
//
// Three defects in a row came from one thing: this repo's tests all run over
// the in-memory backend, so no test had ever seen what `stats()` answers once
// a project is PUBLISHED. The engine-backed session returns null for the
// three figures that describe the tree, because the tree is on the node.
//
// Both shapes are pinned here as literals copied from the two sources, so a
// change on either side has to come through this file.
import assert from "node:assert";
import { treeStats } from "../tree-stats.js";

/**
 * Exactly what `web/src/session.rs::stats` returns once published.
 *
 * Not a shape invented for this test: `blocks`, `bytes` and `height` are
 * `serde_json::Value::Null` there, with a comment saying they are properties
 * of the tree, which lives on the node.
 */
const PUBLISHED = {
  blocks: null, bytes: null, height: null,
  heldBytes: 4096, pendingWrites: 0, pendingBytes: 0,
};

/** And what the in-memory Db answers, where the tree IS in this tab. */
const IN_MEMORY = { height: 2, blocks: 7, bytes: 12345 };

let failures = 0;
const t = (name, fn) => {
  try { fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

t("**the published shape neither throws nor prints a null**", () => {
  const chips = treeStats(PUBLISHED);
  const text = chips.map(c => c.text).join(" · ");
  assert.ok(!/null|undefined|NaN/.test(text),
    `the panel would show "${text}" — a placeholder that reads like a measurement`);
  assert.ok(chips.some(c => /on the node/.test(c.text)),
    "it says nothing about where the tree's size actually is, so a person reads the absence as zero");
  assert.ok(chips.some(c => /4,?096 B here/.test(c.text)),
    "it dropped the one size this tab CAN state");
});

t("THE CONTROL: the in-memory shape still shows all three figures", () => {
  // Without this, a `treeStats` that returned only the "on the node" line
  // would pass the test above and silently stop reporting anything real on
  // an unpublished project.
  const text = treeStats(IN_MEMORY).map(c => c.text).join(" · ");
  assert.match(text, /height 2/, "height is gone");
  assert.match(text, /7 blocks/, "the block count is gone");
  assert.match(text, /12,345 B/, "the byte count is gone, or stopped being grouped");
  assert.ok(!/on the node/.test(text),
    "it claims the tree is on a node for a project that has not been published");
});

t("pending writes are shown, and only when there are some", () => {
  assert.ok(!treeStats(PUBLISHED).some(c => /not yet on the network/.test(c.text)),
    "it warned about zero unshipped writes");
  const busy = treeStats({ ...PUBLISHED, pendingWrites: 3 });
  assert.ok(busy.some(c => c.tone === "warn" && /3 not yet on the network/.test(c.text)),
    "three writes are sitting in this tab and the panel does not say so");
});

t("an empty answer is survivable", () => {
  // `stats()` can be called before anything has been read. It must not throw,
  // and must not claim a size it does not have.
  const chips = treeStats({});
  assert.ok(Array.isArray(chips), "it did not return chips at all");
  assert.ok(!chips.some(c => /null|undefined|NaN/.test(c.text)), "it printed a placeholder");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok tree stats\n");
process.exit(failures ? 1 : 0);
