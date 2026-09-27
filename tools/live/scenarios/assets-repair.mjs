// THE OWNER'S FIRST REPAIR GOAL, LIVE (the Assets tab on the SDK's repairAll): blocks REALLY missing on a real node are
// put back by the tab's Repair now, and the tab says so in the SDK's words.
//   1. Publish through `ws-drop --every N` (craftworks-sdk probe): the proxy drops every Nth Block-contract PUT on the
//      WRITER's connection and answers it itself, so the node never stores those blocks. Its stderr lists each one.
//   2. The SAME browser (its project is in its profile) reopens the project on the node DIRECTLY -- no proxy.
//   3. Assets -> Repair now: a cold reader page of the owner's own tree reads every block from the node, rebuilds the
//      dropped ones from parity and puts them back. The tab must say REPAIRED, with `missing` = `putBack` > 0.
//   4. Repair now again: every block is on the node now -- HEALTHY, nothing missing.
//   5. THE CONTROL: the same page through `ws-lose --group data --lose m+1`: to THAT page the node answers NotFound
//      for m+1 blocks of one group (a loss AT THE READER, not on the node -- said so in the line), which no pass can
//      rebuild -- the tab must say DAMAGED, naming the group. A tab that said REPAIRED here would be blind.
//
// Needs the probes: LIVE_DROP=<ws-drop>, LIVE_LOSE=<ws-lose> (craftworks-sdk probe/, built from the builder's pinned SDK).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { addTo, backedUp, browser, builderServer, comp, ROWS as ROW_STATES, sleep, STEP_MS, until } from "../page.mjs";
import { freePort } from "../runner.mjs";

const APP = {
  name: "live assets-repair",
  components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
  schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } },
};
// Enough rows for groups of k >= 7 (a drop of every 7th PUT stays within m of every group).
const ROWS = Number(process.env.LIVE_ASSETS_ROWS ?? 120);
const EVERY = Number(process.env.LIVE_DROP_EVERY ?? 7);

/** A probe proxy `bin args...`, its stderr's JSON lines collected; killed at the end. Resolves once it listens. */
async function proxy(ctx, bin, args, what) {
  const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  ctx.onEnd(() => { try { process.kill(p.pid, "SIGKILL"); } catch {} });
  const out = { log: "", lines: [] };
  p.stderr.on("data", d => {
    out.log += d;
    for (const l of String(d).split("\n").filter(Boolean)) { try { out.lines.push(JSON.parse(l)); } catch {} }
  });
  for (let i = 0; i < 40 && !out.log.includes("listening"); i++) await sleep(250);
  if (!out.log.includes("listening")) throw new Error(`${what} did not start: ${out.log.slice(-300)}`);
  out.stop = () => { try { process.kill(p.pid, "SIGKILL"); } catch {} };
  return out;
}

/** Open the Assets tab, press Repair now, and wait for the pass's word; returns the row as the page shows it. */
async function repairNow(tab) {
  await tab.evaluate(`const v = document.getElementById("assets-view"); if (v.hidden) document.getElementById("assets").click(); return 1;`);
  if (!(await until(tab, `return document.getElementById("repair-now") && !document.getElementById("repair-now").disabled ? 1 : null;`, 60_000))) {
    throw new Error(`the Assets tab never offered Repair now: ${await tab.evaluate(`return document.getElementById("assets-view").innerText.slice(0, 300);`)}`);
  }
  await tab.evaluate(`document.getElementById("repair-now").click(); return 1;`);
  const row = await until(tab, `const tr = document.querySelector("#assets-view tr[data-health]"); const w = tr?.dataset.health; return w && w !== "repairing" ? { word: w, text: tr.innerText } : null;`, STEP_MS * 2, null, 1000);
  if (!row) throw new Error(`the repair pass did not end within ${(STEP_MS * 2) / 1000} s`);
  return row;
}

/** Point the SAME tab at node port `ws` and wait until the published project is open (its session has a head). */
async function reopen(tab, ws, what) {
  await tab.navigate(`${await tab.evaluate("return location.origin;")}/#node=${ws}`);
  if (!(await until(tab, `return globalThis.__craftworks?.session?.headId?.() || null;`, STEP_MS))) throw new Error(`${what}: the published project did not reopen on :${ws}`);
}

