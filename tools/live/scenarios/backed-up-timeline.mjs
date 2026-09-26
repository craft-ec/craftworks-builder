// WHEN DOES A ROW READ "saved + backed up"? (the BACKED_UP assertion's first finding: on a normal publish, both
// rows still read "saved" after 180 s). A timeline, not a verdict: publish two rows from a fresh node and record every
// state change of the builder's rows for LIVE_WATCH_MS (default 10 min); then WRITE a third row on the published app
// and record its states the same way. It separates "slow" from "never" and "a publish's rows" from "a later write".
//
// And WHY (the architect's split): the builder page's wire is captured, sent and received, and `put-acks`
// (craftworks-sdk probe, LIVE_PUT_ACKS) pairs every PUT with the node's answer by contract -- its block kind (4 is
// PARITY), sends, first sent, answered or never. Plus the page's own word: the web Session's `trace()` of its last
// write and `unsaved_writes()`, read from `globalThis.__craftworks.session`.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { captureWire } from "../../wire-capture.mjs";
import { ROW_STATES, STEP_MS, addTo, backedUp, browser, builderServer, comp, sleep, until } from "../page.mjs";

const APP = {
  name: "live backed-up-timeline",
  components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
  schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } },
};
const WATCH_MS = Number(process.env.LIVE_WATCH_MS ?? 600_000);

/** Poll the rows every second for `ms`; say each change as it happens; stop early when `done(rows)`. */
async function watch(ctx, tab, label, t0, ms, done) {
  let last = "";
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const rows = await tab.evaluate(ROW_STATES).catch(e => [[`(unreadable: ${e.message})`, null]]);
    const now = JSON.stringify(rows);
    if (now !== last) { ctx.say(`STATE ${label} +${Date.now() - t0} ms: ${now}`); last = now; }
    if (done(rows)) return { rows, ms: Date.now() - t0 };
    await sleep(1000);
  }
  return { rows: JSON.parse(last || "[]"), ms: null };
}

export async function run(ctx) {
  const P = await ctx.nodes.start("P");
  const port = await builderServer(ctx);
  const b = await browser(ctx, "live: backed-up timeline");
  const { mkdirSync } = ctx.fs;
  mkdirSync(ctx.logsOf("builder"), { recursive: true });
  const sent = join(ctx.logsOf("builder"), "wire.jsonl"), received = join(ctx.logsOf("builder"), "wire.received.jsonl");
  const cap = await captureWire(b.debug, { out: sent, received, windowOf: () => "timeline", label: "builder" });
  const tab = await b.tab("builder");
  await tab.navigate(`http://127.0.0.1:${port}/#node=${P.ws}&preview=1&app=` + encodeURIComponent(JSON.stringify(APP)));
  if (!(await until(tab, `return (${comp("Form", "notes")}?.querySelector("input[name=title]") && 1) || null;`, 60_000))) throw new Error("no notes form");
  for (const t of ["alpha", "beta"]) { await tab.evaluate(addTo("notes", t)); await sleep(500); }
  const t0 = Date.now();
  await tab.evaluate(`document.getElementById("publish").click(); return 1;`);
  const pub = await until(tab, `return window.__craftworksPublished ?? null;`, STEP_MS * 3, null, 1000);
  if (!pub?.address) throw new Error("publish did not finish");
  ctx.say(`PUB   published ${pub.address} in ${Date.now() - t0} ms`);
  // THE ONE BACKED_UP assertion (page.mjs), which the withheld-parity control proves.
  const a = await watch(ctx, tab, "published rows", t0, WATCH_MS, rows => backedUp(rows, ["alpha", "beta"]));
  ctx.say(`RESULT the publish's rows: ${a.ms === null ? `NOT "saved + backed up" within ${WATCH_MS / 1000} s` : `"saved + backed up" at +${a.ms} ms`}`);
  // A WRITE on the published app.
  const t1 = Date.now();
  await tab.evaluate(addTo("notes", "gamma"));
  const g = await watch(ctx, tab, "after writing gamma", t1, WATCH_MS, rows => backedUp(rows, ["gamma"]));
  ctx.say(`RESULT a write after publishing: ${g.ms === null ? `gamma NOT "saved + backed up" within ${WATCH_MS / 1000} s` : `gamma "saved + backed up" at +${g.ms} ms`}`);
  // The page's own word, then the wire's.
  const own = await tab.evaluate(`const s = globalThis.__craftworks?.session; if (!s) return "no session"; return { trace: JSON.parse(s.trace() || "null"), unsaved: s.unsaved_writes?.() ?? null };`).catch(e => `(unreadable: ${e.message})`);
  ctx.say(`PAGE  the session's last write: ${JSON.stringify(own).slice(0, 1500)}`);
  cap.stop();
  await b.stop();
  if (process.env.LIVE_PUT_ACKS) {
    const r = spawnSync(process.env.LIVE_PUT_ACKS, [sent, received], { encoding: "utf8", maxBuffer: 1 << 26 });
    const out = r.stdout.split("\n").filter(Boolean);
    for (const l of out.filter(l => { try { const j = JSON.parse(l); return j.summary || j.put?.acked == null; } catch { return false; } })) ctx.say(`ACKS  ${l}`);
    if (r.status !== 0) ctx.say(`ACKS  put-acks failed (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  } else ctx.say("ACKS  not read: LIVE_PUT_ACKS is unset");
  return { failed: a.ms === null || g.ms === null };
}
