// Drives the real page in headless Chrome over the DevTools protocol (no deps):
// build an app, preview it, add / edit / delete through the UI, watch the tree count.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8097, DEBUG = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cw-e2e-"))}`, "about:blank"], { stdio: "ignore" });
const done = code => { server.kill(); chrome.kill(); process.exit(code); };

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(t => t.type === "page"); } catch (_) {}
  }
  assert.ok(target, "chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let seq = 0; const waiting = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise(ok => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expr => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page error");
    return r.result.result.value;
  };
  const until = async (expr, what) => { for (let i = 0; i < 60; i++) { if (await evaluate(`return ${expr}`)) return; await sleep(100); } throw new Error(`timed out: ${what}`); };

  const app = { components: [{ type: "form", domain: "tasks", mode: "owned" }, { type: "table", domain: "tasks", mode: "owned" }] };
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/#preview=1&app=${encodeURIComponent(JSON.stringify(app))}` });
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge");
  await until(`!!document.querySelector(".rt-comp input[name=title]")`, "form inputs rendered as inputs");
  assert.ok(!(await evaluate(`return document.getElementById("canvas").textContent.includes("[object")`)), "DOM nodes were stringified");

  const rows = `[...document.querySelectorAll(".rt-comp tbody tr")].map(tr => tr.cells[0].textContent)`;
  const tree = `document.querySelector("#tree .path small")?.textContent ?? ""`;
  // A write is a ROUND TRIP once this runs over the engine, so every helper
  // here clicks and then WAITS for the screen to catch up. The old ones
  // clicked and read immediately, which worked only while a write was
  // synchronous — and failed intermittently the moment it was not, which is
  // worse than failing every time.
  const settle = async before => {
    for (let i = 0; i < 60; i++) {
      if ((await evaluate(`return ${body}`)) !== before) return;
      await sleep(50);
    }
    throw new Error("the table did not change after a write");
  };
  const body = `document.querySelector(".rt-comp tbody")?.textContent ?? ""`;
  const add = async (title, expectChange = true) => {
    const before = await evaluate(`return ${body}`);
    await evaluate(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = ${JSON.stringify(title)}; document.querySelector(".rt-comp button.pri").click();`);
    // A REFUSED write changes nothing, so waiting for a change would hang on
    // exactly the case the next assertion is about.
    if (expectChange) await settle(before);
    else await sleep(150);
  };
  /// Click a button and wait for the table to change because of it.
  const clickAndSettle = async expr => {
    const before = await evaluate(`return ${body}`);
    await evaluate(expr);
    await settle(before);
  };

  // refused write: the required field is blank → message shown, nothing stored
  await add("", false);
  assert.match(await evaluate(`return document.querySelector(".rt-err").textContent`), /title.*required/);
  assert.deepStrictEqual(await evaluate(`return ${rows}`), []);

  await add("first"); await add("second");
  assert.deepStrictEqual(await evaluate(`return ${rows}`), ["first", "second"]);
  assert.match(await evaluate(`return ${tree}`), /2 records/);

  // edit the first row through the UI
  await evaluate(`document.querySelector(".rt-comp tbody tr button").click();`);
  await until(`document.querySelector(".rt-comp input[name=title]").value === "first"`, "the edit form to load the row");
  await clickAndSettle(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = "first, edited"; document.querySelector(".rt-comp button.pri").click();`);
  assert.deepStrictEqual(await evaluate(`return ${rows}`), ["first, edited", "second"]);

  // delete the second row
  await clickAndSettle(`document.querySelectorAll(".rt-comp tbody tr")[1].querySelectorAll("button")[1].click();`);
  assert.deepStrictEqual(await evaluate(`return ${rows}`), ["first, edited"]);
  assert.match(await evaluate(`return ${tree}`), /1 record\b/);

  // ---- the real tree, shown to the user -------------------------------------
  const root = `document.getElementById("root-hash")?.title ?? ""`;
  const short = `document.getElementById("root-hash")?.textContent ?? ""`;
  const stats = `document.getElementById("root-stats")?.textContent ?? ""`;

  const tag = `document.getElementById("root-tag")?.textContent ?? ""`;
  const copied = `document.querySelector("#tree-root .copy")?.dataset.copy ?? ""`;
  // What the SDK makes of the string the panel is showing. Asked of the SDK,
  // not of a regex here: the builder does not own this format, and a test that
  // restated it would agree with a panel that had drifted.
  const parsed = `JSON.stringify(window.craftec.parseBlockId(${root}))`;

  const r1 = await evaluate(`return ${root}`);
  assert.match(r1, /^node:[0-9a-f]{64}$/, "the panel shows a tagged tree-node block id");
  const p1 = JSON.parse(await evaluate(`return ${parsed}`));
  assert.strictEqual(p1.tag, "node");
  assert.strictEqual(await evaluate(`return ${tag}`), "node", "the tag is shown as its own label");
  // The 12 characters on screen must be 12 characters of HASH — the bug this
  // change exists to prevent is the tag eating the visible hash, and a prefix
  // test against the whole string would pass while showing `node:8e3a91c`.
  const shown = await evaluate(`return ${short}`);
  assert.ok(shown.startsWith(p1.hex.slice(0, 12)), `short hash ${shown} must be a prefix of the HEX part`);
  assert.ok(!shown.includes(":"), "the tag must not be inside the short hash");
  assert.ok(!shown.startsWith(p1.tag), "the short hash must not start with the tag");
  // The copied text is the whole id, and it parses back through the SDK: what
  // a user pastes elsewhere has to be something that can be read.
  const c1 = await evaluate(`return ${copied}`);
  assert.strictEqual(c1, r1, "copy carries the full tagged id, not the short form");
  assert.strictEqual(
    JSON.parse(await evaluate(`return JSON.stringify(window.craftec.parseBlockId(${copied}))`)).id,
    c1,
    "the copied string round-trips through the SDK parser");
  assert.match(await evaluate(`return ${stats}`), /height \d+/);
  assert.match(await evaluate(`return ${stats}`), /\d+ blocks/);

  // A write moves the root, and the stats follow.
  await add("third");
  const r2 = await evaluate(`return ${root}`);
  assert.notStrictEqual(r2, r1, "adding a record must move the root");
  const blocksOf = t => Number(t.match(/(\d+) blocks/)[1]);
  assert.ok(blocksOf(await evaluate(`return ${stats}`)) > 1, "blocks are counted");

  // HISTORY INDEPENDENCE, the way the tree means it: the root is a function of
  // the CONTENTS, not of the route taken to them. Add a record and delete it
  // again and the root must come back to exactly what it was.
  //
  // (The issue asked for the same records added in a different order in a fresh
  //  session. That cannot produce the same root through this UI: a record's key
  //  is its rkey = timestamp ‖ device ‖ tail, and device is random per session,
  //  so two sessions never hold the same keys. See the PR.)
  await add("temporary");
  assert.notStrictEqual(await evaluate(`return ${root}`), r2, "the extra record moved it");
  await clickAndSettle(`[...document.querySelectorAll(".rt-comp tbody tr")].find(tr => tr.cells[0].textContent === "temporary").querySelectorAll("button")[1].click();`);
  assert.strictEqual(await evaluate(`return ${root}`), r2, "same contents, same root");

  // An edit and an edit BACK does not restore the root, and that is right: a
  // record carries its own `updated` time, so typing the old title back leaves
  // different CONTENTS. The root follows the contents, not the screen.
  const r3 = await evaluate(`return ${root}`);
  await evaluate(`document.querySelector(".rt-comp tbody tr button").click();`);
  await until(`document.querySelector(".rt-comp input[name=title]")?.value === "first, edited"`, "the edit form");
  await clickAndSettle(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = "changed"; document.querySelector(".rt-comp button.pri").click();`);
  assert.notStrictEqual(await evaluate(`return ${root}`), r3, "an edit moves it");
  await evaluate(`document.querySelector(".rt-comp tbody tr button").click();`);
  await until(`document.querySelector(".rt-comp input[name=title]")?.value === "changed"`, "the edit form again");
  await clickAndSettle(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = "first, edited"; document.querySelector(".rt-comp button.pri").click();`);
  assert.deepStrictEqual(await evaluate(`return ${rows}`), ["first, edited", "third"], "the title is back");
  assert.notStrictEqual(
    await evaluate(`return ${root}`),
    r3,
    "but `updated` moved, so the contents differ and so must the root"
  );

  // A record the SDK refuses: its message is shown, and the root does not move.
  const before = await evaluate(`return ${root}`);
  await evaluate(`const i = document.querySelector(".rt-comp input[name=title]"); i.value = "x".repeat(300 * 1024); document.querySelector(".rt-comp button.pri").click();`);
  const msg = await evaluate(`return document.querySelector(".rt-err").textContent`);
  assert.match(msg, /262144/, "the SDK's limit is shown to the user");
  assert.match(msg, /file|blob/, "and what to do instead");
  assert.strictEqual(await evaluate(`return ${root}`), before, "a refused write must not move the root");

  // Delete everything: back to the empty tree.
  //
  // One click, then WAIT for the row to go, then the next. The old loop
  // clicked fifty times inside one synchronous pass, which worked only while a
  // write was synchronous — it clicked the same stale button over and over and
  // removed one row. A write is a round trip once this runs over the engine,
  // so the test drives it the way a person does: act, wait for the screen to
  // catch up, act again.
  for (let guard = 0; guard < 50; guard++) {
    const left = await evaluate(`return document.querySelectorAll(".rt-comp tbody tr").length`);
    if (left === 0) break;
    await evaluate(`document.querySelector(".rt-comp tbody tr").querySelectorAll("button")[1].click();`);
    await until(`document.querySelectorAll(".rt-comp tbody tr").length < ${left}`, `a row to be deleted (${left} left)`);
  }
  assert.deepStrictEqual(await evaluate(`return ${rows}`), []);
  const empty = await evaluate(`return ${root}`);
  assert.notStrictEqual(empty, before);
  assert.match(await evaluate(`return ${stats}`), /height 1/, "one empty leaf");

  console.log("ok e2e: add, refuse, edit, delete through the page; tree count follows");
  console.log(`ok e2e: root shown and live; same contents give the same root; empty tree ${empty.slice(0, 12)}…`);

  // ---- the control ----------------------------------------------------------
  // With the panel frozen on its first root, the assertions above must FAIL.
  // Without this, "the root followed the tree" would also be true of a panel
  // that printed a constant.
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/#preview=1&stale-root=1&app=${encodeURIComponent(JSON.stringify(app))}` });
  await until(`!!document.querySelector(".rt-comp input[name=title]")`, "form rendered again");
  await until(`!!document.getElementById("root-hash")`, "root panel again");
  const s1 = await evaluate(`return ${root}`);
  await add("one"); await add("two");
  const s2 = await evaluate(`return ${root}`);
  assert.strictEqual(s1, s2, "the control must genuinely freeze the panel");
  assert.deepStrictEqual(await evaluate(`return ${rows}`), ["one", "two"], "while the tree really did change");
  console.log("ok e2e control: a panel that stops following the tree is detected");

  // ---------------------------------------------------------------------
  // THE BACKEND THAT ANSWERS LATER.
  //
  // Every other test in this file — and every other test in this repo — runs
  // the app over the IN-MEMORY database, whose reads are synchronous. The
  // engine-backed one's are not: a cold `schema`, `count` or `scan` is a read
  // over the network, so it returns a Promise.
  //
  // That is a difference no existing test could see, because all of them
  // share the sync backend. What it cost: `render` called `db.schema(domain)`
  // synchronously, a Promise is truthy, so it went straight past the
  // `!schema` guard into `schema.fields.map` — and PUBLISHING A PROJECT
  // REPLACED THE WHOLE APP with "Cannot read properties of undefined (reading
  // 'map')". The button said Published. It fired only after the backend
  // switched, which is precisely the moment this repo claims nothing changes.
  //
  // So: mount over a backend that answers LATER, and require the app to be
  // there. No node and no network — the async-ness is the whole subject.
  {
    const mounted = await evaluate(`
      const { mountApp } = await import("./runtime.js");
      // A hand-rolled backend. Every READ resolves on a later turn, which is
      // the only thing that distinguishes it from the in-memory one.
      const later = v => new Promise(r => setTimeout(() => r(v), 0));
      const rows = [];
      const SCHEMA = { type: "Note", fields: [{ name: "title", kind: "text", required: true }] };
      let snap = [];
      const db = {
        define: async () => {},
        put: async (d, fields) => { const rec = { id: String(rows.length), fields, state: "CLEAN" }; rows.push(rec); return rec; },
        update: async () => {}, delete: async () => {},
        // A SCHEMA READ THAT REFUSES, the way a cold one really can.
        // The runtime must not need it: openApp was handed the schema and
        // passed it to define, so asking the network to say it back is a
        // question that can only add failure modes. Measured against a real
        // node: it answered NotLoaded moments after a publish and both
        // components rendered "No schema" for a domain just defined.
        schema: () => { const e = new Error("this range has not been loaded yet"); e.code = "NOT_LOADED"; return Promise.reject(e); },
        domains: () => later(["notes"]),
        count: d => later(rows.length),
        scan: () => later(rows.slice()),
        get: () => later(null),
        // A REAL BINDING: listeners included, because the thing under test is
        // whether anything listens.
        bind: () => {
          const ls = new Set();
          const b = {
            getSnapshot: () => snap,
            subscribe: cb => { ls.add(cb); return () => ls.delete(cb); },
            reload: async () => { snap = rows.slice(); for (const cb of ls) cb(); },
            liveMode: () => ({ mode: "Polled" }),
          };
          window.__binds = window.__binds ?? [];
          window.__binds.push(b);
          return b;
        },
        liveMode: () => ({ mode: "Polled" }),
      };
      window.__rows = rows;
      const root = document.createElement("div");
      document.body.appendChild(root);
      window.__root = root;
      const app = {
        components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
        schemas: { notes: SCHEMA },
        // A SEED ROW, so the table has something to fail to show. A binding
        // starts empty on the engine-backed backend, so a mount that renders
        // before reloading draws an empty table — in a preview it would have
        // been full, which is the two-screens-one-component failure.
        seed: { notes: [{ title: "seeded" }] },
      };
      await mountApp(root, {}, app, () => {}, db, "published");
      return {
        inputs: root.querySelectorAll("input[name=title]").length,
        comps: root.querySelectorAll(".rt-comp").length,
        rows: root.querySelectorAll("tbody tr").length,
        errors: [...root.querySelectorAll(".rt-err")].map(e => e.textContent).filter(Boolean),
      };`);
    assert.strictEqual(mounted.comps, 2, "the app did not mount over an async backend at all");
    assert.strictEqual(mounted.inputs, 1,
      "the form is not there over a backend whose reads answer later — which is what publishing switches to");
    assert.deepStrictEqual(mounted.errors, [],
      `the app mounted with errors on screen: ${JSON.stringify(mounted.errors)}`);
    assert.strictEqual(mounted.rows, 1,
      "the table is EMPTY on a backend whose bindings start empty. The first " +
      "frame was drawn before anything reloaded, so a preview would have shown " +
      "the row and a published project would not — the same component, two screens");
    console.log("ok e2e: the app mounts over a backend whose reads answer LATER, fills its table, and its schema read REFUSES");
  }

  // ---------------------------------------------------------------------
  // DATA THAT CHANGES UNDERNEATH MUST REACH THE SCREEN, WITH NO APP CALL.
  //
  // A write reaching the network, or another tab's row arriving, changes a
  // binding's rows without anybody clicking anything. Components read
  // `getSnapshot()`, so unless something SUBSCRIBES, the new rows sit in the
  // binding and the screen keeps showing the old ones.
  //
  // Measured against a real node: `db.scan()` returned rows CLEAN three
  // seconds after a write while the chips on screen still said "saving" ten
  // seconds later, and a second tab never showed the first tab's row at all.
  // Every acceptance item about data appearing failed on this.
  // ---------------------------------------------------------------------
  {
    const before = await evaluate(`return window.__root.querySelectorAll("tbody tr").length;`);
    const after = await evaluate(`
      // Nothing here touches the app: a row appears in the backing store and
      // the binding is reloaded, exactly as a notification or a tick does it.
      window.__rows.push({ id: "b", fields: { title: "arrived" }, state: "CLEAN" });
      for (const b of window.__binds) await b.reload();
      await new Promise(r => setTimeout(r, 0));
      return window.__root.querySelectorAll("tbody tr").length;`);
    assert.strictEqual(after, before + 1,
      "a row that arrived underneath never reached the screen: the binding has " +
      "the rows and nothing re-rendered. Components read getSnapshot(), so " +
      "something must subscribe — the app cannot be the only thing that redraws");
    console.log("ok e2e: **a row arriving underneath re-renders, with no app call**");
  }

  // THE CONTROL. The same mount with SYNCHRONOUS reads must also work —
  // otherwise the test above would pass on a runtime that had simply stopped
  // reading schemas at all, and both backends have to keep working.
  {
    const mounted = await evaluate(`
      const { mountApp } = await import("./runtime.js");
      const rows = [];
      const SCHEMA = { type: "Note", fields: [{ name: "title", kind: "text", required: true }] };
      let snap = [];
      const db = {
        define: async () => {}, update: async () => {}, delete: async () => {},
        put: async (d, fields) => { const rec = { id: String(rows.length), fields, state: "CLEAN" }; rows.push(rec); return rec; },
        schema: () => SCHEMA, domains: () => ["notes"], count: () => rows.length,
        scan: () => rows.slice(), get: () => null,
        bind: () => {
          const ls = new Set();
          return {
            getSnapshot: () => snap,
            subscribe: cb => { ls.add(cb); return () => ls.delete(cb); },
            reload: async () => { snap = rows.slice(); for (const cb of ls) cb(); },
            liveMode: () => ({ mode: "Polled" }),
          };
        },
        liveMode: () => ({ mode: "Polled" }),
      };
      const root = document.createElement("div");
      document.body.appendChild(root);
      await mountApp(root, {}, {
        components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
        schemas: { notes: SCHEMA },
      }, () => {}, db, "published");
      return { inputs: root.querySelectorAll("input[name=title]").length };`);
    assert.strictEqual(mounted.inputs, 1, "the synchronous backend stopped working");
    console.log("ok e2e CONTROL: and over one whose reads answer at once");
  }

  done(0);
} catch (e) {
  console.error("e2e FAILED:", e.message);
  // The line that failed, because a diff with no location costs a re-run.
  console.error(String(e.stack).split("\n").filter(l => l.includes("e2e.test")).slice(0, 2).join("\n"));
  done(1);
}
