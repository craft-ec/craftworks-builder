// THE PAGE, for §19 P3: the builder's definition is its project's DRAFT in the owner's tree, written through the
// project runtime's draft writer. In headless Chrome over the real page, with NO NODE — the case a person meets first:
//
//   - there is always an open project (none was stored: a new one is made), named as its draft's meta names it;
//   - an edit is kept in the tab and the line SAYS it is not in the tree yet, and why ("waiting for your node",
//     counting, with the opener's reason) — builder#56's rule, on the new path;
//   - a NEW project inherits nothing of the one that was open (builder#53's rule): no components, no schemas;
//   - an app in the URL (`#app=`) is imported as a new project, never laid over the open one.
import assert from "node:assert";
import { openPageHost, cdpConnect } from "./page-host.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const { port: PORT, debug: DEBUG, nonce, pageProof, done } = await openPageHost("draft-page");

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(t => t.type === "page"); } catch (_) {}
  }
  assert.ok(target, "chrome did not start");
  const { send } = await cdpConnect(target.webSocketDebuggerUrl, "draft-page");
  const evaluate = async expr => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page error");
    return r.result.result.value;
  };
  const until = async (expr, what) => { for (let i = 0; i < 80; i++) { if (await evaluate(`return ${expr}`)) return; await sleep(100); } throw new Error(`timed out: ${what}; the page shows: ${await evaluate(`return document.body.innerText.slice(0, 600)`)}`); };
  const def = () => evaluate(`return JSON.parse(document.getElementById("def").textContent)`);
  const line = `document.getElementById("save-state")`;

  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge");
  assert.strictEqual(await evaluate(pageProof), nonce, "the page is not served from this tree");

  // 1. An open project, made because none was stored, named by its draft's meta.
  await until(`JSON.parse(document.getElementById("def").textContent).name === "Project 1"`, "a first project, named in its definition");
  await evaluate(`document.getElementById("projects-chip").click()`);
  await until(`[...document.querySelectorAll(".proj-row b")].some(b => b.textContent === "Project 1")`, "the list names the project from its meta");

  // 2. An edit: kept in the tab, and the line says it is not in the tree yet, and why.
  await evaluate(`document.body.click()`);
  await evaluate(`[...document.querySelectorAll("#palette button.chip")].find(b => !b.disabled).click()`);
  assert.strictEqual((await def()).components.length, 1, "the edit is not on the canvas");
  await until(`!${line}.hidden && ${line}.textContent.includes("waiting for your node")`, "the not-saved line");
  const said = await evaluate(`return ${line}.textContent`);
  assert.match(said, /^Not saved yet: waiting for your node \(\d+ s\) — /, said);
  assert.ok(!/Not saved\. Not saved/.test(said), `the line says it twice: ${said}`);
  assert.match(said, /no node port was given/, `the line does not say WHY: ${said}`);

  // 3. A new project inherits nothing of the one that was open.
  await evaluate(`document.getElementById("projects-chip").click()`);
  await until(`!!document.getElementById("projects-new")`, "the New project button");
  await evaluate(`document.getElementById("projects-new").click()`);
  await until(`JSON.parse(document.getElementById("def").textContent).name === "Project 2"`, "the second project");
  const second = await def();
  assert.deepStrictEqual([second.components, second.schemas, second.seed], [[], {}, {}], "a new project inherited the open one's definition");

  // 4. An app in the URL is a NEW project, starting as it -- imported ONCE: the page's URL loses `app=` (the rest of
  //    the hash kept), and a RELOAD reopens that project rather than importing it again.
  const imported = { name: "From a link", components: [{ type: "table", domain: "tasks", mode: "owned" }] };
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/#preview=0&app=${encodeURIComponent(JSON.stringify(imported))}` });
  await send("Page.reload", {});
  await until(`JSON.parse(document.getElementById("def")?.textContent || "{}").name === "From a link"`, "the imported app");
  assert.deepStrictEqual((await def()).components.map(c => c.type), ["table"]);
  const openId = () => evaluate(`return JSON.parse(localStorage.getItem("craftec.builder.device.v1") ?? "{}").lastOpened ?? null`);
  const importedId = await openId();
  await until(`!location.hash.includes("app=")`, "the link's app= removed from the page's URL once imported");
  assert.strictEqual(await evaluate(`return location.hash`), "#preview=0", "the rest of the hash was not kept");
  await evaluate(`document.getElementById("projects-chip").click()`);
  await until(`document.querySelectorAll(".proj-row").length === 3`, "three projects: the import did not replace one");
  // A RELOAD reopens the imported project (with no node its draft is not read yet: it is the project that is
  // compared, and how many there are), and imports nothing.
  await send("Page.reload", {});
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK badge after the reload");
  await until(`document.getElementById("save-reason")?.textContent.includes("reading it from your node")`, "the reopened project reading its draft");
  await sleep(1500);   // time for a second import to happen, if one were going to
  assert.strictEqual(await openId(), importedId, "a reload opened another project than the one imported");
  await evaluate(`document.getElementById("projects-chip").click()`);
  await until(`document.querySelectorAll(".proj-row").length > 0`, "the list after the reload");
  assert.strictEqual(await evaluate(`return document.querySelectorAll(".proj-row").length`), 3, "a reload imported the app again as another project");

  // 5. FREENET'S SANDBOXED FRAME refuses `history.replaceState` with a URL (a SecurityError, origin null): the
  //    builder still starts and imports, and the recorded `importedFrom` alone keeps a reload from importing twice.
  await send("Page.enable", {});
  const added = await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `history.replaceState = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };`,
  });
  const identifier = added.result?.identifier ?? added.identifier;
  const sandboxed = { name: "Sandboxed link", components: [{ type: "list", domain: "tasks", mode: "owned" }] };
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/#app=${encodeURIComponent(JSON.stringify(sandboxed))}` });
  await send("Page.reload", {});
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK ready although replaceState is refused");
  await until(`JSON.parse(document.getElementById("def")?.textContent || "{}").name === "Sandboxed link"`, "the link imported although its URL could not be rewritten");
  assert.ok(await evaluate(`return location.hash.includes("app=")`), "THE CONTROL: the refusal was not in force (the URL was rewritten)");
  const notes = await evaluate(`return document.getElementById("storage-note")?.textContent ?? ""`);
  assert.ok(!/insecure|SecurityError|project list/i.test(notes), `the refused URL rewrite surfaced as a failure: ${notes}`);
  const sandboxedId = await openId();
  await send("Page.reload", {});
  await until(`document.getElementById("sdk")?.textContent.startsWith("SDK ")`, "SDK ready after the reload");
  await until(`document.getElementById("save-reason")?.textContent.includes("reading it from your node")`, "the reopened project reading its draft");
  await sleep(1500);
  assert.strictEqual(await openId(), sandboxedId, "a reload of the same link, its URL not rewritable, opened another project");
  await evaluate(`document.getElementById("projects-chip").click()`);
  await until(`document.querySelectorAll(".proj-row").length > 0`, "the list after the reload");
  assert.strictEqual(await evaluate(`return document.querySelectorAll(".proj-row").length`), 4, "the same link imported twice when its URL could not be rewritten");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });

  process.stdout.write("ok the page: an open project always, the not-saved line says why, a new project inherits nothing, #app= imports once (and in a sandboxed frame)\n");
  done(0);
} catch (e) {
  // `done` EXITS with the code it is given: a failure must hand it 1, or it ends the run green.
  console.error("draft page FAILED:", e.message);
  done(1);
}
