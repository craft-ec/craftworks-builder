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

// NOTHING RUNS AFTER THE EXIT. A test file ends with an unconditional,
// top-level `process.exit(…)`; a test written BELOW it is never executed, and
// the file still says "all passing". Three app-id tests of builder#109 sat
// there, and the one about a refused publication hid a real defect (it had
// PUT four containers before refusing). So: after a line that BEGINS with
// `process.exit(` — top level, unconditional — only blank lines and comments
// may follow. A GUARDED exit (`if (!KEY) { … process.exit(1); }`) does not
// begin its line with it, and is not one.
export function codeAfterExit(text) {
  const lines = text.split("\n");
  const at = lines.findIndex(l => /^process\.exit\(/.test(l));
  if (at < 0) return [];
  return lines.slice(at + 1)
    .map((l, i) => ({ line: at + 2 + i, text: l }))
    .filter(({ text }) => text.trim() !== "" && !/^\s*\/\//.test(text));
}

t("**no test file has code after its unconditional exit** — it would never run", () => {
  const dead = disk
    .map(f => ({ f, after: codeAfterExit(readFileSync(at(`../${f}`), "utf8")) }))
    .filter(x => x.after.length > 0)
    .map(x => `${x.f}:${x.after[0].line} (${x.after.length} line(s), first: ${x.after[0].text.trim().slice(0, 60)})`);
  assert.deepStrictEqual(dead, [], `code after the exit, never run: ${dead.join("; ")}`);
});

t("THE CONTROL: a test after the exit is caught; a guarded exit and trailing comments are not", () => {
  const deadFile = 'await t("a", () => {});\nprocess.exit(failures ? 1 : 0);\n\nawait t("never runs", () => {});\n';
  assert.deepStrictEqual(codeAfterExit(deadFile).map(x => x.line), [4], "a test after the exit was not caught");
  const guarded = 'if (!KEY) { process.stdout.write("no"); process.exit(1); }\nawait t("runs", () => {});\nprocess.exit(failures ? 1 : 0);\n// a closing note\n\n';
  assert.deepStrictEqual(codeAfterExit(guarded), [], "a guarded exit or a trailing comment was taken for dead code");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok test script\n");
process.exit(failures ? 1 : 0);
