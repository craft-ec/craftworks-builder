// ONE TAB, ONE PUBLISH, ONE WRITE — and say exactly what the page is.
//
//   node tools/probe-one-write.mjs .
//
// The two-tab acceptance answers "did all seven items pass". This answers
// "what is the page actually doing", which is the question every failing run
// turned out to need. Two acceptance runs were spent on failures that said
// only "timed out waiting for X"; this prints the publish button, the phase,
// the component count, the chips, the stats, the live mode and its REASON,
// and the node's own console, every few seconds.
//
// Its own node, on its own ports, killed by recorded PID — same rules as the
// acceptance. Never 7509 or 7609.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
const ROOT = process.argv[2];
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE = 8097, DEBUG = 9339, WS = 17511, NET = 37511;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const free = port => new Promise(ok => {
  const s = connect({ port, host: "127.0.0.1" });
  const done = v => { s.destroy(); ok(v); };
  s.setTimeout(500);
  s.once("connect", () => done(false)); s.once("error", () => done(true)); s.once("timeout", () => done(false));
});
for (const p of [PAGE, DEBUG, WS, NET]) {
  if (![7509, 7609].includes(p) && await free(p)) continue;
  console.error(`refusing: ${p} is busy or reserved`); process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), "probe-pub-"));
for (const d of ["data", "config", "log"]) mkdirSync(join(dir, d), { recursive: true });
const procs = [];
const node = spawn("freenet", ["network", "--is-gateway", "--skip-load-from-network",
  "--network-address", "127.0.0.1", "--network-port", String(NET),
  "--public-network-address", "127.0.0.1", "--public-network-port", String(NET),
  "--ws-api-address", "127.0.0.1", "--ws-api-port", String(WS),
  "--data-dir", join(dir, "data"), "--config-dir", join(dir, "config"), "--log-dir", join(dir, "log")],
  { stdio: ["ignore", "pipe", "pipe"] });
procs.push(node);
const nodeOut = [];
node.stdout.on("data", d => nodeOut.push(String(d)));
node.stderr.on("data", d => nodeOut.push(String(d)));
const page = spawn("python3", ["-m", "http.server", String(PAGE), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
procs.push(page);
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${DEBUG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "probe-c-"))}`, "about:blank"], { stdio: "ignore" });
procs.push(chrome);
process.on("exit", () => { for (const p of procs) { try { process.kill(p.pid); } catch {} } });
console.log(`node pid ${node.pid} on ${WS}`);
for (let i = 0; i < 180 && await free(WS); i++) await sleep(250);
await sleep(2500);
const t = await (await fetch(`http://127.0.0.1:${DEBUG}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(ok => { ws.onopen = ok; });
let seq = 0; const waiting = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise(ok => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expr => (await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })).result?.result?.value;
const APP = { name: "Two tabs",
  components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned", live: true }],
  schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } } };
await ev(`window.location.href = ${JSON.stringify(`http://127.0.0.1:${PAGE}/#node=${WS}&preview=1&app=` + encodeURIComponent(JSON.stringify(APP)))}; return 1;`);
await sleep(5000);
console.log("before publish:", JSON.stringify(await ev(`return { btn: document.getElementById("publish")?.textContent, phase: window.__craftworks?.phase, comps: document.querySelectorAll(".rt-comp").length };`)));
await ev(`document.getElementById("publish").click(); return 1;`);
// PUBLISH DONE. Now write one record and watch what happens to it.
await sleep(8000);
console.log("after publish:", JSON.stringify(await ev(`return { phase: window.__craftworks?.phase, comps: document.querySelectorAll(".rt-comp").length };`)));
// TRACE ON, before the write, so the step that does not happen is visible.
console.log("traceOn:", JSON.stringify(await ev(`
  try { window.__craftworks.db.traceOn(true); return "on"; } catch (e) { return String(e.message); }`)));
await ev(`
  const i = document.querySelector(".rt-comp input[name=title]");
  i.value = "probe " + Date.now();
  document.querySelector(".rt-comp button.pri").click();
  return 1;`);
for (const at of [2, 5, 10, 20, 40, 70]) {
  await sleep(at === 2 ? 2000 : 3000 * (at > 10 ? 4 : 1));
  console.log(`write t+${at}s:`, JSON.stringify(await ev(`
    const db = window.__craftworks.db;
    let trace = null, unusable = null;
    try { trace = db.trace(); } catch (e) { trace = String(e.message); }
    try { unusable = JSON.parse(window.__craftworks.session?.unusable?.() ?? "[]"); } catch (_) {}
    return {
      chips: [...document.querySelectorAll(".rt-comp .rt-state")].map(e => e.textContent),
      rows: document.querySelectorAll("tbody tr").length,
      stats: db.stats(),
      live: db.liveMode?.(),
      trace: trace ? JSON.stringify(trace).slice(0, 1400) : null,
      unusable,
    };`)));
}
for (const at of []) {
  await sleep(at === 5 ? 5000 : (at - (at === 10 ? 5 : at === 20 ? 10 : at === 35 ? 20 : at === 60 ? 35 : 60)) * 1000);
  console.log(`t+${at}s:`, JSON.stringify(await ev(`
    return { btn: document.getElementById("publish")?.textContent,
             phase: window.__craftworks?.phase,
             comps: document.querySelectorAll(".rt-comp").length,
             inputs: document.querySelectorAll(".rt-comp input").length,
             errs: [...document.querySelectorAll(".rt-err, .empty")].map(e => e.textContent).filter(Boolean),
             canvas: document.getElementById("canvas")?.innerHTML?.slice(0, 300) };`)));
}
console.log("\n--- node console tail ---\n" + nodeOut.join("").split("\n").filter(l => !/RATE LIMIT/.test(l)).slice(-25).join("\n"));
process.exit(0);
