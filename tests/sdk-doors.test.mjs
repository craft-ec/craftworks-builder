// THE BUILDER REACHES THE SDK'S PUBLISHING DOORS ONLY THROUGH THE SDK (ARCHITECTURE §19, app-as-data P5; the
// architect): the SDK DERIVES which of its wasm exports can reach a non-tree PUT -- a site write, a piece PUT -- and
// ships the list as sdk/doors.json (its tools/doors.mjs). The builder keeps NO list of its own: this scan reads that
// file and fails if any builder source or tools file calls one of those wasm doors directly. The one way to them is
// the SDK's own JS doors the same file names (`publishDefinition`, `repairPieces`).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackedFiles } from "./tracked-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

const path = join(root, "sdk/doors.json");
if (!existsSync(path)) { process.stdout.write("  FAIL sdk/doors.json is not there -- run ./build.sh (the SDK ships it)\n"); process.exit(1); }
const doors = JSON.parse(readFileSync(path, "utf8"));
/** The wasm doors the SDK derived, every kind: never called by the builder directly. */
const WASM = Object.values(doors).flatMap(k => (k && Array.isArray(k.wasm) ? k.wasm : []));

/** Lines of `text` that call one of the derived wasm doors (outside comments). */
export function directCalls(text, names = WASM) {
  return text.split("\n").filter(l => {
    const s = l.trim();
    if (s.startsWith("//") || s.startsWith("*")) return false;
    return names.some(n => new RegExp(`\\.${n}\\(`).test(l));
  });
}

await t("**THE SETUP: the SDK's derived doors are there** -- a site write and a piece PUT, each reached by its one JS door", () => {
  assert.ok(WASM.length >= 2, `sdk/doors.json names ${WASM.length} wasm doors: ${JSON.stringify(doors)}`);
  assert.deepEqual(doors.siteWrite?.js, ["engine-db.js:publishDefinition"], "the SDK's site-write door is not publishDefinition");
  assert.deepEqual(doors.piecePut?.js, ["pieces.js:repairPieces"], "the SDK's piece-PUT door is not repairPieces");
});

await t("**no builder source or tools file calls an SDK publishing door directly**", () => {
  const files = trackedFiles(root, { exts: ["js", "mjs", "html"], skip: ["tests/", "docs/", "sdk/"] });
  assert.ok(files.length > 20 && files.includes("app.js") && files.some(f => f.startsWith("tools/")), `the scan found only ${files.length} files`);
  const found = files.flatMap(f => directCalls(readFileSync(join(root, f), "utf8")).map(l => `${f}: ${l.trim()}`));
  assert.deepEqual(found, [], `a direct call of an SDK publishing door (go through publishDefinition / repairPieces):\n${found.join("\n")}`);
});

await t("THE CONTROL: a planted direct call of each derived door is caught; the SDK's JS doors and comments are not", () => {
  for (const n of WASM) assert.equal(directCalls(`  const k = session.${n}(a, b);`).length, 1, `a direct ${n}( was not caught`);
  for (const l of ["  await db.publishDefinition({ site });", "  repairPieces({ spec, bundle });", `  // session.${WASM[0]}( in a comment`]) {
    assert.equal(directCalls(l).length, 0, `caught wrongly: ${l}`);
  }
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
