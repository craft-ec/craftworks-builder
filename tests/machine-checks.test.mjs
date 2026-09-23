// builder#120: the machine checks (craftworks-sdk tools/dup-gate.mjs and
// tools/owners.mjs, taken from SDK_REV) run over this tree and pass. A NEW
// duplicate block, or a branch crossing owners without `shared:`, is red here.
// Their controls (a planted copy is red, a crossing is red, "could not check"
// is red) live beside the tools, in craftworks-sdk.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const r = spawnSync(process.execPath, [fileURLToPath(new URL("../tools/machine-checks.mjs", import.meta.url))], { encoding: "utf8" });
process.stdout.write(r.stdout);
assert.match(r.stdout, /^dup-gate: .* over [1-9]\d* file/m, "the duplicate check did not report scanning anything");
assert.match(r.stdout, /^owners: /m, "the owners check did not report");
assert.equal(r.status, 0, `machine checks failed (exit ${r.status})`);
console.log("  ok  machine checks: no new duplicate, owners respected");
