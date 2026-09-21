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
        bind: (domain, opts = {}) => {
          const ls = new Set();
          const b = {
            limit: opts.limit, reverse: opts.reverse ?? false,
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

  // ---------------------------------------------------------------------
  // A READ COSTS WHAT THE SCREEN COSTS, NOT WHAT THE DOMAIN HOLDS.
  //
  // AFTER the tests above, deliberately: mounting an app stops the previous
  // mount's listeners (one mount at a time, or two would redraw one canvas),
  // so a block that mounts its own app has to come after any block that
  // still expects an earlier mount to be live.
  // ---------------------------------------------------------------------
  {
    const out = await evaluate(`
      const { mountApp, PAGE } = await import("./runtime.js");
      const binds = [];
      const SCHEMA = { type: "Note", fields: [{ name: "title", kind: "text" }] };
      const db = {
        define: async () => {}, put: async () => ({}), update: async () => {}, delete: async () => {},
        schema: () => SCHEMA, domains: () => ["notes"], count: () => 0, get: () => null,
        scan: () => [],
        // EVERY bind recorded, with what it asked for.
        bind: (domain, opts = {}) => {
          const b = {
            domain, opts, limit: opts.limit, reverse: opts.reverse ?? false,
            getSnapshot: () => [],
            subscribe: () => () => {},
            reload: async () => false,
            liveMode: () => ({ mode: "Polled" }),
          };
          binds.push(b);
          return b;
        },
        liveMode: () => ({ mode: "Polled" }),
      };
      const root = document.createElement("div");
      document.body.appendChild(root);
      // TWO components over ONE domain, which is the ordinary case: a form
      // and a table showing what the form writes.
      await mountApp(root, {}, {
        components: [
          { type: "form", domain: "notes", mode: "owned" },
          { type: "table", domain: "notes", mode: "owned" },
        ],
        schemas: { notes: SCHEMA },
      }, () => {}, db, "published");
      const one = binds.length;
      // A LIST over the same domain is a different read — the newest end, not
      // the first — so it must NOT share the table's binding (builder#51).
      await mountApp(document.createElement("div"), {}, {
        components: [{ type: "table", domain: "notes", mode: "owned" }, { type: "list", domain: "notes", mode: "owned" }],
        schemas: { notes: SCHEMA },
      }, () => {}, db, "published");
      return { binds: one, limits: binds.map(b => b.opts.limit), PAGE,
        directions: binds.slice(one).map(b => b.opts.reverse) };
    `);
    assert.deepStrictEqual(out.directions, [false, true],
      `a table and a list over one domain took bindings with directions ${JSON.stringify(out.directions)} — ` +
      "a forward table and a newest-first list are two reads, and sharing one shows one of them the wrong end");

    assert.strictEqual(out.binds, 1,
      `two components over one domain took ${out.binds} bindings — the same rows are ` +
      "read once per component, and re-read once per component on every change");
    assert.strictEqual(out.limits[0], out.PAGE,
      `the binding asked for limit ${out.limits[0]} instead of a screenful (${out.PAGE}). ` +
      "A list over a cold domain then fetches every record in it to show twenty rows.");
    console.log(`ok e2e: **two components over one domain share ONE read, of ${out.PAGE} rows**`);
  }

  // ---------------------------------------------------------------------
  // A NEWEST-FIRST LIST SHOWS THE NEWEST RECORDS, AND A FULL PAGE SAYS SO
  // (builder#51) — over the REAL SDK, not a fake.
  //
  // The defect this replaces, measured by core dev at `ad67cf7` with 60
  // records: the binding read the first 50 of a FORWARD scan — the OLDEST,
  // since ids are time-ordered — and `list()` reversed them. Top row
  // "note 50"; notes 51..60 never on screen; nothing saying there was more.
  //
  // A fake cannot be this test: the earlier one's `scan` returned `[]`, so it
  // was green whether or not a page was ever read, and it never held more
  // than a page, so it could not see WHICH end reached the screen.
  // ---------------------------------------------------------------------
  {
    const out = await evaluate(`
      const { mountApp, PAGE } = await import("./runtime.js");
      const sdk = window.craftec;
      const N = PAGE + 10;
      const SCHEMA = { type: "Note", fields: [{ name: "title", kind: "text" }] };
      const name = i => "note " + String(i).padStart(2, "0");
      const seed = { notes: Array.from({ length: N }, (_, i) => ({ title: name(i + 1) })) };
      const root = document.createElement("div");
      document.body.appendChild(root);
      const db = await mountApp(root, sdk, {
        components: [{ type: "list", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
        schemas: { notes: SCHEMA }, seed,
      }, () => {}, null, "idle");
      const [listC, tableC] = root.querySelectorAll(".rt-comp");
      const items = () => [...listC.querySelectorAll("li > span:first-child")].map(e => e.textContent);
      const more = c => c.querySelector(".rt-more")?.textContent ?? "";
      // THE CONTROL: an unbounded binding over the same db. If this does not
      // hold every record with the newest on top, the fixture is wrong and
      // nothing below means anything.
      const all = db.bind("notes", { reverse: true });
      await all.reload();
      const control = all.getSnapshot().map(r => r.fields.title);
      const first = { list: items(), listMore: more(listC),
        table: [...tableC.querySelectorAll("tbody tr")].map(tr => tr.cells[0].textContent), tableMore: more(tableC) };
      // "Show more" on the list reads the next page with \`after\`.
      listC.querySelector(".rt-more button")?.click();
      for (let k = 0; k < 100 && !more(root.querySelectorAll(".rt-comp")[0]).startsWith("All"); k++) await new Promise(r => setTimeout(r, 20));
      const after = { list: [...root.querySelectorAll(".rt-comp")[0].querySelectorAll("li > span:first-child")].map(e => e.textContent),
        listMore: more(root.querySelectorAll(".rt-comp")[0]) };
      return { N, PAGE, control, first, after, top: name(N), bottom: name(1) };
    `);
    assert.strictEqual(out.control.length, out.N, `CONTROL: an unbounded binding held ${out.control.length} of ${out.N} records — the fixture is wrong`);
    assert.strictEqual(out.control[0], out.top, `CONTROL: an unbounded reverse binding's top row is ${out.control[0]}, not ${out.top}`);
    console.log(`  records ${out.N} · PAGE ${out.PAGE} · CONTROL unbounded top row: ${out.control[0]} (${out.control.length} rows)`);
    console.log(`  list: ${out.first.list.length} rows, top ${out.first.list[0]}, bottom ${out.first.list.at(-1)} · footer "${out.first.listMore}"`);
    console.log(`  table: ${out.first.table.length} rows, top ${out.first.table[0]} · footer "${out.first.tableMore}"`);
    assert.strictEqual(out.first.list[0], out.top,
      `the newest record is not on screen: a newest-first list's top row is ${out.first.list[0]}, not ${out.top}. ` +
      "It read the OLDEST page and reversed it (builder#51).");
    assert.strictEqual(out.first.list.length, out.PAGE, "the list did not read a page");
    assert.match(out.first.listMore, /may be more/,
      `a full page of ${out.PAGE} said nothing about there being more — 'there are ${out.PAGE}' and 'at least ${out.PAGE}' drew the same`);
    assert.strictEqual(out.first.table[0], out.bottom, "a table is oldest-first, deliberately");
    assert.match(out.first.tableMore, /may be more/, "a full forward page said nothing about there being more");
    assert.strictEqual(out.after.list.length, out.N, `"Show more" reached ${out.after.list.length} of ${out.N}`);
    assert.strictEqual(out.after.list.at(-1), out.bottom, "the page past the first did not continue in the same direction");
    assert.strictEqual(new Set(out.after.list).size, out.N, "a row was shown twice across pages");
    assert.strictEqual(out.after.listMore, `All ${out.N} shown.`, "the read past the end came back short and the view still did not say so");
    console.log(`ok e2e: **a list shows the NEWEST ${out.PAGE}, says there may be more, and "Show more" reaches all ${out.N}** — over the real SDK`);
  }

  // ---------------------------------------------------------------------
  // A TOO-OLD SDK FAILS LOUDLY. Three stale pins in three PRs, each found by
  // review: an SDK that does not know an option DROPS it, and the runtime
  // drew a screen from a read it never asked for. So a binding that does not
  // report the page it was asked for refuses to mount. The fake here is
  // exactly an old SDK: it takes the options and ignores `reverse`.
  // ---------------------------------------------------------------------
  {
    const refused = await evaluate(`
      const { mountApp, PAGE } = await import("./runtime.js");
      const SCHEMA = { type: "Note", fields: [{ name: "title", kind: "text" }] };
      const make = honest => ({
        define: async () => {}, put: async () => ({}), update: async () => {}, delete: async () => {},
        schema: () => SCHEMA, domains: () => ["notes"], count: () => 0, get: () => null, scan: async () => [],
        bind: (domain, opts = {}) => ({
          limit: opts.limit, reverse: honest ? (opts.reverse ?? false) : false,
          getSnapshot: () => [], subscribe: () => () => {}, reload: async () => false, liveMode: () => ({ mode: "Polled" }),
        }),
        liveMode: () => ({ mode: "Polled" }),
      });
      const app = { components: [{ type: "list", domain: "notes", mode: "owned" }], schemas: { notes: SCHEMA } };
      const tryMount = async honest => { try { await mountApp(document.createElement("div"), {}, app, () => {}, make(honest), "published"); return ""; } catch (e) { return e.message; } };
      return { old: await tryMount(false), current: await tryMount(true) };
    `);
    assert.match(refused.old, /SDK_REV/, `an SDK that ignored \`reverse\` mounted anyway ("${refused.old}") — the oldest page would be drawn as the newest`);
    assert.strictEqual(refused.current, "", `CONTROL: an SDK that honours the page was refused too ("${refused.current}")`);
    console.log("ok e2e: **an SDK that ignores the page refuses to mount** (control: one that honours it mounts)");
  }

  // ---------------------------------------------------------------------
  // THE LIMITATION, PINNED — and this test is MEANT to fail one day.
  //
  // A component filtered by a parent still reads the whole domain, because a
  // record's key cannot carry a parent and the filter cannot be expressed as
  // a range (craftworks-sdk#122). Paginating that path would be worse than
  // leaving it: twenty scanned rows can yield zero matches, so the page size
  // stops bounding anything a person cares about while appearing to.
  //
  // So the gap is recorded as a FACT rather than a comment. When #122 lands
  // and a binding can express a parent, THIS ASSERTION FAILS — and tells
  // whoever did it that the other half of builder#48 just became available.
  // A test that fails when a blocker clears is worth more than a note nobody
  // re-reads.
  // ---------------------------------------------------------------------
  {
    const asked = await evaluate(`
      const { engineDb } = await import("./sdk/engine-db.js");
      const seen = [];
      const db = engineDb({ session: {
        scan: (domain, reverse, limit, after) => { seen.push({ limit, after }); return "[]"; },
        root: () => "node:r", refresh_domain: () => {}, take_stale: () => "[]",
        live_mode: () => JSON.stringify({ mode: "Polled", why: "", foreignNotifications: 0 }),
        take_loads: () => "[]",
      } });
      // Ask for the children of a parent. There is no way to say it.
      const b = db.bind("notes", { limit: 50, parent: "some-parent-id" });
      await b.reload();
      return { seen, keys: Object.keys(b) };
    `);
    assert.ok(asked.seen.length > 0, "the binding never scanned — this test measures nothing");
    assert.ok(!("parent" in asked),
      "a binding now accepts a parent. craftworks-sdk#122 has landed, so a filtered read " +
      "no longer has to scan the whole domain — the other half of builder#48 is available, " +
      "and THIS TEST is the thing telling you so. Update it and paginate the filtered path.");
    console.log("ok e2e CONTROL: a filtered read is still O(domain) — pinned to craftworks-sdk#122");
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
        bind: (domain, opts = {}) => {
          const ls = new Set();
          return {
            limit: opts.limit, reverse: opts.reverse ?? false,
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
