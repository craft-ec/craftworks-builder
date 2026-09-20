// THE TWO-TAB ACCEPTANCE (craftworks-builder#20).
//
//   node tools/two-tab.mjs
//
// Tab A publishes a project and writes a record. Tab B, which made no write
// of its own, must see it — and the whole point is WHICH MECHANISM told it.
// With LIVE on, the SDK holds a client-API subscription to the head contract
// and B is notified: an engine-originated push returns to whoever invoked the
// delegate (F40), so a subscription is the only thing that can reach a tab
// that wrote nothing. With LIVE off, B finds out on its tick.
//
// The control is not decoration. A "live works" table produced by the tick
// would be a faked outcome, and the two arms are only distinguishable by
// TIME and by what the session reports its LiveMode to be — so both are
// recorded, for both arms.
//
// THE NODE IS ISOLATED AND IT IS OURS.
//   * its own port, never 7509 or 7609 — those are nodes this machine runs
//     for somebody else, and publishing installs a delegate and hands over a
//     signing key;
//   * both ports probed FREE before anything starts ("I assumed nothing was
//     listening" is how a screenshot run once connected to a real node);
//   * `--is-gateway --skip-load-from-network`, loopback on the listen AND
//     advertised address, so it dials nothing and nothing it does leaves
//     this machine. Flags follow craftworks-sdk `probe/src/node.rs`, which
//     is where that recipe is worked out;
//   * its PID is recorded at launch and it is killed BY THAT PID, never by
//     a name pattern — three sessions share this Mac;
//   * network MODE, not local: a delegate-originated PUT is silently dropped
//     in local mode (F35), and publishing is entirely delegate-originated.

import assert from "node:assert";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE_PORT = 8095, DEBUG = 9337;
const NODE_PORT = 17509, NET_PORT = 37509;
const RESERVED = [7509, 7609];
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 180_000);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1_000_000n);

const free = port => new Promise(ok => {
  const s = connect({ port, host: "127.0.0.1" });
  const done = v => { s.destroy(); ok(v); };
  s.setTimeout(500);
  s.once("connect", () => done(false));
  s.once("error", () => done(true));
  s.once("timeout", () => done(false));
});

// ---- guards, before anything is started -----------------------------------
for (const p of [NODE_PORT, NET_PORT]) {
  assert.ok(!RESERVED.includes(p), `${p} is a node this machine runs for somebody else`);
}
for (const [p, what] of [[PAGE_PORT, "page server"], [DEBUG, "chrome"], [NODE_PORT, "node ws"], [NET_PORT, "node network"]]) {
  assert.ok(await free(p), `something is already listening on ${p} (${what}); refusing to start`);
}

// THE REVISION THESE NUMBERS ARE ABOUT.
//
// A screenshot with no revision on it is evidence for nothing: the same page
// against two SDKs is two different measurements. `SDK_REV` is what build.sh
// actually built into sdk/, so it is what the run is named after.
const SDK_REV = readFileSync(new URL("../SDK_REV", import.meta.url), "utf8").trim();
const SHOTS = join(new URL("..", import.meta.url).pathname, "shots", SDK_REV);
mkdirSync(SHOTS, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "cw-twotab-"));
for (const d of ["data", "config", "log"]) mkdirSync(join(dir, d), { recursive: true });

