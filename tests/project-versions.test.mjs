// What a project records, and what may be SAID about those versions later.
//
// The distinctions these tests pin are the ones ARCHITECTURE §19 is made of:
// code is current or superseded AUTHORITATIVELY (the released table says so);
// an app's own blocks are reachable or not-reachable-within-T and never "gone";
// and an upgrade is offered, never applied.
import assert from "node:assert";
import { stamp, drift, codeState, blockState, appSection, short } from "../project-versions.js";

const baked = {
  builder: { rev: "abc1234", profile: "dev" },
  sdkRev: "3bf049a",
  contracts: {
    code: {
      block: "sha256:1521dddb9ecbaa164579bf8c65accea9e05f7ca5238ea455517e8462c0877c70",
      register: "sha256:e273be8c6f35a739d91c3cae63f4ef60b792c1b89e8a8373f52b3008191eb735",
    },
  },
  released: [],
};
const sdk = { rev: "3bf049a", prollyRev: "e2756c8", formatTag: "PT01", version: "0.1.0" };

// ---- what a project records -------------------------------------------------
{
  const s = stamp({ baked, sdk, now: new Date("2026-09-20T00:00:00Z") });
  assert.strictEqual(s.sdkRev, "3bf049a");
  assert.strictEqual(s.prollyRev, "e2756c8");
  assert.strictEqual(s.formatTag, "PT01");
  assert.strictEqual(s.contracts.block, baked.contracts.code.block);
  assert.strictEqual(s.recorded, "2026-09-20T00:00:00.000Z");
  // The RUNTIME answer wins over the pin: the pin is what was asked for, the
  // wasm is what is loaded, and only one of them can be wrong about itself.
  const stale = stamp({ baked, sdk: { ...sdk, rev: "deadbee" } });
  assert.strictEqual(stale.sdkRev, "deadbee");
}

// ---- drift lists only what CHANGED -----------------------------------------
{
  const made = stamp({ baked, sdk });
  assert.deepStrictEqual(drift(made, { baked, sdk }), [], "no drift against itself");

  const moved = drift(made, {
    baked: { ...baked, contracts: { code: { ...baked.contracts.code, block: "sha256:" + "f".repeat(64) } } },
    sdk: { ...sdk, rev: "9999999" },
  });
  const what = moved.map((r) => r.what).sort();
  assert.deepStrictEqual(what, ["SDK", "block"], `only the changed rows: ${JSON.stringify(moved)}`);
  // register did not move and must NOT appear: a list where most rows say
  // "same" buries the answer the developer is looking for.
  assert.ok(!what.includes("register"));
}
{
  // A project with no stamp is not a project with no drift.
  assert.deepStrictEqual(drift(null, { baked, sdk }), []);
  const s = appSection(null, { baked, sdk });
  assert.match(s.rows[0].note, /predates version stamping/);
  assert.strictEqual(s.rows[0].state, "unknown");
}

// ---- code: current vs superseded, from the released table -------------------
{
  // Nothing released: nothing can be superseded, and claiming "current" would
  // name an epoch that does not exist.
  assert.strictEqual(codeState(baked.contracts.code.block, []).text, "current build, not released");
  // ...but "current build" is a claim about THIS hash. A project pinned to an
  // older one was getting the same label, which a screenshot caught sitting
  // under a hash that was visibly not the current build.
  const older = codeState("sha256:" + "a".repeat(64), [], baked.contracts.code.block);
  assert.match(older.text, /an earlier build \(1521dddb is current\)/);
  assert.match(older.text, /no released table to say whether it is still served/);

  const released = [
    { number: 1, code: { block: "sha256:" + "a".repeat(64) } },
    { number: 2, code: { block: baked.contracts.code.block } },
  ];
  assert.match(codeState(baked.contracts.code.block, released).text, /^current — epoch 2/);
  const old = codeState("sha256:" + "a".repeat(64), released);
  assert.match(old.text, /superseded by epoch 2, still served/);
  assert.strictEqual(old.state, "info", "superseded is not a warning: it is still served");
  // A hash in no epoch at all is a different thing again.
  assert.strictEqual(codeState("sha256:" + "b".repeat(64), released).state, "warn");
  assert.strictEqual(codeState(null, released).state, "unknown");
}

// ---- the app's own blocks: never "gone" -------------------------------------
{
  assert.match(blockState(true, 1500).text, /reachable within 1500 ms/);
  const miss = blockState(false, 1500);
  assert.match(miss.text, /NOT reachable within 1500 ms/);
  assert.match(miss.text, /not the same as gone/);
  assert.ok(!/gone\b(?!.*not the same)/.test(miss.text.replace("not the same as gone", "")),
    "the word 'gone' must only ever appear in the denial");
  assert.strictEqual(blockState(null, 1500).state, "unknown");
  assert.match(blockState(null, 1500).text, /phase 3/);
}

// ---- the section a reader sees ---------------------------------------------
{
  const made = stamp({ baked, sdk });
  const s = appSection(made, { baked, sdk });
  const row = (l) => s.rows.find((r) => r.label === l);
  assert.strictEqual(row("drift").value, "none");
  assert.strictEqual(row("block").note, "current build, not released");

  const moved = appSection(made, { baked, sdk: { ...sdk, rev: "9999999" } });
  const d = moved.rows.find((r) => r.label === "drift");
  assert.strictEqual(d.value, "1 changed");
  assert.match(d.note, /SDK 3bf049a → 9999999/);
  // The promise §19 makes, in the row itself.
  assert.match(d.note, /offered, never applied on its own/);
}

// ---- the SDK is code, the app's blocks are not ------------------------------
{
  const made = stamp({ baked, sdk });
  const same = appSection(made, { baked, sdk });
  const sdkRow = same.rows.find((r) => r.label === "SDK");
  assert.strictEqual(sdkRow.state, "ok");
  assert.match(sdkRow.note, /no released table for the SDK yet/,
    "it must not claim 'current' from a table that does not exist");

  const newer = appSection(made, { baked, sdk: { ...sdk, rev: "9999999" } });
  const moved = newer.rows.find((r) => r.label === "SDK");
  assert.strictEqual(moved.state, "info", "superseded is not a warning");
  assert.match(moved.note, /superseded by 9999999, and still what this project builds against/);
}

// ---- own blocks: none, unchecked, reachable, and some missing ---------------
{
  const made = stamp({ baked, sdk });
  const row = (probes) =>
    appSection(made, { baked, sdk, probes, tMs: 1500 }).rows.find((r) => r.label === "own blocks");

  // No components yet is NOT the same as unchecked, and says so.
  assert.match(row({}).note, /none to check yet/);
  assert.match(row({ a: null, b: null }).note, /phase 3/);
  assert.match(row({ a: true, b: true }).note, /reachable within 1500 ms/);

  const partial = row({ a: true, b: false, c: false });
  assert.strictEqual(partial.value, "1/3");
  assert.strictEqual(partial.state, "warn");
  assert.match(partial.note, /2 NOT reachable within 1500 ms/);
  assert.match(partial.note, /not the same as gone/);
}

assert.strictEqual(short("sha256:1521dddb9ecbaa16"), "1521dddb");
console.log("ok project versions: stamping, drift, current/superseded, reachable-within-T");
