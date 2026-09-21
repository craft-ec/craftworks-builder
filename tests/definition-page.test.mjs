// THE PAGE, for builder#53: switching projects must not hand one project's
// definition to another. The auditor's sequence, in headless Chrome over the
// real page and its real localStorage:
//
//   1. Project 1: a Table on `tables`, its schema type set to SchemaA.
//   2. Project 2: a Table on the SAME domain, schema type SchemaB.
//   3. Reopen Project 1: its app definition must say SchemaA. It said SchemaB.
//
// Then what the acceptance adds: a reload, a duplicate, and a new project that
// must inherit nothing. The "app definition" panel is read because it is what
// the page shows a person as the definition.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8100, DEBUG = 9336;
const SHOTS = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), "cw-def-shots-"));
mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--window-size=1280,900", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cw-def-"))}`, "about:blank"], { stdio: "ignore" });
const done = code => { server.kill(); chrome.kill(); process.exit(code); };
setTimeout(() => { console.error("definition page FAILED: the run exceeded its 120 s budget"); done(1); }, 120_000).unref();

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

  /** The app definition the page shows, parsed. */
  const def = () => evaluate(`return JSON.parse(document.getElementById("def").textContent);`);
  const openPop = async () => {
    if (await evaluate(`return document.getElementById("projects-pop").hidden;`)) {
      await evaluate(`document.getElementById("projects-chip").click();`);
    }
    await until(`!!document.getElementById("projects-new")`, "the projects popover");
  };
  const closePop = async () => {
    if (!(await evaluate(`return document.getElementById("projects-pop").hidden;`))) {
      await evaluate(`document.getElementById("projects-chip").click();`);
    }
  };
  const newProject = async () => { await openPop(); await evaluate(`document.getElementById("projects-new").click();`); await sleep(400); await closePop(); };
  const openByTitle = async t => {
    await openPop();
    await evaluate(`[...document.querySelectorAll(".proj-row")].find(r => r.querySelector("b").textContent === ${JSON.stringify(t)}).click();`);
    await sleep(400); await closePop();
  };
  /** Place a Table on `tables` and set its schema type, through the UI. */
  const tableWithType = async type => {
    await evaluate(`[...document.querySelectorAll("#palette .chip")].find(b => b.textContent.startsWith("Table")).click();`);
    await until(`!!document.querySelector('#props input[title="Record type name"]')`, "the schema editor");
    await evaluate(`const i = document.querySelector('#props input[title="Record type name"]');
      i.value = ${JSON.stringify(type)}; i.dispatchEvent(new Event("input", { bubbles: true }));`);
    await sleep(400);   // the save is asynchronous
  };

  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge");

  // 1-2. The auditor's two projects.
  await newProject();   // Project 1
  await tableWithType("SchemaA");
  await newProject();   // Project 2
  await tableWithType("SchemaB");
  assert.strictEqual((await def()).schemas.tables.type, "SchemaB");

  // 3. Reopen Project 1.
  await openByTitle("Project 1");
  await shot("53-1-project1-reopened");
  const p1 = await def();
  assert.strictEqual(p1.name, "Project 1");
  assert.strictEqual(p1.schemas?.tables?.type, "SchemaA",
    `Project 1 must read its own SchemaA — the audit found SchemaB (builder#53): ${JSON.stringify(p1.schemas)}`);
  console.log("ok page: reopening Project 1 shows SchemaA, not Project 2's SchemaB (builder#53)");

  // A reload does not lose it: it is STORED with Project 1 now.
  await send("Page.reload", { ignoreCache: true });
  await sleep(300);
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge after reload");
  await sleep(500);
  assert.strictEqual((await def()).schemas?.tables?.type, "SchemaA", "after a reload Project 1 still reads SchemaA");
  await openByTitle("Project 2");
  assert.strictEqual((await def()).schemas?.tables?.type, "SchemaB", "and Project 2 still reads SchemaB");
  console.log("ok page: both definitions survive a reload");

  // A duplicate copies the definition, not just the components.
  await openByTitle("Project 1");
  await openPop();
  await evaluate(`document.getElementById("projects-dup").click();`);
  await sleep(400);
  await openByTitle("Project 1 copy");
  assert.strictEqual((await def()).schemas?.tables?.type, "SchemaA", "a duplicate of Project 1 carries SchemaA");
  console.log("ok page: a duplicate carries its source's definition");

  // A new project inherits NOTHING.
  await newProject();
  await shot("53-2-new-project");
  const fresh = await def();
  assert.deepStrictEqual(fresh.schemas, {}, `a new project must start with no schemas: ${JSON.stringify(fresh.schemas)}`);
  assert.deepStrictEqual(fresh.seed, {});
  console.log("ok page: a new project inherits no schemas and no seed");

  console.log(`\ndefinition page: all ok  (screenshots: ${SHOTS})`);
  done(0);
} catch (e) {
  console.error("definition page FAILED:", e.message);
  console.error(`screenshots so far: ${SHOTS}`);
  done(1);
}
