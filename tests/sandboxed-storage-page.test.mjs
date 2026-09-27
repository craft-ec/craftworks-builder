// THE BUILDER WITH NO BROWSER STORAGE (the owner, 2026-09-27): published on freenet, the builder runs in the node's
// sandboxed frame (origin null), where READING `localStorage` throws -- "Failed to read the 'localStorage' property
// from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag." -- and app.js stopped at its
// first touch, so the SDK never started. Here that exact throw is put on the page BEFORE its code runs (the one thing
// the sandbox does to storage; a real null-origin frame would also need CORS this test server does not send), and the
// builder must still reach "SDK ready", SAYING there is no storage. The control: with storage, no such note.
import assert from "node:assert/strict";
import { openPageHost, cdpConnect } from "./page-host.mjs";
import { MemoryStorage, NO_STORAGE_NOTE, probeStorage } from "../storage.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.stack}\n`); }
};

await t("probeStorage: a document whose localStorage THROWS gets null and the browser's reason; one that has it gets it", () => {
  const sandboxed = { get localStorage() { throw new Error("The document is sandboxed and lacks the 'allow-same-origin' flag."); } };
  assert.deepEqual(probeStorage(sandboxed), { storage: null, why: "The document is sandboxed and lacks the 'allow-same-origin' flag." });
  const s = new MemoryStorage();
  assert.equal(probeStorage({ localStorage: s }).storage, s);
  assert.equal(s.length, 0, "the probe left its key behind");
});

await t("MemoryStorage has the Storage surface LocalDb and the panel use", () => {
  const s = new MemoryStorage();
  s.setItem("a", 1);
  assert.equal(s.getItem("a"), "1");
  assert.equal(s.getItem("b"), null);
  assert.equal(s.length, 1);
  assert.equal(s.key(0), "a");
  s.removeItem("a");
  assert.equal(s.length, 0);
});

const SANDBOX = `Object.defineProperty(window, "localStorage", { configurable: true, get() {
  throw new DOMException("Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.", "SecurityError"); } });`;

const { port: PORT, debug: DEBUG, nonce, done } = await openPageHost("sandboxed storage page", { budgetMs: 90_000 });
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(x => x.type === "page"); } catch (_) {}
  }
  assert.ok(target, "chrome did not start");
  const { send } = await cdpConnect(target.webSocketDebuggerUrl, "sandboxed-storage");
  const evaluate = async expr => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "page error");
    return r.result.result.value;
  };
  const sdkReady = async (what, ms = 30_000) => {
    const end = Date.now() + ms;
    let s = null;
    while (Date.now() < end) {
      s = await evaluate(`return document.getElementById("sdk")?.textContent ?? null;`).catch(() => null);
      if (s && /^SDK /.test(s)) return s;
      await sleep(200);
    }
    throw new Error(`${what}: the builder never reached SDK ready (its line says ${JSON.stringify(s)})`);
  };
  const open = async sandboxed => {
    await send("Page.enable");
    const { identifier } = sandboxed ? await send("Page.addScriptToEvaluateOnNewDocument", { source: SANDBOX }) : {};
    // A FRESH document each time: the same URL again would be a same-document (hash) navigation, keeping the last one.
    await send("Page.navigate", { url: "about:blank" });
    await sleep(200);
    await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/#preview=1` });
    try {
      return await sdkReady(sandboxed ? "sandboxed" : "the control");
    } finally {
      if (identifier) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
  };
  const note = () => evaluate(`return document.getElementById("storage-note")?.innerText ?? "";`);

  await t("THE CONTROL (first, a fresh browser): with browser storage, SDK ready and no such note", async () => {
    await open(false);
    assert.doesNotMatch(await note(), new RegExp(NO_STORAGE_NOTE));
  });
  await t("**a document with NO browser storage (reading localStorage throws) still reaches SDK ready, and SAYS so**", async () => {
    await open(true);
    assert.equal(await evaluate(`return (await fetch("/.page-nonce/${nonce}")).text()`), nonce, "the page is not on this tree's server");
    assert.equal(await evaluate(`try { localStorage; return "readable"; } catch (e) { return e.name; }`), "SecurityError", "THE SETUP: storage did not throw, so this tested nothing");
    assert.match(await note(), new RegExp(NO_STORAGE_NOTE));
  });

} finally {
  if (failures) process.stdout.write(`sandboxed storage: ${failures} failed\n`);
  await done(failures ? 1 : 0);
}
