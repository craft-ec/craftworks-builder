// THE ASSETS TAB IN A REAL PAGE (the owner's first repair goal): Repair now calls the session's repairAll(), the row
// says REPAIRING while it runs (its button off), then DAMAGED for a report with a group given up, and REPAIRED once a
// pass put every missing block back. The session is a stand-in whose repairAll() the test resolves by hand: what is
// under test is the tab's reading of a report, over the real panel code (assets-panel.js) in headless Chrome.
import assert from "node:assert/strict";
import { openPageHost, cdpConnect } from "./page-host.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const { port: PORT, debug: DEBUG, nonce, done } = await openPageHost("assets page", { windowSize: "1280,800", budgetMs: 90_000 });
let failures = 0;
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(t => t.type === "page"); } catch (_) {}
  }
  assert.ok(target, "chrome did not start");
  const { send } = await cdpConnect(target.webSocketDebuggerUrl, "assets-page");
  const evaluate = async expr => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page error");
    return r.result.result.value;
  };
  const until = async (expr, what, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(`return ${expr}`)) return;
      await sleep(100);
    }
    throw new Error(`timed out: ${what}: at ${await evaluate("return location.href")}: ${await evaluate("return document.documentElement.outerHTML.slice(0, 300)")}`);
  };
  // An empty page on THIS tree's server -- proven by its nonce, fetched from inside the page -- so the module imported
  // below is this tree's assets-panel.js.
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/tests/fixtures/assets-tab.html` });
  await until(`document.title === "assets tab fixture"`, "the fixture page");
  assert.equal(await evaluate(`return (await fetch("/.page-nonce/${nonce}")).text()`), nonce, "the page is not on this tree's server");
  await evaluate(`
    const { mountAssets } = await import("/assets-panel.js");
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    window.calls = 0;
    window.cancels = 0;
    // The SDK's two lists, as sdk.status gives their words (the pinned build's own lists are read in the app).
    const words = { repairOutcome: ["repaired", "partial", "cancelled"], groupHealth: ["whole", "degraded", "damaged"] };
    const repair = () => { window.calls += 1; return { done: new Promise(ok => { window.answer = ok; }), cancel: () => { window.cancels += 1; } }; };
    mountAssets(host, { repair, words, tree: () => ({ name: "Notes", address: "register " + "ab".repeat(32) }) });
    return true;`);
  const row = () => evaluate(`const tr = document.querySelector("tr[data-health]"); const b = document.getElementById("repair-now");
    return { health: tr.dataset.health, text: tr.innerText, disabled: b.disabled, button: b.textContent, calls: window.calls, cancels: window.cancels, cancel: !!document.getElementById("repair-cancel") };`);

  const t = async (name, fn) => {
    try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.stack}\n`); }
  };
  await t("**before a pass: 'not checked', nothing measured, Repair now enabled**", async () => {
    const r = await row();
    assert.equal(r.health, "not checked");
    assert.equal(r.disabled, false);
    assert.equal(r.calls, 0, "the tab ran a pass nobody asked for");
  });
  await t("**Repair now: repairAll() is called ONCE; the row says repairing and its button is off while it runs**", async () => {
    await evaluate(`document.getElementById("repair-now").click(); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "repairing"`, "repairing");
    const r = await row();
    assert.equal(r.calls, 1);
    assert.equal(r.disabled, true, "a second pass could be started while one runs");
    assert.equal(r.cancel, true, "no Cancel while a pass runs");
  });
  await t("**a report with a group given up: DAMAGED, naming the group and why**", async () => {
    await evaluate(`window.answer({ rows: 40, outcome: "damaged", outcomeList: "groupHealth", missing: 6, putBack: 3, rejected: 0, givenUp: 1, parityMismatched: 0, pending: 0, damaged: [{ block: "cd".repeat(32), present: 2, k: 4, health: "damaged" }], why: "2 of 4 blocks left" }); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "damaged"`, "damaged");
    const r = await row();
    assert.match(r.text, /1 group could not be rebuilt: 2 of 4 blocks left/);
    assert.match(r.text, /cdcdcdcdcdcd… damaged: 2 of 4 blocks found/);
    assert.equal(r.cancel, false, "Cancel stays after the pass ended");
    assert.match(r.text, /40 rows · 6 missing · 3 put back/);
    assert.equal(r.disabled, false, "Repair now is still off after the pass ended");
  });
  await t("**a second pass that put every missing block back: REPAIRED**", async () => {
    await evaluate(`document.getElementById("repair-now").click(); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "repairing"`, "repairing again");
    await evaluate(`window.answer({ rows: 40, outcome: "repaired", outcomeList: "repairOutcome", missing: 3, putBack: 3, rejected: 0, givenUp: 0, parityMismatched: 0, pending: 0, damaged: [], why: null }); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "repaired"`, "repaired");
    const r = await row();
    assert.match(r.text, /40 rows · 3 missing · 3 put back/);
    assert.equal(r.calls, 2);
  });
  await t("**Cancel: asked once, the row says it is stopping, and the pass's own CANCELLED report is shown**", async () => {
    await evaluate(`document.getElementById("repair-now").click(); return true;`);
    await until(`!!document.getElementById("repair-cancel")`, "Cancel shown");
    await evaluate(`document.getElementById("repair-cancel").click(); return true;`);
    await until(`/stopping/.test(document.querySelector("tr[data-health]").innerText)`, "stopping");
    let r = await row();
    assert.equal(r.cancels, 1);
    assert.equal(r.cancel, false, "Cancel could be asked twice");
    await evaluate(`window.answer({ rows: 12, outcome: "cancelled", outcomeList: "repairOutcome", missing: 1, putBack: 0, rejected: 0, givenUp: 0, parityMismatched: 0, pending: 1, damaged: [], why: null }); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "cancelled"`, "cancelled");
    r = await row();
    assert.match(r.text, /12 rows · 1 missing · 0 put back/);
  });
  await t("**a word the SDK does not define is said as a failure, never painted as a health word**", async () => {
    await evaluate(`document.getElementById("repair-now").click(); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "repairing"`, "repairing");
    await evaluate(`window.answer({ rows: 1, outcome: "fine", outcomeList: "repairOutcome", missing: 0, putBack: 0, rejected: 0, givenUp: 0, parityMismatched: 0, pending: 0, damaged: [], why: null }); return true;`);
    await until(`/not a word of status\.repairOutcome/.test(document.querySelector("tr[data-health]").innerText)`, "refused word");
    assert.equal((await row()).health, "not checked");
  });
  await t("**THE DEMO'S ORDER: the tab OPENS with a check (nothing put back) -> DEGRADED with the missing count -> Repair now -> REPAIRED**", async () => {
    await evaluate(`
      const { mountAssets } = await import("/assets-panel.js");
      const host = document.createElement("div");
      document.body.replaceChildren(host);
      window.checks = 0; window.calls = 0;
      const words = { repairOutcome: ["repaired", "partial", "cancelled"], groupHealth: ["whole", "degraded", "damaged"] };
      const check = () => { window.checks += 1; return { done: new Promise(ok => { window.answer = ok; }), cancel: () => {} }; };
      const repair = () => { window.calls += 1; return { done: new Promise(ok => { window.answer = ok; }), cancel: () => {} }; };
      mountAssets(host, { repair, check, words, tree: () => ({ name: "Notes", address: "register " + "ab".repeat(32) }) });
      return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "checking"`, "checking on open");
    assert.equal(await evaluate("return window.checks"), 1, "the tab did not check on open");
    await evaluate(`window.answer({ rows: 40, outcome: "degraded", outcomeList: "groupHealth", missing: 7, putBack: 0, reput: 0, rejected: 0, givenUp: 0, parityMismatched: 0, pending: 0, damaged: [], why: null }); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "degraded"`, "degraded");
    let text = await evaluate(`return document.querySelector("tr[data-health]").innerText`);
    assert.match(text, /7 blocks missing from your node — Repair now rebuilds them from parity/);
    assert.match(text, /40 rows · 7 missing/);
    assert.equal(await evaluate("return window.calls"), 0, "the check repaired something");
    await evaluate(`document.getElementById("repair-now").click(); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "repairing"`, "repairing");
    await evaluate(`window.answer({ rows: 40, outcome: "repaired", outcomeList: "repairOutcome", missing: 7, putBack: 7, reput: 0, rejected: 0, givenUp: 0, parityMismatched: 0, pending: 0, damaged: [], why: null }); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "repaired"`, "repaired");
    text = await evaluate(`return document.querySelector("tr[data-health]").innerText`);
    assert.match(text, /40 rows · 7 missing · 7 put back/);
  });
  await t("**a pass that throws is said, and is not a health word**", async () => {
    await evaluate(`document.getElementById("repair-now").click(); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "repairing"`, "repairing a third time");
    await evaluate(`window.answer(Promise.reject(new Error("the node closed the socket"))); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "not checked"`, "failed pass");
    assert.match((await row()).text, /could not run: the node closed the socket/);
  });
} catch (e) {
  // A setup that throws is a FAILURE with its words -- never a silent exit 0 through `done`.
  failures += 1;
  process.stdout.write(`  FAIL the setup: ${e.stack}\n`);
} finally {
  if (failures) process.stdout.write(`${failures} failed\n`);
  await done(failures ? 1 : 0);
}
