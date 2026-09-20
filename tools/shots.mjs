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
import { connect } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8099, DEBUG = 9335;

/**
 * A port this tool is about to take must be FREE.
 *
 * "I assumed nothing was listening" is how a screenshot run connected to a
 * node somebody else was running and began provisioning it. A tool that
 * expects a port to be free CHECKS, and refuses if it is not — binding on top
 * of someone else's service, or silently driving it, are both worse than
 * stopping.
 */
const portIsFree = port => new Promise(resolve => {
  const s = connect({ port, host: "127.0.0.1" });
  const done = free => { s.destroy(); resolve(free); };
  s.setTimeout(500);
  s.once("connect", () => done(false));   // something answered
  s.once("error", () => done(true));      // nothing there
  s.once("timeout", () => done(false));   // something is holding it
});

async function refuseIfTaken(ports) {
  for (const [port, what] of ports) {
    if (!(await portIsFree(port))) {
      console.error(
        `something is already listening on 127.0.0.1:${port} (${what}).\n` +
        "Refusing to start: this tool would either fail to bind or drive somebody else's service.");
      process.exit(1);
    }
  }
}
/**
 * The node port the publish shots point at, and NOTHING may be on it.
 *
 * Not 7509 or 7609: those are nodes a developer machine already runs for
 * somebody else, and publishing installs a delegate and hands over a signing
 * key. `publish.js` refuses them by name; this never names them.
 */
const NODE_PORT = 17509;

await refuseIfTaken([
  [PORT, "the page server"],
  [DEBUG, "Chrome's debugging port"],
  [NODE_PORT, "the node port the publish shots expect to be empty"],
]);
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

const LIVE_APP = {
  ...APP,
  components: [APP.components[0], { ...APP.components[1], live: true }],
};

/** Each shot: what it is FOR, in one line, so a reviewer knows what to look at. */
const SHOTS = [
  {
    name: "row-state-in-memory",
    what: "Every row says where it actually is. An unpublished project's rows say 'in this tab only' — not 'saved', which is the thing Publish is for.",
    hash: () => `#preview=1&app=${encodeURIComponent(JSON.stringify(APP))}`,
    setup: `
      for (const t of ["Buy milk", "Renew the passport"]) {
        const i = document.querySelector(".rt-comp input[name=title]");
        i.value = t;
        document.querySelector(".rt-comp button.pri").click();
        await new Promise(r => setTimeout(r, 120));
      }`,
    wait: `document.querySelectorAll(".rt-comp tbody tr").length === 2`,
  },
  {
    name: "publish-button",
    what: "The Publish button before anything is published, beside an address bar that says the project is in this tab only. The two say the same thing in two places, because the decision to close the tab is made while looking at the rows.",
    hash: () => `#app=${encodeURIComponent(JSON.stringify(APP))}`,
    setup: "",
    wait: `document.getElementById("publish")?.disabled === false`,
  },
  {
    name: "publish-no-node",
    what: "What a person sees when there is no node running. It names the cause and what to do about it, and the button invites another try — the delegate refuses a second install on its own, so pressing it again cannot cost a signing key. A bare 'failed' here would be unfixable.",
    // A REAL failure, not a mocked one: nothing is listening on NODE_PORT,
    // which this run checks before starting. The first version of this shot
    // named no port at all, so it used a default — and the default was a
    // node somebody else was running, which it connected to and began
    // provisioning. There is no default now, in the page or here.
    //
    // The states that need a live node are captured by the two-tab
    // acceptance run, against an isolated node of this project's own, where
    // they are facts rather than arrangements.
    hash: () => `#node=${NODE_PORT}&app=${encodeURIComponent(JSON.stringify(APP))}`,
    setup: `
      document.getElementById("publish").click();
      await new Promise(r => setTimeout(r, 1500));`,
    wait: `/again|running/i.test(document.getElementById("publish").textContent + document.getElementById("publish").title)`,
  },
  {
    name: "live-binding-marked",
    what: "A component whose binding is LIVE says so on its heading, so nobody has to open the properties panel to find out which parts of a screen refresh themselves.",
    // Starts in DESIGN mode and selects the live component before previewing,
    // so the properties panel and the badge describe the SAME component. The
    // first version went straight to preview with the Form selected: the panel
    // showed LIVE unchecked beside a table badged live, which is true of two
    // different components and reads as a contradiction. A reviewer would stop
    // at that, and be right to.
    hash: () => `#app=${encodeURIComponent(JSON.stringify(LIVE_APP))}`,
    setup: `
      document.querySelectorAll('.comp')[1].click();
      await new Promise(r => setTimeout(r, 80));
      document.getElementById("preview").click();
      await new Promise(r => setTimeout(r, 200));
      const i = document.querySelector(".rt-comp input[name=title]");
      i.value = "A live list";
      document.querySelector(".rt-comp button.pri").click();
      await new Promise(r => setTimeout(r, 150));`,
    wait2: `document.getElementById("live")?.checked === true`,
    wait: `!!document.querySelector(".rt-live")`,
  },
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
    // A UNIQUE QUERY, not just a different hash. Two shots differing only in
    // the fragment are a FRAGMENT navigation: the browser does not reload, the
    // app never re-runs, and the second shot photographs the first one's page.
    // Running a shot alone passed and running the pair failed, which is the
    // signature — and a flaky gate is one people learn to re-run.
    await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?shot=${shot.name}${shot.hash()}` });
    await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "the SDK badge");
    if (shot.setup) await evaluate(shot.setup);
    if (shot.wait2) await until(shot.wait2, `${shot.name}: ${shot.wait2}`);
    if (shot.wait) {
      try {
        await until(shot.wait, `${shot.name}: ${shot.wait}`);
      } catch (e) {
        // A timeout with no context costs a re-run. Say what the page
        // actually had, which is almost always the answer.
        const seen = await evaluate(
          `return JSON.stringify({ comps: [...document.querySelectorAll(".rt-comp h4")].map(h => h.textContent), live: document.querySelectorAll(".rt-live").length, app: (location.hash.match(/app=([^&]*)/) || [])[1]?.slice(0, 120) })`);
        throw new Error(`${e.message}\n  page had: ${seen}`);
      }
    }
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
