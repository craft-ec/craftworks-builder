// THE OWNER'S DEMO, on the real network (CLAUDE.md, Delivery 0): publish on
// the server's node (B), open it by address through this machine's node (A),
// and on the app owner's site ADD, EDIT and DELETE a row, each checked on
// A's OPEN view — and a USER on a third node (V) writes to their OWN tree
// through the app's own-data (`mine`) components (a guestbook), which survives a
// reload and leaves the app's data untouched. One PASS/FAIL line per
// step, with what it measured. Run it through `tools/realnet.sh`, which owns
// the lock, the tunnel, the user's node and the cleanup proof; this script
// starts NO node.
//
//   RN_B=<B's ws, through the tunnel> RN_A=<A's ws> RN_V=<V's ws> node tools/realnet-demo.mjs
//
// A is only READ: its page GETs, subscribes and asks A's signer whose node it
// is — nothing is ever typed on A. The user who WRITES does it on V, a
// private node on this machine joined to the real network. When A is one of the owner's ports that needs REALNET_OWNER_OK=1, the
// owner's standing permission for these runs.
import { openPageHost, openFreshBrowser } from "../tests/page-host.mjs";
import { spawnSync } from "node:child_process";
import { captureWire } from "./wire-capture.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Every CLIENT connected to the node on `port` now: `{ pid, command, peer }` (lsof, read-only). */
function clientsOn(port) {
  const r = spawnSync("lsof", ["-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:ESTABLISHED", "-F", "pcn"], { encoding: "utf8" });
  const out = [];
  let pid = null, command = null;
  for (const line of (r.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c")) command = line.slice(1);
    // The CLIENT end: a connection whose REMOTE is the node's port.
    else if (line.startsWith("n") && line.endsWith(`->127.0.0.1:${port}`)) out.push({ pid, command, peer: line.slice(1) });
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const B = { ws: Number(process.env.RN_B), label: process.env.RN_B_LABEL ?? "B (the app owner's node)" };
const A = { ws: Number(process.env.RN_A), label: process.env.RN_A_LABEL ?? "A (another user's node)" };
const V = { ws: Number(process.env.RN_V), label: process.env.RN_V_LABEL ?? "V (a user who writes their own data)" };
for (const n of [A, B, V]) if (!Number.isInteger(n.ws) || n.ws <= 0) { console.log("FAIL  RN_B, RN_A and RN_V must each name a ws port"); process.exit(2); }
if ([7509, 7609].includes(V.ws)) { console.log(`FAIL  ${V.ws} is the owner's node: the user who WRITES is never on it`); process.exit(2); }
if ([7509, 7609].includes(B.ws)) { console.log(`FAIL  ${B.ws} is the owner's node: the demo never PUBLISHES there`); process.exit(2); }
if ([7509, 7609].includes(A.ws) && process.env.REALNET_OWNER_OK !== "1") {
  console.log(`FAIL  ${A.ws} is the owner's node: reading through it needs REALNET_OWNER_OK=1 (the owner's standing permission for real-network runs)`);
  process.exit(2);
}
// Each step's wait for an ANSWER from the network: long, because a hotspot's
// tail is long (block arrival p90 ~31 s), and said as "not within T" if hit.
const STEP_MS = Number(process.env.STEP_MS ?? 180_000);
const host = await openPageHost("realnet-demo", { budgetMs: Number(process.env.BUDGET_MS ?? 1_500_000) });
// THE A-SIDE CHECK (no user-data writes through a view): every frame A's and
// V's browsers send their node, raw (wire-capture.mjs), classified afterwards
// by the SDK's ONE decoder (`probe classify-frames`, RN_CLASSIFY) — the step
// in progress names each frame's window. MUTANT (V only, never through A):
// REALNET_MUTANT=view-write | view-register-put.
const WIRE_DIR = process.env.RN_WIRE_DIR;
const MUTANT = process.env.REALNET_MUTANT ?? "";
const windowOf = () => String(stepN + 1);
const wires = [];
let pubBrowser = null, visBrowser = null, vBrowser = null, failed = 0, stepN = 0;
let vOpenWindow = null, vWriteWindow = null;
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
  console.log(`app owner ${B.label} ws ${B.ws}; user ${A.label} ws ${A.ws}; rows tagged ${tag}; each step waits at most ${STEP_MS / 1000} s`);
  // 1. PUBLISH ON B, from the builder.
  const builder = await host.tab("builder");
  // The app's notes, and a GUESTBOOK whose data is each USER's own
  // (`source: "mine"`, builder#113/#115): every person writes their own tree.
  const APP = { name: `Notes ${tag}`, components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" },
    { type: "form", domain: "guests", source: "mine" }, { type: "table", domain: "guests", source: "mine" }],
    schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] }, guests: { type: "Guest", fields: [{ name: "title", kind: "text", required: true }] } } };
  await builder.navigate(`http://127.0.0.1:${host.port}/#node=${B.ws}&preview=1&app=` + encodeURIComponent(JSON.stringify(APP)));
  await until(builder, `return (${comp("Form", "notes")}?.querySelector("input[name=title]") && 1) || null;`, 30_000);
  for (const t of ["alpha", "beta"]) { await builder.evaluate(addTo("notes", t)); await sleep(500); }
  const t1 = Date.now();
  await builder.evaluate(`document.getElementById("publish").click(); return 1;`);
  const pub = await until(builder, `return window.__craftworksPublished ?? null;`, STEP_MS * 3);
  if (!step(!!pub?.address, `publish on ${B.label} from the builder (${Date.now() - t1} ms)`, pub?.address ?? await builder.evaluate(`return document.getElementById("publish-note")?.textContent?.slice(0, 300) ?? null;`).catch(() => null))) throw new Error("nothing to open");
  const url = ws => `http://127.0.0.1:${ws}/v1/contract/web/${pub.address}/`;
  const frameOf = ws => `127.0.0.1:${ws}/v1/contract/web/${pub.address}/?__sandbox=1`;

  // 2. OPEN BY ADDRESS THROUGH A, in a fresh profile: the rows, as a view.
  visBrowser = await openFreshBrowser("realnet-demo: another user on A");
  wires.push({ label: "A", file: join(WIRE_DIR, "wire-A.jsonl"), cap: await captureWire(visBrowser.debug, { out: join(WIRE_DIR, "wire-A.jsonl"), windowOf, label: "A" }) });
  const vis = await visBrowser.tab("user-a");
  const t2 = Date.now();
  await vis.navigate(url(A.ws));
  const seen = await until(vis, has(["alpha", "beta"]), STEP_MS, 500, frameOf(A.ws));
  // The APP's components are a view here: no notes form, and the notes
  // table carries no writing button. (The guestbook is the user's own and
  // may be writable; nothing is typed on A.)
  const visUi = await vis.evaluateIn(frameOf(A.ws), `const t = ${comp("Table", "notes")}; return { notesForm: !!${comp("Form", "notes")}, notesButtons: [...(t?.querySelectorAll("button") ?? [])].map(b => b.textContent).filter(x => ["Edit", "Delete"].includes(x)).length, status: document.getElementById("status")?.textContent?.slice(0, 200) };`).catch(e => ({ error: e.message }));
  step(!!seen && visUi.notesForm === false && visUi.notesButtons === 0, `${A.label} opens it by address and shows the app's rows, as a VIEW (${Date.now() - t2} ms)`, seen ? visUi : { status: visUi, rows: await vis.evaluateIn(frameOf(A.ws), TITLES).catch(() => null) });

  // 3. THE APP OWNER'S SITE ON B opens EDITABLE, in its own browser.
  pubBrowser = await openFreshBrowser("realnet-demo: the app owner's site on B");
  const own = await pubBrowser.tab("owner");
  const t3 = Date.now();
  await own.navigate(url(B.ws));
  const editable = await until(own, `return (${comp("Form", "notes")}?.querySelector("input[name=title]") && 1) || null;`, STEP_MS, 500, frameOf(B.ws));
  if (!step(!!editable, `the app owner's site on ${B.label} opens EDITABLE (${Date.now() - t3} ms)`, editable ? undefined : await own.evaluateIn(frameOf(B.ws), `return document.body?.innerText?.slice(0, 200);`).catch(e => e.message))) throw new Error("no editable site to write from");
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
      onA ? undefined : { did, site: await onSite(TITLES).catch(() => null), onA: await vis.evaluateIn(frameOf(A.ws), TITLES).catch(() => null) });
  }
  // 4–6. ADD, EDIT, DELETE.
  await add(EDIT_FROM); await add(DELETED);
  await savedOnSite(EDIT_FROM); await savedOnSite(DELETED);
  await change("ADD a row", () => add(ADDED), [ADDED, EDIT_FROM, DELETED], [], ADDED);
  await change("EDIT a row", () => onSite(`const tr = [...(${comp("Table", "notes")}?.querySelectorAll("tbody tr") ?? [])].find(r => r.querySelector("td")?.textContent === ${JSON.stringify(EDIT_FROM)}); if (!tr) return "no row"; [...tr.querySelectorAll("button")].find(b => b.textContent === "Edit").click(); await new Promise(r => setTimeout(r, 300)); const i = ${comp("Form", "notes")}?.querySelector("input[name=title]"); if (i.value !== ${JSON.stringify(EDIT_FROM)}) return "not editing"; i.value = ${JSON.stringify(EDIT_TO)}; i.dispatchEvent(new Event("input", { bubbles: true })); [...document.querySelectorAll("button")].find(b => b.textContent === "Save changes").click(); return "ok";`),
    [EDIT_TO], [EDIT_FROM], EDIT_TO);
  await change("DELETE a row", () => onSite(`const tr = [...(${comp("Table", "notes")}?.querySelectorAll("tbody tr") ?? [])].find(r => r.querySelector("td")?.textContent === ${JSON.stringify(DELETED)}); if (!tr) return "no row"; [...tr.querySelectorAll("button")].find(b => b.textContent === "Delete").click(); return "ok";`),
    [], [DELETED], null);

  // 7. A RELOADED reader reads all three from the network.
  const t7 = Date.now();
  await vis.reload();
  const reread = await until(vis, has(["alpha", "beta", ADDED, EDIT_TO], [EDIT_FROM, DELETED]), STEP_MS, 500, frameOf(A.ws));
  step(!!reread, `${A.label} RELOADED reads the add, the edit and the delete (${Date.now() - t7} ms)`, reread ? undefined : await vis.evaluateIn(frameOf(A.ws), TITLES).catch(e => e.message));

  // 8. The builder RELOADED reopens connected, and the rows are still there.
  const t8 = Date.now();
  await builder.reload();
  await sleep(1500);
  const again = await until(builder, `return window.__craftworksPublished ?? null;`, STEP_MS);
  const rows = again ? await until(builder, has([ADDED, EDIT_TO], [EDIT_FROM, DELETED]), STEP_MS) : null;
  step(!!again && !!rows && again.address === pub.address, `the builder RELOADED reopens connected at the same address, with the rows (${Date.now() - t8} ms)`, { address: again?.address === pub.address ? "same" : again?.address, put: again?.put, rows: !!rows });

  // 9. A USER WRITES THEIR OWN TREE (Phase 3 item 5): on V — a node that
  // is neither the app owner's nor the machine owner's — the app's rows are a
  // view, and the guestbook (source: mine) takes the user's entry into
  // the user's OWN tree: saved, shown, still there after a reload, and the
  // app's data untouched.
  // NOTHING IS CONNECTED TO V BEFORE ITS PAGE: V is this run's own node, and
  // nothing of this run has opened it yet — a client here is a stray (an
  // earlier run's browser found V's port and provisioned its signer before
  // step 9). Named, and the run fails.
  const strays = clientsOn(V.ws);
  step(strays.length === 0, `no client is connected to ${V.label} before its page opens (${strays.length} found)`, strays.length ? strays.map(c => ({ ...c, command: spawnSync("ps", ["-o", "command=", "-p", String(c.pid)], { encoding: "utf8" }).stdout.trim().slice(0, 200) })) : undefined);
  vBrowser = await openFreshBrowser("realnet-demo: a user who writes their own data, on V");
  wires.push({ label: "V", file: join(WIRE_DIR, "wire-V.jsonl"), cap: await captureWire(vBrowser.debug, { out: join(WIRE_DIR, "wire-V.jsonl"), windowOf, label: "V" }) });
  const vt = await vBrowser.tab("user-v");
  const t9 = Date.now();
  // V's two windows, taken from the step counter WHEN THEY START, never
  // written as numbers: a step added before them (#133's stray check) shifted
  // both, and the control then read V's OPEN window for V's write — 0 seen.
  vOpenWindow = windowOf();
  await vt.navigate(url(V.ws));
  // THE MUTANTS, inside V's OPEN window (step 9), never on A: the check must SEE them.
  const mutate = async () => {
    if (MUTANT === "view-write") return vt.evaluateIn(frameOf(V.ws), addTo("guests", `mutant ${tag}`));
    if (MUTANT === "view-register-put") {
      const framed = spawnSync(process.env.RN_FRAME_PUT, [process.env.RN_REGISTER_WASM, "01", "02"], { encoding: "utf8" });
      if (framed.status !== 0) throw new Error(`frame-put: ${framed.stderr}`);
      const b64 = framed.stdout.trim().split("\n");
      return vt.evaluateIn(frameOf(V.ws), `const ws = new WebSocket("ws://127.0.0.1:${V.ws}/v1/contract/command?encodingProtocol=native"); ws.binaryType = "arraybuffer"; await new Promise(ok => ws.onopen = ok); for (const f of ${JSON.stringify(b64)}) ws.send(Uint8Array.from(atob(f), c => c.charCodeAt(0))); await new Promise(ok => setTimeout(ok, 1000)); ws.close(); return "sent";`);
    }
    return null;
  };
  const vReady = await until(vt, `return (${comp("Form", "guests")}?.querySelector("input[name=title]") && !${comp("Form", "notes")} && ${JSON.stringify(["alpha", "beta"])}.every(t => [...(${comp("Table", "notes")}?.querySelectorAll("tbody tr td:first-child") ?? [])].some(td => td.textContent === t)) && 1) || null;`, STEP_MS, 500, frameOf(V.ws));
  if (vReady && MUTANT) console.log(`MUTANT ${MUTANT}: ${JSON.stringify(await mutate().catch(e => e.message))}`);
  if (!step(!!vReady, `${V.label} opens it: the app's rows as a view, and the guestbook writable (${Date.now() - t9} ms)`, vReady ? undefined : await vt.evaluateIn(frameOf(V.ws), `return { status: document.getElementById("status")?.textContent?.slice(0, 300), mounted: document.querySelectorAll(".rt-comp").length, headings: [...document.querySelectorAll(".rt-comp h4")].map(h => h.textContent), body: document.body?.innerText?.slice(0, 200) };`).catch(e => e.message))) throw new Error("no guestbook to write");
  const t10 = Date.now();
  vWriteWindow = windowOf();
  const typed = await vt.evaluateIn(frameOf(V.ws), addTo("guests", GUEST));
  const vSaved = await until(vt, savedIn("guests", GUEST), STEP_MS, 500, frameOf(V.ws));
  step(typed === "ok" && !!vSaved, `the user on ${V.label} adds a guestbook entry to their OWN tree: saved and shown (${Date.now() - t10} ms)`, vSaved ? undefined : { typed, guests: await vt.evaluateIn(frameOf(V.ws), titles("guests")).catch(() => null), body: await vt.evaluateIn(frameOf(V.ws), `return document.body?.innerText?.slice(0, 300);`).catch(e => e.message) });
  const t11 = Date.now();
  await vt.reload();
  const kept = await until(vt, hasIn("guests", [GUEST]), STEP_MS, 500, frameOf(V.ws));
  step(!!kept, `the user's entry survives a RELOAD of ${V.label} (${Date.now() - t11} ms)`, kept ? undefined : await vt.evaluateIn(frameOf(V.ws), titles("guests")).catch(e => e.message));
  // The app's data is untouched: B's own notes and A's view of them
  // hold exactly the app's rows, and the guest entry is in neither.
  const pubNotes = await own.evaluateIn(frameOf(B.ws), TITLES).catch(() => null);
  const aNotes = await vis.evaluateIn(frameOf(A.ws), TITLES).catch(() => null);
  const want = ["alpha", "beta", ADDED, EDIT_TO].sort();
  step(JSON.stringify([...(pubNotes ?? [])].sort()) === JSON.stringify(want) && JSON.stringify([...(aNotes ?? [])].sort()) === JSON.stringify(want),
    `the app's notes are untouched by the user's write (on ${B.label}'s site and ${A.label}'s view)`, { ownerSite: pubNotes, onA: aNotes });
  wireCheck();
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

