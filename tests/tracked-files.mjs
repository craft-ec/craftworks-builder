// THE FILES A CODE CONTROL SCANS: those git TRACKS (the core dev's ruling,
// with craftworks-sdk's dup-gate). A control over the builder's code —
// one-home (no fetch( or validation regex outside the SDK's) and the one CDP
// connection — looks at the code IN the repo, never a walk of the tree: a
// killed run's leftovers in an ignored or scratch dir made a control cry wolf,
// and a copy nobody tracks cannot ship anyway. ONE lister for every such
// control, so no two of them can disagree on what "the builder's code" is.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The tracked files under `root` with one of `exts`, as paths relative to it,
 * leaving out any under a `skip` prefix or a dot-directory. Throws when git
 * cannot list them or lists none: a scan of nothing is never a clean scan.
 */
export function trackedFiles(root, { exts = ["js", "mjs"], skip = [] } = {}) {
  let listed;
  try {
    listed = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`git could not list the tracked files under ${root} (${String(e.stderr ?? e.message).trim().split("\n")[0]})`);
  }
  const files = listed.split("\0").filter(f =>
    f && exts.includes(f.split(".").pop()) && !skip.some(s => f.startsWith(s)) && !f.split("/").slice(0, -1).some(d => d.startsWith(".")) && existsSync(join(root, f)));
  if (!files.length) throw new Error(`git tracks no ${exts.join("/")} file under ${root}`);
  return files;
}
