// RUN EVERY TEST FILE, THEN TALLY (builder#70).
//
// The `test` script was one `&&` chain, so the first red file hid every file
// after it: a flaky page test at position 25 meant the last five files never
// ran, and a run that stopped there read the same as one that finished. Each
// file now runs whatever happened before it, and the verdict comes at the end,
// with every file named.
//
// Sequential on purpose: the page tests each start a Chrome, and running them
// side by side on a loaded machine turns their timing waits into the thing
// under test.
import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("run-tests: no test files given — a run that checked nothing is not a pass");
  process.exit(1);
}
const results = [];
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [f], { stdio: "inherit" });
  results.push({ f, rc: r.status ?? (r.signal ? `signal ${r.signal}` : "?"), s: ((Date.now() - t0) / 1000).toFixed(1) });
}
const failed = results.filter(r => r.rc !== 0);
console.log(`\n── ${files.length} test files: ${files.length - failed.length} passed, ${failed.length} failed ──`);
for (const r of results) console.log(`  ${r.rc === 0 ? "ok  " : "FAIL"} ${r.f}  (${r.s} s${r.rc === 0 ? "" : `, rc ${r.rc}`})`);
process.exit(failed.length ? 1 : 0);
