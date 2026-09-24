// THE PAGE, for builder#54 and #57 — the two audit findings reproduced where
// they were found: in headless Chrome, through the real page.
//
// `tests/project-runtime.test.mjs` proves the owner. This proves app.js USES
// it: a correct owner nobody consults behaves exactly like the old globals.
//
//   #57  preview -> design -> preview. The second preview used to render
//        nothing: `mounting` was set and never cleared outside the publish
//        path, so the page skipped the mount for good.
//   #54  publish A (an injected provisioned backend over a second real SDK
//        Db — no node), then New project. B used to read "Published", with
//        nothing requested, on A's backend.
//
// Screenshots are written beside each assertion (SHOTS dir printed at the end)
// because a screenshot caught a data-losing bug here that no test could.
import assert from "node:assert";
import { openPageHost, cdpConnect } from "./page-host.mjs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), "cw-owner-shots-"));
mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// This run's own server and Chrome, on ports the OS chose, with the run's
// budget (builder#70).
const { port: PORT, debug: DEBUG, nonce, pageProof, done } = await openPageHost("owner page");

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(t => t.type === "page"); } catch (_) {}
  }
  assert.ok(target, "chrome did not start");
  // Through the ONE CDP connection (page-host): every call has a deadline.
  const { send } = await cdpConnect(target.webSocketDebuggerUrl, "owner-page");
  // A DEADLINE ON EVERY CALL. `awaitPromise` waits for the page's promise, and
  // a page that stalls never settles it — which hung the first control run of
  // this file past ten minutes with no output. A stall is a failure to report,
  // not a thing to wait on.
  const within = (p, ms, what) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error(`no answer in ${ms} ms: ${what}`)), ms))]);
  const evaluate = async expr => {
    const r = await within(send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }), 5000, expr.slice(0, 60));
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page error");
    return r.result.result.value;
  };
  // A failed or unanswered evaluate is "not yet", not a failure: one sent while
  // the page is mid-navigation never answers, and treating that as fatal made
  // a reload look like a hung page. The condition itself keeps a deadline, and
  // on timeout the message says what was last SEEN, not only what was wanted.
  const until = async (expr, what, { ms = 10_000, show = null } = {}) => {
    const end = Date.now() + ms;
    // The LAST error is kept: "not yet" must not swallow a genuine exception in
    // the expression, which would otherwise time out looking like a condition
    // that simply never became true.
    let lastError = null;
    while (Date.now() < end) {
      try { if (await within(evaluate(`return ${expr}`), 2000, what)) return; lastError = null; }
      catch (e) { lastError = e; }
      await sleep(100);
    }
    let seen = "";
    if (show) { try { seen = ` — last seen: ${JSON.stringify(await evaluate(`return ${show}`))}`; } catch (_) {} }
    throw new Error(`timed out after ${ms} ms: ${what}${seen}${lastError ? ` — last error: ${lastError.message}` : ""}`);
  };
  const shot = async name => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64"));
  };
  // EACH SCENARIO STARTS FROM EMPTY STORAGE. Projects persist in this origin's
  // storage, and the last-opened one is restored over the `#app=` definition
  // on load — so a scenario that ran after another opened the previous one's
  // project instead of its own. Cleared, then reloaded.
  // TIME-TO-BADGE IS PRINTED for every navigation, so a slow start is a number
  // rather than a story. It was suspected that a cold start (fresh profile,
  // first wasm compile, loaded machine) outran the 5 s deadline; measured, it
  // did not: 105-114 ms for the first navigation, cold or warm alike, at load
  // 6.5-11, 12 of 12 runs with every page-test port free. So there is ONE
  // deadline for every navigation, and the earlier "no answer in 5000 ms"
  // failures are not explained by a slow start.
  let navigations = 0;
  const badge = `document.getElementById("sdk")?.textContent.startsWith("SDK ")`;
  const toBadge = async what => {
    const n = ++navigations;
    const t0 = Date.now();
    await until(badge, `${what} (navigation ${n})`,
      { ms: 15_000, show: `({ badge: document.getElementById("sdk")?.textContent ?? null, readyState: document.readyState })` });
    console.log(`  time-to-badge ${Date.now() - t0} ms — navigation ${n}: ${what}`);
  };
  const fresh = async extra => {
    await send("Page.navigate", { url: url(extra) });
    await toBadge("SDK badge");
    // THE PAGE PROVES IT IS THIS TREE: it fetches this run's nonce through
    // its own origin. A foreign server on a stale port cannot answer it.
    assert.strictEqual(await evaluate(pageProof), nonce, "owner page: the page is not served from this tree");
    await evaluate(`localStorage.clear(); sessionStorage.clear();`);
    await send("Page.reload", { ignoreCache: true });
    await toBadge("SDK badge after reset");
  };
  const inputs = `document.querySelectorAll(".rt-comp input").length`;
  const cards = `document.querySelectorAll("#canvas .comp").length`;

  const app = { components: [{ type: "form", domain: "tasks", mode: "owned" }, { type: "table", domain: "tasks", mode: "owned" }] };
  const url = extra => `http://127.0.0.1:${PORT}/#${extra}app=${encodeURIComponent(JSON.stringify(app))}`;

  // `ONLY=54` / `ONLY=57` runs one scenario, so each can be checked against
  // the unfixed page on its own — the first failure would otherwise hide the
  // second.
  const only = process.env.ONLY;
  // ---- builder#57: the auditor's exact sequence --------------------------
  if (!only || only === "57") {
  await fresh("preview=1&");
  await until(`${inputs} > 0`, "the first preview's inputs", { show: `document.getElementById("canvas").textContent.slice(0, 160)` });
  await shot("57-1-first-preview");

  await evaluate(`document.getElementById("preview").click();`);
  await until(`${cards} === 2`, "two design cards after Back to design");
  await shot("57-2-back-to-design");

  await evaluate(`document.getElementById("preview").click();`);
  await until(`document.body.classList.contains("previewing") && ${inputs} > 0`,
    "the SECOND preview's inputs — this is where it used to stay empty (builder#57)");
  await shot("57-3-second-preview");
  const again = await evaluate(`return { previewing: document.body.classList.contains("previewing"), inputs: ${inputs}, cards: ${cards} };`);
  assert.ok(again.inputs > 0 && again.cards === 0, `second preview did not mount: ${JSON.stringify(again)}`);
  console.log("ok page: preview -> design -> preview mounts again (builder#57)", JSON.stringify(again));
  }

  // ---- builder#54: publish A, then New project ---------------------------
  if (!only || only === "54") {
  // Design mode, with a node port that is not reserved, and the SDK's `open`
  // replaced by a provisioned fake over a SECOND real Db — the auditor's
  // setup. No node is involved.
  await fresh("node=18080&");
  await until(`!!document.getElementById("projects-chip")`, "the projects chip");
  await evaluate(`
    window.__closed = 0;
    window.craftec.open = async () => {
      const db = new window.craftec.Db();
      db.preload = async () => {};
      db.trace = () => null;
      return { db, provisioned: () => true, refused: () => null, exhausted: () => false,
               close: () => { window.__closed += 1; } };
    };`);
  await evaluate(`document.getElementById("publish").click();`);
  await until(`document.getElementById("publish").textContent === "Published"`, "A to publish",
    { show: `({ button: document.getElementById("publish").textContent, reason: document.getElementById("publish-note")?.textContent })` });
  await shot("54-1-A-published");

  // NO PROJECT WAS OPEN — the app came from a link — so Publish kept it as one
  // first and published under its id (builder#83). What the person did is
  // unchanged; what is now TRUE of the store is asserted, not assumed.
  const store = `(() => {
    const ns = "craftec.builder.db.v1/r/";
    const rows = p => Object.keys(localStorage).filter(k => k.startsWith(ns + p + "/")).map(k => JSON.parse(localStorage.getItem(k)));
    const device = JSON.parse(localStorage.getItem("craftec.builder.device.v1") ?? "{}");
    return { projects: rows("project").map(r => ({ id: r.id, title: r.fields.title })),
             publications: rows("project.publication").map(r => r.fields.pid),
             open: device.lastOpened ?? null,
             note: document.getElementById("storage-note")?.textContent ?? "" };
  })()`;
  const a = await evaluate(`return ${store}`);
  assert.strictEqual(a.projects.length, 1, `Publish kept the app as ONE project: ${JSON.stringify(a)}`);
  assert.strictEqual(a.open, a.projects[0].id, "and it is the open one");
  assert.deepStrictEqual(a.publications, [a.projects[0].id], "with one publication record, under its id");
  assert.match(a.note, /Saved as project “Untitled app” and published\./, "and the person is told");
  await evaluate(`document.getElementById("projects-chip").click();`);
  await until(`document.getElementById("projects-pop")?.textContent.includes("Untitled app")`, "the kept project to be listed",
    { show: `document.getElementById("projects-pop")?.textContent` });
  await evaluate(`document.getElementById("projects-chip").click();`);
  console.log("ok page: Publish with no project open keeps the app as a project, opens it, and records its publication (builder#83)", JSON.stringify(a));

  await evaluate(`document.getElementById("projects-chip").click();`);
  await until(`!!document.getElementById("projects-new")`, "the New project button");
  await evaluate(`document.getElementById("projects-new").click();`);
  // WAIT ON THE SWITCH ITSELF — B open and A's session closed — not on "the
  // canvas has no cards", which is a proxy that can be true before the switch
  // has run. On timeout the message prints what the page actually showed.
  const state = `({ name: JSON.parse(document.getElementById("def").textContent).name,
    cards: document.querySelectorAll("#canvas .comp").length, closed: window.__closed,
    label: document.getElementById("publish").textContent })`;
  await until(`(() => { const s = ${state}; return s.name === "Project 2" && s.cards === 0 && s.closed >= 1; })()`,
    "B to open and A's session to close", { show: state });
  await shot("54-2-new-project-B");
  const b = await evaluate(`
    const btn = document.getElementById("publish");
    return { label: btn.textContent, disabled: btn.disabled, closed: window.__closed,
             addr: document.getElementById("tree-addr").textContent };`);
  assert.notStrictEqual(b.label, "Published",
    `B was never published and must not say so (builder#54): ${JSON.stringify(b)}`);
  assert.strictEqual(b.disabled, false, "B's Publish must be pressable");
  assert.ok(b.addr.includes("not published"), `B's address line must say it is not published: ${b.addr}`);
  assert.strictEqual(b.closed, 1, "A's session is closed by the switch, not left running beside B");
  console.log("ok page: after A publishes, New project B is not Published and A's session is closed (builder#54)", JSON.stringify(b));

  // THE CONTROL: Publish with a project OPEN makes no second project of it.
  await evaluate(`document.getElementById("publish").click();`);
  await until(`document.getElementById("publish").textContent === "Published"`, "B to publish",
    { show: `({ button: document.getElementById("publish").textContent, reason: document.getElementById("publish-note")?.textContent })` });
  const after = await evaluate(`return ${store}`);
  assert.strictEqual(after.projects.length, 2, `A and B, and no third: ${JSON.stringify(after)}`);
  assert.strictEqual(after.publications.filter(p => p === after.open).length, 1, "B's one publication, under B");
  console.log("ok page: Publish with a project open creates no second project", JSON.stringify(after.projects.length));
  }

  // ---- `stop` releases EVERY subscription a mount made ---------------------
  // Since #51 a mount binds once per unique (domain, live, page, direction), so
  // three components over two domains make TWO subscriptions. The owner
  // disposes a mount through the `stop` it returns, and that must release
  // both. Driven in the page because `mountApp` renders into a real DOM.
  if (!only || only === "stop") {
  await send("Page.navigate", { url: url("") });
  await toBadge("SDK badge (stop scenario)");
  const r = await evaluate(`
    const { mountApp } = await import("/runtime.js");
    let live = 0, made = 0;
    const binding = () => {
      const rows = [];
      return { limit: 50, reverse: false, rows,
        subscribe: () => { live += 1; made += 1; return () => { live -= 1; }; },
        reload: async () => {}, getSnapshot: () => rows, status: () => ({ state: "ready" }) };
    };
    const db = { define: async () => {}, put: async () => ({}), bind: () => binding(),
                 root: () => "", stats: () => ({}), scan: async () => [] };
    const app = { components: [
      { type: "table", domain: "a", mode: "owned" },
      { type: "form", domain: "a", mode: "owned" },
      { type: "table", domain: "b", mode: "owned" } ], schemas: {} };
    const root = document.createElement("div");
    const h = await mountApp(root, {}, app, () => {}, db, "published", { alive: () => true /* no owner here: nothing disposes this mount */ });
    const afterMount = live;
    h.stop();
    const afterStop = live;
    // And a mount disowned before it finished subscribes to NOTHING.
    const before = made;
    const stale = await mountApp(document.createElement("div"), {}, app, () => {}, db, "published", { alive: () => false });
    return { afterMount, afterStop, stale, staleMade: made - before };`);
  assert.ok(r.afterMount > 0, `the mount subscribed to nothing, so this measures nothing: ${JSON.stringify(r)}`);
  assert.strictEqual(r.afterStop, 0, `stop left subscriptions running: ${JSON.stringify(r)}`);
  assert.strictEqual(r.stale, null);
  assert.strictEqual(r.staleMade, 0, "a disowned mount must not subscribe");
  console.log("ok page: stop releases every subscription the mount made; a disowned mount makes none", JSON.stringify(r));
  }

  // ---- builder#52: publish carries the preview's records --------------------
  // The auditor's sequence: Preview a form and table with NO seed, enter a
  // task, publish to a provisioned fake over a second real Db. Before: old
  // count 1, new count 0, button Published.
  if (!only || only === "52") {
  await fresh("node=18080&preview=1&");
  await until(`!!document.querySelector(".rt-comp input[name=title]")`, "the form");
  await evaluate(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = "entered in preview";
    document.querySelector(".rt-comp button.pri").click();`);
  await until(`document.querySelectorAll(".rt-comp tbody tr").length === 1`, "the entered row in the preview table");
  await evaluate(`
    window.__target = null;
    window.craftec.open = async () => {
      const db = new window.craftec.Db();
      db.preload = async () => {};
      db.trace = () => null;
      window.__target = db;
      return { db, provisioned: () => true, refused: () => null, exhausted: () => false, close() {} };
    };`);
  await evaluate(`document.getElementById("publish").click();`);
  await until(`["Published", "Try publishing again"].includes(document.getElementById("publish").textContent)`, "publish to settle");
  // Given time to show the row, but NOT fatal: when the row was dropped the
  // table never shows it, and the assertion below is what should report that,
  // with the numbers — not a timeout that says only "it did not happen".
  await until(`document.querySelectorAll(".rt-comp tbody tr").length === 1`, "the remounted table").catch(() => {});
  await shot("52-1-published-with-the-row");
  const p = await evaluate(`
    return { label: document.getElementById("publish").textContent,
             target: (await window.__target.scan("tasks")).map(r => r.fields.title),
             shown: [...document.querySelectorAll(".rt-comp tbody tr")].map(tr => tr.cells[0].textContent) };`);
  assert.deepStrictEqual(p.target, ["entered in preview"],
    `the row entered in Preview must be on the published backend (builder#52): ${JSON.stringify(p)}`);
  assert.strictEqual(p.label, "Published");
  assert.deepStrictEqual(p.shown, ["entered in preview"], "and the remounted app shows it");
  console.log("ok page: a row entered in Preview is on the published backend and on screen (builder#52)", JSON.stringify(p));
  }

  console.log(`\nowner page: all ok  (screenshots: ${SHOTS})`);
  done(0);
} catch (e) {
  console.error("owner page FAILED:", e.message);
  console.error(`screenshots so far: ${SHOTS}`);
  done(1);
}
