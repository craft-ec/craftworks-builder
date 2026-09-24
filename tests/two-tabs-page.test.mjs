// THE PAGE, for builder#74: a component changed in two tabs TELLS the person,
// through the wiring app.js does — `onConflict` into the storage-notice line.
//
// The node tests prove `saveCanvas` and `mountProjects`; nothing in node loads
// app.js, so deleting its `onConflict:` line left every one of them green
// (review of builder#77). Here the other tab is simulated in the page: the
// open component is written as another tab would write it — the same count,
// another writer, other content — and then edited in this tab.
import assert from "node:assert";
import { openPageHost, cdpConnect } from "./page-host.mjs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), "cw-twotabs-shots-"));
mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { port: PORT, debug: DEBUG, nonce, pageProof, done } = await openPageHost("two tabs page");
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(t => t.type === "page"); } catch (_) {}
  }
  assert.ok(target, "chrome did not start");
  // Through the ONE CDP connection (page-host): every call has a deadline.
  const { send } = await cdpConnect(target.webSocketDebuggerUrl, "two-tabs-page");
  // A DEADLINE ON EVERY CALL. `awaitPromise` waits for the page's promise, and
  // a page that stalls never settles it — which hung the first control run of
  // this file past ten minutes with no output. A stall is a failure to report,
  // not a thing to wait on.
  const within = (p, ms, what) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error(`no answer in ${ms} ms: ${what}`)), ms))]);
  const evaluate = async expr => {
    const r = await within(send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }), 5000, expr.slice(0, 60));
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page error");
    return r.result.result.value;
  };
  // A failed or unanswered evaluate is "not yet", not a failure: one sent while
  // the page is mid-navigation never answers, and treating that as fatal made
  // a reload look like a hung page. The condition itself keeps a deadline, and
  // on timeout the message says what was last SEEN, not only what was wanted.
  const until = async (expr, what, { ms = 10_000, show = null } = {}) => {
    const end = Date.now() + ms;
    // The LAST error is kept: "not yet" must not swallow a genuine exception in
    // the expression, which would otherwise time out looking like a condition
    // that simply never became true.
    let lastError = null;
    while (Date.now() < end) {
      try { if (await within(evaluate(`return ${expr}`), 2000, what)) return; lastError = null; }
      catch (e) { lastError = e; }
      await sleep(100);
    }
    let seen = "";
    if (show) { try { seen = ` — last seen: ${JSON.stringify(await evaluate(`return ${show}`))}`; } catch (_) {} }
    throw new Error(`timed out after ${ms} ms: ${what}${seen}${lastError ? ` — last error: ${lastError.message}` : ""}`);
  };
  const shot = async name => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64"));
  };

  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge");
  assert.strictEqual(await evaluate(pageProof), nonce, "two tabs page: the page is not served from this tree");

  // A project, open, with one component stored.
  await evaluate(`document.getElementById("projects-chip").click();`);
  await until(`!!document.getElementById("projects-new")`, "New project");
  await evaluate(`document.getElementById("projects-new").click();`);
  await until(`!!JSON.parse(localStorage.getItem("craftec.builder.device.v1") ?? "{}").lastOpened`, "the project to open");
  await evaluate(`document.getElementById("projects-chip").click();`);
  await evaluate(`[...document.querySelectorAll("#palette .chip")].find(b => b.textContent.startsWith("Table")).click();`);
  const stored = `(async () => {
    const { LocalDb } = await import("/local-db.js"); const P = await import("/projects.js");
    const pid = JSON.parse(localStorage.getItem("craftec.builder.device.v1")).lastOpened;
    return (await P.openProject(new LocalDb(), pid)).components; })()`;
  await until(`${stored}.then(c => c.length === 1)`, "the component to be stored");

  // ANOTHER TAB writes it: the same count, another writer, other content.
  await evaluate(`
    const { LocalDb } = await import("/local-db.js"); const P = await import("/projects.js");
    const db = new LocalDb();
    const pid = JSON.parse(localStorage.getItem("craftec.builder.device.v1")).lastOpened;
    const [c] = (await P.openProject(db, pid)).components;
    const props = { ...c.props, domain: "changed-in-other-tab", _builder: { ...c.props._builder, by: "another-tab" } };
    await P.setComponentProps(db, c.id, props);`);

  // And THIS tab edits it too.
  await evaluate(`const i = document.querySelector("#props input"); i.value = "changed-here"; i.dispatchEvent(new Event("input", { bubbles: true }));`);
  await until(`document.getElementById("storage-note")?.hidden === false`,
    "the conflict to be TOLD in the notice line — app.js must wire onConflict",
    { show: `({ note: document.getElementById("storage-note")?.textContent, unsaved: document.getElementById("save-state")?.textContent })` });
  await shot("77-conflict-told");
  const note = await evaluate(`return document.getElementById("storage-note").textContent;`);
  assert.match(note, /also changed in another tab; your version was kept/, `got: ${note}`);
  console.log("ok page: a component changed in two tabs is TOLD through app.js's onConflict wiring", JSON.stringify({ note }));

  // CLEAR STILL CLEARS (review of #79). A canvas with no base set now deletes
  // nothing, so a Clear that REPLACED the array would silently stop removing
  // anything — the person clears, reloads, and it is all back. app.js empties
  // it in place, keeping the base set; this proves the records go.
  await evaluate(`document.getElementById("clear").click();`);
  await until(`${stored}.then(c => c.length === 0)`, "Clear to remove the stored components",
    { show: stored.replace(/\)\(\)$/, ")()") });
  console.log("ok page: Clear removes this tab's components from storage");

  console.log(`\ntwo tabs page: all ok  (screenshots: ${SHOTS})`);
  done(0);
} catch (e) {
  console.error("two tabs page FAILED:", e.message);
  console.error(`screenshots so far: ${SHOTS}`);
  done(1);
}
