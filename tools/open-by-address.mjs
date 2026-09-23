// builder#104's ACCEPTANCE, live: publish on node A from the builder; open the
// app BY ADDRESS through node B in a FRESH browser profile.
//
// Two PRIVATE linked 0.2.136 nodes (A a gateway with a transport key, B joins
// it), explicit dirs, --disable-auto-update, named ports that refuse the
// owner's 7509/7609. Prints each step's evidence and exits non-zero on any
// failed check. Run: `node tools/open-by-address.mjs` (BUDGET_MS to extend).
import { openPageHost, openFreshBrowser, spawnNode } from "../tests/page-host.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = { ws: 17521, net: 37521, gatewayKey: true }, B = { ws: 17531, net: 37531 };
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 600_000);
const host = await openPageHost("open-by-address", { node: A, budgetMs: BUDGET_MS });
const nodeA = host.node;
let nodeB = null, fresh = null, failed = 0;
const check = (ok, what, evidence) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${evidence === undefined ? "" : `  — ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`}`);
};
/** Poll `expr` in `tab` until it is truthy, or `ms` passes; the last value either way. */
async function until(tab, expr, ms, everyMs = 1000) {
  const end = Date.now() + ms;
  let v;
  do { v = await tab.evaluate(expr).catch(e => ({ error: e.message })); if (v && !v.error) return v; await sleep(everyMs); } while (Date.now() < end);
  return v;
}

/** `until`, reading inside the node's sandboxed app frame. */
async function untilIn(tab, expr, ms, everyMs = 1000, frame = "__sandbox=1") {
  const end = Date.now() + ms;
  let v;
  do { v = await tab.evaluateIn(frame, expr).catch(e => ({ error: e.message })); if (v && !v.error) return v; await sleep(everyMs); } while (Date.now() < end);
  return v;
}

try {
  nodeB = await spawnNode("open-by-address: node B", { ...B, joins: nodeA });
  // If the run is cut short (its budget), B and the visitor's browser must not
  // outlive it: killed by their recorded PIDs on the way out.
  process.on("exit", () => { for (const pid of [nodeB?.pid, fresh?.pid]) { try { if (pid) process.kill(pid, "SIGKILL"); } catch (_) {} } });
  console.log(`A pid ${nodeA.pid} ws ${A.ws} (gateway, key ${nodeA.publicKey.slice(0, 12)}…); B pid ${nodeB.pid} ws ${B.ws} joins A`);
  await sleep(4000);

  // ---- 1. PUBLISH ON A, from the builder ------------------------------------
  const builder = await host.tab("builder");
  const APP = { name: "Notes", components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
    schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } } };
  await builder.evaluate(`window.location.href = ${JSON.stringify(`http://127.0.0.1:${host.port}/#node=${A.ws}&preview=1&app=` + encodeURIComponent(JSON.stringify(APP)))}; return 1;`);
  await until(builder, `return document.querySelectorAll(".rt-comp input[name=title]").length > 0;`, 30_000);
  for (const title of ["alpha", "beta"]) {
    await builder.evaluate(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = ${JSON.stringify(title)}; document.querySelector(".rt-comp button.pri").click(); return 1;`);
    await sleep(500);
  }
  const tPublish = Date.now();
  await builder.evaluate(`document.getElementById("publish").click(); return 1;`);
  const pub = await until(builder, `const p = window.__craftworksPublished; return p ? p : null;`, 180_000, 500);
  const publishMs = Date.now() - tPublish;
  check(!!pub?.address, `Publish on A put the app on the network, in ${publishMs} ms (click → both containers acknowledged)`, pub?.address ? { address: pub.address, head: pub.head?.slice(0, 16) } : pub);
  if (!pub?.address) throw new Error("nothing to open");
  const addrLine = await builder.evaluate(`return document.getElementById("app-address")?.title ?? null;`);
  check(addrLine === pub.address, "the builder SHOWS the address", addrLine);
  console.log(`SIZES  app container ${pub.containerBytes} B (bundle ${pub.bundleBytes} B, stored xz); artefacts container ${pub.artefactsBytes} B, once per SDK build`);
  // DIAGNOSIS: HOLD_MS keeps both nodes up after the publish, the address
  // printed, so a person can probe them directly.
  if (process.env.HOLD_MS) {
    console.log(`HOLD ${pub.address} A=${A.ws} B=${B.ws} for ${process.env.HOLD_MS} ms`);
    await sleep(Number(process.env.HOLD_MS));
  }
  const rowsOnA = await until(builder, `const r = [...document.querySelectorAll("tbody tr td:first-child")].map(td => td.textContent); return r.length >= 2 ? r : null;`, 60_000);
  console.log("A shows:", JSON.stringify(rowsOnA));

  // ---- 2. OPEN BY ADDRESS THROUGH B, in a FRESH profile ---------------------
  fresh = await openFreshBrowser("open-by-address: visitor");
  const visitor = await fresh.tab("visitor");
  const url = `http://127.0.0.1:${B.ws}/v1/contract/web/${pub.address}/`;
  const t0 = Date.now();
  await visitor.evaluate(`window.location.href = ${JSON.stringify(url)}; return 1;`);
  const seen = await untilIn(visitor, `const r = [...document.querySelectorAll("tbody tr td:first-child")].map(td => td.textContent); return r.length >= 2 ? r : null;`, 150_000, 250, `${pub.address}/?__sandbox=1`);
  const firstLoadMs = Date.now() - t0;
  // WHAT THE VISITOR'S PAGE SAID — the evidence when it shows nothing.
  console.log("visitor page:", JSON.stringify(await visitor.evaluateIn(`${pub.address}/?__sandbox=1`, `return { status: document.getElementById("status")?.textContent, cls: document.getElementById("status")?.className, body: document.body?.innerText?.slice(0, 300) };`)));
  const shown = await visitor.evaluateIn(`${pub.address}/?__sandbox=1`, `return { status: document.getElementById("status")?.textContent, view: document.querySelector(".rt-view")?.textContent ?? null, inputs: document.querySelectorAll("input").length, writing: [...document.querySelectorAll("button")].map(b => b.textContent).filter(t => ["Add","Save changes","Edit","Delete","Cancel"].includes(t)) };`);
  check(Array.isArray(seen) && ["alpha", "beta"].every(x => seen.includes(x)), `B (fresh profile) shows A's ${Array.isArray(seen) ? seen.length : 0} rows; first load ${firstLoadMs} ms (navigate → rows painted)`, seen);
  check(shown.inputs === 0 && shown.writing.length === 0 && !!shown.view, "B renders a VIEW: no input, no writing button", shown);

  // ---- 3. A WRITES; B sees it after a reload --------------------------------
  // THE PROBE ON (core dev): if the write is slow, the trace says what it is
  // waiting on — the PUT, Held, the signature, or the read-back.
  console.log("trace on:", JSON.stringify(await builder.evaluate(`try { window.__craftworks.db.traceOn(true); return "on"; } catch (e) { return String(e.message); }`)));
  await builder.evaluate(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = "gamma"; document.querySelector(".rt-comp button.pri").click(); return 1;`);
  const tWrite = Date.now();
  // PUBLISHED, by the store's own count: every write not yet published is
  // `pendingWrites`. (Not by the row's chip: a non-live table keeps a
  // published row at "saving" — builder#107, on main too, not this issue's.)
  const savedOnA = await until(builder, `const s = window.__craftworks.db.stats(); return [...document.querySelectorAll("tbody tr")].some(tr => tr.textContent.includes("gamma")) && s.pendingWrites === 0 && s.pendingBytes === 0 ? s : null;`, 240_000, 250);
  check(!!savedOnA, `A's new row published (the store: nothing pending) in ${Date.now() - tWrite} ms`, savedOnA);
  const savedMs = Date.now() - tWrite;
  // What the write was waiting on, every time: slow or not, the trace is the number.
  console.log("A's write trace:", JSON.stringify(await builder.evaluate(`
    const db = window.__craftworks.db;
    let trace = null, unusable = null;
    try { trace = db.trace(); } catch (e) { trace = String(e.message); }
    try { unusable = window.__craftworks.session?.unusable?.() ?? null; } catch (_) {}
    return { stats: (() => { try { return db.stats(); } catch (e) { return String(e.message); } })(), trace: trace ? JSON.stringify(trace).slice(0, 3000) : null, unusable };`)));
  if (!savedOnA) console.log("A's rows:", JSON.stringify(await builder.evaluate(`return [...document.querySelectorAll("tbody tr")].map(tr => tr.textContent).slice(0, 5);`)));
  let onB = null, reloads = 0;
  const tSaved = Date.now();
  for (let i = 0; i < 8 && !onB; i += 1) {
    reloads += 1;
    await visitor.evaluate(`location.reload(); return 1;`);
    onB = await untilIn(visitor, `return [...document.querySelectorAll("tbody tr td:first-child")].some(td => td.textContent === "gamma") || null;`, 20_000, 250, `${pub.address}/?__sandbox=1`);
  }
  check(!!onB, `B sees A's new row after a reload: ${Date.now() - tSaved} ms after A's store had it published (${reloads} reload(s))`);

  // ---- 4. A BYTE THAT DOES NOT MATCH ITS HASH IS REFUSED --------------------
  // The same app, but its artefacts.json names a WRONG hash for the SDK wasm.
  const tampered = await builder.evaluate(`
    const { publishApp } = await import("./publish-app.js");
    const { loadSdk } = await import("./sdk-loader.js");
    const sdk = await loadSdk();
    const m = await (await fetch("./sdk/artefacts.json")).json();
    const h = window.__craftworks.session;
    const read = async p => { const r = await fetch("./" + p); return /\\.(js|html|json)$/.test(p) ? r.text() : new Uint8Array(await r.arrayBuffer()); };
    const bad = { ...m, sdk: { ...m.sdk, sha256: "0".repeat(64) } };
    const missing = { ...m, sdk: { ...m.sdk, file: "no-such-artefact.wasm" } };
    const app = ${JSON.stringify(APP)};
    // The SAME app id the real publication used (one project, one app).
    const appId = window.__craftworksPublished.app;
    const a = await publishApp({ ...app, name: "Notes (tampered)" }, { sdk, session: h.session, headId: h.headId(), appId, manifest: bad, read, subtle: crypto.subtle });
    const b = await publishApp({ ...app, name: "Notes (missing)" }, { sdk, session: h.session, headId: h.headId(), appId, manifest: missing, read, subtle: crypto.subtle });
    return { mismatch: a.address, missing: b.address, sha: m.sdk.sha256 };`);
  for (const [kind, addr, expect] of [["mismatch", tampered.mismatch, /sha256|hash|mismatch|does not match/i], ["missing", tampered.missing, /no-such-artefact\.wasm/]]) {
    const tab = await fresh.tab(`visitor-${kind}`);
    await tab.evaluate(`window.location.href = ${JSON.stringify(`http://127.0.0.1:${B.ws}/v1/contract/web/${addr}/`)}; return 1;`);
    const st = await untilIn(tab, `const s = document.getElementById("status"); return s?.className === "bad" ? s.textContent : null;`, 90_000, 2000, `${addr}/?__sandbox=1`);
    const rows = await tab.evaluateIn(`${addr}/?__sandbox=1`, `return document.querySelectorAll("tbody tr").length;`);
    check(typeof st === "string" && expect.test(st) && rows === 0,
      kind === "mismatch" ? "an SDK wasm that does not match its hash is REFUSED and the app does not load" : "an unresolvable artefact is NAMED, with its hash",
      st);
  }
} catch (e) {
  failed += 1;
  console.log(`FAIL  the run stopped: ${e.message}`);
} finally {
  if (fresh) await fresh.stop();
  if (nodeB) { const r = await nodeB.stop(); if (!r.gone || r.held.length) failed += 1; }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  await host.done(failed ? 1 : 0);
}
