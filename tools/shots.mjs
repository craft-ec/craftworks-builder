// Capture the builder's states as images, so the screenshot gate is something
// anyone can re-run rather than something one person did once.
//
//   node tools/shots.mjs            # every shot
//   node tools/shots.mjs live-off   # one
//
// The images go to docs/ and are COMMITTED. A path on the author's disk
// renders as nothing for anyone else, and a gate only the author can apply is
// not a gate.
//
// Same headless Chrome the e2e test drives, for the same reason: a screenshot
// taken from a different page than the tests exercise is a picture of
// something nobody checked.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8099, DEBUG = 9335;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const only = process.argv[2];

const APP = {
  name: "Notes",
  components: [
    { type: "form", domain: "notes", mode: "owned" },
    { type: "table", domain: "notes", mode: "owned" },
  ],
  schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }, { name: "done", kind: "bool" }] } },
};

/** Each shot: what it is FOR, in one line, so a reviewer knows what to look at. */
const SHOTS = [
  {
    name: "live-switch-off",
    what: "The LIVE switch in its default state: off, with the line that says what it costs.",
    hash: () => `#app=${encodeURIComponent(JSON.stringify(APP))}`,
    setup: `document.querySelectorAll('.comp')[1].click();`,
    wait: `!!document.getElementById("live")`,
  },
  {
    name: "live-switch-on",
    what: "The same switch turned on — the one thing an app author changes to make a component update by itself.",
    hash: () => `#app=${encodeURIComponent(JSON.stringify(APP))}`,
    setup: `document.querySelectorAll('.comp')[1].click(); await new Promise(r=>setTimeout(r,100)); document.getElementById("live").click();`,
    wait: `document.getElementById("live")?.checked === true`,
  },
];

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"],
  { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--force-device-scale-factor=2",
  "--window-size=1400,900", `--remote-debugging-port=${DEBUG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "cw-shots-"))}`, "about:blank"], { stdio: "ignore" });
const done = code => { server.kill(); chrome.kill(); process.exit(code); };

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(t => t.type === "page"); } catch (_) {}
  }
  if (!target) throw new Error("chrome did not start (set CHROME if it lives elsewhere)");
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
  const until = async (expr, what) => {
    for (let i = 0; i < 60; i++) { if (await evaluate(`return ${expr}`)) return; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  };

  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });

  let taken = 0;
  for (const shot of SHOTS) {
    if (only && shot.name !== only) continue;
    await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/${shot.hash()}` });
    await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "the SDK badge");
    if (shot.setup) await evaluate(shot.setup);
    if (shot.wait) await until(shot.wait, `${shot.name}: ${shot.wait}`);
    await sleep(250);
    const r = await send("Page.captureScreenshot", { format: "png" });
    const data = r.result?.data;
    // An empty capture is a blank PNG that looks like a shot until someone
    // opens it. Refuse rather than write one.
    if (!data || data.length < 2000) throw new Error(`${shot.name}: capture came back empty (${data?.length ?? 0} b64 chars)`);
    writeFileSync(new URL(`../docs/${shot.name}.png`, import.meta.url), Buffer.from(data, "base64"));
    console.log(`docs/${shot.name}.png — ${shot.what}`);
    taken += 1;
  }
  if (taken === 0) throw new Error(only ? `no shot named ${only}` : "no shots defined");
  console.log(`${taken} shot(s). LOOK AT THEM before attaching: tests read text, they cannot see an overlap.`);
  done(0);
} catch (e) {
  console.error(e.message ?? e);
  done(1);
}
