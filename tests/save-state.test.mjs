// THE PAGE, for builder#56: a save the browser refuses is SHOWN, and a retry
// that succeeds clears it. In headless Chrome over the real page and its real
// localStorage — `app.js` used to discard exactly this rejection with
// `.catch(() => {})`, so no unit test of LocalDb could see the UI half.
import assert from "node:assert";
import { openPageHost } from "./page-host.mjs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), "cw-save-shots-"));
mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// This run's own server and Chrome, on ports the OS chose, with the run's
// budget (builder#70).
const { port: PORT, debug: DEBUG, nonce, pageProof, done } = await openPageHost("save state");

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(t => t.type === "page"); } catch (_) {}
  }
  assert.ok(target, "chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let seq = 0; const waiting = new Map();
  // Uncaught PAGE exceptions are kept, and a timed-out wait names the last one:
  // a page whose module threw at load shows nothing in the DOM, so without this
  // the failure says only what never appeared, not why.
  const pageErrors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "an exception");
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(ok => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const within = (p, ms, what) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error(`no answer in ${ms} ms: ${what}`)), ms))]);
  const evaluate = async expr => {
    const r = await within(send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }), 5000, expr.slice(0, 60));
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page error");
    return r.result.result.value;
  };
  // A failed or unanswered evaluate is "not yet": one sent mid-navigation never
  // answers. The condition keeps its deadline.
  const until = async (expr, what, ms = 15_000) => {
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
    const thrown = pageErrors.length ? ` — the page threw: ${pageErrors.at(-1).split("\n")[0]}` : "";
    throw new Error(`timed out after ${ms} ms: ${what}${lastError ? ` — last error: ${lastError.message}` : ""}${thrown}`);
  };
  const shot = async name => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64"));
  };

  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge");
  // THE PAGE PROVES IT IS THIS TREE: it fetches this run's nonce through
  // its own origin. A foreign server on a stale port cannot answer it.
  assert.strictEqual(await evaluate(pageProof), nonce, "save state: the page is not served from this tree");
  // A project must be OPEN, or there is nothing for `persist` to save into.
  await evaluate(`document.getElementById("projects-chip").click();`);
  await until(`!!document.getElementById("projects-new")`, "New project");
  await evaluate(`document.getElementById("projects-new").click();`);
  // Wait for the project to be OPEN, not for a duration: the edit below saves
  // into whatever project is open, and a guess of 300 ms is a guess.
  await until(`JSON.parse(localStorage.getItem("craftec.builder.device.v1") ?? "{}").lastOpened
    && document.querySelectorAll(".proj-row").length === 1`, "the new project to open");
  await evaluate(`document.getElementById("projects-chip").click();`);   // close the popover
  // `!== false`, not `=== true`: on a page with no unsaved line at all (main,
  // before this change) the check must fail at the CLAIM below — the line
  // never appearing — not crash here on a missing element.
  assert.ok(await evaluate(`return document.getElementById("save-state")?.hidden !== false;`),
    "the unsaved line is hidden while saves succeed");

  // THE BROWSER REFUSES EVERY WRITE, as a full quota does.
  await evaluate(`
    window.__realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };`);
  // An edit: place a component.
  await evaluate(`[...document.querySelectorAll("#palette .chip")].find(b => !b.disabled).click();`);
  await until(`document.getElementById("save-state")?.hidden === false`, "the unsaved line to appear after a refused save");
  await shot("56-1-refused");
  const refused = await evaluate(`return {
    text: document.getElementById("save-state").textContent,
    cards: document.querySelectorAll("#canvas .comp").length };`);
  assert.match(refused.text, /Not saved on this device/);
  assert.match(refused.text, /QuotaExceededError|quota/i, `the reason must be shown: ${refused.text}`);
  assert.strictEqual(refused.cards, 1, "the edit is NOT taken away: the canvas keeps it");
  console.log("ok page: a refused save is shown, with its reason, and the edit stays on the canvas", JSON.stringify(refused));

  // Storage recovers; Retry.
  await evaluate(`Storage.prototype.setItem = window.__realSet;`);
  await evaluate(`document.getElementById("save-retry").click();`);
  await until(`document.getElementById("save-state").hidden`, "Retry to clear the unsaved line");
  await shot("56-2-retried");
  const kept = await evaluate(`
    const { LocalDb } = await import("/local-db.js");
    const db = new LocalDb();
    return (await db.scan("project.component")).length;`);
  assert.strictEqual(kept, 1, "after Retry the component is in storage, where a reload would find it");
  console.log("ok page: Retry after storage recovers saves the edit and clears the line", JSON.stringify({ kept }));

  // AN OLDER TAB IS REPORTED. A legacy blob that appears AFTER the migration
  // marker was written back by a tab still running the old builder; the page
  // must say so, since reloading that tab is something a person can do.
  await evaluate(`
    localStorage.setItem("craftec.builder.db.v1/migrated", JSON.stringify({ at: 1 }));
    localStorage.setItem("craftec.builder.db.v1", JSON.stringify({ schemas: {}, records: {}, seq: 0 }));`);
  await send("Page.reload", { ignoreCache: true });
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge after reload");
  await until(`document.getElementById("storage-note")?.hidden === false`, "the older-tab notice");
  await shot("66-older-tab-notice");
  const note = await evaluate(`return document.getElementById("storage-note").textContent;`);
  assert.match(note, /older version of the builder/, `got: ${note}`);
  console.log("ok page: a blob written back by an older tab is reported", JSON.stringify({ note }));

  console.log(`\nsave state: all ok  (screenshots: ${SHOTS})`);
  done(0);
} catch (e) {
  console.error("save state FAILED:", e.message);
  console.error(`screenshots so far: ${SHOTS}`);
  done(1);
}
