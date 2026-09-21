// EVERY TEST FILE ON DISK IS ACTUALLY RUN.
//
// The `test` script is a hand-maintained LIST, and a list is the thing two
// branches conflict on. Resolving that conflict means re-typing it, and a
// dropped entry is a test that silently stops running — no error, no missing
// file, just a suite that got quieter.
//
// It has already cost two merges. And the arithmetic used to check one of
// them was itself wrong: `grep -o 'tests/[a-z-]*\.test\.mjs'` excludes digits,
// so it silently dropped `tests/e2e.test.mjs` and the union came out short.
// A check whose own pattern can miss a file is not a check.
//
// So this compares the script against the DIRECTORY, in both directions, and
// needs no count to be right:
//
//   * ORPHAN  — a file on disk that nothing runs. The failure this exists for.
//   * PHANTOM — a name in the script with no file. Fails loudly today, but
//               after a rename it fails as "cannot find module" in CI rather
//               than here, where the cause is obvious.
//
// Both directions, because a resolution that drops one entry and invents
// another has the right COUNT.
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = p => fileURLToPath(new URL(p, import.meta.url));
const script = JSON.parse(readFileSync(at("../package.json"), "utf8")).scripts.test;

// DIGITS AND DOTS INCLUDED. The pattern that missed `e2e` did not have them.
const named = script.match(/tests\/[A-Za-z0-9._-]+\.test\.(?:mjs|cjs)/g) ?? [];
const disk = readdirSync(at("../tests"))
  .filter(f => /\.test\.(mjs|cjs)$/.test(f))
  .map(f => `tests/${f}`)
  .sort();

let failures = 0;
const t = (name, fn) => {
  try { fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

t("**every test file on disk is named in the test script**", () => {
  const orphans = disk.filter(f => !named.includes(f));
  assert.deepStrictEqual(orphans, [],
    `these exist and are never run: ${orphans.join(", ")}. A merge that re-typed the ` +
    "test list dropped them, and nothing else would ever say so.");
});

t("every name in the test script exists on disk", () => {
  const phantoms = named.filter(f => !disk.includes(f));
  assert.deepStrictEqual(phantoms, [],
    `named but missing: ${phantoms.join(", ")}. After a rename this fails in CI as ` +
    "\"cannot find module\", which does not name the list as the cause.");
});

t("no file is named twice", () => {
  const dupes = [...new Set(named.filter(f => named.filter(x => x === f).length > 1))];
  assert.deepStrictEqual(dupes, [],
    `named more than once: ${dupes.join(", ")} — a merge that kept both sides`);
});

t("THE CONTROL: the reader finds files and names, not nothing", () => {
  // Without this, a regex that matched nothing would report perfect agreement
  // between two empty lists — which is exactly the failure that produced the
  // wrong union count in the first place.
  assert.ok(named.length >= 10, `only ${named.length} names parsed out of the test script`);
  assert.ok(disk.length >= 10, `only ${disk.length} test files found on disk`);
  assert.ok(named.includes("tests/e2e.test.mjs"),
    "the reader cannot see tests/e2e.test.mjs — the exact file the previous check's " +
    "pattern dropped, because it excluded digits");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok test script\n");
process.exit(failures ? 1 : 0);
