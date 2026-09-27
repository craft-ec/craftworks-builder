// THE OWNER'S FIRST REPAIR GOAL, LIVE (main, 2026-09-27): publish, THEN the node loses data, and the Assets tab shows
// the loss and puts it back -- in the SDK's words.
//   1. A PLAIN builder publish on a private node P, every row "saved + backed up" (page.mjs's judgement).
//   2. P is STOPPED; `node-forget forget` (craftworks-sdk probe) removes from P's own store the blocks of `GROUPS`
//      groups, `m` each (repairable); P restarts on the same dirs. `node-forget check` then GETs them: every forgotten
//      block must answer NotFound -- the loss is P's, not a proxy's.
//   3. A FRESH reader (a new browser, the app's address on P) still loads every row: the reads rebuild from parity.
//   4. The builder's Assets tab (the same project, on P): its check on open says DEGRADED (N missing) -- capture 1;
//      Repair now -- REPAIRING, capture 2 -- then REPAIRED, missing = put back -- capture 3; checked again, WHOLE.
//   5. THE CONTROL: P stopped again, `m + 1` of one group forgotten, restarted: the tab's check says DAMAGED.
//
// Needs LIVE_FORGET=<node-forget> (craftworks-sdk probe/, built from the builder's pinned SDK).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../runner.mjs";
import { backedUp, browser, builderServer, comp, OPENER_TRACE, recordPageTrace, ROWS as ROW_STATES, sleep, STEP_MS, until } from "../page.mjs";

const APP = {
  name: "live assets-repair",
  components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
  schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }, { name: "body", kind: "text" }] } },
};
// A record larger than a leaf may inline (freenet-prolly MAX_INLINE, 1024 bytes) is its OWN block, and a leaf groups
// such values with parity -- the groups a node can lose and a reader rebuild. So each row carries a 1200-char body;
// its title (the table's first cell, what the row judge reads) stays short.
const BODY = "x".repeat(1200);
const addRow = t => `const f = ${comp("Form", "notes")}; const i = f?.querySelector("input[name=title]"), b = f?.querySelector("[name=body]"); if (!i || !b) return "no form"; i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event("input", { bubbles: true })); b.value = ${JSON.stringify(BODY)}; b.dispatchEvent(new Event("input", { bubbles: true })); f.querySelector("button.pri").click(); return "ok";`;
const ROWS = Number(process.env.LIVE_ASSETS_ROWS ?? 24);
const GROUPS = Number(process.env.LIVE_FORGET_GROUPS ?? 1);
const BLOCK_WASM = join(ROOT, "sdk", "block.wasm");
const oneLine = t => t.replace(/\s+/g, " ").slice(0, 300);

/** `node-forget args...`, its JSON lines. */
function forgetTool(args) {
  const r = spawnSync(process.env.LIVE_FORGET, args, { encoding: "utf8", timeout: 120_000 });
  const lines = (r.stdout ?? "").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  if (r.status !== 0) throw new Error(`node-forget ${args[0]} failed (${r.status}): ${(r.stderr ?? "").slice(-400)}`);
  return lines;
}

/** Open the Assets tab afresh (its check runs on open) and wait for the check's word; the row as the page shows it. */
async function assetsCheck(tab) {
  await tab.evaluate(`const v = document.getElementById("assets-view"); if (!v.hidden) document.getElementById("assets").click(); document.getElementById("assets").click(); return 1;`);
  const row = await until(tab, `const tr = document.querySelector("#assets-view tr[data-health]"); const w = tr?.dataset.health; return w && w !== "checking" && w !== "not checked" ? { word: w.toLowerCase(), text: tr.innerText } : null;`, STEP_MS * 2, null, 1000);
  if (!row) throw new Error(`the Assets tab's check did not end within ${(STEP_MS * 2) / 1000} s`);
  return row;
}