// THE A-SIDE CHECK's verdicts, from the SDK's one decoder: A's browser only ever READS, so every frame it sent is a
// view step's; V's step 9 is a view window (the mutants' target), step 10 the control (a write must be SEEN).
function classified(file) {
  let input = "";
  try { input = readFileSync(file, "utf8"); } catch { return []; }
  const r = spawnSync(process.env.RN_CLASSIFY, ["--block-code", process.env.RN_BLOCK_WASM], { input, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`classify-frames failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map(l => JSON.parse(l));
}
function wireCheck() {
  for (const w of wires) w.cap.stop();
  const byLabel = Object.fromEntries(wires.map(w => [w.label, { stats: w.cap.stats(), rows: classified(w.file) }]));
  const A = byLabel.A ?? { rows: [], stats: {} }, Vw = byLabel.V ?? { rows: [], stats: {} };
  const fails = A.rows.filter(r => r.verdict === "fail");
  const repairs = A.rows.filter(r => r.verdict === "report").length;
  const unpaused = [...(A.stats.unpaused ?? []), ...(Vw.stats.unpaused ?? [])];
  if (unpaused.length) step(false, `a frame or worker started UNPAUSED: a socket it opened at once could be unseen by the capture`, unpaused);
  const unresumed = [...(A.stats.unresumed ?? []), ...(Vw.stats.unresumed ?? [])];
  if (unresumed.length) step(false, `a target the capture paused was NOT resumed: it never ran, and its network is unseen`, unresumed);
  // SAID, not failed: targets that closed while being attached, and Chrome's
  // own targets that carry no page's sockets.
  for (const [w, st] of [["A", A.stats], ["V", Vw.stats]]) {
    if (st.gone?.length || st.notOurs?.length) console.log(`NOTE  capture ${w}: ${st.gone?.length ?? 0} target(s) closed while attached, ${st.notOurs?.length ?? 0} not ours (${[...new Set((st.notOurs ?? []).map(x => x.type))].join(", ")}), network not captured`);
  }
  step(A.rows.length > 0 && fails.length === 0,
    // The BOUNDARY (architect): this proves every target in THIS run's browser sent no user-data write through A;
    // it cannot see a writer outside that browser (an earlier orphan, another harness, a native tool).
    `A view steps: ${fails.length ? `${fails.length} user-data write(s) through A` : "no write through A"} from this run's browser (${repairs} repair PUTs)`,
    fails.length ? fails.slice(0, 8) : A.rows.length ? { requests: A.rows.length, sockets: A.stats.sockets, targets: A.stats.targets } : "NOTHING was captured from A: the check saw no frame at all");
  const v9 = Vw.rows.filter(r => r.window === vOpenWindow && r.verdict === "fail");
  // V's OPEN window (open → before its first user write). REPORT-ONLY until sdk#350 (opening commits nothing on a
  // key-holding node); REALNET_V_OPEN_ENFORCE=1 makes it a step. A MUTANT run is the proof the capture and the decoder
  // SEE a view's write: its count must be non-zero, or the run fails.
  const v9line = `V open window (${vOpenWindow}): ${v9.length} user-data writes${MUTANT ? ` [MUTANT ${MUTANT}]` : ""}`;
  if (MUTANT) step(v9.length > 0, `${v9line}: the mutant's write is SEEN`, v9.length ? v9.slice(0, 4) : "the mutant wrote and NOTHING was seen");
  else if (process.env.REALNET_V_OPEN_ENFORCE === "1") step(v9.length === 0, v9line, v9.length ? v9.slice(0, 8) : undefined);
  else console.log(`NOTE  ${v9line} (report-only until sdk#350)${v9.length ? ": " + JSON.stringify(v9.slice(0, 4)) : ""}`);
  const v10 = Vw.rows.filter(r => r.window === vWriteWindow);
  const seen = { blockPuts: v10.filter(r => r.op === "put" && r.code === "block").length, commits: v10.filter(r => r.op === "update" || (r.op === "signer" && r.signer === "sign") || (r.op === "put" && r.code === "other")).length };
  step(seen.blockPuts >= 1 && seen.commits >= 1, `THE CONTROL: V's write (step ${vWriteWindow}) is SEEN on the wire: ${seen.blockPuts} block PUT(s), ${seen.commits} sign/update/register PUT(s)`, seen);
  console.log(`WIRE  frames kept in ${WIRE_DIR}`);
}
