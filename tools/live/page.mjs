// THE LIVE SCENARIOS' PAGE STEPS, one home (tools/live/): the builder's own static server, a fresh browser killed
// by pid on every exit, a poll with a deadline, and PUBLISH (the builder's publish flow on a node, optionally with
// its wire captured). A scenario imports these; none keeps a copy.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { captureWire } from "../wire-capture.mjs";
import { openFreshBrowser } from "../../tests/page-host.mjs";
import { ROOT } from "./runner.mjs";

export const STEP_MS = Number(process.env.LIVE_STEP_MS ?? 180_000);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const comp = (label, domain) => `[...document.querySelectorAll(".rt-comp")].find(s => (s.querySelector("h4")?.textContent ?? "").startsWith(${JSON.stringify(`${label} · ${domain}`)}))`;
export const addTo = (domain, t) => `const f = ${comp("Form", domain)}; const i = f?.querySelector("input[name=title]"); if (!i) return "no form"; i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event("input", { bubbles: true })); f.querySelector("button.pri").click(); return "ok";`;

/** Poll `expr` (in `frame` when given) until it is truthy, for at most `ms`; null when it never was. */
export async function until(tab, expr, ms, frame = null, every = 250) {
  const end = Date.now() + ms;
  do {
    const v = await (frame ? tab.evaluateIn(frame, expr) : tab.evaluate(expr)).catch(() => null);
    if (v) return v;
    await sleep(every);
  } while (Date.now() < end);
  return null;
}

