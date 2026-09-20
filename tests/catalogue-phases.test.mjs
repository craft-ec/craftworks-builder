// Every component's phase, against the roadmap that defines it.
//
// The palette prints these numbers on disabled chips ("phase 4"), so a stale
// one is a promise to the person reading the screen about when their component
// arrives. They HAD all gone stale: a phase reorder moved identity, privacy,
// many-writer structures, files and discovery, and the catalogue kept the old
// numbers. Ten of the thirteen components were wrong, including five the
// review had not spotted.
//
// The table below is copied from ARCHITECTURE §21 "Build order", Builder
// column, which is the source. When the roadmap moves, this fails — which is
// the point: a number nothing checks is a number that drifts silently.
import assert from "node:assert";
import { COMPONENTS } from "../catalogue.js";

/** component → phase, and the §21 Builder-column phrase that fixes it. */
const ROADMAP = {
  table: [1, "table · form · list bound to a collection"],
  form: [1, "table · form · list bound to a collection"],
  list: [1, "table · form · list bound to a collection"],
  files: [5, "phase 5 files & media — demo only: uploader + player"],
  media: [5, "phase 5 files & media — demo only: uploader + player"],
  profile: [6, "phase 6 identity — demo only: a table over another identity's records"],
  vault: [7, "phase 7 privacy — capability lines, vault component, share dialog"],
  feed: [8, "phase 8 many-writer structures — demo only: a counter and an inbox list"],
  comments: [8, "phase 8 many-writer structures"],
  votes: [8, "phase 8 many-writer structures — tallies"],
  search: [10, "phase 10 discovery — directory · search widgets"],
  pay: [11, "phase 11 ledger — pay button · usage dashboard"],
  chat: [13, "phase 13 domain grammars — messaging"],
};

// Every component is in the table, and every table entry is a component: a
// component added without a roadmap phase would otherwise pass unnoticed,
// which is how these drifted in the first place.
const inCatalogue = COMPONENTS.map((c) => c.type).sort();
const inRoadmap = Object.keys(ROADMAP).sort();
assert.deepStrictEqual(
  inCatalogue,
  inRoadmap,
  "every component needs a roadmap phase, and every roadmap phase a component",
);

for (const c of COMPONENTS) {
  const [want, why] = ROADMAP[c.type];
  assert.strictEqual(
    c.phase,
    want,
    `${c.label} says phase ${c.phase}; ARCHITECTURE §21 puts it at ${want} (${why})`,
  );
}

// And the numbers must be phases that exist. §21 runs 0–14.
for (const c of COMPONENTS) {
  assert.ok(
    Number.isInteger(c.phase) && c.phase >= 0 && c.phase <= 14,
    `${c.label}: phase ${c.phase} is not one §21 defines`,
  );
}

console.log(`ok catalogue phases: ${COMPONENTS.length} components against ARCHITECTURE §21`);
