import assert from "node:assert";
import { COMPONENTS, validateComponent, mapping, treeView } from "../catalogue.js";

// Every component carries a complete mapping.
for (const c of COMPONENTS) assert.deepStrictEqual(validateComponent(c), [], `${c.type}`);
assert.ok(COMPONENTS.length >= 10);

// Negative controls: the validator must refuse what it exists to refuse.
const good = COMPONENTS[0];
assert.ok(validateComponent({ ...good, keys: ["x/nowhere"] }).some(e => e.includes("outside the keyspace")));
assert.ok(validateComponent({ ...good, keys: [] }).includes("no key patterns"));
assert.ok(validateComponent({ ...good, schema: "spreadsheet" }).some(e => e.includes("unknown schema")));
assert.ok(validateComponent({ ...good, sets: ["inbox(x)"] }).some(e => e.includes("does not list the Set contract")));
assert.ok(validateComponent({ ...good, note: "" }).includes("missing note"));

// Mapping fills the domain in.
const m = mapping({ type: "comments", domain: "posts", mode: "owned" });
assert.deepStrictEqual(m.keys, ["d/posts/<rkey>", "e/annotates/<comment>/<target>"]);
assert.deepStrictEqual(m.sets, ["inbox(<target>, posts, <day>)"]);
assert.match(m.writes, /Set the target owns/);

// The mode decides where records live: shared data is in a Set, not in your tree.
const owned = mapping({ type: "list", domain: "notes", mode: "owned" });
assert.deepStrictEqual([owned.keys, owned.sets], [["d/notes/<rkey>"], []]);
const shared = mapping({ type: "list", domain: "notes", mode: "shared" });
assert.deepStrictEqual([shared.keys, shared.sets], [[], ["shared(<owner>, notes)"]]);
assert.ok(shared.contracts.includes("Set") && /Set/.test(shared.writes));
assert.strictEqual(mapping({ type: "list", domain: "n", mode: "bogus" }).modeName, "owned"); // unknown mode → default

// Tree view: two components on one domain share a path; Sets are listed apart.
const app = { components: [
  { type: "table", domain: "tasks", mode: "owned" },
  { type: "form", domain: "tasks", mode: "owned" },
  { type: "votes", domain: "tasks", mode: "owned" },
] };
const t = treeView(app);
assert.deepStrictEqual(t.ranges.d["d/tasks/<rkey>"], [0, 1]);
assert.deepStrictEqual(t.ranges.e["e/votes/<me>/<target>"], [2]);
assert.deepStrictEqual(t.sets["tally(<target>, votes)"], [2]);
assert.deepStrictEqual(treeView({ components: [] }), { ranges: {}, sets: {} });
console.log(`ok catalogue: ${COMPONENTS.length} components mapped`);