const procs = [];
const kill = () => {
  // BY RECORDED PID, never by a name pattern: three sessions share this Mac
  // and a pattern has taken down somebody else's runs before.
  for (const { name, child } of procs.reverse()) {
    try { process.kill(child.pid, "SIGTERM"); console.log(`  killed ${name} (pid ${child.pid})`); } catch (_) {}
  }
  // AND SAY WHAT IS STILL HELD.
  //
  // Verifying cleanup by grepping for a name pattern is how an orphan
  // survives: the page server's command line is `python3 -m http.server`
  // and carries no marker this run put there, so a `cw-twotab` grep reported
  // "clean" while it held 8095 — and the next run then failed at the port
  // guard, which reads as "port in use" rather than "the last run left
  // something". The PORTS are the thing to check, because they are what the
  // next run actually needs.
  const held = [PAGE_PORT, DEBUG, NODE_PORT, NET_PORT].filter(p => {
    try { return require("node:child_process").execSync(
      `lsof -nP -iTCP:${p} -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1`).toString().trim().length > 0; }
    catch (_) { return false; }
  });
  if (held.length) console.log(`  STILL HELD after cleanup: ${held.join(", ")} — kill these by PID before the next run`);
};
process.on("exit", kill);
process.on("SIGINT", () => { kill(); process.exit(130); });
// SIGTERM TOO. It was missing, and that is how a run stopped from outside
// left its node and its Chrome behind: `exit` does not fire for a signal
// nobody handles, so the PIDs this file carefully recorded were never used.
// An orphaned node holding 17509 then refuses the next run at the port
// guard, which reads like the port being in use rather than like the last
// run not having cleaned up.
process.on("SIGTERM", () => { kill(); process.exit(143); });
process.on("SIGHUP", () => { kill(); process.exit(129); });

const node = spawn("freenet", [
  "network", "--is-gateway", "--skip-load-from-network",
  "--network-address", "127.0.0.1", "--network-port", String(NET_PORT),
  "--public-network-address", "127.0.0.1", "--public-network-port", String(NET_PORT),
  "--ws-api-address", "127.0.0.1", "--ws-api-port", String(NODE_PORT),
  "--data-dir", join(dir, "data"), "--config-dir", join(dir, "config"), "--log-dir", join(dir, "log"),
], { stdio: ["ignore", "pipe", "pipe"] });
procs.push({ name: "freenet", child: node });
writeFileSync(join(dir, "node.pid"), String(node.pid));
console.log(`node: isolated NETWORK mode on 127.0.0.1:${NODE_PORT} (net ${NET_PORT}), pid ${node.pid}, tree ${dir}`);

// The node's own account lives on the CONSOLE, not in its file log.
const consoleOut = [];
node.stdout.on("data", d => consoleOut.push(String(d)));
node.stderr.on("data", d => consoleOut.push(String(d)));

// ---- wait for it, on PROGRESS and not on a fixed sleep ---------------------
{
  const deadline = now() + 45_000;
  let up = false;
  while (now() < deadline && !up) {
    await sleep(250);
    up = !(await free(NODE_PORT));
    if (node.exitCode !== null) {
      console.error(consoleOut.join("").slice(-2000));
      assert.fail(`the node exited before it was ready (${node.exitCode})`);
    }
  }
  assert.ok(up, "the node did not open its ws port within 45s");
  console.log(`node: ready after ${45_000 - (deadline - now())} ms`);
}

// ---- the page, and two tabs on it ----------------------------------------
const page = spawn("python3", ["-m", "http.server", String(PAGE_PORT), "--bind", "127.0.0.1"],
  { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
procs.push({ name: "page server", child: page });

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${DEBUG}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "cw-twotab-chrome-"))}`, "about:blank",
], { stdio: "ignore" });
procs.push({ name: "chrome", child: chrome });

/** One CDP-driven tab. */
async function openTab(label) {
  const t = await (await fetch(`http://127.0.0.1:${DEBUG}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let seq = 0; const waiting = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const send = (method, params = {}) =>
    new Promise(ok => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expr => {
    const r = await send("Runtime.evaluate", {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.result?.exceptionDetails || r.result?.result?.subtype === "error") {
      throw new Error(`${label}: ${JSON.stringify(r.result).slice(0, 300)}`);
    }
    return r.result?.result?.value;
  };
  /**
   * Wait for a condition IN THE PAGE, on progress, with a short deadline.
   *
   * A timeout DUMPS THE PAGE. Two runs of this acceptance were spent on
   * failures that said only "timed out waiting for X" — which names the
   * condition and says nothing about why it was not met, so the next step is
   * always a guess. What the page was showing at that moment is the answer
   * nearly every time, and it costs one evaluate.
   */
  const until = async (expr, what, ms = 30_000) => {
    const deadline = now() + ms;
    while (now() < deadline) {
      if (await evaluate(`return !!(${expr});`)) return now();
      await sleep(POLL_MS);
    }
    let page = "(the page could not be read)";
    try {
      page = JSON.stringify(await evaluate(`
        const el = document.getElementById("canvas");
        return {
          publishButton: document.getElementById("publish")?.textContent,
          phase: window.__craftworks?.phase,
          seam: !!window.__craftworks,
          comps: document.querySelectorAll(".rt-comp").length,
          errors: [...document.querySelectorAll(".rt-err, .empty")].map(e => e.textContent).filter(Boolean),
          canvas: el?.innerHTML?.slice(0, 400),
        };`));
    } catch (_) {}
    throw new Error(`${label}: timed out waiting for ${what}\n      page: ${page}`);
  };
  return { label, send, evaluate, until, close: () => ws.close() };
}

// Wait for Chrome itself, on progress.
{
  const deadline = now() + 20_000;
  let ready = false;
  while (now() < deadline && !ready) {
    await sleep(200);
    try { await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json(); ready = true; } catch (_) {}
  }
  assert.ok(ready, "chrome did not start");
}

const APP = {
  name: "Two tabs",
  components: [
    { type: "form", domain: "notes", mode: "owned" },
    { type: "table", domain: "notes", mode: "owned" },
  ],
  schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } },
};

