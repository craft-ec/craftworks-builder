#!/usr/bin/env node
// THE MACHINE CHECKS, from the SDK the builder pins (builder#120).
//
// craftworks-sdk owns ONE copy of each check (tools/dup-gate.mjs: a new
// duplicate block; tools/owners.mjs: a branch crossing owners without a
// `shared:` line). The builder does not copy them -- a copy would be the
// defect the first one looks for. It takes both from the SDK repository at
// SDK_REV, the revision it already pins, and runs them over THIS tree with
// its own dup-gate.json, dup-baseline.json and OWNERS.
//
// Exit 0: both pass. Otherwise the first failing check's code; 2 = could not
// check (no SDK repo, or SDK_REV has no such tool): a failure, not a pass.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rev = readFileSync(join(root, "SDK_REV"), "utf8").trim();
const sdk = resolve(root, process.env.CRAFTWORKS_SDK ?? "../craftworks-sdk");
const dir = mkdtempSync(join(tmpdir(), "machine-checks-"));
let worst = 0;
try {
  for (const tool of ["dup-gate.mjs", "owners.mjs"]) {
    let text;
    try {
      text = execFileSync("git", ["-C", sdk, "show", `${rev}:tools/${tool}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      console.log(`machine-checks: COULD NOT CHECK — craftworks-sdk at SDK_REV ${rev.slice(0, 12)} (${sdk}) has no tools/${tool} (it arrived with craftworks-sdk#320)`);
      worst = worst || 2;
      continue;
    }
    writeFileSync(join(dir, tool), text);
    const r = spawnSync(process.execPath, [join(dir, tool), "--root", root], { stdio: "inherit" });
    if (r.status !== 0) worst = worst || (r.status ?? 2);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(worst);
