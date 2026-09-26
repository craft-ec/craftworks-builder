// THE DEMO'S PAGE LOADS WAIT THE STEP'S BUDGET (tools/realnet-load.mjs), not the CDP call's 30 s: a fresh node's first
// app GET runs to 60+ s (F60, #153), and a 30 s cut-off "broke" sdk#440's realnet at step 12 with no SDK code run.
// Each load's time is SAID (a TIME line), never a verdict.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SLOW_LOAD_MS, loadPage } from "../tools/realnet-load.mjs";

let failures = 0;
const t = async (name, f) => {
  try { await f(); process.stdout.write(`  ok  ${name}\n`); } catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};
/** A tab stand-in: records what it was asked to wait, and "loads" after `after` ms. */
const tab = (after = 5) => {
  const asked = [];
  const wait = async (what, opts) => { asked.push({ what, ...opts }); await new Promise(r => setTimeout(r, after)); };
  return { asked, navigate: (url, opts) => wait(`navigate ${url}`, opts), reload: opts => wait("reload", opts) };
};

await t("**a navigation and a reload each wait the budget they are given** (not a fixed 30 s), and the time is SAID", async () => {
  const said = [], p = tab(20);
  await loadPage(p, "http://x/app", { ms: 180_000, what: "12. V opens the app", say: l => said.push(l) });
  await loadPage(p, null, { ms: 180_000, what: "V reloads", say: l => said.push(l) });
  assert.deepEqual(p.asked.map(a => [a.what, a.ms]), [["navigate http://x/app", 180_000], ["reload", 180_000]]);
  assert.match(said[0], /^TIME  12\. V opens the app: page load \d+ ms \(budget 180000 ms\)$/);
  assert.ok(Number(said[0].match(/load (\d+) ms/)[1]) >= 15, `the measured time is not the load's: ${said[0]}`);
});

await t("**a load over the slow threshold is SAID (NOTE SLOW) and handed on to be counted; one under it is not**", async () => {
  const said = [], slow = [];
  await loadPage(tab(40), "http://x/slow", { ms: 180_000, what: "12. V opens the app", slowMs: 20, say: l => said.push(l), onSlow: n => slow.push(n) });
  await loadPage(tab(1), "http://x/fast", { ms: 180_000, what: "2. A opens the app", slowMs: 20, say: l => said.push(l), onSlow: n => slow.push(n) });
  assert.equal(slow.length, 1, `slow loads handed on: ${JSON.stringify(slow)}`);
  assert.match(slow[0], /^NOTE  SLOW 12\. V opens the app: page load \d+ ms \(> 20 ms\)$/);
  assert.ok(said.includes(slow[0]), "the NOTE was not said");
  assert.equal(SLOW_LOAD_MS, 30_000, "the stated threshold moved");
});

await t("**the demo records every slow load, and realnet's RESULT line counts them**", () => {
  const demo = readFileSync(fileURLToPath(new URL("../tools/realnet-demo.mjs", import.meta.url)), "utf8");
  const sh = readFileSync(fileURLToPath(new URL("../tools/realnet.sh", import.meta.url)), "utf8");
  assert.match(demo, /onSlow: note => \{[^}]*slow-loads\.txt/, "the demo's loads do not record slow ones");
  assert.match(sh, /slow=.*slow-loads\.txt/, "realnet.sh does not count the slow loads");
  assert.match(sh, /^echo "RESULT .*\$\{slow\} slow page load/m, "the RESULT line does not carry the count");
});

await t("a load with no budget is refused, never left to a default", async () => {
  await assert.rejects(loadPage(tab(), "http://x", { what: "no budget", say: () => {} }), /no budget/);
});

await t("**every page load in the demo goes through loadPage with the step's budget STEP_MS** -- no raw navigate or reload", () => {
  const src = readFileSync(fileURLToPath(new URL("../tools/realnet-demo.mjs", import.meta.url)), "utf8");
  assert.deepEqual(src.match(/\.(navigate|reload)\(/g) ?? [], [], "a page load in the demo bypasses loadPage (and its budget)");
  const calls = src.split("\n").filter(l => /\bloadPage\(/.test(l) && !/^import/.test(l));
  assert.ok(calls.length >= 6, `only ${calls.length} loadPage call(s): the demo's loads were not found`);
  for (const l of calls) assert.match(l, /ms: STEP_MS\b/, `a load waits something other than the step's budget: ${l.trim()}`);
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nall ok\n");
process.exit(failures ? 1 : 0);
