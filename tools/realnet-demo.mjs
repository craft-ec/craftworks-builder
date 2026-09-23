// THE OWNER'S DEMO, on the real network (CLAUDE.md, Delivery 0): publish on
// the server's node (B), open it by address through this machine's node (A),
// and on the publisher's own site ADD, EDIT and DELETE a row, each checked on
// A's OPEN view. One PASS/FAIL line per step, with what it measured. Run it
// through `tools/realnet.sh`, which owns the lock, the tunnel and the cleanup
// proof; this script starts NO node.
//
//   RN_PUB=<B's ws, through the tunnel> RN_VIS=<A's ws> node tools/realnet-demo.mjs
//
// A is only READ: its page GETs, subscribes and asks A's signer whose node it
// is. When A is one of the owner's ports that needs REALNET_OWNER_OK=1, the
// owner's standing permission for these runs.
import { openPageHost, openFreshBrowser } from "../tests/page-host.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const B = { ws: Number(process.env.RN_PUB), label: process.env.RN_PUB_LABEL ?? "B (publisher)" };
const A = { ws: Number(process.env.RN_VIS), label: process.env.RN_VIS_LABEL ?? "A (visitor)" };
for (const n of [A, B]) if (!Number.isInteger(n.ws) || n.ws <= 0) { console.log("FAIL  RN_PUB and RN_VIS must both name a ws port"); process.exit(2); }
if ([7509, 7609].includes(B.ws)) { console.log(`FAIL  ${B.ws} is the owner's node: the demo never PUBLISHES there`); process.exit(2); }
if ([7509, 7609].includes(A.ws) && process.env.REALNET_OWNER_OK !== "1") {
  console.log(`FAIL  ${A.ws} is the owner's node: reading through it needs REALNET_OWNER_OK=1 (the owner's standing permission for real-network runs)`);
  process.exit(2);
}
// Each step's wait for an ANSWER from the network: long, because a hotspot's
// tail is long (block arrival p90 ~31 s), and said as "not within T" if hit.
const STEP_MS = Number(process.env.STEP_MS ?? 180_000);
const host = await openPageHost("realnet-demo", { budgetMs: Number(process.env.BUDGET_MS ?? 1_500_000) });
let pubBrowser = null, visBrowser = null, failed = 0, stepN = 0;
const step = (ok, what, evidence) => {
  stepN += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${stepN}. ${what}${evidence === undefined ? "" : `  — ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`}`);
  return ok;
};
async function until(tab, expr, ms, every = 500, frame = null) {
  const end = Date.now() + ms; let v;
  do { v = await (frame ? tab.evaluateIn(frame, expr) : tab.evaluate(expr)).catch(e => ({ error: e.message })); if (v && !v.error) return v; await sleep(every); } while (Date.now() < end);
  return null;
}
const TITLES = `return [...document.querySelectorAll("tbody tr td:first-child")].map(td => td.textContent);`;
const has = (want, gone = []) => `const r = [...document.querySelectorAll("tbody tr td:first-child")].map(td => td.textContent); return (${JSON.stringify(want)}.every(t => r.includes(t)) && !${JSON.stringify(gone)}.some(t => r.includes(t))) || null;`;
const tag = Date.now().toString(36);
const [ADDED, EDIT_FROM, EDIT_TO, DELETED] = [`added ${tag}`, `to-edit ${tag}`, `edited ${tag}`, `to-delete ${tag}`];

try {
  console.log(`publisher ${B.label} ws ${B.ws}; visitor ${A.label} ws ${A.ws}; rows tagged ${tag}; each step waits at most ${STEP_MS / 1000} s`);
  // 1. PUBLISH ON B, from the builder.
  const builder = await host.tab("builder");
  const APP = { name: `Notes ${tag}`, components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
    schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } } };
  await builder.evaluate(`window.location.href = ${JSON.stringify(`http://127.0.0.1:${host.port}/#node=${B.ws}&preview=1&app=` + encodeURIComponent(JSON.stringify(APP)))}; return 1;`);
  await until(builder, `return document.querySelectorAll(".rt-comp input[name=title]").length > 0 || null;`, 30_000);
  for (const t of ["alpha", "beta"]) { await builder.evaluate(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = ${JSON.stringify(t)}; document.querySelector(".rt-comp button.pri").click(); return 1;`); await sleep(500); }
  const t1 = Date.now();
  await builder.evaluate(`document.getElementById("publish").click(); return 1;`);
  const pub = await until(builder, `return window.__craftworksPublished ?? null;`, STEP_MS * 3);
  if (!step(!!pub?.address, `publish on ${B.label} from the builder (${Date.now() - t1} ms)`, pub?.address ?? await builder.evaluate(`return document.getElementById("publish-note")?.textContent?.slice(0, 300) ?? null;`).catch(() => null))) throw new Error("nothing to open");
  const url = ws => `http://127.0.0.1:${ws}/v1/contract/web/${pub.address}/`;
  const frameOf = ws => `127.0.0.1:${ws}/v1/contract/web/${pub.address}/?__sandbox=1`;

  // 2. OPEN BY ADDRESS THROUGH A, in a fresh profile: the rows, as a view.
  visBrowser = await openFreshBrowser("realnet-demo: visitor on A");
  const vis = await visBrowser.tab("visitor");
  const t2 = Date.now();
  await vis.evaluate(`window.location.href = ${JSON.stringify(url(A.ws))}; return 1;`);
  const seen = await until(vis, has(["alpha", "beta"]), STEP_MS, 500, frameOf(A.ws));
  const visUi = await vis.evaluateIn(frameOf(A.ws), `return { inputs: document.querySelectorAll("input").length, view: !!document.querySelector(".rt-view"), status: document.getElementById("status")?.textContent?.slice(0, 200) };`).catch(e => ({ error: e.message }));
  step(!!seen && visUi.inputs === 0, `${A.label} opens it by address and shows the rows, as a VIEW (${Date.now() - t2} ms)`, seen ? visUi : { status: visUi, rows: await vis.evaluateIn(frameOf(A.ws), TITLES).catch(() => null) });

  // 3. THE PUBLISHER'S OWN SITE ON B opens EDITABLE, in its own browser.
  pubBrowser = await openFreshBrowser("realnet-demo: the publisher's own site on B");
  const own = await pubBrowser.tab("owner");
  const t3 = Date.now();
  await own.evaluate(`window.location.href = ${JSON.stringify(url(B.ws))}; return 1;`);
  const editable = await until(own, `return (document.querySelectorAll(".rt-comp input[name=title]").length > 0 && !document.querySelector(".rt-view")) || null;`, STEP_MS, 500, frameOf(B.ws));
  if (!step(!!editable, `the publisher's own site on ${B.label} opens EDITABLE (${Date.now() - t3} ms)`, editable ? undefined : await own.evaluateIn(frameOf(B.ws), `return document.body?.innerText?.slice(0, 200);`).catch(e => e.message))) throw new Error("no editable site to write from");
  const onSite = js => own.evaluateIn(frameOf(B.ws), js);
  const add = t => onSite(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector(".rt-comp button.pri").click(); return 1;`);
  const savedOnSite = t => until(own, `return [...document.querySelectorAll("tbody tr")].some(tr => tr.querySelector("td")?.textContent === ${JSON.stringify(t)} && tr.textContent.includes("saved")) || null;`, STEP_MS, 500, frameOf(B.ws));
  // Each change: saved on the site, then on A's OPEN view with no reload.
  async function change(what, doIt, want, gone, savedTitle) {
    const t0 = Date.now();
    const did = await doIt();
    const saved = savedTitle ? await savedOnSite(savedTitle) : true;
    const tSaved = Date.now();
    const onA = saved ? await until(vis, has(want, gone), STEP_MS, 250, frameOf(A.ws)) : null;
    step(!!saved && !!onA, `${what}: saved on ${B.label}'s site ${saved ? `in ${tSaved - t0} ms` : "NOT within " + STEP_MS / 1000 + " s"}; on ${A.label}'s open view ${onA ? `${Date.now() - tSaved} ms after` : "NOT within " + STEP_MS / 1000 + " s"}`,
      onA ? undefined : { did, site: await onSite(TITLES).catch(() => null), visitor: await vis.evaluateIn(frameOf(A.ws), TITLES).catch(() => null) });
  }
  // 4–6. ADD, EDIT, DELETE.
  await add(EDIT_FROM); await add(DELETED);
  await savedOnSite(EDIT_FROM); await savedOnSite(DELETED);
  await change("ADD a row", () => add(ADDED), [ADDED, EDIT_FROM, DELETED], [], ADDED);
  await change("EDIT a row", () => onSite(`const tr = [...document.querySelectorAll("tbody tr")].find(r => r.querySelector("td")?.textContent === ${JSON.stringify(EDIT_FROM)}); if (!tr) return "no row"; [...tr.querySelectorAll("button")].find(b => b.textContent === "Edit").click(); await new Promise(r => setTimeout(r, 300)); const i = document.querySelector(".rt-comp input[name=title]"); if (i.value !== ${JSON.stringify(EDIT_FROM)}) return "not editing"; i.value = ${JSON.stringify(EDIT_TO)}; i.dispatchEvent(new Event("input", { bubbles: true })); [...document.querySelectorAll("button")].find(b => b.textContent === "Save changes").click(); return "ok";`),
    [EDIT_TO], [EDIT_FROM], EDIT_TO);
  await change("DELETE a row", () => onSite(`const tr = [...document.querySelectorAll("tbody tr")].find(r => r.querySelector("td")?.textContent === ${JSON.stringify(DELETED)}); if (!tr) return "no row"; [...tr.querySelectorAll("button")].find(b => b.textContent === "Delete").click(); return "ok";`),
    [], [DELETED], null);

  // 7. A RELOADED visitor reads all three from the network.
  const t7 = Date.now();
  await vis.evaluate(`location.reload(); return 1;`);
  const reread = await until(vis, has(["alpha", "beta", ADDED, EDIT_TO], [EDIT_FROM, DELETED]), STEP_MS, 500, frameOf(A.ws));
  step(!!reread, `${A.label} RELOADED reads the add, the edit and the delete (${Date.now() - t7} ms)`, reread ? undefined : await vis.evaluateIn(frameOf(A.ws), TITLES).catch(e => e.message));

  // 8. The builder RELOADED reopens connected, and the rows are still there.
  const t8 = Date.now();
  await builder.evaluate(`location.reload(); return 1;`);
  await sleep(1500);
  const again = await until(builder, `return window.__craftworksPublished ?? null;`, STEP_MS);
  const rows = again ? await until(builder, has([ADDED, EDIT_TO], [EDIT_FROM, DELETED]), STEP_MS) : null;
  step(!!again && !!rows && again.address === pub.address, `the builder RELOADED reopens connected at the same address, with the rows (${Date.now() - t8} ms)`, { address: again?.address === pub.address ? "same" : again?.address, put: again?.put, rows: !!rows });
} catch (e) {
  console.log(`FAIL  the run stopped after step ${stepN}: ${e.message}`);
  failed += 1;
} finally {
  if (visBrowser) await visBrowser.stop();
  if (pubBrowser) await pubBrowser.stop();
  console.log(failed ? `DEMO: breaks — ${failed} step(s) failed` : `DEMO: passes — all ${stepN} steps`);
  await host.done(failed ? 1 : 0);
}
