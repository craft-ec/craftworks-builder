// THE CONTROL (the owner, 2026-09-23: "provide me solution, control so that
// things won't happen"): the builder FETCHES only through the SDK's one fetch
// (`served`, via builder-files.js) and CHECKS ids only through the SDK's rules
// (`sdk.ids`). A `fetch(` or a validation regex anywhere else in the builder's
// own code fails this test, so a new copy cannot merge.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "sdk", "tests", ".git", "docs", ".sdk-build", "tools"]);

// THE EXCEPTIONS, printed on every run so one added is never silent. Each names
// why, and each is removed by the work it names.
const EXEMPT = {
  "local-db.js": "the builder's OWN local store's record-id rule (never an SDK id)",
  "package-app.js": "checks the SDK's manifest shape: moves to the SDK's one manifest reader (next SDK PR)",
  "projects.js": "a 64-hex id's slot: moves to sdk.ids with the manifest reader (next SDK PR)",
  "versions-panel.js": "build-info.json needs no-store: moves to served() once it takes fetch options (next SDK PR)",
};

/** Lines that fetch or validate by hand. */
function copies(text) {
  return text.split("\n").filter(l => !l.trim().startsWith("//") && (/\bfetch\w*\(/.test(l) || /\/\^\[/.test(l)));
}

function files(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (!SKIP.has(n) && !n.startsWith(".")) files(p, out); }
    else if (/\.m?js$/.test(n)) out.push(p);
  }
  return out;
}

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

await t("**no fetch( and no validation regex in the builder's own code outside the named exceptions**", () => {
  const all = files(root);
  assert.ok(all.length > 20, `the scan found only ${all.length} files: it is not looking at the builder`);
  process.stdout.write(`      exceptions: ${Object.entries(EXEMPT).map(([f, why]) => `${f} (${why})`).join("; ")}\n`);
  const found = all.flatMap(f => {
    const rel = relative(root, f);
    return EXEMPT[rel] ? [] : copies(readFileSync(f, "utf8")).map(l => `${rel}: ${l.trim()}`);
  });
  assert.deepEqual(found, [], `fetch or validate through the SDK (served / sdk.ids):\n${found.join("\n")}`);
});

await t("the detector's control: each shape is caught; the calls it points to are not", () => {
  for (const l of ['  const r = await fetch(`./${f}`);', "  await fetchWith(u)", '  if (!/^[a-z0-9_-]{1,32}$/.test(id)) {']) assert.equal(copies(l).length, 1, l);
  for (const l of ['  await servedText({ url: "./a" })', "  sdk.ids.app(id)", "  // fetch( in a comment"]) assert.equal(copies(l).length, 0, l);
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
