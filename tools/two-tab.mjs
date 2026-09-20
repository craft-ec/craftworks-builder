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
};
process.on("exit", kill);
process.on("SIGINT", () => { kill(); process.exit(130); });

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
      await sleep(50);
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

/** One arm of the acceptance. Returns what it measured. */
async function arm(live) {
  const a = await openTab(`tab A (live=${live})`);
  const b = await openTab(`tab B (live=${live})`);
  await publish(a, live);
  await publish(b, live);

  const before = await rows(b);
  const mode = await liveMode(b);

  const title = `from A ${live ? "live" : "tick"} ${Date.now()}`;
  const wrote = now();
  await a.evaluate(`
    const i = document.querySelector(".rt-comp input[name=title]");
    i.value = ${JSON.stringify(title)};
    document.querySelector(".rt-comp button.pri").click();
    return 1;`);
  await a.until(`document.querySelectorAll(".rt-comp tbody tr").length === ${before + 1}`,
    "A's own row to appear");
  const aSaw = now();

  // B MADE NO WRITE. Whatever reaches it reaches it by itself.
  const bSaw = await b.until(
    `document.querySelectorAll(".rt-comp tbody tr").length === ${before + 1}`,
    "B to see A's row", 90_000);

  const bMode = await liveMode(b);
  await shot(a, `${live ? "live" : "tick"}-a-wrote`);
  await shot(b, `${live ? "live" : "tick"}-b-saw`);

  a.close(); b.close();
  return { live, mode, bMode, aMs: aSaw - wrote, bMs: bSaw - wrote };
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

  await a.evaluate(`window.location.reload(); return 1;`);
  await sleep(1000);
  await a.until(`document.getElementById("publish")`, "the page to come back", 60_000);
  const back = await a.until(
    `[...document.querySelectorAll(".rt-comp td")].some(e => e.textContent === ${JSON.stringify(title)})`,
    "the reloaded tab to show what was written before it", 120_000);
  const shown = await rows(a);
  await shot(a, "reload-after");
  a.close();
  return { start, shown, ms: back - now() + (back - back) };
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
  if (r) results.push(r);
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
check("4. a reloaded tab A gets its data back from the network", () => {
  assert.ok(report.reload?.shown > 0, "the reloaded tab showed nothing");
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

console.log("\n=== what was measured ===");
for (const r of results) {
  console.log(`  ${r.live ? "live" : "tick"}: A ${r.aMs} ms, B ${r.bMs} ms, B's mode ${r.bMode?.mode ?? "?"}`);
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
