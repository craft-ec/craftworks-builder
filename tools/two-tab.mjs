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
//   * both ports proved FREE before anything starts, TCP and UDP ("I assumed
//     nothing was listening" is how a screenshot run once connected to a real
//     node) — by the shared helper, tests/page-host.mjs `spawnNode`;
//   * `--is-gateway --skip-load-from-network`, loopback on the listen AND
//     advertised address, so it dials nothing and nothing it does leaves
//     this machine. Flags follow craftworks-sdk `probe/src/node.rs`, which
//     is where that recipe is worked out;
//   * its PID is recorded at launch and it is killed BY THAT PID, never by
//     a name pattern — three sessions share this Mac — and verified GONE;
//   * network MODE, not local: a delegate-originated PUT is silently dropped
//     in local mode (F35), and publishing is entirely delegate-originated.

import assert from "node:assert";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { now, openPageHost } from "../tests/page-host.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

const NODE_PORT = 17509, NET_PORT = 37509;
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 600_000);

// THE REVISION THESE NUMBERS ARE ABOUT.
//
// A screenshot with no revision on it is evidence for nothing: the same page
// against two SDKs is two different measurements.
//
// NAMED AFTER WHAT IS IN sdk/, and REFUSED when that is not what SDK_REV
// asks for. This used to say "`SDK_REV` is what build.sh actually built into
// sdk/" and name the run after SDK_REV — which is false when the SDK build
// FAILS: build.sh leaves the previous sdk/ in place, and a run carried on
// against it. Measured: SDK_REV said 9b043f7, sdk/REV said f7faca6, and the
// run filed its screenshots under 9b043f7 and PASSED "screenshots taken,
// filed under the SDK revision" over the old SDK's behaviour.
const SDK_REV = readFileSync(new URL("../SDK_REV", import.meta.url), "utf8").trim();
const BUILT_REV = (() => {
  try { return readFileSync(new URL("../sdk/REV", import.meta.url), "utf8").trim(); }
  catch (_) { return ""; }
})();
if (BUILT_REV !== SDK_REV) {
  console.log(`REFUSED: sdk/ holds craftworks-sdk ${BUILT_REV || "(no REV)"}, and SDK_REV asks for ${SDK_REV}. ` +
    "The SDK build did not produce what this run would be named after — run build.sh and read its result first.");
  process.exit(2);
}
const SHOTS = join(new URL("..", import.meta.url).pathname, "shots", SDK_REV);
mkdirSync(SHOTS, { recursive: true });

// THE NODE, THE PAGE SERVER, CHROME AND EVERY TAB come from the one helper
// (tests/page-host.mjs, builder#98): the node on NAMED ports, refusing
// 7509/7609 and any busy TCP or UDP port before anything starts, three
// explicit dirs, `--disable-auto-update`, killed by its recorded PID and
// VERIFIED gone (and what is still held is said); the page server and Chrome
// on ports the OS picks. The run has a budget: BUDGET_MS, default 10 min.
const host = await openPageHost("two-tab", { node: { ws: NODE_PORT, net: NET_PORT }, budgetMs: BUDGET_MS });
const { port: PAGE_PORT, node } = host;
console.log(`node: isolated NETWORK mode on 127.0.0.1:${NODE_PORT} (net ${NET_PORT}), pid ${node.pid}, tree ${node.dir}`);

/**
 * One CDP-driven tab. A timeout DUMPS THE PAGE: two runs of this acceptance
 * were spent on failures that said only "timed out waiting for X", and what
 * the page was showing at that moment is the answer nearly every time.
 */
