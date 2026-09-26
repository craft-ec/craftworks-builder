// `npm test`: RUN EVERY TEST FILE THAT EXISTS, THEN TALLY (builder#70, builder#168).
//
// The DIRECTORY is the ONE list of test files (CLAUDE.md "Structure before code": one list, read by everyone; the SDK's
// runner is the same shape, sdk#496). The `test` script used to hand this runner a hand-written list -- a second list,
// guarded by a test that compared the two: a new file had to be typed into package.json or it never ran, and a merge
// resolving that list could drop one silently. Now every `*.test.{mjs,cjs,js}` under tests/ (or the directory given),
// at ANY depth, runs because it exists, in path order.
//
// The first red file does not hide the files after it: each file runs whatever happened before it, and the verdict
// comes at the end with every file named. Sequential on purpose: the page tests each start a Chrome, and running them
// side by side on a loaded machine turns their timing waits into the thing under test.
//
// The tally prints PASS/FAILED, never "  ok " (a test's own count marker) and never a bare "FAIL" (every review grep
// is `FAILED|panicked|REFUSED`).
import { spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_FILE = /\.test\.(mjs|cjs|js)$/;

/** Every test file under `dir`, at any depth, sorted by path. */
export function testFiles(dir) {
  const out = [];
  const walk = d => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (TEST_FILE.test(f)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = process.argv[2] ?? join(root, "tests");
  const files = testFiles(dir);
  if (files.length === 0) {
    console.error(`run-tests: no test files under ${dir}: a run that checked nothing is not a pass`);
    process.exit(1);
  }
  // THE DISK GUARD (sdk#361), before any test starts a node or a browser: a run that starts short of space fails late
  // and misleads. The SDK owns the one copy; no guard to run is a refusal, never a skip. Exit 1 refused, 2 could not
  // check: both stop the run.
  const guard = process.env.DISK_GUARD ?? resolve(root, process.env.CRAFTWORKS_SDK ?? "../craftworks-sdk", "scripts/disk-guard.sh");
  try {
    accessSync(guard, constants.X_OK);
  } catch {
    console.error(`no disk guard at ${guard} -- cannot check the disk, and will not skip it`);
    process.exit(1);
  }
  if (spawnSync(guard, ["the builder test run"], { stdio: "inherit" }).status !== 0) process.exit(1);
  const results = [];
  for (const f of files) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [f], { stdio: "inherit" });
    results.push({ f: relative(process.cwd(), f), rc: r.status ?? (r.signal ? `signal ${r.signal}` : "?"), s: ((Date.now() - t0) / 1000).toFixed(1) });
  }
  const failed = results.filter(r => r.rc !== 0);
  console.log(`\n── ${files.length} test files: ${files.length - failed.length} passed, ${failed.length} failed ──`);
  for (const r of results) console.log(`${r.rc === 0 ? "PASS" : "FAILED"} ${r.f}  (${r.s} s${r.rc === 0 ? "" : `, rc ${r.rc}`})`);
  process.exit(failed.length ? 1 : 0);
}
