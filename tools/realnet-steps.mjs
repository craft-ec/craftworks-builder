#!/usr/bin/env node
// THE REAL-NETWORK STEPS, by name (the owner's rule 0: merge and iterate -- a real-network run tests ONLY the step
// that changed). ONE table: realnet.sh asks it which private nodes to start, and realnet-demo.mjs asks it which steps
// to run. `--only lose-data` runs that step AND the setup it needs (its `needs`, closed over), in the demo's order,
// and nothing else.
//
// `nodes`: the private nodes of the run a step uses beyond B and A (always there): V (the user who writes), O (the
// same-key pair O1/O2), LOSE (the ws-lose proxies in front of V).
//
// CLI: `node tools/realnet-steps.mjs [a,b,...]` prints `steps <ordered names>` and `nodes <names>`; an unknown name
// exits 2, naming the known ones. No names = every step.

/** In the demo's ORDER. */
export const STEPS = {
  "publish":        { needs: [],                     nodes: [],            what: "the builder publishes on B" },
  "view":           { needs: ["publish"],            nodes: [],            what: "A opens it by address, as a view" },
  "owner-site":     { needs: ["publish"],            nodes: [],            what: "the owner's site on B opens editable" },
  "edits":          { needs: ["view", "owner-site"], nodes: [],            what: "add / edit / delete on B, each on A's open view" },
  "view-reload":    { needs: ["view"],               nodes: [],            what: "A reloaded reads the rows" },
  "builder-reopen": { needs: ["publish"],            nodes: [],            what: "the builder reloaded reopens connected" },
  "structure":      { needs: ["view"],               nodes: [],            what: "a structure change republishes at the same address; A reloaded shows it" },
  "same-key":       { needs: [],                     nodes: ["O"],         what: "same key on a second node: the site converges" },
  "user-writes":    { needs: ["view", "owner-site"], nodes: ["V"],         what: "a user writes their own tree on V" },
  "lose-data":      { needs: ["publish"],            nodes: ["V", "LOSE"], what: "V's node loses a group's blocks: rows still read at m, not at m + 1" },
};

/** The steps to run for `only` (a list, or a comma string; empty = all), with their setup, in order; and their nodes. */
export function plan(only = []) {
  const names = (Array.isArray(only) ? only : String(only).split(",")).map(s => s.trim()).filter(Boolean);
  const unknown = names.filter(n => !Object.hasOwn(STEPS, n));
  if (unknown.length) throw new Error(`no such real-network step: ${unknown.join(", ")} (the steps: ${Object.keys(STEPS).join(", ")})`);
  const want = new Set();
  const add = n => { if (want.has(n)) return; want.add(n); for (const d of STEPS[n].needs) add(d); };
  for (const n of names.length ? names : Object.keys(STEPS)) add(n);
  const steps = Object.keys(STEPS).filter(n => want.has(n));
  const nodes = [...new Set(steps.flatMap(n => STEPS[n].nodes))];
  return { steps, nodes, only: names };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const p = plan(process.argv[2] ?? "");
    console.log(`steps ${p.steps.join(",")}`);
    console.log(`nodes ${p.nodes.join(" ")}`);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
