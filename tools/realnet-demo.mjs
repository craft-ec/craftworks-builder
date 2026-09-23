// THE OWNER'S DEMO, on the real network (CLAUDE.md, Delivery 0): publish on
// the server's node (B), open it by address through this machine's node (A),
// and on the publisher's own site ADD, EDIT and DELETE a row, each checked on
// A's OPEN view — and a VISITOR on a third node (V) writes to their OWN tree
// through the app's viewer-source components (a guestbook), which survives a
// reload and leaves the publisher's data untouched. One PASS/FAIL line per
// step, with what it measured. Run it through `tools/realnet.sh`, which owns
// the lock, the tunnel, the visitor's node and the cleanup proof; this script
// starts NO node.
//
//   RN_PUB=<B's ws, through the tunnel> RN_VIS=<A's ws> RN_VIEWER=<V's ws> node tools/realnet-demo.mjs
//
// A is only READ: its page GETs, subscribes and asks A's signer whose node it
// is — nothing is ever typed on A. The visitor who WRITES does it on V, a
// private node on this machine joined to the real network. When A is one of the owner's ports that needs REALNET_OWNER_OK=1, the
// owner's standing permission for these runs.
import { openPageHost, openFreshBrowser } from "../tests/page-host.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const B = { ws: Number(process.env.RN_PUB), label: process.env.RN_PUB_LABEL ?? "B (publisher)" };
const A = { ws: Number(process.env.RN_VIS), label: process.env.RN_VIS_LABEL ?? "A (visitor)" };
const V = { ws: Number(process.env.RN_VIEWER), label: process.env.RN_VIEWER_LABEL ?? "V (a visitor who writes)" };
for (const n of [A, B, V]) if (!Number.isInteger(n.ws) || n.ws <= 0) { console.log("FAIL  RN_PUB, RN_VIS and RN_VIEWER must each name a ws port"); process.exit(2); }
if ([7509, 7609].includes(V.ws)) { console.log(`FAIL  ${V.ws} is the owner's node: the visitor who WRITES is never on it`); process.exit(2); }
if ([7509, 7609].includes(B.ws)) { console.log(`FAIL  ${B.ws} is the owner's node: the demo never PUBLISHES there`); process.exit(2); }
if ([7509, 7609].includes(A.ws) && process.env.REALNET_OWNER_OK !== "1") {
  console.log(`FAIL  ${A.ws} is the owner's node: reading through it needs REALNET_OWNER_OK=1 (the owner's standing permission for real-network runs)`);
  process.exit(2);
}
// Each step's wait for an ANSWER from the network: long, because a hotspot's
// tail is long (block arrival p90 ~31 s), and said as "not within T" if hit.
const STEP_MS = Number(process.env.STEP_MS ?? 180_000);
const host = await openPageHost("realnet-demo", { budgetMs: Number(process.env.BUDGET_MS ?? 1_500_000) });
let pubBrowser = null, visBrowser = null, vBrowser = null, failed = 0, stepN = 0;
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
// EVERY CHECK NAMES ITS COMPONENT, by the heading the runtime gives it
// ("Form · notes", "Table · guests"): a page holds two forms and two tables.
const comp = (label, domain) => `[...document.querySelectorAll(".rt-comp")].find(s => (s.querySelector("h4")?.textContent ?? "").startsWith(${JSON.stringify(`${label} · ${domain}`)}))`;
const titles = domain => `return [...(${comp("Table", domain)}?.querySelectorAll("tbody tr td:first-child") ?? [])].map(td => td.textContent);`;
const TITLES = titles("notes");
const hasIn = (domain, want, gone = []) => `const r = [...(${comp("Table", domain)}?.querySelectorAll("tbody tr td:first-child") ?? [])].map(td => td.textContent); return (${JSON.stringify(want)}.every(t => r.includes(t)) && !${JSON.stringify(gone)}.some(t => r.includes(t))) || null;`;
const has = (want, gone = []) => hasIn("notes", want, gone);
const addTo = (domain, t) => `const f = ${comp("Form", domain)}; const i = f?.querySelector("input[name=title]"); if (!i) return "no form for ${domain}"; i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event("input", { bubbles: true })); f.querySelector("button.pri").click(); return "ok";`;
const savedIn = (domain, t) => `return [...(${comp("Table", domain)}?.querySelectorAll("tbody tr") ?? [])].some(tr => tr.querySelector("td")?.textContent === ${JSON.stringify(t)} && tr.textContent.includes("saved")) || null;`;
const tag = Date.now().toString(36);
const [ADDED, EDIT_FROM, EDIT_TO, DELETED, GUEST] = [`added ${tag}`, `to-edit ${tag}`, `edited ${tag}`, `to-delete ${tag}`, `guest ${tag}`];