/** Press Repair now; the row while it runs, and once it ends. */
async function repairNow(tab) {
  await tab.evaluate(`document.getElementById("repair-now").click(); return 1;`);
  const running = await until(tab, `const tr = document.querySelector("#assets-view tr[data-health]"); return tr?.dataset.health === "repairing" ? { word: "repairing", text: tr.innerText } : null;`, 30_000, null, 200);
  const done = await until(tab, `const tr = document.querySelector("#assets-view tr[data-health]"); const w = tr?.dataset.health; return w && w !== "repairing" ? { word: w.toLowerCase(), text: tr.innerText } : null;`, STEP_MS * 2, null, 1000);
  if (!done) throw new Error(`the repair pass did not end within ${(STEP_MS * 2) / 1000} s`);
  return { running, done };
}

/** Point the SAME tab at P and wait until the published project is open again (its session has a head). */
async function reopen(tab, ws, what) {
  await tab.navigate(`${await tab.evaluate("return location.origin;")}/#node=${ws}`);
  if (!(await until(tab, `return globalThis.__craftworks?.session?.headId?.() || null;`, STEP_MS))) throw new Error(`${what}: the published project did not reopen on :${ws}`);
}

export async function run(ctx) {
  const { say } = ctx;
  if (!process.env.LIVE_FORGET || !existsSync(process.env.LIVE_FORGET)) throw new Error(`LIVE_FORGET must name node-forget (craftworks-sdk probe/); got ${process.env.LIVE_FORGET ?? "unset"}`);
  if (!existsSync(BLOCK_WASM)) throw new Error(`no ${BLOCK_WASM}: build the builder first`);
  // LOCAL: P never joins the network. On the network the peers the publish put a block on hand it back (run
  // 2026-09-27T08-16: P forgot 8, its GETs then answered found 6, silent 2) -- a loss must be of the only copy.
  let P = await ctx.nodes.start("P", { mode: "local" });

  // 1. A plain publish, in a browser kept for the whole run (the project is in its profile).
  const port = await builderServer(ctx);
  const b = await browser(ctx, "live: assets-repair builder");
  const tab = await b.tab("builder");
  await tab.navigate(`http://127.0.0.1:${port}/#node=${P.ws}&preview=1&app=` + encodeURIComponent(JSON.stringify(APP)));
  if (!(await until(tab, `return (${comp("Form", "notes")}?.querySelector("input[name=title]") && 1) || null;`, 60_000))) throw new Error("the builder never showed the notes form");
  const rows = Array.from({ length: ROWS }, (_, i) => `row ${String(i).padStart(4, "0")}`);
  for (const t of rows) {
    const said = await tab.evaluate(addRow(t));
    if (said !== "ok") throw new Error(`the notes form could not take a row: ${said}`);
    await sleep(100);
  }
  const t0 = Date.now();
  await tab.evaluate(`document.getElementById("publish").click(); return 1;`);
  const pub = await until(tab, `return window.__craftworksPublished ?? null;`, STEP_MS * 3, null, 1000);
  if (!pub?.address) {
    // What the page said, so a stall is read, not guessed.
    const note = await tab.evaluate(`return { publish: document.getElementById("publish-note")?.textContent ?? null, save: document.getElementById("save-state")?.textContent ?? null, addr: document.getElementById("tree-addr")?.textContent ?? null, notAnswering: globalThis.__craftworks?.session?.notAnswering?.() ?? null };`).catch(e => ({ unreadable: e.message }));
    const trace = await tab.evaluate(`const s = globalThis.__craftworks?.session; return s?.pageTrace ? s.pageTrace().slice(-2500) : "(no session on the page yet)";`).catch(e => `(unreadable: ${e.message})`);
    say(`FAIL  the plain publish did not finish in ${(STEP_MS * 3) / 1000} s. Page: ${JSON.stringify(note)}`);
    say(`TRACE ${trace}`);
    return { failed: true };
  }
  let states = [];
  while (Date.now() < t0 + STEP_MS * 3 && !backedUp(states, rows)) { states = await tab.evaluate(ROW_STATES).catch(() => []); await sleep(500); }
  if (!backedUp(states, rows)) {
    const seen = states.filter(r => rows.includes(r.cell));
    say(`FAIL  published ${pub.address}, but the rows never all read "saved + backed up": ${seen.length} of ${rows.length} rows visible in the table, ${seen.filter(r => r.backedUp).length} backed up, ${seen.filter(r => r.saved).length} saved; first not backed up ${JSON.stringify(seen.find(r => !r.backedUp) ?? null)}`);
    return { failed: true };
  }
  // The head's CURRENT tree: node-forget chooses groups only under it (the store also keeps older versions' nodes).
  // The mount's db (runtime.js's seam): "" until the store can state its root, so waited for.
  const root = await until(tab, `return globalThis.__craftworks?.db?.root?.() || null;`, 60_000, null, 500);
  if (!root) { say("FAIL  the page states no tree root: node-forget cannot tell the head's tree from older versions"); return { failed: true }; }
  say(`PUBLISHED ${pub.address} (${rows.length} rows) on P :${P.ws} (local), backed up in ${Date.now() - t0} ms; root ${root}`);

  // 2. P loses m blocks of GROUPS groups, from its own store, while it is stopped.
  let forgot = [];
  P = await ctx.nodes.restart(P, async () => {
    forgot = forgetTool(["forget", join(P.dir, "data"), BLOCK_WASM, "--root", root, "--lose", "m", "--groups", String(GROUPS)]);
  });
  for (const l of forgot) say(`FORGET ${JSON.stringify(l)}`);
  const lost = forgot.filter(l => l.forgot).map(l => l.forgot);
  if (!lost.length) { say("FAIL  node-forget forgot nothing: nothing below is measured"); return { failed: true }; }
  // Until the restarted node ANSWERS (found / not_found), 60 s at most: an early GET is refused ("not joined yet").
  let checked = [];
  for (const until_ = Date.now() + 60_000; ;) {
    checked = forgetTool(["check", `ws://127.0.0.1:${P.ws}/v1/contract/command?encodingProtocol=native`, BLOCK_WASM, ...lost]);
    if (checked.every(l => l.answer === "found" || l.answer === "not_found") || Date.now() > until_) break;
    await sleep(2_000);
  }
  for (const l of checked) say(`CHECK  ${JSON.stringify(l)}`);
  const notFound = checked.filter(l => l.answer === "not_found").length;
  say(`P restarted :${P.ws}; ${lost.length} block(s) forgotten, ${notFound} answer NotFound on P`);

  // 3. A fresh reader still loads every row, from parity.
  const r = await browser(ctx, "live: assets-repair fresh reader");
  const rTab = await r.tab("reader");
  await rTab.navigate(`http://127.0.0.1:${P.ws}/v1/contract/web/${pub.address}/`).catch(() => {});
  const hasRows = `const r = [...(${comp("Table", "notes")}?.querySelectorAll("tbody tr td:first-child") ?? [])].map(td => td.textContent); return ${JSON.stringify(rows)}.every(t => r.includes(t)) || null;`;
  const frame = `127.0.0.1:${P.ws}/v1/contract/web/${pub.address}/?__sandbox=1`;
  const read = await until(rTab, hasRows, STEP_MS, frame, 500);
  say(read ? `READER a fresh reader on P shows all ${rows.length} rows` : `READER a fresh reader on P did NOT show all ${rows.length} rows within ${STEP_MS / 1000} s`);
  // The reader's own recording, pass or fail: which reads it sent, how each ended -- a reader that stops is read, not
  // guessed (run 2026-09-27T08-42: P's log shows its 5 NotFounds, then nothing).
  const shown = await rTab.evaluateIn(frame, `const t = ${comp("Table", "notes")}; return { rows: t?.querySelectorAll("tbody tr").length ?? null, text: (document.body?.innerText ?? "").slice(0, 400) };`).catch(e => ({ unreadable: e.message }));
  say(`READER shows ${JSON.stringify(shown)}`);
  await recordPageTrace(ctx, rTab, "reader", read ? "rows" : "no rows", { frame, read: OPENER_TRACE });
  await r.stop();

  // 4. The Assets tab: DEGRADED -> REPAIRING -> REPAIRED, then WHOLE.
  await reopen(tab, P.ws, "after the loss");
  const shots = join(ctx.dir, "shots");
  mkdirSync(shots, { recursive: true });
  const capture = async name => {
    // CDP answers `{ result: { data } }` (tools/shots.mjs); a capture that fails is SAID, never skipped silently.
    const r = await tab.send("Page.captureScreenshot", { format: "png" }).catch(e => ({ error: e.message }));
    const data = r?.result?.data;
    if (data) writeFileSync(join(shots, `${name}.png`), Buffer.from(data, "base64"));
    else say(`SHOT  ${name}: not captured (${JSON.stringify(r).slice(0, 200)})`);
  };
  const first = await assetsCheck(tab);
  await capture("1-degraded");
  say(`CAPTURE 1 (the check on open): ${first.word} -- ${oneLine(first.text)}`);
  const { running, done } = await repairNow(tab);
  say(`CAPTURE 2 (repairing): ${running ? oneLine(running.text) : "(the pass ended before a capture)"}`);
  await capture("3-repaired");
  say(`CAPTURE 3 (after Repair now): ${done.word} -- ${oneLine(done.text)}`);
  const again = await assetsCheck(tab);
  say(`CHECK AGAIN: ${again.word} -- ${oneLine(again.text)}`);

  // 5. THE CONTROL: m + 1 of one group.
  let forgot2 = [];
  P = await ctx.nodes.restart(P, async () => {
    forgot2 = forgetTool(["forget", join(P.dir, "data"), BLOCK_WASM, "--root", root, "--lose", "m+1", "--groups", "1"]);
  });
  for (const l of forgot2) say(`FORGET (control) ${JSON.stringify(l)}`);
  await reopen(tab, P.ws, "the control");
  const control = await assetsCheck(tab);
  await capture("5-control");
  say(`CONTROL (P's store lost m+1 of one group): ${control.word} -- ${oneLine(control.text)}`);
  await b.stop();

  const missingOf = t => Number((t.match(/(\d+) missing/) ?? [])[1] ?? NaN);
  const putBackOf = t => Number((t.match(/(\d+) put back/) ?? [])[1] ?? NaN);
  const checks = [
    [notFound === lost.length, `only ${notFound} of ${lost.length} forgotten blocks answer NotFound on P`],
    [!!read, "a fresh reader did not load every row"],
    [first.word === "degraded" && missingOf(first.text) > 0, `the check on open said ${first.word} (${missingOf(first.text)} missing), not degraded with some missing`],
    [done.word === "repaired" && missingOf(done.text) === putBackOf(done.text) && putBackOf(done.text) > 0, `Repair now said ${done.word}, missing ${missingOf(done.text)}, put back ${putBackOf(done.text)}`],
    [again.word === "whole", `the check after the repair said ${again.word}, not whole`],
    [control.word === "damaged", `the control said ${control.word}, not damaged: the tab is blind to a group it cannot rebuild`],
  ];
  const failed = checks.filter(([ok]) => !ok);
  for (const [, why] of failed) say(`FAIL  ${why}`);
  if (!failed.length) say(`PASS  P forgot ${lost.length} block(s) (NotFound on P); a fresh reader read every row; the tab: DEGRADED (${missingOf(first.text)} missing) -> REPAIRED (${putBackOf(done.text)} put back) -> WHOLE; the m+1 control DAMAGED`);
  return { failed: failed.length > 0 };
}
