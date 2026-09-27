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
    const session = { repairAll: () => { window.calls += 1; return new Promise(ok => { window.answer = ok; }); } };
    mountAssets(host, { session, tree: () => ({ name: "Notes", address: "craftec://realm/you/" }) });
    return true;`);
  const row = () => evaluate(`const tr = document.querySelector("tr[data-health]"); const b = document.getElementById("repair-now");
    return { health: tr.dataset.health, text: tr.innerText, disabled: b.disabled, button: b.textContent, calls: window.calls };`);

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
  });
  await t("**a report with a group given up: DAMAGED, naming the group and why**", async () => {
    await evaluate(`window.answer({ rows: 40, missing: 6, putBack: 3, rejected: 0, givenUp: 1, why: "2 of 4 blocks left" }); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "damaged"`, "damaged");
    const r = await row();
    assert.match(r.text, /1 group could not be rebuilt: fewer than k of its blocks anywhere \(2 of 4 blocks left\)/);
    assert.match(r.text, /40 rows · 6 missing · 3 put back/);
    assert.equal(r.disabled, false, "Repair now is still off after the pass ended");
  });
  await t("**a second pass that put every missing block back: REPAIRED**", async () => {
    await evaluate(`document.getElementById("repair-now").click(); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "repairing"`, "repairing again");
    await evaluate(`window.answer({ rows: 40, missing: 3, putBack: 3, rejected: 0, givenUp: 0, why: null }); return true;`);
    await until(`document.querySelector("tr[data-health]").dataset.health === "repaired"`, "repaired");
    const r = await row();
    assert.match(r.text, /3 missing blocks rebuilt from parity and put back/);
    assert.equal(r.calls, 2);
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