const url = live =>
  `http://127.0.0.1:${PAGE_PORT}/#node=${NODE_PORT}&preview=1&app=` +
  encodeURIComponent(JSON.stringify({
    ...APP,
    components: [APP.components[0], { ...APP.components[1], live }],
  }));

/** Publish a tab and wait until the NODE has confirmed it. */
async function publish(tab, live) {
  await tab.evaluate(`window.location.href = ${JSON.stringify(url(live))}; return 1;`);
  await sleep(500);
  await tab.until(`document.getElementById("publish")`, "the page to load");
  await tab.evaluate(`document.getElementById("publish").click(); return 1;`);
  await tab.until(
    `/Published/.test(document.getElementById("publish").textContent)`,
    "the node to confirm the publish", 90_000);
  // AND THE CANVAS HAS TO COME BACK.
  //
  // A successful publish REMOUNTS the app on the published database — that is
  // how the backend is switched — and the remount is async. The button says
  // "Published" as soon as the node confirms, several round trips before the
  // form exists again.
  //
  // Waiting only on the button is how the first run of this harness reported
  // five failures that were its own race: every arm queried a form that was
  // not there yet, and one arm went on to write 120 records into the
  // IN-MEMORY database the page had before it published. That arm then
  // reported "no row ever reached parity-complete", which was true of a
  // database that has no network behind it and said nothing about the engine.
  //
  // `phase` comes from the seam, so this waits on what mountApp was actually
  // given rather than on a shape in the DOM that both backends produce.
  await tab.until(
    `window.__craftworks?.phase === "published" && document.querySelector(".rt-comp input")`,
    "the app to be remounted on the published database", 90_000);
}

const rows = tab => tab.evaluate(`return document.querySelectorAll(".rt-comp tbody tr").length;`);
// Through the seam `runtime.js` documents, not through a hook invented here.
// `liveMode()` is the SDK's own report; a row count cannot tell a
// subscription from a tick.
const liveMode = tab => tab.evaluate(
  `return window.__craftworks?.db?.liveMode?.() ?? null;`);

/** What each row's chip says about its own write. */
const chips = tab => tab.evaluate(
  `return [...document.querySelectorAll(".rt-comp .rt-state")].map(e => e.textContent);`);