/** This builder tree, served by a static server of the run's own (port 0, read back); killed by pid at the end. */
export async function builderServer(ctx) {
  const child = spawn("python3", ["-u", "-m", "http.server", "0", "--bind", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  ctx.onEnd(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
  const port = await new Promise((ok, bad) => {
    let seen = "";
    const timer = setTimeout(() => bad(new Error(`the builder's page server said no port within 10 s: ${seen.slice(-200)}`)), 10_000);
    for (const s of [child.stdout, child.stderr]) s.on("data", d => { seen += d; const m = seen.match(/port (\d+)/); if (m) { clearTimeout(timer); ok(Number(m[1])); } });
  });
  return port;
}

/** A fresh browser whose pid is killed at the end whatever happens. */
export async function browser(ctx, label) {
  const b = await openFreshBrowser(label);
  ctx.onEnd(() => { try { process.kill(b.pid, "SIGKILL"); } catch {} });
  return b;
}

/**
 * THE PAGE'S RECORDING, read into the run's evidence (sdk#434): the session handle's `pageTrace()` -- each op by send
 * order, how it ENDED (Response, Timeout, Withdrawn) and its retry clock -- written whole to `<logs>/page-trace.txt`,
 * and its counts line said. An SDK whose handle has no `pageTrace()` is SAID, never skipped silently.
 */
export async function recordPageTrace(ctx, tab, label, when) {
  const dir = ctx.logsOf(label);
  ctx.fs.mkdirSync(dir, { recursive: true });
  const dump = await tab.evaluate(`const s = globalThis.__craftworks?.session; if (!s) return "(no session on this page)"; return typeof s.pageTrace === "function" ? s.pageTrace() : "(this SDK's session handle has no pageTrace(): sdk#434)";`).catch(e => `(unreadable: ${e.message})`);
  ctx.fs.appendFileSync(join(dir, "page-trace.txt"), `==== ${when} ${new Date().toISOString()}\n${dump}\n`);
  const counts = String(dump).split("\n").filter(l => /OUTSTANDING|outcome /.test(l)).map(l => l.trim()).join("; ");
  ctx.say(`TRACE ${label} ${when}: ${counts || String(dump).slice(0, 200)} (whole: ${join(dir, "page-trace.txt")})`);
}

/** A publish that reached Published but whose rows never read "saved + backed up": BACKED_UP was not reached. */
export class NotBackedUp extends Error {
  constructor(message, { address, states, published_ms, t0 }) { super(message); Object.assign(this, { address, states, published_ms, t0 }); }
}

/** The builder's row states, in page order: `[[first cell, state], ...]` (for a script's `return`). */
export const ROW_STATES = `return [...document.querySelectorAll(".rt-comp tbody tr")].filter(tr => tr.querySelector(".rt-state")).map(tr => [tr.querySelector("td")?.textContent ?? null, tr.querySelector(".rt-state").textContent]);`;

/**
 * THE BACKED_UP ASSERTION, one home: do the rows titled `titles` (at least one) ALL read "saved + backed up"? A
 * title with no row is not backed up. Every scenario asks through this, so the withheld-parity control proves it for
 * all of them.
 */
export function backedUp(states, titles) {
  if (!titles.length) throw new Error("backedUp: no row named, so nothing would be asserted");
  return titles.every(t => states.some(([cell, s]) => cell === t && s === "saved + backed up"));
}

/**
 * PUBLISH `app` (with `rows` typed into its `notes` form first) from `node` through the builder page. With
 * `capture`, every frame the builder sent is written there (wire-capture's JSONL: what the publish PUT).
 *
 * EVERY PUBLISH ASSERTS BACKED_UP, not just Published (stock-take proposal 4): after Published, every typed row
 * must read "saved + backed up" (the SDK's BACKED_UP, publish-state.js) within a step, or this throws
 * `NotBackedUp` naming the rows' states. Its control is the withheld-parity scenario, which must see it thrown.
 * Returns `{ address, ms, t0, backed_up_ms }`.
 */
export async function publish(ctx, node, { app, rows, capture = null, label = "publisher" }) {
  if (!rows?.length) throw new Error("publish: no rows, so BACKED_UP would be asserted about nothing");
  const port = await builderServer(ctx);
  const b = await browser(ctx, `live: the ${label}'s builder`);
  const cap = capture ? await captureWire(b.debug, { out: capture, windowOf: () => "publish", label }) : null;
  const tab = await b.tab("builder");
  await tab.navigate(`http://127.0.0.1:${port}/#node=${node.ws}&preview=1&app=` + encodeURIComponent(JSON.stringify(app)));
  if (!(await until(tab, `return (${comp("Form", "notes")}?.querySelector("input[name=title]") && 1) || null;`, 60_000))) throw new Error("the builder never showed the notes form");
  for (const t of rows) { await tab.evaluate(addTo("notes", t)); await sleep(500); }
  const t0 = Date.now();
  await tab.evaluate(`document.getElementById("publish").click(); return 1;`);
  const pub = await until(tab, `return window.__craftworksPublished ?? null;`, STEP_MS * 3, null, 1000);
  if (!pub?.address) throw new Error(`publish on ${node.label} did not finish within ${(STEP_MS * 3) / 1000} s: ${await tab.evaluate(`return document.getElementById("publish-note")?.textContent?.slice(0, 200) ?? null;`).catch(() => null)}`);
  const ms = Date.now() - t0;
  // BACKED_UP: every typed row reads "saved + backed up".
  let seen = [], backed_up_ms = null;
  const end = Date.now() + STEP_MS;
  while (Date.now() < end) {
    seen = await tab.evaluate(ROW_STATES).catch(e => [[`(unreadable: ${e.message})`, null]]);
    if (backedUp(seen, rows)) { backed_up_ms = Date.now() - t0; break; }
    await sleep(500);
  }
  await recordPageTrace(ctx, tab, "builder", `${label} publish`);
  cap?.stop();
  await b.stop();
  if (backed_up_ms === null) throw new NotBackedUp(`NOT BACKED UP: published ${pub.address} in ${ms} ms, but its rows did not all read "saved + backed up" within ${STEP_MS / 1000} s (they read ${JSON.stringify(seen)})`, { address: pub.address, states: seen, published_ms: ms, t0 });
  return { address: pub.address, ms, t0, backed_up_ms };
}

/**
 * PUBLISH, and RECORD a NotBackedUp instead of stopping: the publish reached Published, so a scenario still measures
 * what it came for, and fails at the end. Returns `{ pub, notBacked }` (`notBacked` null when BACKED_UP was reached).
 */
export async function publishRecording(ctx, node, opts) {
  try {
    const pub = await publish(ctx, node, opts);
    ctx.say(`PUB   published ${pub.address} from ${node.label} in ${pub.ms} ms; BACKED_UP (every row "saved + backed up") at ${pub.backed_up_ms} ms`);
    return { pub, notBacked: null };
  } catch (e) {
    if (!(e instanceof NotBackedUp)) throw e;
    ctx.say(`FAIL  ${e.message}`);
    return { pub: { address: e.address, ms: e.published_ms, t0: e.t0, backed_up_ms: null }, notBacked: e };
  }
}
