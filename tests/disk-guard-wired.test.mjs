// THE DISK GUARD IS ASKED FIRST (sdk#361): the test runner and the realnet run
// each run the SDK's disk-guard.sh before anything else, stop on its refusal
// (exit 1) and on could-not-check (exit 2), and REFUSE when there is no guard
// to run -- a missing guard is never a skip. The guard is a stub here
// (DISK_GUARD), so nothing measures this machine's disk, and nothing here
// reaches a node or the network: the realnet run stops at a held lock.
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownTmp } from "./page-host.mjs";

const dir = ownTmp("disk-guard-");
const runner = fileURLToPath(new URL("../tools/run-tests.mjs", import.meta.url));
const realnet = fileURLToPath(new URL("../tools/realnet.sh", import.meta.url));
// A stub guard: records what it was asked about, then exits `rc`.
const stub = rc => {
  const p = join(dir, `guard-${rc}.sh`);
  writeFileSync(p, `#!/bin/sh\necho "$1" >> ${JSON.stringify(join(dir, "asked"))}\nexit ${rc}\n`);
  chmodSync(p, 0o755);
  return p;
};
const asked = () => (existsSync(join(dir, "asked")) ? readFileSync(join(dir, "asked"), "utf8") : "");
const missing = join(dir, "no-such-guard.sh");
const marker = join(dir, "ran");
const file = join(dir, "marks.test.mjs");
writeFileSync(file, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "yes");`);

const holder = spawn("sleep", ["60"]);
try {
  // ---- the test runner ------------------------------------------------------
  const tests = guard => {
    rmSync(marker, { force: true });
    rmSync(join(dir, "asked"), { force: true });
    return spawnSync(process.execPath, [runner, file], { encoding: "utf8", env: { ...process.env, DISK_GUARD: guard } });
  };
  for (const rc of [1, 2]) {
    const r = tests(stub(rc));
    assert.strictEqual(r.status, 1, `the runner did not stop on the guard's exit ${rc}: ${r.stdout}${r.stderr}`);
    assert.ok(!existsSync(marker), `a test ran after the guard said ${rc}`);
    assert.match(asked(), /the builder test run/, "the guard was not asked");
  }
  console.log("ok the runner stops before any test when the guard refuses (1) or could not check (2)");
  const gone = tests(missing);
  assert.strictEqual(gone.status, 1, "a missing guard was skipped by the runner");
  assert.match(gone.stderr, /no disk guard at .*no-such-guard\.sh -- cannot check the disk, and will not skip it/);
  assert.ok(!existsSync(marker), "a test ran with no guard to ask");
  console.log("ok the runner refuses when there is no guard to run");
  const room = tests(stub(0));
  assert.strictEqual(room.status, 0, `CONTROL: the runner failed with room on the disk: ${room.stdout}${room.stderr}`);
  assert.ok(existsSync(marker), "CONTROL: with room, the test did not run");
  console.log("ok CONTROL: with room, the runner asks the guard and runs the tests");

  // ---- the realnet run: stops at a HELD lock, so it never builds or dials ----
  const LOCK = join(dir, "lock");
  mkdirSync(LOCK);
  writeFileSync(`${LOCK}/owner`, `pid=${holder.pid}\nbranch=disk-guard-test\n`);
  const run = guard => {
    rmSync(join(dir, "asked"), { force: true });
    return spawnSync("bash", [realnet], { encoding: "utf8", timeout: 20_000, env: { ...process.env, TMPDIR: dir, REALNET_LOCK: LOCK, REALNET_HOST: "nobody@127.0.0.1", DISK_GUARD: guard } });
  };
  for (const rc of [1, 2]) {
    const r = run(stub(rc));
    assert.strictEqual(r.status, 1, `realnet did not stop on the guard's exit ${rc}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /another real-network run holds/, "realnet reached the lock after the guard refused");
    assert.match(asked(), /the builder realnet run/, "the guard was not asked");
  }
  console.log("ok realnet stops before the lock when the guard refuses (1) or could not check (2)");
  const none = run(missing);
  assert.strictEqual(none.status, 1, "a missing guard was skipped by realnet");
  assert.match(none.stderr, /no disk guard at .*no-such-guard\.sh -- cannot check the disk, and will not skip it/);
  assert.doesNotMatch(none.stdout, /another real-network run holds/);
  console.log("ok realnet refuses when there is no guard to run");
  const ok = run(stub(0));
  assert.strictEqual(ok.status, 3, `CONTROL: with room, realnet did not go on to the lock (exit ${ok.status}): ${ok.stdout}${ok.stderr}`);
  assert.match(ok.stdout, /REFUSED {2}another real-network run holds .*branch=disk-guard-test/);
  console.log("ok CONTROL: with room, realnet asks the guard and goes on to the lock");
  assert.strictEqual(readFileSync(`${LOCK}/owner`, "utf8"), `pid=${holder.pid}\nbranch=disk-guard-test\n`, "a run touched the held lock");
} finally {
  holder.kill();
  rmSync(dir, { recursive: true, force: true });
}
