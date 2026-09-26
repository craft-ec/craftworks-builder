// A ROW IS JUDGED BY ITS RECORD, NEVER ITS TEXT (tools/row-judge.mjs, builder#172). The page scripts run here over a
// stand-in document (rows with a first cell and a chip carrying `data-row-state`) with the REAL SDK's rowSaved /
// rowBackedUp on `globalThis.__craftworks`, as the runtime puts them there. The control the issue names: a row
// TITLED "saved" whose record is not saved must NOT pass; a row that is saved passes.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSdk } from "../sdk-loader.js";
import { ROWS, backedUp, savedRow } from "../tools/row-judge.mjs";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
let failures = 0;
const t = async (name, f) => {
  try { await f(); process.stdout.write(`  ok  ${name}\n`); } catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

/** A stand-in page: `rows` as [title, record state code, the chip's WORDS]; a script is evaluated against it. */
function page(rows) {
  const tr = ([title, code, words]) => ({
    textContent: `${title} ${words}`,
    querySelector: sel => (sel === "td" ? { textContent: title } : sel === ".rt-state" ? { textContent: words, dataset: { rowState: code } } : null),
  });
  const doc = { querySelectorAll: sel => (sel === "tbody tr" ? rows.map(tr) : []) };
  return script => new Function("document", "globalThis", script)(doc, { __craftworks: { rowSaved: sdk.rowSaved, rowBackedUp: sdk.rowBackedUp } });
}

const CLEAN = sdk.rowStates().find(c => sdk.rowSaved(c) && !sdk.rowBackedUp(c));
const BACKED = sdk.rowStates().find(c => sdk.rowBackedUp(c));
const UNSAVED = sdk.rowStates().find(c => !sdk.rowSaved(c));

await t("THE SETUP: the SDK names a saved, a backed-up and an unsaved code", () => {
  assert.ok(CLEAN && BACKED && UNSAVED, JSON.stringify(sdk.rowStates()));
});

await t("**a row TITLED \"saved\" whose record is NOT saved does not pass**; control: a saved row does", () => {
  const run = page([["saved", UNSAVED, "saving"], ["real", CLEAN, "saved"]]);
  assert.equal(run(savedRow("document", "saved")), null, "a title passed as a state");
  assert.equal(run(savedRow("document", "real")), true, "THE CONTROL: a saved row did not pass");
});

await t("**the chip's WORDS decide nothing**: a chip reading \"saved + backed up\" over an unsaved record is neither", () => {
  const rows = page([["alpha", UNSAVED, "saved + backed up"]])(ROWS);
  assert.deepEqual(rows, [{ cell: "alpha", code: UNSAVED, saved: false, backedUp: false }]);
});

await t("**BACKED_UP by record**: only the backed-up record passes; a missing title and an empty list do not", () => {
  const rows = page([["alpha", BACKED, "anything"], ["beta", CLEAN, "saved + backed up"]])(ROWS);
  assert.equal(backedUp(rows, ["alpha"]), true);
  assert.equal(backedUp(rows, ["beta"]), false, "a saved-not-backed-up record passed");
  assert.equal(backedUp(rows, ["gamma"]), false, "a title with no row passed");
  assert.throws(() => backedUp(rows, []), /no row named/);
});

await t("**ONE HOME**: no tool judges \"saved\" from WORDS (a row's text or a chip's), only row-judge.mjs reads a row's state; control: a planted text check is caught", () => {
  const judgesByWords = src => /includes\("saved"\)|===\s*"saved( \+ backed up)?"/.test(src.replace(/\/\/.*$/gm, ""));
  const tools = new URL("../tools/", import.meta.url);
  const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".mjs") ? [join(d, e.name)] : []));
  const files = walk(fileURLToPath(tools));
  assert.ok(files.length > 10 && files.some(f => f.endsWith("realnet-demo.mjs")), "THE SETUP: the scan found no tools");
  const offenders = files.filter(f => !f.endsWith("row-judge.mjs") && judgesByWords(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, [], "a tool judges a row by its words");
  assert.ok(judgesByWords(`tr.textContent.includes("saved")`) && judgesByWords(`x.textContent === "saved + backed up"`), "THE CONTROL: a planted text check was not caught");
});

process.stdout.write(failures ? `row-judge: ${failures} FAILED\n` : "row-judge: all ok\n");
process.exit(failures ? 1 : 0);
