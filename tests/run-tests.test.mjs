// THE RUNNER ITSELF (tools/run-tests.mjs; builder#70, builder#168): the directory is the one list of test files, found
// at ANY depth; a red file does not hide the files after it; a run that checked nothing is not a pass. Each claim with
// its control, over a scratch directory. (It replaces test-script-runs-everything, which compared a hand-written list
// against the directory: there is no list left to compare.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testFiles } from "../tools/run-tests.mjs";

const runner = fileURLToPath(new URL("../tools/run-tests.mjs", import.meta.url));
let failures = 0;
const t = (name, fn) => {
  try { fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};
const scratch = files => {
  const d = mkdtempSync(join(tmpdir(), "cw-runner-"));
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), body); }
  return d;
};
// The disk guard is not what this file tests (disk-guard-wired does): a guard that always finds room.
const run = d => spawnSync(process.execPath, [runner, d], { encoding: "utf8", env: { ...process.env, DISK_GUARD: "/usr/bin/true" } });

t("**a test file at ANY depth is found** (a subdirectory's too); control: fixtures and helpers are not", () => {
  const d = scratch({ "a.test.mjs": "", "b.test.cjs": "", "sub/deep/c.test.mjs": "", "fixtures/data.json": "", "page-host.mjs": "" });
  try {
    assert.deepEqual(testFiles(d).map(f => f.slice(d.length + 1)), ["a.test.mjs", "b.test.cjs", "sub/deep/c.test.mjs"]);
    const r = run(d);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS .*sub\/deep\/c\.test\.mjs/m, "the subdirectory's file did not RUN");
  } finally { rmSync(d, { recursive: true }); }
});

t("**a red file does not hide the files after it**: all run, exit 1, each named; control: all green exits 0", () => {
  const d = scratch({ "1.test.mjs": "process.exit(3)", "2.test.mjs": "console.log('second ran')", "z/3.test.mjs": "console.log('third ran')" });
  const ok = scratch({ "1.test.mjs": "", "2.test.mjs": "" });
  try {
    const r = run(d);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes("second ran") && r.stdout.includes("third ran"), r.stdout);
    assert.match(r.stdout, /3 test files: 2 passed, 1 failed/);
    assert.match(r.stdout, /^FAILED .*1\.test\.mjs.*rc 3/m, "a red file's line must match the review grep FAILED|panicked|REFUSED");
    assert.equal(run(ok).status, 0, "THE CONTROL");
  } finally { rmSync(d, { recursive: true }); rmSync(ok, { recursive: true }); }
});

t("**no test files is a refusal**, never a pass; the tally never prints a test's `  ok ` marker", () => {
  const d = scratch({ "readme.md": "" });
  try {
    const r = run(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no test files/);
  } finally { rmSync(d, { recursive: true }); }
  const one = scratch({ "x.test.mjs": "" });
  try { assert.doesNotMatch(run(one).stdout, /^ {2}ok /m, "the tally printed a test's own count marker"); }
  finally { rmSync(one, { recursive: true }); }
});

t("**`npm test` names no files**: the directory is the one list (no second list in package.json)", () => {
  const script = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).scripts.test;
  assert.equal(script, "node tools/run-tests.mjs", `the test script lists files again: ${script}`);
});

process.stdout.write(failures ? `run-tests: ${failures} FAILED\n` : "run-tests: all ok\n");
process.exit(failures ? 1 : 0);