export async function run(ctx) {
  const { say } = ctx;
  for (const [env, bin] of [["LIVE_DROP", process.env.LIVE_DROP], ["LIVE_LOSE", process.env.LIVE_LOSE]]) {
    if (!bin || !existsSync(bin)) throw new Error(`${env} must name the probe binary (craftworks-sdk probe/); got ${bin ?? "unset"}`);
  }
  const P = await ctx.nodes.start("P");
  const dropPort = freePort("tcp");
  const drop = await proxy(ctx, process.env.LIVE_DROP, [String(dropPort), String(P.ws), "--every", String(EVERY)], "ws-drop");
  say(`PROXY ws-drop :${dropPort} -> P :${P.ws}, dropping every ${EVERY}th Block-contract PUT (the node never stores them)`);

  // 1. Publish through ws-drop, in a browser kept for the whole run (the project is in its profile).
  const port = await builderServer(ctx);
  const b = await browser(ctx, "live: assets-repair builder");
  const tab = await b.tab("builder");
  await tab.navigate(`http://127.0.0.1:${port}/#node=${dropPort}&preview=1&app=` + encodeURIComponent(JSON.stringify(APP)));
  if (!(await until(tab, `return (${comp("Form", "notes")}?.querySelector("input[name=title]") && 1) || null;`, 60_000))) throw new Error("the builder never showed the notes form");
  const rows = Array.from({ length: ROWS }, (_, i) => `row ${String(i).padStart(4, "0")}`);
  for (const t of rows) { await tab.evaluate(addTo("notes", t)); await sleep(100); }
  await tab.evaluate(`document.getElementById("publish").click(); return 1;`);
  const pub = await until(tab, `return window.__craftworksPublished ?? null;`, STEP_MS * 3, null, 1000);
  if (!pub?.address) throw new Error("the publish through ws-drop did not finish");
  // BACKED_UP, as page.mjs judges it: through ws-drop the WRITER believes every row saved and backed up (the proxy
  // answered the dropped PUTs itself) -- exactly the lie the repair must find. Not reached: the publish is not the one
  // this scenario is about, and it stops here.
  let states = [];
  const until_ = Date.now() + STEP_MS;
  while (Date.now() < until_ && !backedUp(states, rows)) { states = await tab.evaluate(ROW_STATES).catch(() => []); await sleep(500); }
  if (!backedUp(states, rows)) { say(`FAIL  the writer never read "saved + backed up" through ws-drop (${JSON.stringify(states.slice(0, 3))}…): not the publish this measures`); return { failed: true }; }
  await sleep(5_000); // the proxy answers the dropped PUTs itself: let the page's last PUTs go out
  drop.stop();
  const dropped = drop.lines.filter(l => l.dropped).map(l => l.dropped);
  say(`PUBLISHED ${pub.address} (${ROWS} rows) through ws-drop: ${dropped.length} block(s) never stored on P: ${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? ", …" : ""}`);
  if (!dropped.length) { say("FAIL  ws-drop dropped nothing: nothing is missing, so nothing below is measured"); return { failed: true }; }

  // 2-3. The same project, on P directly: Repair now must put the dropped blocks back.
  await reopen(tab, P.ws, "after the publish");
  const first = await repairNow(tab);
  say(`PASS 1: ${first.word} -- ${first.text.replace(/\s+/g, " ").slice(0, 300)}`);
  // 4. Again: nothing missing now.
  const second = await repairNow(tab);
  say(`PASS 2: ${second.word} -- ${second.text.replace(/\s+/g, " ").slice(0, 300)}`);

  // 5. THE CONTROL: the same page, reading through ws-lose m+1.
  const losePort = freePort("tcp");
  const lose = await proxy(ctx, process.env.LIVE_LOSE, [String(losePort), String(P.ws), "--group", "data", "--lose", "m+1"], "ws-lose");
  await reopen(tab, losePort, "the control");
  const control = await repairNow(tab);
  const chosen = lose.lines.find(l => l.chosen);
  const notFound = lose.lines.filter(l => l.not_found).length;
  say(`CONTROL (P's node answers NotFound to this page for ${chosen?.lost?.length ?? "?"} of group ${chosen?.chosen ?? "?"} (k ${chosen?.k ?? "?"}, ${chosen?.slots ?? "?"} slots): ws-lose, a loss AT THE READER): ${control.word} -- ${control.text.replace(/\s+/g, " ").slice(0, 300)} [NotFound answered ${notFound} time(s)]`);
  lose.stop();
  await b.stop();

  const missingOf = t => Number((t.match(/(\d+) missing/) ?? [])[1] ?? NaN);
  const putBackOf = t => Number((t.match(/(\d+) put back/) ?? [])[1] ?? NaN);
  const checks = [
    [first.word === "repaired", `pass 1 said ${first.word}, not repaired`],
    [missingOf(first.text) > 0 && missingOf(first.text) === putBackOf(first.text), `pass 1: missing ${missingOf(first.text)}, put back ${putBackOf(first.text)}`],
    [second.word === "healthy" && missingOf(second.text) === 0, `pass 2 said ${second.word} with ${missingOf(second.text)} missing, not healthy with none`],
    [control.word === "damaged", `the control said ${control.word}, not damaged: the tab is blind to a group it cannot rebuild`],
  ];
  const failed = checks.filter(([ok]) => !ok);
  for (const [, why] of failed) say(`FAIL  ${why}`);
  if (!failed.length) say(`PASS  dropped ${dropped.length} block(s) at publish; Repair now put back ${putBackOf(first.text)} (REPAIRED), then HEALTHY; the m+1 control DAMAGED`);
  return { failed: failed.length > 0 };
}
