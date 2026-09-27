// ONE OWNER FOR THE RESERVED NAMES (the architect on builder#191): `craftworks.*` is the SDK's (sdk#547:
// SystemDomain, refused by type to every ordinary write, reached only through its doors). The builder's SHIPPED code
// never spells one -- no `"craftworks.published"`, no `"craftworks.app"` -- so a second copy of the SDK's name cannot
// merge. Comments may name them. Tests, tools and docs are not shipped and are not scanned.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackedFiles } from "./tracked-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = ["tests/", "tools/", "docs/", "sdk/"];

/** Lines that spell a reserved name as a string, outside comments. */
export function spelled(text) {
  return text.split("\n").filter(l => {
    const s = l.trim();
    if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) return false;
    return /["'`]craftworks\.[a-z]/.test(l);
  });
}

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

await t("**the builder's shipped code spells no reserved `craftworks.` name**: the SDK's doors are the only way to them", () => {
  const files = trackedFiles(root, { exts: ["js", "mjs", "html"], skip: SKIP });
  assert.ok(files.length > 20 && files.includes("handoff.js"), `the scan found only ${files.length} files: it is not looking at the builder`);
  const found = files.flatMap(f => spelled(readFileSync(join(root, f), "utf8")).map(l => `${f}: ${l.trim()}`));
  assert.deepEqual(found, [], `a second copy of the SDK's reserved name:\n${found.join("\n")}`);
});

await t("the scan's control: a planted name is caught in every quote; comments and look-alikes are not", () => {
  for (const l of ['export const PUBLISHED_DOMAIN = "craftworks.published";', "  target.get('craftworks.app', id)", "  const d = `craftworks.draft`;"]) {
    assert.equal(spelled(l).length, 1, `not caught: ${l}`);
  }
  for (const l of ["// markers live in `craftworks.published` (the SDK's)", " * `craftworks.*` is refused by type", '  import x from "./craftworks-sdk.js";']) {
    assert.equal(spelled(l).length, 0, `caught wrongly: ${l}`);
  }
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
