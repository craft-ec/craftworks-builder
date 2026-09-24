// builder#104's ACCEPTANCE, live: publish on node A from the builder; open the
// app BY ADDRESS through node B in a FRESH browser profile.
//
// Two PRIVATE linked 0.2.136 nodes (A a gateway with a transport key, B joins
// it), explicit dirs, --disable-auto-update, named ports that refuse the
// owner's 7509/7609. Prints each step's evidence and exits non-zero on any
// failed check. Run: `node tools/open-by-address.mjs` (BUDGET_MS to extend).
//
// REAL NETWORK: with RN_PUB=<ws> and RN_VIS=<ws> (and RN_PUB_LABEL /
// RN_VIS_LABEL) it spawns NO node and runs across two EXISTING nodes — the
// SDK's tools/realnet/run.sh sets them, with the server's node behind an SSH
// tunnel. The builder refuses to publish to the owner's ports (publish.js
// RESERVED_PORTS), so there the publisher is the server's node.
import { execFileSync } from "node:child_process";
import { openPageHost, openFreshBrowser, spawnNode } from "../tests/page-host.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const REAL = !!(process.env.RN_PUB && process.env.RN_VIS);
const A = REAL ? { ws: Number(process.env.RN_PUB), label: process.env.RN_PUB_LABEL ?? "publisher" } : { ws: 17521, net: 37521, gatewayKey: true, label: "A" };
const B = REAL ? { ws: Number(process.env.RN_VIS), label: process.env.RN_VIS_LABEL ?? "visitor" } : { ws: 17531, net: 37531, label: "B" };
// THE OWNER'S NODES are refused HERE, not only by a wrapper that calls this:
// a direct run cannot skip it. REALNET_OWNER_OK=1 only with the core dev's
// approval for that run.
if (REAL) {
  for (const n of [A, B]) {
    if ([7509, 7609].includes(n.ws) && process.env.REALNET_OWNER_OK !== "1") {
      console.log(`refusing ${n.ws} (${n.label}): it is the owner's node; REALNET_OWNER_OK=1 only with the core dev's approval for this run`);
      process.exit(2);
    }
  }
}
// EVERY publish this run makes, and how many retries each needed. First-try
// reliability is what Phase 3 must prove, so a publish that needed a retry
// fails the run — it is counted and said, never passed silently.
const publishes = [];
const BUDGET_MS = Number(process.env.BUDGET_MS ?? (REAL ? 1_100_000 : 600_000));
const host = await openPageHost("open-by-address", { ...(REAL ? {} : { node: A }), budgetMs: BUDGET_MS });
const nodeA = host.node;
let nodeB = null, fresh = null, ownerBrowser = null, failed = 0;
const check = (ok, what, evidence) => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${evidence === undefined ? "" : `  — ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`}`);
};
/**
 * Watch a publish the builder is running until it has put the app on the
 * network (`__craftworksPublished`), printing its own words as they change.
 * On the real network a stalled handoff is RETRIED as a person would (at most
 * 3), each retry a FINDING, and every publish is recorded with its retries.
 */
async function watchPublish(what, t0) {
  let pub = null, lastLine = "", retries = 0;
  const end = Date.now() + (REAL ? 500_000 : 180_000);
  while (Date.now() < end) {
    pub = await builderTab.evaluate(`return window.__craftworksPublished ?? null;`).catch(() => null);
    if (pub) break;
    const line = JSON.stringify(await builderTab.evaluate(`const b = document.getElementById("publish"); return { label: b?.textContent, note: document.getElementById("publish-note")?.textContent?.slice(0, 300) || undefined, notice: document.getElementById("storage-note")?.textContent?.slice(0, 300) || undefined };`).catch(e => ({ error: e.message })));
    if (line !== lastLine) { console.log(`  +${Date.now() - t0} ms ${what}: ${line}`); lastLine = line; }
    if (REAL && line.includes("Try publishing again") && retries < 3) {
      retries += 1;
      console.log(`  FINDING  the ${what} stopped (above) and is retried by a click, ${retries} of 3`);
      await builderTab.evaluate(`document.getElementById("publish").click(); return 1;`);
      lastLine = "";
    }
    await sleep(500);
  }
  publishes.push({ what, retries, ok: !!pub });
  return { pub, retries };
}
let builderTab = null;

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
  if (!REAL) nodeB = await spawnNode("open-by-address: node B", { ...B, joins: nodeA });
  // If the run is cut short (its budget), B and the visitor's browser must not
  // outlive it: killed by their recorded PIDs on the way out.
  process.on("exit", () => { for (const pid of [nodeB?.pid, fresh?.pid]) { try { if (pid) process.kill(pid, "SIGKILL"); } catch (_) {} } });
  console.log(REAL ? `REAL NETWORK: publisher ${A.label} ws ${A.ws}; visitor ${B.label} ws ${B.ws}; ${new Date().toISOString()}` : `A pid ${nodeA.pid} ws ${A.ws} (gateway, key ${nodeA.publicKey.slice(0, 12)}…); B pid ${nodeB.pid} ws ${B.ws} joins A`);
  await sleep(4000);

  // ---- 1. PUBLISH ON A, from the builder ------------------------------------
  const builder = await host.tab("builder");
  builderTab = builder;
  const APP = { name: "Notes", components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
    schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } } };
  await builder.navigate(`http://127.0.0.1:${host.port}/#node=${A.ws}&preview=1&app=` + encodeURIComponent(JSON.stringify(APP)));
  await until(builder, `return document.querySelectorAll(".rt-comp input[name=title]").length > 0;`, 30_000);
  for (const title of ["alpha", "beta"]) {
    await builder.evaluate(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = ${JSON.stringify(title)}; document.querySelector(".rt-comp button.pri").click(); return 1;`);
    await sleep(500);
  }
  const tPublish = Date.now();
  await builder.evaluate(`document.getElementById("publish").click(); return 1;`);
  // The publish's own words while it runs, each change printed; on the real
  // network a record handoff that stalls is RETRIED as a person would (at most
  // 3), and each retry is printed as a finding, not hidden.
  const { pub, retries } = await watchPublish("publish", tPublish);
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
  await visitor.navigate(url);
  const seen = await untilIn(visitor, `const r = [...document.querySelectorAll("tbody tr td:first-child")].map(td => td.textContent); return r.length >= 2 ? r : null;`, 150_000, 250, `${pub.address}/?__sandbox=1`);
  const firstLoadMs = Date.now() - t0;
  // WHAT THE VISITOR'S PAGE SAID — the evidence when it shows nothing.
  console.log("visitor page:", JSON.stringify(await visitor.evaluateIn(`${pub.address}/?__sandbox=1`, `return { status: document.getElementById("status")?.textContent, cls: document.getElementById("status")?.className, body: document.body?.innerText?.slice(0, 300) };`)));
  const shown = await visitor.evaluateIn(`${pub.address}/?__sandbox=1`, `return { status: document.getElementById("status")?.textContent, view: document.querySelector(".rt-view")?.textContent ?? null, inputs: document.querySelectorAll("input").length, writing: [...document.querySelectorAll("button")].map(b => b.textContent).filter(t => ["Add","Save changes","Edit","Delete","Cancel"].includes(t)) };`);
  check(Array.isArray(seen) && ["alpha", "beta"].every(x => seen.includes(x)), `B (fresh profile) shows A's ${Array.isArray(seen) ? seen.length : 0} rows; first load ${firstLoadMs} ms (navigate → rows painted)`, seen);
  check(shown.inputs === 0 && shown.writing.length === 0 && !!shown.view, "B renders a VIEW: no input, no writing button", shown);
  // WHERE THE OPEN WENT (the loader's phase stamps): recorded, each once, in the order the loader runs them.
  const ph = await visitor.evaluateIn(`${pub.address}/?__sandbox=1`, `return globalThis.__craftworksOpen ?? null;`);
  const order = ["loader", "files", "sdk", "opened", "rows"];
  check(!!ph && order.every(k => Number.isInteger(ph[k])) && order.every((k, i) => i === 0 || ph[order[i - 1]] <= ph[k]) && Number.isInteger(ph.head),
    `B's first load says where it went (ms since its app frame began): ${ph ? Object.entries(ph).map(([k, v]) => `${k} ${v}`).join(", ") : "no phases"}`, ph);

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
  // THE VIEW IS LIVE BY DEFAULT (builder#114): the app declares no `live`,
  // and B's OPEN view shows A's new row with no reload.
  const visFrame = `127.0.0.1:${B.ws}/v1/contract/web/${pub.address}/?__sandbox=1`;
  const visRows = () => visitor.evaluateIn(visFrame, `return [...document.querySelectorAll("tbody tr td:first-child")].map(td => td.textContent);`).catch(() => []);
  async function seenOnVisitor(titles, ms) {
    const t0 = Date.now(); let rows = [];
    while (Date.now() - t0 < ms) { rows = await visRows(); if (titles.every(x => rows.includes(x))) return { ms: Date.now() - t0, rows: rows.length }; await sleep(500); }
    return { ms: null, missing: titles.filter(x => !rows.includes(x)).length, rows: rows.length };
  }
  const live = await seenOnVisitor(["gamma"], 90_000);
  check(live.ms !== null, `${B.label}'s OPEN view shows the new row with NO reload (a view is live by default): ${live.ms} ms after ${A.label}'s store had it published`, live);
  let onB = null, reloads = 0;
  const tSaved = Date.now();
  for (let i = 0; i < 8 && !onB; i += 1) {
    reloads += 1;
    await visitor.reload();
    onB = await untilIn(visitor, `return [...document.querySelectorAll("tbody tr td:first-child")].some(td => td.textContent === "gamma") || null;`, 20_000, 250, `${pub.address}/?__sandbox=1`);
  }
  check(!!onB, `B sees A's new row after a reload: ${Date.now() - tSaved} ms after A's store had it published (${reloads} reload(s))`);

  // ---- 3b. THE PUBLISHER'S OWN SITE, A BURST, AND A RELOADED BUILDER --------
  // (builder#114) The publisher opening its published site on ITS OWN node
  // gets it EDITABLE; another person's node keeps the VIEW. In its OWN
  // browser, and every frame named by port: the two pages share a path, and
  // a bare path once read the publisher's frame as the visitor's.
  const addIn = (tab, fr, title) => {
    const js = `const i = document.querySelector(".rt-comp input[name=title]"); i.value = ${JSON.stringify(title)}; i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector(".rt-comp button.pri").click(); return 1;`;
    return fr ? tab.evaluateIn(fr, js) : tab.evaluate(js);
  };
  ownerBrowser = await openFreshBrowser("open-by-address: the publisher's own site");
  const owner = await ownerBrowser.tab("owner");
  const ownFrame = `127.0.0.1:${A.ws}/v1/contract/web/${pub.address}/?__sandbox=1`;
  const tOwner = Date.now();
  await owner.navigate(`http://127.0.0.1:${A.ws}/v1/contract/web/${pub.address}/`);
  const ownerUi = await untilIn(owner, `return document.querySelectorAll(".rt-comp input[name=title]").length > 0 ? { buttons: [...document.querySelectorAll("button")].map(b => b.textContent).filter(t => ["Add","Edit","Delete"].includes(t)), view: !!document.querySelector(".rt-view") } : null;`, 120_000, 500, ownFrame);
  check(!!ownerUi && ownerUi.buttons.includes("Add") && !ownerUi.view, `the publisher's own site on ${A.label} opens EDITABLE (in ${Date.now() - tOwner} ms)`, ownerUi ?? await owner.evaluateIn(ownFrame, `return document.body?.innerText?.slice(0, 200);`).catch(e => e.message));
  const visUi = await visitor.evaluateIn(visFrame, `return { inputs: document.querySelectorAll("input").length, view: !!document.querySelector(".rt-view") };`);
  check(visUi.inputs === 0 && visUi.view, `the same site on ${B.label} (another person's node) is still a VIEW`, visUi);
  if (ownerUi) {
    await addIn(owner, ownFrame, "from the publisher's site");
    const seen = await seenOnVisitor(["from the publisher's site"], 90_000);
    check(seen.ms !== null, `a row added on the publisher's own site shows on ${B.label}'s open view, no reload: ${seen.ms} ms`, seen);
    const burst = Array.from({ length: 10 }, (_, i) => `burst ${i}`);
    const tB = Date.now();
    for (const b of burst) { await addIn(owner, ownFrame, b); await sleep(150); }
    const ownerSaved = await untilIn(owner, `const r = [...document.querySelectorAll("tbody tr")].filter(tr => tr.textContent.startsWith("burst ")); return r.length === 10 && r.every(tr => tr.textContent.includes("saved")) ? Date.now() : null;`, 180_000, 500, ownFrame);
    const burstSeen = await seenOnVisitor(burst, 180_000);
    check(!!ownerSaved && burstSeen.ms !== null, `a burst of 10 rows from the publisher's site: all saved at ${ownerSaved ? ownerSaved - tB : null} ms; all on ${B.label}'s open view ${burstSeen.ms} ms after that`, { burstSeen });
  }
  // A published project REOPENS CONNECTED: reload the builder, no Publish
  // click — and a row added there reaches B's open view. It is a publish too,
  // counted with the rest.
  const tReload = Date.now();
  await builder.reload();
  await sleep(1500);
  const again = await watchPublish("reopen", tReload);
  const addrNow = await builder.evaluate(`return document.getElementById("tree-addr")?.textContent ?? "";`);
  check(!!again.pub && !/not published|not connected/.test(addrNow), `after a reload the builder reopens CONNECTED, with no click, in ${Date.now() - tReload} ms`, addrNow);
  if (again.pub) {
    await until(builder, `return document.querySelectorAll(".rt-comp input[name=title]").length > 0 || null;`, 30_000, 500);
    // WHAT THE ADD HITS, said before and after (a row from the reloaded
    // builder once never reached the other node): the canvas's backend and
    // address line, the row's own state in the builder, and — with HEAD_READ
    // set to the SDK's head-read probe — the publisher's head seq on its node.
    const headSeq = () => {
      if (!process.env.HEAD_READ) return "HEAD_READ unset";
      try { return execFileSync(process.env.HEAD_READ, [String(A.ws), pub.head], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/^port \d+: /, ""); } catch (e) { return "probe failed"; }
    };
    const canvas = () => builder.evaluate(`return { addr: document.getElementById("tree-addr")?.textContent, publish: document.getElementById("publish")?.textContent, rows: [...document.querySelectorAll("tbody tr")].map(tr => tr.textContent.trim().replace(/\\s+/g, " ")).filter(t => t.startsWith("after the builder reload")) };`).catch(e => ({ error: e.message }));
    console.log("  BEFORE the add:", JSON.stringify(await canvas()), "| head", headSeq());
    await addIn(builder, null, "after the builder reload");
    for (const at of [2_000, 10_000, 30_000]) { await sleep(at === 2_000 ? 2_000 : at - (at === 10_000 ? 2_000 : 10_000)); console.log(`  +${at} ms after the add:`, JSON.stringify(await canvas()), "| head", headSeq()); }
    const rl = await seenOnVisitor(["after the builder reload"], 60_000);
    check(rl.ms !== null, `a row added in the reloaded builder shows on ${B.label}'s open view, no reload: ${rl.ms === null ? null : rl.ms + 30_000} ms`, rl);
  }

  // ---- 4. A BYTE THAT DOES NOT MATCH ITS HASH IS REFUSED --------------------
  // The same app, but its artefacts.json names a WRONG hash for the SDK wasm.
  const tampered = await builder.evaluate(`
    const { publishApp } = await import("./publish-app.js");
    const { loadSdk } = await import("./sdk-loader.js");
    const sdk = await loadSdk();
    const { readBuilderFile: read, readSdkManifest } = await import("./builder-files.js");
    const m = await readSdkManifest();
    const h = window.__craftworks.session;
    const bad = { ...m, sdk: { ...m.sdk, sha256: "0".repeat(64) } };
    const missing = { ...m, sdk: { ...m.sdk, file: "no-such-artefact.wasm" } };
    const app = ${JSON.stringify(APP)};
    // The SAME app id the real publication used (one project, one app).
    const appId = window.__craftworksPublished.app;
    const a = await publishApp({ ...app, name: "Notes (tampered)" }, { sdk, session: h.session, headId: h.headId(), headSeq: h.headSeq(), appId, manifest: bad, read, subtle: crypto.subtle });
    const b = await publishApp({ ...app, name: "Notes (missing)" }, { sdk, session: h.session, headId: h.headId(), headSeq: h.headSeq(), appId, manifest: missing, read, subtle: crypto.subtle });
    // Published at a version no node has yet (craftworks-sdk#349): a view of it WAITS.
    const ahead = h.headSeq() + 1000;
    const c = await publishApp({ ...app, name: "Notes (ahead)" }, { sdk, session: h.session, headId: h.headId(), headSeq: ahead, appId, manifest: m, read, subtle: crypto.subtle });
    return { mismatch: a.address, missing: b.address, ahead: c.address, aheadSeq: ahead, sha: m.sdk.sha256 };`, { ms: BUDGET_MS });
  for (const [kind, addr, expect] of [["mismatch", tampered.mismatch, /sha256|hash|mismatch|does not match/i], ["missing", tampered.missing, /no-such-artefact\.wasm/]]) {
    const tab = await fresh.tab(`visitor-${kind}`);
    await tab.navigate(`http://127.0.0.1:${B.ws}/v1/contract/web/${addr}/`);
    const st = await untilIn(tab, `const s = document.getElementById("status"); return s?.className === "bad" ? s.textContent : null;`, 90_000, 2000, `${addr}/?__sandbox=1`);
    const rows = await tab.evaluateIn(`${addr}/?__sandbox=1`, `return document.querySelectorAll("tbody tr").length;`);
    check(typeof st === "string" && expect.test(st) && rows === 0,
      kind === "mismatch" ? "an SDK wasm that does not match its hash is REFUSED and the app does not load" : "an unresolvable artefact is NAMED, with its hash",
      st);
  }
  // ---- 5. PUBLISHED AT A NEWER VERSION THAN THE NODE HOLDS, THE VIEW WAITS --
  // (craftworks-sdk#349) and says so in the SDK's words — never the older
  // head's rows. Watched for 30 s: a wait has no end (rule 8), so the check is
  // that it is STILL waiting, with no row, when the watch ends.
  {
    const tab = await fresh.tab("visitor-ahead");
    const frame = `${tampered.ahead}/?__sandbox=1`;
    await tab.navigate(`http://127.0.0.1:${B.ws}/v1/contract/web/${tampered.ahead}/`);
    const said = await untilIn(tab, `const s = document.getElementById("status")?.textContent ?? ""; return s.includes("waiting for the published version") ? s : null;`, 90_000, 1000, frame);
    await sleep(30_000);
    const after = await tab.evaluateIn(frame, `return { status: document.getElementById("status")?.textContent ?? null, rows: document.querySelectorAll("tbody tr").length };`);
    check(typeof said === "string" && said.includes(`seq ${tampered.aheadSeq}`) && /waiting for the published version/.test(after.status ?? "") && after.rows === 0,
      "an app published at a newer version than the node holds WAITS for it, says so, and shows no older rows", { said, after });
  }
} catch (e) {
  failed += 1;
  console.log(`FAIL  the run stopped: ${e.message}`);
} finally {
  if (fresh) await fresh.stop();
  if (ownerBrowser) await ownerBrowser.stop();
  const first = publishes.filter(p => p.ok && !p.retries).length;
  console.log(`\npublish: ${first}/${publishes.length} first try, ${publishes.filter(p => p.retries).length} retried${publishes.some(p => !p.ok) ? `, ${publishes.filter(p => !p.ok).length} never published` : ""}`);
  if (publishes.some(p => p.retries)) {
    failed += 1;
    console.log("FAIL  a publish needed a retry: first-try reliability is what this run proves");
  }
  if (nodeB) { const r = await nodeB.stop(); if (!r.gone || r.held.length) failed += 1; }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  await host.done(failed ? 1 : 0);
}