try {
  console.log(`publisher ${B.label} ws ${B.ws}; visitor ${A.label} ws ${A.ws}; rows tagged ${tag}; each step waits at most ${STEP_MS / 1000} s`);
  // 1. PUBLISH ON B, from the builder.
  const builder = await host.tab("builder");
  // The publisher's notes, and a GUESTBOOK whose data is each VISITOR's own
  // (`source: "viewer"`, builder#113/#115): every person writes their own tree.
  const APP = { name: `Notes ${tag}`, components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" },
    { type: "form", domain: "guests", source: "viewer" }, { type: "table", domain: "guests", source: "viewer" }],
    schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] }, guests: { type: "Guest", fields: [{ name: "title", kind: "text", required: true }] } } };
  await builder.evaluate(`window.location.href = ${JSON.stringify(`http://127.0.0.1:${host.port}/#node=${B.ws}&preview=1&app=` + encodeURIComponent(JSON.stringify(APP)))}; return 1;`);
  await until(builder, `return (${comp("Form", "notes")}?.querySelector("input[name=title]") && 1) || null;`, 30_000);
  for (const t of ["alpha", "beta"]) { await builder.evaluate(addTo("notes", t)); await sleep(500); }
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
  // The PUBLISHER's components are a view here: no notes form, and the notes
  // table carries no writing button. (The guestbook is the visitor's own and
  // may be writable; nothing is typed on A.)
  const visUi = await vis.evaluateIn(frameOf(A.ws), `const t = ${comp("Table", "notes")}; return { notesForm: !!${comp("Form", "notes")}, notesButtons: [...(t?.querySelectorAll("button") ?? [])].map(b => b.textContent).filter(x => ["Edit", "Delete"].includes(x)).length, status: document.getElementById("status")?.textContent?.slice(0, 200) };`).catch(e => ({ error: e.message }));
  step(!!seen && visUi.notesForm === false && visUi.notesButtons === 0, `${A.label} opens it by address and shows the publisher's rows, as a VIEW (${Date.now() - t2} ms)`, seen ? visUi : { status: visUi, rows: await vis.evaluateIn(frameOf(A.ws), TITLES).catch(() => null) });

  // 3. THE PUBLISHER'S OWN SITE ON B opens EDITABLE, in its own browser.
  pubBrowser = await openFreshBrowser("realnet-demo: the publisher's own site on B");
  const own = await pubBrowser.tab("owner");
  const t3 = Date.now();
  await own.evaluate(`window.location.href = ${JSON.stringify(url(B.ws))}; return 1;`);
  const editable = await until(own, `return (${comp("Form", "notes")}?.querySelector("input[name=title]") && 1) || null;`, STEP_MS, 500, frameOf(B.ws));
  if (!step(!!editable, `the publisher's own site on ${B.label} opens EDITABLE (${Date.now() - t3} ms)`, editable ? undefined : await own.evaluateIn(frameOf(B.ws), `return document.body?.innerText?.slice(0, 200);`).catch(e => e.message))) throw new Error("no editable site to write from");
  const onSite = js => own.evaluateIn(frameOf(B.ws), js);
  const add = t => onSite(addTo("notes", t));
  const savedOnSite = t => until(own, savedIn("notes", t), STEP_MS, 500, frameOf(B.ws));
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
  await change("EDIT a row", () => onSite(`const tr = [...(${comp("Table", "notes")}?.querySelectorAll("tbody tr") ?? [])].find(r => r.querySelector("td")?.textContent === ${JSON.stringify(EDIT_FROM)}); if (!tr) return "no row"; [...tr.querySelectorAll("button")].find(b => b.textContent === "Edit").click(); await new Promise(r => setTimeout(r, 300)); const i = ${comp("Form", "notes")}?.querySelector("input[name=title]"); if (i.value !== ${JSON.stringify(EDIT_FROM)}) return "not editing"; i.value = ${JSON.stringify(EDIT_TO)}; i.dispatchEvent(new Event("input", { bubbles: true })); [...document.querySelectorAll("button")].find(b => b.textContent === "Save changes").click(); return "ok";`),
    [EDIT_TO], [EDIT_FROM], EDIT_TO);
  await change("DELETE a row", () => onSite(`const tr = [...(${comp("Table", "notes")}?.querySelectorAll("tbody tr") ?? [])].find(r => r.querySelector("td")?.textContent === ${JSON.stringify(DELETED)}); if (!tr) return "no row"; [...tr.querySelectorAll("button")].find(b => b.textContent === "Delete").click(); return "ok";`),
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

  // 9. A VISITOR WRITES THEIR OWN TREE (Phase 3 item 5): on V — a node that
  // is neither the publisher's nor the owner's — the publisher's rows are a
  // view, and the guestbook (source: viewer) takes the visitor's entry into
  // the visitor's OWN tree: saved, shown, still there after a reload, and the
  // publisher's data untouched.
  vBrowser = await openFreshBrowser("realnet-demo: a visitor who writes, on V");
  const vt = await vBrowser.tab("visitor-writer");
  const t9 = Date.now();
  await vt.evaluate(`window.location.href = ${JSON.stringify(url(V.ws))}; return 1;`);
  const vReady = await until(vt, `return (${comp("Form", "guests")}?.querySelector("input[name=title]") && !${comp("Form", "notes")} && ${JSON.stringify(["alpha", "beta"])}.every(t => [...(${comp("Table", "notes")}?.querySelectorAll("tbody tr td:first-child") ?? [])].some(td => td.textContent === t)) && 1) || null;`, STEP_MS, 500, frameOf(V.ws));
  if (!step(!!vReady, `${V.label} opens it: the publisher's rows as a view, and the guestbook writable (${Date.now() - t9} ms)`, vReady ? undefined : await vt.evaluateIn(frameOf(V.ws), `return { status: document.getElementById("status")?.textContent?.slice(0, 300), mounted: document.querySelectorAll(".rt-comp").length, headings: [...document.querySelectorAll(".rt-comp h4")].map(h => h.textContent), body: document.body?.innerText?.slice(0, 200) };`).catch(e => e.message))) throw new Error("no guestbook to write");
  const t10 = Date.now();
  const typed = await vt.evaluateIn(frameOf(V.ws), addTo("guests", GUEST));
  const vSaved = await until(vt, savedIn("guests", GUEST), STEP_MS, 500, frameOf(V.ws));
  step(typed === "ok" && !!vSaved, `the visitor on ${V.label} adds a guestbook entry to their OWN tree: saved and shown (${Date.now() - t10} ms)`, vSaved ? undefined : { typed, guests: await vt.evaluateIn(frameOf(V.ws), titles("guests")).catch(() => null), body: await vt.evaluateIn(frameOf(V.ws), `return document.body?.innerText?.slice(0, 300);`).catch(e => e.message) });
  const t11 = Date.now();
  await vt.evaluate(`location.reload(); return 1;`);
  const kept = await until(vt, hasIn("guests", [GUEST]), STEP_MS, 500, frameOf(V.ws));
  step(!!kept, `the visitor's entry survives a RELOAD of ${V.label} (${Date.now() - t11} ms)`, kept ? undefined : await vt.evaluateIn(frameOf(V.ws), titles("guests")).catch(e => e.message));
  // The publisher's data is untouched: B's own notes and A's view of them
  // hold exactly the publisher's rows, and the guest entry is in neither.
  const pubNotes = await own.evaluateIn(frameOf(B.ws), TITLES).catch(() => null);
  const aNotes = await vis.evaluateIn(frameOf(A.ws), TITLES).catch(() => null);
  const want = ["alpha", "beta", ADDED, EDIT_TO].sort();
  step(JSON.stringify([...(pubNotes ?? [])].sort()) === JSON.stringify(want) && JSON.stringify([...(aNotes ?? [])].sort()) === JSON.stringify(want),
    `the publisher's notes are untouched by the visitor's write (on ${B.label}'s site and ${A.label}'s view)`, { publisher: pubNotes, onA: aNotes });
} catch (e) {
  console.log(`FAIL  the run stopped after step ${stepN}: ${e.message}`);
  failed += 1;
} finally {
  if (visBrowser) await visBrowser.stop();
  if (pubBrowser) await pubBrowser.stop();
  if (vBrowser) await vBrowser.stop();
  console.log(failed ? `DEMO: breaks — ${failed} step(s) failed` : `DEMO: passes — all ${stepN} steps`);
  await host.done(failed ? 1 : 0);
}
