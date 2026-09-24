// THE PAGE, for builder#53: switching projects must not hand one project's
// definition to another. The auditor's sequence, in headless Chrome over the
// real page and its real localStorage:
//
//   1. Project 1: a Table on `tables`, its schema type set to SchemaA.
//   2. Project 2: a Table on the SAME domain, schema type SchemaB.
//   3. Reopen Project 1: its app definition must say SchemaA. It said SchemaB.
//
// Then what the acceptance adds: a reload, a duplicate, and a new project that
// must inherit nothing. The "app definition" panel is read because it is what
// the page shows a person as the definition.
import assert from "node:assert";
import { openPageHost, cdpConnect } from "./page-host.mjs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), "cw-def-shots-"));
mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// This run's own server and Chrome, on ports the OS chose, proven to be THIS
// tree by a nonce (builder#70).
const { port: PORT, debug: DEBUG, nonce, pageProof, done } =
  await openPageHost("definition page", { windowSize: "1280,900", budgetMs: 150_000 });

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(t => t.type === "page"); } catch (_) {}
  }
  assert.ok(target, "chrome did not start");
  // Through the ONE CDP connection (page-host): every call has a deadline.
  const { send } = await cdpConnect(target.webSocketDebuggerUrl, "definition-page");
  const within = (p, ms, what) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error(`no answer in ${ms} ms: ${what}`)), ms))]);
  const evaluate = async expr => {
    const r = await within(send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }), 5000, expr.slice(0, 60));
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page error");
    return r.result.result.value;
  };
  // A failed or unanswered evaluate is "not yet", not a failure: one sent while
  // the page is mid-navigation never answers, and treating that as fatal made
  // a reload look like a hung page. The condition itself still has a deadline.
  const until = async (expr, what, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await within(evaluate(`return ${expr}`), 2000, what)) return; } catch (_) { /* not yet */ }
      await sleep(100);
    }
    throw new Error(`timed out: ${what}`);
  };
  /** Reload, and wait until the app has opened a project whose name is `name`. */
  const reloadInto = async (name, what) => {
    await send("Page.reload", { ignoreCache: true });
    await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")
      && JSON.parse(document.getElementById("def").textContent).name === ${JSON.stringify(name)}`, what);
  };
  const shot = async name => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64"));
  };

  /** The app definition the page shows, parsed. */
  const def = () => evaluate(`return JSON.parse(document.getElementById("def").textContent);`);
  const openPop = async () => {
    if (await evaluate(`return document.getElementById("projects-pop").hidden;`)) {
      await evaluate(`document.getElementById("projects-chip").click();`);
    }
    await until(`!!document.getElementById("projects-new")`, "the projects popover");
  };
  const closePop = async () => {
    if (!(await evaluate(`return document.getElementById("projects-pop").hidden;`))) {
      await evaluate(`document.getElementById("projects-chip").click();`);
    }
  };
  // EVERY STEP WAITS FOR THE STATE IT CAUSED, never for a duration. A fixed
  // sleep is a guess about how long the page takes, and this file's guesses
  // failed intermittently (a duplicate read before it was written).
  const rows = () => evaluate(`return [...document.querySelectorAll(".proj-row b")].map(b => b.textContent);`);
  const newProject = async () => {
    await openPop();
    const before = (await rows()).length;
    await evaluate(`document.getElementById("projects-new").click();`);
    await until(`document.querySelectorAll(".proj-row").length === ${before + 1}
      && JSON.parse(document.getElementById("def").textContent).name === "Project ${before + 1}"`, "the new project to open");
    await closePop();
  };
  const openByTitle = async t => {
    await openPop();
    await until(`[...document.querySelectorAll(".proj-row b")].some(b => b.textContent === ${JSON.stringify(t)})`, `a row for ${t}`);
    await evaluate(`[...document.querySelectorAll(".proj-row")].find(r => r.querySelector("b").textContent === ${JSON.stringify(t)}).click();`);
    await until(`JSON.parse(document.getElementById("def").textContent).name === ${JSON.stringify(t)}`, `${t} to open`);
    await closePop();
  };
  /** Place a Table on `tables` and set its schema type, through the UI. */
  const tableWithType = async type => {
    await evaluate(`[...document.querySelectorAll("#palette .chip")].find(b => b.textContent.startsWith("Table")).click();`);
    await until(`!!document.querySelector('#props input[title="Record type name"]')`, "the schema editor");
    await evaluate(`const i = document.querySelector('#props input[title="Record type name"]');
      i.value = ${JSON.stringify(type)}; i.dispatchEvent(new Event("input", { bubbles: true }));`);
    // The save is asynchronous: wait until the edit is STORED with the project,
    // not merely on screen — the next step switches away from it.
    await until(`(async () => {
      const { LocalDb } = await import("/local-db.js");
      const P = await import("/projects.js");
      const pid = JSON.parse(localStorage.getItem("craftec.builder.device.v1")).lastOpened;
      return (await P.openProject(new LocalDb(), pid))?.schemas?.tables?.type === ${JSON.stringify(type)};
    })()`, `${type} to be stored with its project`);
  };

  // 0. AN EXISTING PROJECT FROM BEFORE THIS CHANGE keeps its schema. Its
  // schema lived only in the shared working copy ("craftec.builder.app.v2"),
  // never with the project. Opening it with an empty definition and saving
  // that back would have deleted a person's real schema on the first load
  // after the deploy.
  if (process.env.ONLY !== "main") {
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge");
  assert.strictEqual(await evaluate(pageProof), nonce, "definition page: the page is not served from this tree");
  await evaluate(`
    localStorage.clear();
    const { LocalDb } = await import("/local-db.js");
    const P = await import("/projects.js");
    const db = new LocalDb();
    await P.defineProjectDomains(db);
    const p = await P.createProject(db, { title: "Old project" });   // stored the OLD way: no definition
    await P.addComponent(db, p.id, { kind: "table", props: { domain: "tables", mode: "owned" } });
    localStorage.setItem("craftec.builder.device.v1", JSON.stringify({ lastOpened: p.id }));
    localStorage.setItem("craftec.builder.app.v2", JSON.stringify({
      name: "Old project", tree: { realm: "public", identity: null },
      components: [{ type: "table", domain: "tables", mode: "owned" }],
      schemas: { tables: { type: "SchemaOld", fields: [{ name: "title", kind: "text", required: true }] } },
      seed: {} }));`);
  await reloadInto("Old project", "the old project to reopen after seeding it");
  assert.strictEqual((await def()).schemas?.tables?.type, "SchemaOld",
    "the last-opened OLD project must keep the schema its working copy held, not open empty");
  await reloadInto("Old project", "the old project after a second reload");
  assert.strictEqual((await def()).schemas?.tables?.type, "SchemaOld", "and it is now STORED with the project");
  console.log("ok page: an existing project keeps its schema across the upgrade, and it is now stored with it");
  await evaluate(`localStorage.clear();`);

  // A LEGACY PROJECT THAT WAS NOT THE LAST ONE OPEN adopts its own domains too
  // (review of builder#67). P2 was open, so the working copy holds its schema
  // for `b` AND the schema P1 set for `a` earlier. P1 must open with SA — and
  // only SA: taking the whole copy would hand it P2's SB, which is the bug.
  await evaluate(`
    const { LocalDb } = await import("/local-db.js");
    const P = await import("/projects.js");
    const db = new LocalDb();
    await P.defineProjectDomains(db);
    const p1 = await P.createProject(db, { title: "Legacy one" });
    await P.addComponent(db, p1.id, { kind: "table", props: { domain: "a", mode: "owned" } });
    const p2 = await P.createProject(db, { title: "Legacy two" });
    await P.addComponent(db, p2.id, { kind: "table", props: { domain: "b", mode: "owned" } });
    localStorage.setItem("craftec.builder.device.v1", JSON.stringify({ lastOpened: p2.id }));
    localStorage.setItem("craftec.builder.app.v2", JSON.stringify({
      name: "Legacy two", tree: { realm: "public", identity: null },
      components: [{ type: "table", domain: "b", mode: "owned" }],
      schemas: { a: { type: "SA", fields: [{ name: "title", kind: "text" }] },
                 b: { type: "SB", fields: [{ name: "title", kind: "text" }] } },
      seed: {} }));`);
  await reloadInto("Legacy two", "the last-opened legacy project");
  assert.deepStrictEqual(Object.keys((await def()).schemas ?? {}), ["b"], "the open one keeps only its own domain");
  await openByTitle("Legacy one");
  const one = (await def()).schemas ?? {};
  assert.strictEqual(one.a?.type, "SA", `a legacy project that was NOT last opened must adopt its own schema: ${JSON.stringify(one)}`);
  assert.ok(!("b" in one), `and only its own — never P2's SB: ${JSON.stringify(one)}`);
  console.log("ok page: every legacy project adopts exactly its own domains' schemas from the working copy");
  await evaluate(`localStorage.clear();`);

  // ONCE, ENFORCED (review of builder#67). P1 binds `c`, which the copy holds
  // nothing for: it must still leave the first mount NON-legacy, or a later
  // mount would hand it whatever the copy holds by then. And the last-opened
  // project keeps a copy domain nobody's components bind to (`z`).
  await evaluate(`
    const { LocalDb } = await import("/local-db.js");
    const P = await import("/projects.js");
    const db = new LocalDb();
    await P.defineProjectDomains(db);
    const p1 = await P.createProject(db, { title: "Legacy c" });
    await P.addComponent(db, p1.id, { kind: "table", props: { domain: "c", mode: "owned" } });
    const p2 = await P.createProject(db, { title: "Legacy b" });
    await P.addComponent(db, p2.id, { kind: "table", props: { domain: "b", mode: "owned" } });
    localStorage.setItem("craftec.builder.device.v1", JSON.stringify({ lastOpened: p2.id }));
    localStorage.setItem("craftec.builder.app.v2", JSON.stringify({
      name: "Legacy b", tree: { realm: "public", identity: null },
      components: [{ type: "table", domain: "b", mode: "owned" }],
      schemas: { b: { type: "SB", fields: [] }, z: { type: "SZ", fields: [] } }, seed: {} }));`);
  await reloadInto("Legacy b", "mount 1");
  const lastKeeps = Object.keys((await def()).schemas ?? {}).sort();
  assert.deepStrictEqual(lastKeeps, ["b", "z"], `the last-opened project keeps an unclaimed copy domain: ${JSON.stringify(lastKeeps)}`);
  const afterMount1 = await evaluate(`
    const { LocalDb } = await import("/local-db.js"); const P = await import("/projects.js");
    const db = new LocalDb(); const row = (await P.listProjects(db)).find(r => r.fields.title === "Legacy c");
    const p = await P.openProject(db, row.id); return { legacy: p.legacy, schemas: p.schemas };`);
  assert.strictEqual(afterMount1.legacy, false, "the pass must leave every project it touched non-legacy");
  // The copy changes, and the builder mounts again.
  await evaluate(`const a = JSON.parse(localStorage.getItem("craftec.builder.app.v2"));
    a.schemas.c = { type: "SX from later", fields: [] }; localStorage.setItem("craftec.builder.app.v2", JSON.stringify(a));`);
  await reloadInto("Legacy b", "mount 2");
  const afterMount2 = await evaluate(`
    const { LocalDb } = await import("/local-db.js"); const P = await import("/projects.js");
    const db = new LocalDb(); const row = (await P.listProjects(db)).find(r => r.fields.title === "Legacy c");
    return (await P.openProject(db, row.id)).schemas;`);
  assert.deepStrictEqual(afterMount2, afterMount1.schemas,
    `a project adopted once must be unchanged by a later mount with a different copy: ${JSON.stringify(afterMount2)}`);
  console.log("ok page: the adoption happens once — a later mount with a changed copy leaves a project as it was");
  await evaluate(`localStorage.clear();`);
  }

  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge");

  // 1-2. The auditor's two projects.
  await newProject();   // Project 1
  await tableWithType("SchemaA");
  await newProject();   // Project 2
  await tableWithType("SchemaB");
  assert.strictEqual((await def()).schemas.tables.type, "SchemaB");

  // 3. Reopen Project 1.
  await openByTitle("Project 1");
  await shot("53-1-project1-reopened");
  const p1 = await def();
  assert.strictEqual(p1.name, "Project 1");
  assert.strictEqual(p1.schemas?.tables?.type, "SchemaA",
    `Project 1 must read its own SchemaA — the audit found SchemaB (builder#53): ${JSON.stringify(p1.schemas)}`);
  console.log("ok page: reopening Project 1 shows SchemaA, not Project 2's SchemaB (builder#53)");

  // A reload does not lose it: it is STORED with Project 1 now.
  await reloadInto("Project 1", "Project 1 to reopen after a reload");
  assert.strictEqual((await def()).schemas?.tables?.type, "SchemaA", "after a reload Project 1 still reads SchemaA");
  await openByTitle("Project 2");
  assert.strictEqual((await def()).schemas?.tables?.type, "SchemaB", "and Project 2 still reads SchemaB");
  console.log("ok page: both definitions survive a reload");

  // A duplicate copies the definition, not just the components.
  await openByTitle("Project 1");
  await openPop();
  await evaluate(`document.getElementById("projects-dup").click();`);
  await openByTitle("Project 1 copy");
  assert.strictEqual((await def()).schemas?.tables?.type, "SchemaA", "a duplicate of Project 1 carries SchemaA");
  console.log("ok page: a duplicate carries its source's definition");

  // A new project inherits NOTHING.
  await newProject();
  await shot("53-2-new-project");
  const fresh = await def();
  assert.deepStrictEqual(fresh.schemas, {}, `a new project must start with no schemas: ${JSON.stringify(fresh.schemas)}`);
  assert.deepStrictEqual(fresh.seed, {});
  console.log("ok page: a new project inherits no schemas and no seed");

  // A PANEL WITHOUT `getDefinition` MUST NOT WIPE (review of builder#67). The
  // old default, `() => ({})`, looked like a no-op and was a wipe: `persist`
  // saved an empty definition, which removes every domain record.
  const kept = await evaluate(`
    const { LocalDb } = await import("/local-db.js");
    const P = await import("/projects.js");
    const { mountProjects } = await import("/projects-panel.js");
    const mem = new Map();
    const storage = { get length() { return mem.size; }, key: i => [...mem.keys()][i] ?? null,
      getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
    const db = new LocalDb(storage);
    await P.defineProjectDomains(db);
    const p = await P.createProject(db, { title: "kept" });
    await P.saveDefinition(db, p.id, { schemas: { a: { type: "Kept", fields: [] } } });
    storage.setItem("craftec.builder.device.v1", JSON.stringify({ lastOpened: p.id }));
    const panel = await mountProjects(document.createElement("div"), {
      db, storage, getCanvas: () => [], setCanvas: () => {} });   // NO getDefinition
    await panel.persist();
    return (await P.openProject(db, p.id)).schemas;`);
  assert.deepStrictEqual(kept, { a: { type: "Kept", fields: [] } }, `persist without getDefinition wiped the definition: ${JSON.stringify(kept)}`);
  console.log("ok page: a panel with no getDefinition leaves a project's definition alone");

  console.log(`\ndefinition page: all ok  (screenshots: ${SHOTS})`);
  done(0);
} catch (e) {
  console.error("definition page FAILED:", e.message);
  console.error(`screenshots so far: ${SHOTS}`);
  done(1);
}