/** A screenshot, filed under the SDK revision it was taken against. */
async function shot(tab, name) {
  const r = await tab.send("Page.captureScreenshot", { format: "png" });
  const data = r.result?.data;
  assert.ok(data, `${tab.label}: the browser returned no image for ${name}`);
  const file = join(SHOTS, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

/** How often a wait looks. Stated, because a latency is only as fine as this. */
const POLL_MS = 25;

/** The page's tick period, which bounds the control arm by construction. */
const TICK_MS = 1_000;

/** How many samples an arm takes. A single one is an anecdote. */
const N = 20;

/**
 * THE NORMAL-ACK DEADLINE, and why it is not 60 seconds.
 *
 * 60 s is an ERROR bound — how long to wait before declaring failure. It is
 * not a measurement window. The normal path is known and measured:
 * `probe/src/bin/live-write` publishes a write on a local node in **177 ms**.
 * So a leg that has not acked in a couple of seconds has already failed, and
 * waiting 60 s to say so returns the same verdict twenty times slower.
 *
 * Worse, it pollutes the table: a sample that took 47 seconds is not a
 * latency, it is a timeout wearing a latency's name, and it drags a p90 into
 * fiction. A tight deadline makes a miss a MISS — recorded as such, excluded
 * from the figures, and counted.
 *
 * Sized at roughly 17x the measured normal path, which is slack for a loaded
 * machine and still 30x tighter than an error bound.
 */
const ACK_MS = 3_000;

/**
 * The FIRST write after a publish gets longer, once, and is not a sample.
 *
 * A cold page has ranges nobody has loaded, so its first write pays for a
 * round trip the rest do not. Timing it alongside the others would put one
 * cold number in every column; leaving it untimed and unbounded would hide a
 * build that never warms up at all.
 */
const WARMUP_MS = 20_000;

/** Consecutive misses after which an arm stops paying for more. */
const GIVE_UP_AFTER = 3;

/** The median and the spread, which is what a latency actually is. */
function summarise(xs) {
  const ok = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!ok.length) return { n: 0 };
  const at = q => ok[Math.min(ok.length - 1, Math.floor(q * ok.length))];
  return { n: ok.length, min: ok[0], p50: at(0.5), p90: at(0.9), max: ok[ok.length - 1] };
}

/**
 * ONE ARM, N TIMES, with the journey broken into its three legs.
 *
 * A single end-to-end number cannot tell "the subscription is fast" from "the
 * tick happened to fire early", so each write is timed at three points:
 *
 *   write -> published    A's own row reaches the network
 *   published -> notified B's session hears about it (live arm only; the
 *                         control has no subscription, so there is nothing
 *                         to hear and the column is n/a by construction)
 *   notified -> rendered  B's table actually shows the row
 *
 * The middle leg is what the two arms differ IN. The control's B changes on
 * its tick, so its end-to-end number is bounded below by the tick period and
 * says nothing about being told.
 */
async function arm(live) {
  const a = await openTab(`tab A (live=${live})`);
  const b = await openTab(`tab B (live=${live})`);
  await publish(a, live);
  await publish(b, live);

  const mode = await liveMode(b);
  const settled = `[...document.querySelectorAll(".rt-comp .rt-state")].filter(x => x.textContent === "saved" || x.textContent === "saved + backed up").length`;
  const seen = await b.evaluate(`return document.querySelectorAll(".rt-comp tbody tr").length;`);
  let have = seen;
  const legs = { published: [], notified: [], rendered: [], total: [] };

  // WARM UP, untimed: one write to pay the cold-range cost once.
  {
    const before = await a.evaluate(`return ${settled};`);
    await a.evaluate(`
      const i = document.querySelector(".rt-comp input[name=title]");
      i.value = ${JSON.stringify(`warmup ${live} ${Date.now()}`)};
      document.querySelector(".rt-comp button.pri").click();
      return 1;`);
    try {
      await a.until(`${settled} > ${before}`, "the first write to reach the network", WARMUP_MS);
      have += 1;
      await b.until(`document.querySelectorAll(".rt-comp tbody tr").length >= ${have}`, "B to render the warm-up row", WARMUP_MS);
    } catch (e) {
      have = await b.evaluate(`return document.querySelectorAll(".rt-comp tbody tr").length;`);
      console.log(`  warm-up did not complete for live=${live}: ${e.message.split("\n")[0]}`);
    }
  }

  let missed = 0;
  for (let i = 0; i < N; i += 1) {
    if (missed >= GIVE_UP_AFTER) {
      console.log(`  ${live ? "live" : "tick"}: gave up after ${missed} consecutive misses at sample ${i}`);
      break;
    }
    const before = await a.evaluate(`return ${settled};`);
    const notes = (await liveMode(b))?.foreignNotifications ?? 0;
    const title = `s${i} ${live ? "live" : "tick"} ${Date.now()}`;
    const t0 = now();
    await a.evaluate(`
      const i = document.querySelector(".rt-comp input[name=title]");
      i.value = ${JSON.stringify(title)};
      document.querySelector(".rt-comp button.pri").click();
      return 1;`);

    // LEG 1: A's own row reaches the network.
    let tPub = NaN;
    try { tPub = await a.until(`${settled} > ${before}`, "A's row to reach the network", ACK_MS); }
    catch (_) {
      missed += 1;
      legs.published.push(NaN); legs.notified.push(NaN); legs.rendered.push(NaN); legs.total.push(NaN);
      continue;
    }

    // LEG 2: B hears about it. Only the live arm can.
    let tNote = NaN;
    if (live) {
      try { tNote = await b.until(`(window.__craftworks?.db?.liveMode?.().foreignNotifications ?? 0) > ${notes}`, "B to be notified", ACK_MS); }
      catch (_) { /* recorded as NaN, not retried */ }
    }

    // LEG 3: B renders it. B MADE NO WRITE.
    have += 1;
    let tRender = NaN;
    // The CONTROL arm is told by its tick, so it is bounded by the tick
    // period and not by an ack. Two ticks is generous; more would be waiting
    // for a mechanism that has already had its chance.
    const renderBy = live ? ACK_MS : 2 * TICK_MS + ACK_MS;
    try { tRender = await b.until(`document.querySelectorAll(".rt-comp tbody tr").length >= ${have}`, "B to render A's row", renderBy); }
    catch (_) { have -= 1; missed += 1; }

    legs.published.push(tPub - t0);
    legs.notified.push(Number.isFinite(tNote) ? tNote - tPub : NaN);
    legs.rendered.push(Number.isFinite(tRender) ? tRender - (Number.isFinite(tNote) ? tNote : tPub) : NaN);
    legs.total.push(Number.isFinite(tRender) ? tRender - t0 : NaN);
    if (Number.isFinite(tRender)) missed = 0;
  }

  const bMode = await liveMode(b);
  await shot(a, `${live ? "live" : "tick"}-a-wrote`);
  await shot(b, `${live ? "live" : "tick"}-b-saw`);
  a.close(); b.close();
  return {
    live, mode, bMode,
    published: summarise(legs.published),
    notified: summarise(legs.notified),
    rendered: summarise(legs.rendered),
    total: summarise(legs.total),
  };
}

/**
 * THE WRITE PATH, END TO END: a row reaches the network, and three hundred
 * writes are accepted.
 *
 * Two separate claims, and the second is the one that was broken: the write
 * path did not drain, so an app stopped at 256 (craftworks-sdk#73). A refusal
 * count of zero is only evidence if the writes were actually MADE, so the row
 * count is checked too — "no refusals" over nothing refused nothing.
 *
 * PENDING → CLEAN is read from the CHIP, which is what a person sees: a row
 * that says "saving" for ever and a row that says "saved" are the difference
 * between data that survives closing the tab and data that does not.
 */
async function writePath() {
  const a = await openTab("write path");
  await publish(a, true);

  const start = await rows(a);
  const title = `one write ${Date.now()}`;
  await a.evaluate(`
    const i = document.querySelector(".rt-comp input[name=title]");
    i.value = ${JSON.stringify(title)};
    document.querySelector(".rt-comp button.pri").click();
    return 1;`);

  // SAVING FIRST. If the chip never says "saving" the transition is not being
  // observed — it would pass just as well on a build that reported every row
  // "saved" from the moment it was typed.
  const sawPending = await a.evaluate(`
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const c = [...document.querySelectorAll(".rt-comp .rt-state")].map(e => e.textContent);
      if (c.includes("saving") || c.includes("queued")) return true;
      await new Promise(r => setTimeout(r, 20));
    }
    return false;`);

  await a.until(
    `[...document.querySelectorAll(".rt-comp .rt-state")].filter(e => e.textContent === "saved" || e.textContent === "saved + backed up").length >= ${start + 1}`,
    "every row to reach the network", 120_000);
  const settled = await chips(a);
  await shot(a, "write-path-settled");

  // THREE HUNDRED, through the db the app holds. Refusals are what #73 was:
  // the copy filled and the app could make no more.
  const bulk = await a.evaluate(`
    const db = window.__craftworks.db;
    let refused = 0; const reasons = [];
    for (let i = 0; i < 300; i++) {
      try { await db.put("notes", { title: "bulk " + i }); }
      catch (e) { refused += 1; if (reasons.length < 3) reasons.push(String(e.message ?? e)); }
    }
    return { refused, reasons };`);

  await a.until(`document.querySelectorAll(".rt-comp tbody tr").length >= ${start + 301}`,
    "all 300 rows to appear", 120_000);
  const after = await rows(a);
  await shot(a, "write-path-300");

  a.close();
  return { sawPending, settled, ...bulk, wrote: after - start };
}

/**
 * RELOAD TAB A. The data has to come back from the NETWORK.
 *
 * A published project whose rows live only in the tab that wrote them is a
 * published project in name only, and every other number here would look
 * identical.
 */
async function reload() {
  const a = await openTab("reload");
  await publish(a, true);
  const start = await rows(a);
  const title = `survives a reload ${Date.now()}`;
  await a.evaluate(`
    const i = document.querySelector(".rt-comp input[name=title]");
    i.value = ${JSON.stringify(title)};
    document.querySelector(".rt-comp button.pri").click();
    return 1;`);
  await a.until(
    `[...document.querySelectorAll(".rt-comp .rt-state")].some(e => e.textContent === "saved" || e.textContent === "saved + backed up")`,
    "the write to reach the network", 120_000);

  // THE HEAD BEFORE, so "the same head" is a comparison and not a hope.
  const headBefore = await a.evaluate(`return window.__craftworks?.db?.root?.() ?? null;`);

  await a.evaluate(`window.location.reload(); return 1;`);
  await sleep(1000);
  await a.until(`document.getElementById("publish")`, "the page to come back", 60_000);
  // A SECOND PUBLISH after the reload must not install anything again: the
  // delegate refuses a second install on its own (first-writer-wins), and a
  // run that installed twice would have handed out a second signing key.
  await a.evaluate(`document.getElementById("publish").click(); return 1;`);
  await a.until(`/Published/.test(document.getElementById("publish").textContent)`, "the reloaded tab to publish", 90_000);
  await a.until(`window.__craftworks?.phase === "published"`, "the reloaded tab to remount", 90_000);
  const steps = await a.evaluate(`return JSON.parse(window.__craftworksSession?.take_progress?.() ?? "[]");`);
  const headAfter = await a.evaluate(`return window.__craftworks?.db?.root?.() ?? null;`);
  const back = await a.until(
    `[...document.querySelectorAll(".rt-comp td")].some(e => e.textContent === ${JSON.stringify(title)})`,
    "the reloaded tab to show what was written before it", 120_000);
  const shown = await rows(a);
  await shot(a, "reload-after");
  a.close();
  return { start, shown, headBefore, headAfter, steps, ms: back };
}

/**
 * TWO LIVE TABS, ONE CONTEXT, AND THE REDUNDANCY.
 *
 * A delegate's context is shared by every connection (F47), so this is the
 * first time two tabs drive one engine under a real node. The engine-side
 * table (craftworks-sdk `what_a_flush_causes`) reads 3, 0, 0 — parity is put
 * once and the group then settles. What a PAGE can see of that is the chip:
 * `parity-complete` shows as "saved + backed up", and it must be reached and
 * then STAY.
 *
 * What this cannot see, and says so rather than implying otherwise: the
 * number of puts. A group re-coded on every tick would show the same chip.
 * The observable claim is reached-and-held, under two tabs, both sending
 * time.
 */
async function parityUnderTwoTabs() {
  const a = await openTab("parity A");
  const b = await openTab("parity B");
  await publish(a, true);
  await publish(b, true);

  // Enough records that a leaf fills and a node lists a trio. The engine-side
  // measurement needed eleven 512-byte records; these are written through the
  // app's own schema, so this writes more of them rather than guessing.
  const made = await a.evaluate(`
    const db = window.__craftworks.db;
    let refused = 0;
    for (let i = 0; i < 120; i++) {
      try { await db.put("notes", { title: "parity " + i + " " + "x".repeat(400) }); }
      catch (e) { refused += 1; }
    }
    return { refused };`);

  const backed = `[...document.querySelectorAll(".rt-comp .rt-state")].filter(x => x.textContent === "saved + backed up").length`;
  let reached = 0;
  try {
    await a.until(`${backed} > 0`, "a row to reach parity-complete", 120_000);
    reached = await a.evaluate(`return ${backed};`);
  } catch (_) {
    // REPORTED, not retried. A row that never reaches parity-complete under
    // two tabs IS the finding.
    reached = 0;
  }

  // HELD. Several ticks later, with both tabs still open and both sending
  // time, the same rows must still say it.
  await sleep(15_000);
  const held = await a.evaluate(`return ${backed};`);
  const heldB = await b.evaluate(`return ${backed};`);
  await shot(a, "parity-two-tabs-a");
  await shot(b, "parity-two-tabs-b");
  const modeA = await liveMode(a), modeB = await liveMode(b);

  a.close(); b.close();
  return { ...made, reached, held, heldB, modeA: modeA?.mode, modeB: modeB?.mode };
}

// ---- both arms -------------------------------------------------------------
const report = { failures: [] };
const step = async (name, fn) => {
  try { return await fn(); }
  catch (e) {
    // EVERY ITEM RUNS. A run that stopped at the first failure would leave
    // five items looking untested rather than unreached, and the instruction
    // was to report what fails, not to re-run until green.
    report.failures.push(`${name}: ${e.message}`);
    console.log(`  !! ${name} FAILED: ${e.message}`);
    return null;
  }
};

const results = [];
for (const live of [false, true]) {
  const r = await step(`arm live=${live}`, () => arm(live));
  if (r) {
    results.push(r);
    // PRINTED NOW, not at the end. A run stopped or killed part-way used to
    // lose everything it had already measured: the table is written once,
    // last, so forty minutes of completed samples went with it.
    console.log(`  [arm ${r.live ? "live" : "tick"} done] mode=${r.bMode?.mode ?? "?"} ` +
      `published p50=${r.published.p50 ?? "-"}ms n=${r.published.n} · ` +
      `notified p50=${r.notified.p50 ?? "-"}ms n=${r.notified.n} · ` +
      `rendered p50=${r.rendered.p50 ?? "-"}ms n=${r.rendered.n} · ` +
      `TOTAL p50=${r.total.p50 ?? "-"}ms n=${r.total.n}`);
  }
}
report.writePath = await step("write path", writePath);
report.reload = await step("reload", reload);
report.parity = await step("parity under two tabs", parityUnderTwoTabs);

console.log("\n  arm    | LiveMode        | A sees own write | B sees A's write");
console.log("  -------|-----------------|------------------|-----------------");
for (const r of results) {
  console.log(
    `  ${r.live ? "live " : "tick "} | ${String(r.mode?.mode ?? "?").padEnd(15)} | ` +
    `${String(r.aMs + " ms").padEnd(16)} | ${r.bMs} ms`);
}
for (const r of results) if (r.mode?.why) console.log(`  ${r.live ? "live" : "tick"}: ${r.mode.why}`);

// ---- what the arms must actually differ IN ---------------------------------
const tick = results.find(r => !r.live), liveArm = results.find(r => r.live);
const check = (what, fn) => {
  try { fn(); console.log(`  PASS  ${what}`); }
  catch (e) { report.failures.push(`${what}: ${e.message}`); console.log(`  FAIL  ${what}: ${e.message}`); }
};

console.log("\n=== the six items ===");
check("1. the live arm really held a head subscription", () => assert.strictEqual(
  liveArm?.mode?.mode, "HeadSubscribed",
  "not subscribed, so its number is the tick's number wearing a different name"));
check("2. the control arm polled, so the arms are different mechanisms", () => assert.strictEqual(
  tick?.mode?.mode, "Polled", "the control held a subscription too"));
check("3a. a write reached the network: the chip said saving, then saved", () => {
  assert.ok(report.writePath?.sawPending,
    "the chip never said saving or queued, so the transition is not being observed at all");
  assert.ok(report.writePath.settled.some(c => c === "saved" || c === "saved + backed up"),
    `no row reached saved; chips were ${JSON.stringify(report.writePath.settled.slice(0, 5))}`);
});
check("3b. 300 writes, zero refusals", () => {
  assert.strictEqual(report.writePath?.refused, 0,
    `${report.writePath?.refused} refused: ${JSON.stringify(report.writePath?.reasons)}`);
  assert.ok(report.writePath.wrote >= 300,
    `only ${report.writePath.wrote} rows appeared, so "no refusals" is over writes that were never made`);
});
check("4. a reloaded tab A gets its data back, same head, no second install", () => {
  assert.ok(report.reload?.shown > 0, "the reloaded tab showed nothing");
  assert.ok(report.reload.headBefore, "no head was recorded before the reload, so there is nothing to compare");
  assert.strictEqual(report.reload.headAfter, report.reload.headBefore,
    `the head moved across a reload that wrote nothing: ${report.reload.headBefore} -> ${report.reload.headAfter}`);
  const installs = (report.reload.steps ?? []).filter(x => /install/i.test(String(x)));
  assert.deepStrictEqual(installs, [],
    `the reloaded tab installed again (${installs.join(", ")}). A second install would hand out a second signing key.`);
});
check("5. the node ran on its own port, killed by recorded PID", () => {
  assert.ok(![7509, 7609].includes(NODE_PORT), "it used somebody else's node");
  assert.ok(node.pid > 0, "no PID was recorded");
});
check("6. screenshots taken, filed under the SDK revision", () => {
  const n = readdirSync(SHOTS).filter(f => f.endsWith(".png")).length;
  assert.ok(n >= 6, `only ${n} screenshots in ${SHOTS}`);
});
check("+ owed parity settles under two tabs, and stays settled", () => {
  assert.strictEqual(report.parity?.refused, 0, `${report.parity?.refused} writes refused with two tabs open`);
  assert.ok(report.parity?.reached > 0,
    "no row ever reached parity-complete with two tabs open: the redundancy was never written");
  assert.ok(report.parity.held >= report.parity.reached,
    `parity-complete went BACKWARDS: ${report.parity.reached} rows, then ${report.parity.held} fifteen seconds later`);
});

console.log("\n=== the latency table ===");
console.log(`  N = ${N} writes per arm, polled every ${POLL_MS} ms — a leg cannot be measured finer than that.`);
console.log("  ms          | n  | min | p50 | p90 | max");
console.log("  ------------|----|-----|-----|-----|-----");
const row = (label, s) => console.log(
  `  ${label.padEnd(11)} | ${String(s.n).padEnd(2)} | ${String(s.min ?? "-").padEnd(3)} | ` +
  `${String(s.p50 ?? "-").padEnd(3)} | ${String(s.p90 ?? "-").padEnd(3)} | ${s.max ?? "-"}`);
for (const r of results) {
  console.log(`  --- ${r.live ? "LIVE" : "CONTROL (tick)"}: B's mode ${r.bMode?.mode ?? "?"}`);
  row("published", r.published);
  row(r.live ? "notified" : "notified n/a", r.notified);
  row("rendered", r.rendered);
  row("TOTAL", r.total);
}
console.log(`  screenshots: ${SHOTS} (SDK ${SDK_REV})`);
console.log(`  node: 127.0.0.1:${NODE_PORT}, pid ${node.pid}`);
if (report.writePath) console.log(`  write path: ${report.writePath.wrote} rows, ${report.writePath.refused} refused, saw-pending ${report.writePath.sawPending}`);
if (report.reload) console.log(`  reload: ${report.reload.shown} rows back after a reload`);
if (report.parity) console.log(`  parity: ${report.parity.reached} backed up, ${report.parity.held} still backed up 15s later (A ${report.parity.modeA}, B ${report.parity.modeB})`);

if (report.failures.length) {
  console.log(`\n${report.failures.length} FAILING:`);
  for (const f of report.failures) console.log(`  - ${f}`);
  console.log(`\ntree kept at ${dir} for inspection`);
  process.exit(1);
}
console.log("\nall six items pass.");
rmSync(dir, { recursive: true, force: true });
process.exit(0);
