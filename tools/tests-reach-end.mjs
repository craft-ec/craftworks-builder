// EVERY TEST IN A FILE RUNS: a test written after the file's own exit never runs, and says nothing.
//
// A test file here reports and exits at its end (`process.stdout.write(...)` then `process.exit(...)`). A test
// APPENDED below that line is dead code that looks like coverage: two tests added for craftworks-sdk#408 sat there,
// and their mutants SURVIVED until they were moved above it (main: a gate hole, not a one-off -- any PR that adds
// a test can hit it). So, per file:
// - at most ONE unconditional top-level `process.exit(` (a line that starts with it; an exit inside an `if`, a
//   setup check, is not the file's end);
// - NO test call (`t(` / `await t(` at the start of a line) after it.
// Each finding names the file and the line.
import { readFileSync } from "node:fs";

export function findings(path, text = readFileSync(path, "utf8")) {
  const lines = text.split("\n");
  const exits = lines.flatMap((l, i) => (/^process\.exit\(/.test(l) ? [i + 1] : []));
  const out = [];
  if (exits.length > 1) out.push(`${path}:${exits[1]}: a second top-level process.exit (the first is line ${exits[0]}): the file ends twice`);
  if (exits.length > 0) {
    const end = exits[exits.length - 1];
    lines.forEach((l, i) => {
      if (i + 1 > end && /^\s*(await\s+)?t\(/.test(l)) out.push(`${path}:${i + 1}: a test AFTER the file's exit (line ${end}): it never runs`);
    });
  }
  return out;
}
