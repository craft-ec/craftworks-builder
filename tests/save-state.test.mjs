// THE PAGE, for builder#56: a save the browser refuses is SHOWN, and a retry
// that succeeds clears it. In headless Chrome over the real page and its real
// localStorage — `app.js` used to discard exactly this rejection with
// `.catch(() => {})`, so no unit test of LocalDb could see the UI half.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8099, DEBUG = 9335;
const SHOTS = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), "cw-save-shots-"));
mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--window-size=1280,800", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cw-save-"))}`, "about:blank"], { stdio: "ignore" });
const done = code => { server.kill(); chrome.kill(); process.exit(code); };
setTimeout(() => { console.error("save state FAILED: the run exceeded its 90 s budget"); done(1); }, 90_000).unref();

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
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise(ok => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const within = (p, ms, what) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error(`no answer in ${ms} ms: ${what}`)), ms))]);
  const evaluate = async expr => {
    const r = await within(send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }), 5000, expr.slice(0, 60));
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page error");
    return r.result.result.value;
  };
  const until = async (expr, what) => {
    for (let i = 0; i < 80; i++) { if (await evaluate(`return ${expr}`)) return; await sleep(100); }
    throw new Error(`timed out: ${what}`);
  };
  const shot = async name => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64"));
  };

  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge");
  // A project must be OPEN, or there is nothing for `persist` to save into.
  await evaluate(`document.getElementById("projects-chip").click();`);
  await until(`!!document.getElementById("projects-new")`, "New project");
  await evaluate(`document.getElementById("projects-new").click();`);
  await sleep(300);
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

  console.log(`\nsave state: all ok  (screenshots: ${SHOTS})`);
  done(0);
} catch (e) {
  console.error("save state FAILED:", e.message);
  console.error(`screenshots so far: ${SHOTS}`);
  done(1);
}
