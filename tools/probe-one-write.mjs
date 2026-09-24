// ONE TAB, ONE PUBLISH, ONE WRITE — and say exactly what the page is.
//
//   node tools/probe-one-write.mjs
//
// The two-tab acceptance answers "did all seven items pass". This answers
// "what is the page actually doing", which is the question every failing run
// turned out to need. Two acceptance runs were spent on failures that said
// only "timed out waiting for X"; this prints the publish button, the phase,
// the component count, the chips, the stats, the live mode and its REASON,
// and the node's own console, every few seconds.
//
// Its own node, on its own ports, killed by recorded PID and verified gone —
// the shared helper in tests/page-host.mjs. Never 7509 or 7609.
import { openPageHost } from "../tests/page-host.mjs";
// ONE helper for the node, the page server, Chrome and the tab (builder#98):
// named node ports, refusing 7509/7609 and any busy port, three explicit dirs,
// killed by recorded PID and verified gone. The page server and Chrome take
// ports the OS picks, so this can run beside another session's tests.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WS = 17511, NET = 37511;
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 240_000);
const host = await openPageHost("probe-one-write", { node: { ws: WS, net: NET }, budgetMs: BUDGET_MS });
const { port: PAGE, node } = host;
console.log(`node pid ${node.pid} on ${WS} (tree ${node.dir})`);
const tab = await host.tab("probe");
const ev = expr => tab.evaluate(expr);
const APP = { name: "Two tabs",
  components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned", live: true }],
  schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } } };
await tab.navigate(`http://127.0.0.1:${PAGE}/#node=${WS}&preview=1&app=` + encodeURIComponent(JSON.stringify(APP)));
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
console.log("\n--- node console tail ---\n" + node.console().split("\n").filter(l => !/RATE LIMIT/.test(l)).slice(-25).join("\n"));
await host.done(0);
