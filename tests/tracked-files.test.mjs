// THE CODE CONTROLS SCAN WHAT GIT TRACKS (tests/tracked-files.mjs): in a
// planted repo, a tracked file is listed; one left UNTRACKED and one in an
// IGNORED dir (a killed run's leftovers) are not; a dir that is no checkout
// cannot be listed — a failure by name, never an empty scan.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackedFiles } from "./tracked-files.mjs";

let failures = 0;
const t = (name, fn) => {
  try { fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};
const dir = mkdtempSync(join(tmpdir(), "tracked-files-"));
const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
try {
  // THE SETUP: this temp dir is inside no checkout (or "no .git" below would list the outer repo).
  assert.notEqual(spawnSync("git", ["-C", dir, "rev-parse", "--git-dir"]).status, 0, "THE SETUP: the temp dir is inside a git checkout");

  t("**a dir that is no git checkout cannot be listed: it throws, naming it — never an empty scan**", () => {
    writeFileSync(join(dir, "a.mjs"), "export const a = 1;\n");
    assert.throws(() => trackedFiles(dir), /git could not list the tracked files/);
  });

  git("init", "-q");
  mkdirSync(join(dir, "tools"));
  mkdirSync(join(dir, "scratch"));
  writeFileSync(join(dir, ".gitignore"), "scratch/\n");
  writeFileSync(join(dir, "tools", "t.mjs"), "export const t = 1;\n");
  writeFileSync(join(dir, "docs.md"), "not code\n");
  git("add", "a.mjs", "tools/t.mjs", "docs.md", ".gitignore");
  writeFileSync(join(dir, "leftover.mjs"), "export const copy = 1;\n");
  writeFileSync(join(dir, "scratch", "copy.mjs"), "export const copy = 1;\n");

  t("**only TRACKED code is listed: an untracked leftover and a copy in an ignored dir are not**", () => {
    assert.deepEqual(trackedFiles(dir).sort(), ["a.mjs", "tools/t.mjs"]);
  });
  t("a skipped prefix is left out, and a tracked file becomes listed the moment it is tracked", () => {
    assert.deepEqual(trackedFiles(dir, { skip: ["tools/"] }), ["a.mjs"]);
    git("add", "leftover.mjs");
    assert.deepEqual(trackedFiles(dir).sort(), ["a.mjs", "leftover.mjs", "tools/t.mjs"]);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
