// Drives the real page in headless Chrome over the DevTools protocol (no deps):
// build an app, preview it, add / edit / delete through the UI, watch the tree count.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8097, DEBUG = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cw-e2e-"))}`, "about:blank"], { stdio: "ignore" });
const done = code => { server.kill(); chrome.kill(); process.exit(code); };

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
  const evaluate = async expr => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page error");
    return r.result.result.value;
  };
  const until = async (expr, what) => { for (let i = 0; i < 60; i++) { if (await evaluate(`return ${expr}`)) return; await sleep(100); } throw new Error(`timed out: ${what}`); };

  const app = { components: [{ type: "form", domain: "tasks", mode: "owned" }, { type: "table", domain: "tasks", mode: "owned" }] };
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/#preview=1&app=${encodeURIComponent(JSON.stringify(app))}` });
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge");
  await until(`!!document.querySelector(".rt-comp input[name=title]")`, "form inputs rendered as inputs");
  assert.ok(!(await evaluate(`return document.getElementById("canvas").textContent.includes("[object")`)), "DOM nodes were stringified");

  const rows = `[...document.querySelectorAll(".rt-comp tbody tr")].map(tr => tr.cells[0].textContent)`;
  const tree = `document.querySelector("#tree .path small")?.textContent ?? ""`;
  const add = title => evaluate(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = ${JSON.stringify(title)}; document.querySelector(".rt-comp button.pri").click();`);

  // refused write: the required field is blank → message shown, nothing stored
  await add("");
  assert.match(await evaluate(`return document.querySelector(".rt-err").textContent`), /title.*required/);
  assert.deepStrictEqual(await evaluate(`return ${rows}`), []);

  await add("first"); await add("second");
  assert.deepStrictEqual(await evaluate(`return ${rows}`), ["first", "second"]);
  assert.match(await evaluate(`return ${tree}`), /2 records/);

  // edit the first row through the UI
  await evaluate(`document.querySelector(".rt-comp tbody tr button").click();`);
  assert.strictEqual(await evaluate(`return document.querySelector(".rt-comp input[name=title]").value`), "first");
  await evaluate(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = "first, edited"; document.querySelector(".rt-comp button.pri").click();`);
  assert.deepStrictEqual(await evaluate(`return ${rows}`), ["first, edited", "second"]);

  // delete the second row
  await evaluate(`document.querySelectorAll(".rt-comp tbody tr")[1].querySelectorAll("button")[1].click();`);
  assert.deepStrictEqual(await evaluate(`return ${rows}`), ["first, edited"]);
  assert.match(await evaluate(`return ${tree}`), /1 record\b/);

  console.log("ok e2e: add, refuse, edit, delete through the page; tree count follows");
  done(0);
} catch (e) {
  console.error("e2e FAILED:", e.message);
  done(1);
}