const openTab = label => host.tab(label, {
  pollMs: POLL_MS,
  dump: `
    const el = document.getElementById("canvas");
    return {
      publishButton: document.getElementById("publish")?.textContent,
      phase: window.__craftworks?.phase,
      seam: !!window.__craftworks,
      comps: document.querySelectorAll(".rt-comp").length,
      errors: [...document.querySelectorAll(".rt-err, .empty")].map(e => e.textContent).filter(Boolean),
      canvas: el?.innerHTML?.slice(0, 400),
    };`,
});

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
  try {
    // DONE EITHER WAY: published, or the page said it failed. Waiting out the
    // full budget on a failure the page has already announced cost 90 s per
    // arm and said nothing more.
    await tab.until(
      `/Published|Try publishing again/.test(document.getElementById("publish").textContent)`,
      "the node to confirm the publish", 90_000);
    const label = await tab.evaluate(`return document.getElementById("publish").textContent;`);
    if (!/Published/.test(label)) throw new Error("the publish FAILED");
  } catch (e) {
    // SAY WHAT THE PAGE SAID. A timeout alone reads the same whether the node
    // never answered or the page refused to publish at all, and those are
    // different faults; the button, the phase line and any notice are the
    // page's own account of which.
    const said = await tab.evaluate(`return JSON.stringify({
      button: document.getElementById("publish")?.textContent ?? null,
      why: document.getElementById("publish-note")?.textContent || document.getElementById("publish")?.title || null,
      notices: [...document.querySelectorAll(".notice, .storage-notice, [role=alert], .pub-why, .err")].map(n => n.textContent.trim()).filter(Boolean).slice(0, 5),
    });`).catch(() => "(the page could not be read)");
    throw new Error(`${e.message.split("\n")[0]} — the page said: ${said}`);
  }
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
 * THE CONTROL ARM, AS THE OWNER'S RULE ACTUALLY IS: **not live = read when
 * needed**.
 *
 * The old control timed how long a PLAIN binding took to show another tab's
 * write, allowing it two tick periods — so it encoded "a plain binding
 * eventually re-renders on somebody else's change", which is a rule the owner
 * never made, and its number was the tick period wearing a latency's name.
 *
 * What the rule says is the opposite, and it is a BEHAVIOUR, not a latency:
 *
 *   1. after A's write has settled, B does NOT show it — for at least as long
 *      as the old control waited for it to appear;
 *   2. after an explicit re-read (`__craftworks.refresh()`, the app's own
 *      "read now"), B DOES show it — at a head B has adopted (sdk#266);
 *   3. B holds no LIVE binding, which is what makes 1 the rule and not a bug
 *      (`liveMode().liveBindings`, sdk#259).
 *
 * There is no `notified` leg here and there should not be: nothing is telling
 * B anything, by design.
 */
async function controlArm() {
  const a = await openTab("tab A (control)");
  const b = await openTab("tab B (control)");
  await publish(a, false);
  await publish(b, false);

  // B has READ the range once: the rule is about a range a tab holds, not
  // about one it has never looked at.
  await b.evaluate(`await window.__craftworks.refresh(); return 1;`);
  const have = await rows(b);
  const mode = await liveMode(b);

  const settled = `[...document.querySelectorAll(".rt-comp .rt-state")].filter(x => x.textContent === "saved" || x.textContent === "saved + backed up").length`;
  const before = await a.evaluate(`return ${settled};`);
  const title = `control ${Date.now()}`;
  await a.evaluate(`
    const i = document.querySelector(".rt-comp input[name=title]");
    i.value = ${JSON.stringify(title)};
    document.querySelector(".rt-comp button.pri").click();
    return 1;`);
  await a.until(`${settled} > ${before}`, "A's row to reach the network", ACK_MS);

  // 1. B DOES NOT SHOW IT. The window is the one the old control allowed for
  // the row to APPEAR, so this claim is at least as strong as that one was.
  const quietFor = 2 * TICK_MS + ACK_MS;
  let leaked = false;
  try {
    await b.until(`document.querySelectorAll(".rt-comp tbody tr").length > ${have}`, "B to render A's row", quietFor);
    leaked = true;
  } catch (_) { /* absent, which is the rule */ }

  // 2. AN EXPLICIT RE-READ SHOWS IT.
  const t0 = now();
  await b.evaluate(`await window.__craftworks.refresh(); return 1;`);
  let shown = true, readMs = NaN;
  try { readMs = (await b.until(`document.querySelectorAll(".rt-comp tbody tr").length > ${have}`, "B to show A's row after an explicit re-read", ACK_MS + 2 * TICK_MS)) - t0; }
  catch (_) { shown = false; }

  await shot(a, "control-a-wrote");
  await shot(b, "control-b-read");
  a.close(); b.close();
  return { mode, leaked, quietFor, shown, readMs, liveBindings: mode?.liveBindings ?? null };
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
// The CONTROL is a behaviour, not a latency (see `controlArm`), so it is run
// on its own and reported on its own.
const control = await step("control arm (not live = read when needed)", controlArm);
if (control) {
  console.log(`  [control done] B did ${control.leaked ? "RENDER" : "not render"} A's row within ${control.quietFor} ms; ` +
    `after an explicit re-read it ${control.shown ? `showed it in ${control.readMs} ms` : "STILL did not show it"}; ` +
    `liveBindings=${control.liveBindings}`);
}
for (const live of [true]) {
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
const liveArm = results.find(r => r.live);
const check = (what, fn) => {
  try { fn(); console.log(`  PASS  ${what}`); }
  catch (e) { report.failures.push(`${what}: ${e.message}`); console.log(`  FAIL  ${what}: ${e.message}`); }
};

console.log("\n=== the six items ===");
check("1. the live arm really held a head subscription, and a LIVE binding to re-run", () => {
  assert.strictEqual(liveArm?.bMode?.mode, "HeadSubscribed",
    `not subscribed (${liveArm?.bMode?.why ?? "no report"}), so its number is the tick's number wearing a different name`);
  assert.ok((liveArm?.bMode?.headChanges ?? 0) > 0,
    "the subscription delivered no head change, so it is a subscription in name only (sdk#259)");
  assert.ok((liveArm?.bMode?.liveBindings ?? 0) > 0,
    "the live arm held no LIVE binding, so nothing would re-run on what the subscription delivered");
});
check("2. the control follows the owner's rule: not live = read when needed", () => {
  // NOT "B is slower without a subscription", which is what this used to
  // assert. A plain binding is not told about anybody else's write at all —
  // it shows what it last read, and reads again when the app asks. So the
  // three claims are: it did NOT appear on its own, it DID appear on an
  // explicit re-read, and nothing was watching (`liveBindings` is 0, which is
  // what makes the first claim the rule rather than a defect).
  assert.ok(control, "the control arm did not run at all");
  assert.ok(!control.leaked,
    `B rendered A's row with no LIVE binding and no re-read, within ${control.quietFor} ms: ` +
    "either something IS watching, or the rule is not what the owner said");
  assert.ok(control.shown,
    "an explicit re-read did not show A's row: a tab cannot read at the head it has adopted (sdk#266)");
  assert.strictEqual(control.liveBindings, 0,
    `the control held ${control.liveBindings} LIVE binding(s), so it was never a control`);
});
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
  console.log(`\ntree kept at ${node.dir} for inspection`);
  await host.done(1);
}
console.log("\nall six items pass.");
rmSync(node.dir, { recursive: true, force: true });
await host.done(0);
