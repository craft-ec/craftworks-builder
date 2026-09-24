// THE RUNNER ITSELF: a red file does not hide the files after it, and a run
// that checked nothing is not a pass (builder#70).
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../tools/run-tests.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "cw-runner-"));
const file = (name, body) => { const p = join(dir, name); writeFileSync(p, body); return p; };
// The disk guard is not what this file tests (disk-guard-wired does): a guard
// that always finds room.
const run = files => spawnSync(process.execPath, [runner, ...files], { encoding: "utf8", env: { ...process.env, DISK_GUARD: "/usr/bin/true" } });

const red = file("red.test.mjs", "process.exit(3);");
const after = file("after.test.mjs", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(dir, "ran"))}, "yes");`);
const r = run([red, after]);
assert.strictEqual(r.status, 1, "a run with a red file did not fail");
assert.ok(existsSync(join(dir, "ran")), "the file after the red one never ran — the chain hid it");
assert.match(r.stdout, /1 passed, 1 failed/);
assert.match(r.stdout, /FAIL .*red\.test\.mjs.*rc 3/);
process.stdout.write("ok a red file does not hide the files after it, and the tally names it\n");

const none = run([]);
assert.strictEqual(none.status, 1, "a run of zero files passed");
process.stdout.write("ok a run that checked nothing is not a pass\n");

const green = run([after]);
assert.strictEqual(green.status, 0, "CONTROL: an all-green run failed");
process.stdout.write("ok CONTROL: an all-green run passes\n");

