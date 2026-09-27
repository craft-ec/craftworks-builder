// A ROW IS JUDGED BY ITS RECORD, NEVER ITS TEXT (tools/row-judge.mjs, builder#172). The page scripts run here over a
// stand-in document (rows with a first cell and a chip carrying `data-row-state`) with the REAL SDK's rowSaved /
// rowBackedUp on `globalThis.__craftworks`, as the runtime puts them there. The control the issue names: a row
// TITLED "saved" whose record is not saved must NOT pass; a row that is saved passes.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSdk } from "../sdk-loader.js";
import { NO_JUDGE, ROWS, backedUp, savedRow, stopOnNoJudge } from "../tools/row-judge.mjs";

const sdk = await loadSdk(readFileSync(new URL("../sdk/craftworks_sdk_bg.wasm", import.meta.url)));
let failures = 0;
const t = async (name, f) => {
  try { await f(); process.stdout.write(`  ok  ${name}\n`); } catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

/** A stand-in page: `rows` as [title, record state code, the chip's WORDS]; a script is evaluated against it. */
function page(rows, judge = { rowSaved: sdk.rowSaved, rowBackedUp: sdk.rowBackedUp }) {
  const tr = ([title, code, words]) => ({
    textContent: `${title} ${words}`,
    querySelector: sel => (sel === "td" ? { textContent: title } : sel === ".rt-state" ? { textContent: words, dataset: { rowState: code } } : null),
  });
  const doc = { querySelectorAll: sel => (sel === "tbody tr" ? rows.map(tr) : []) };
  return script => new Function("document", "globalThis", script)(doc, { __craftworks: judge });
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

await t("**a frame WITHOUT the SDK's judge THROWS, named** (builder#177, the architect on #174) -- never 'not saved', which a gate waits out for 180 s; control: with the judge it reads", async () => {
  const rows = [["alpha", CLEAN, "saved"]];
  for (const judge of [null, {}, { rowSaved: sdk.rowSaved }]) {
    assert.throws(() => page(rows, judge)(ROWS), e => e.message.includes(NO_JUDGE), `a frame with judge ${JSON.stringify(Object.keys(judge ?? {}))} did not throw`);
    assert.throws(() => page(rows, judge)(savedRow("document", "alpha")), e => e.message.includes(NO_JUDGE));
  }
  assert.equal(page(rows)(savedRow("document", "alpha")), true, "THE CONTROL: the judge's frame did not read");
});

await t("**stopOnNoJudge ENDS a wait only for a missing judge**; any other failure is 'not yet' (null)", () => {
  assert.throws(() => stopOnNoJudge(new Error(`Uncaught Error: ${NO_JUDGE}`)), /no SDK judge on this frame: globalThis.__craftworks has no rowSaved/);
  assert.equal(stopOnNoJudge(new Error("Cannot read properties of null (reading 'querySelector')")), null, "an ordinary mid-load failure ended the wait");
});

await t("**EVERY row wait stops on a missing judge**: each tool's `until` that swallows a script's errors passes them to stopOnNoJudge; control: a planted catch-all is caught", () => {
  const swallows = src => /\.catch\(\(\) => null\)|\.catch\(e => \(\{ error: e\.message \}\)\); if \(v && !v\.error\)/.test(src);
  for (const f of ["realnet-demo.mjs", "live/page.mjs", "open-by-address.mjs"]) {
    const src = readFileSync(new URL(`../tools/${f}`, import.meta.url), "utf8");
    const untilBody = src.slice(src.search(/async function until\b/), src.search(/async function until\b/) + 500);
    assert.ok(untilBody.includes("stopOnNoJudge"), `tools/${f}'s until does not stop on a missing judge`);
    assert.ok(!swallows(untilBody), `tools/${f}'s until still swallows every error`);
  }
  assert.ok(swallows("const v = await tab.evaluate(expr).catch(() => null);"), "THE CONTROL: a planted catch-all was not caught");
});

await t("**ONE HOME**: no tool judges \"saved\" from WORDS (a row's text or a chip's), only row-judge.mjs reads a row's state; control: a planted text check is caught", () => {
  // WIDENED (builder#177): any row WORDS read as a state -- "saved", "backed up", "saving", in an include or a compare.
  const judgesByWords = src => /(includes\(|[!=]==?\s*)"[^"]*\b(saved|backed up|saving|unsaved)\b[^"]*"/i.test(src.replace(/\/\/.*$/gm, ""));
  const tools = new URL("../tools/", import.meta.url);
  const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".mjs") ? [join(d, e.name)] : []));
  const files = walk(fileURLToPath(tools));
  assert.ok(files.length > 10 && files.some(f => f.endsWith("realnet-demo.mjs")), "THE SETUP: the scan found no tools");
  const offenders = files.filter(f => !f.endsWith("row-judge.mjs") && judgesByWords(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, [], "a tool judges a row by its words");
  for (const planted of [`tr.textContent.includes("saved")`, `x.textContent === "saved + backed up"`, `chip.textContent === "backed up"`, `s.includes("backed up")`, `t.textContent !== "saving"`]) {
    assert.ok(judgesByWords(planted), `THE CONTROL: the planted \`${planted}\` was not caught`);
  }
});

process.stdout.write(failures ? `row-judge: ${failures} FAILED\n` : "row-judge: all ok\n");
process.exit(failures ? 1 : 0);
