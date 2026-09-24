// THE CONTROL (the owner, 2026-09-23: "provide me solution, control so that
// things won't happen"): the builder FETCHES only through the SDK's one fetch
// (`served`, via builder-files.js) and CHECKS ids only through the SDK's rules
// (`sdk.ids`). A `fetch(` or a validation regex anywhere else in the builder's
// own code fails this test, so a new copy cannot merge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trackedFiles } from "./tracked-files.mjs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// The builder's own code: what git TRACKS (tests/tracked-files.mjs), less the
// tests themselves and docs (no JavaScript); dependencies, the SDK's copied
// files and build output are not tracked. tools/ IS scanned.
const SKIP = ["tests/", "docs/", "sdk/"];

// THE EXCEPTIONS, printed on every run so one added is never silent: each file
// with the EXACT number of such lines it may hold and why. A second copy in an
// excepted file is still red. Each is removed by the work it names.
const EXEMPT = {
  "local-db.js": [1, "the builder's OWN local store's record-id rule (never an SDK id)"],
};

/** What the scan finds wrong in one file: every copy, or for an excepted one a count other than its own. */
function wrong(rel, text) {
  const found = copies(text);
  const [allowed] = EXEMPT[rel] ?? [0];
  if (found.length === allowed) return [];
  return EXEMPT[rel] ? [`${rel}: ${found.length} lines, ${allowed} excepted:\n    ${found.map(l => l.trim()).join("\n    ")}`] : found.map(l => `${rel}: ${l.trim()}`);
}

/** Lines that fetch or validate by hand. */
function copies(text) {
  return text.split("\n").filter(l => !l.trim().startsWith("//") && (/\bfetch\w*\(/.test(l) || /\/\^\[/.test(l)));
}


let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

await t("**no fetch( and no validation regex in the builder's own code outside the named exceptions**", () => {
  const all = trackedFiles(root, { skip: SKIP }).map(f => join(root, f));
  assert.ok(all.length > 20, `the scan found only ${all.length} files: it is not looking at the builder`);
  process.stdout.write(`      exceptions: ${Object.entries(EXEMPT).map(([f, [n, why]]) => `${f} ×${n} (${why})`).join("; ")}\n`);
  const found = all.flatMap(f => wrong(relative(root, f), readFileSync(f, "utf8")));
  assert.deepEqual(found, [], `fetch or validate through the SDK (served / sdk.ids):\n${found.join("\n")}`);
});

await t("the detector's control: each shape is caught; the calls it points to are not", () => {
  for (const l of ['  const r = await fetch(`./${f}`);', "  await fetchWith(u)", '  if (!/^[a-z0-9_-]{1,32}$/.test(id)) {']) assert.equal(copies(l).length, 1, l);
  for (const l of ['  await servedText({ url: "./a" })', "  sdk.ids.app(id)", "  // fetch( in a comment"]) assert.equal(copies(l).length, 0, l);
  // An excepted file: its own count passes, ONE MORE copy in it is red.
  const one = '  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {';
  assert.deepEqual(wrong("local-db.js", one), []);
  assert.equal(wrong("local-db.js", `${one}\n  const r = await fetch("./x");`).length, 1, "a second copy in an excepted file passed");
  assert.equal(wrong("app.js", one).length, 1, "a copy in a file with no exception passed");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
