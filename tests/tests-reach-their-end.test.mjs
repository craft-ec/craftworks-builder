// EVERY TEST IN A FILE RUNS (main, after craftworks-sdk#408): no test sits after its file's exit, and no file ends
// twice. The rule is tools/tests-reach-end.mjs; this applies it to every tests/*.mjs, and its CONTROLS are files
// written here (a committed bad fixture would be a finding of the rule itself).
import assert from "node:assert";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findings } from "../tools/tests-reach-end.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const files = readdirSync(here).filter(f => f.endsWith(".mjs")).map(f => join(here, f));
assert.ok(files.length > 20, `THE SETUP: only ${files.length} test files found`);
const all = files.flatMap(f => findings(f));
assert.deepStrictEqual(all, [], `tests that never run:\n  ${all.join("\n  ")}`);
process.stdout.write(`ok no test after its file's exit, no file ending twice (${files.length} files)\n`);

// THE CONTROLS: the rule sees each case.
const dir = mkdtempSync(join(tmpdir(), "cw-reach-end-"));
const fixture = (name, body) => { const p = join(dir, name); writeFileSync(p, body); return p; };
const after = fixture("after.test.mjs", `await t("runs", async () => {});\nprocess.stdout.write("ok\\n");\nprocess.exit(0);\n\nawait t("never runs", async () => {});\n`);
const found = findings(after);
assert.strictEqual(found.length, 1, `THE CONTROL: a test after the exit was not found: ${found}`);
assert.match(found[0], /after\.test\.mjs:5: a test AFTER the file's exit \(line 3\)/);
const twice = fixture("twice.test.mjs", `process.exit(0);\nprocess.exit(1);\n`);
assert.match(findings(twice).join("\n"), /twice\.test\.mjs:2: a second top-level process\.exit/, "THE CONTROL: a file ending twice was not found");
const guarded = fixture("guarded.test.mjs", `if (!ready) { process.exit(1); }\nawait t("runs", async () => {});\nprocess.exit(0);\n`);
assert.deepStrictEqual(findings(guarded), [], "THE CONTROL: a guarded setup exit was taken for the file's end");
process.stdout.write("ok the controls: a test after the exit, a second exit, and a guarded setup exit are each told apart\n");
