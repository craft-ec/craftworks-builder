// NO CDP CALL WAITS FOR EVER (the batch-1 realnet, 2026-09-24): step 7 hung
// ten minutes on one unanswered DevTools call, outside every `until`, and
// printed nothing. Driven here against a REAL Chrome, each under this test's
// OWN guard (a call that hangs fails the guard, never the suite's patience):
//   1. a call Chrome never answers REJECTS within its deadline, naming the
//      method (the mutant with no deadline hangs into the guard: red);
//   2. the connection's default deadline applies with no per-call one;
//   3. a socket that closes rejects the call still waiting on it, by name;
//   4. a RELOAD and a NAVIGATION end on the new document's load, and the next
//      evaluate reads the NEW document (the old context is never waited on);
//   5. THE CONTROL: no file opens a DevTools socket of its own — the one
//      connection is page-host's `cdpConnect`, so none can lack the deadline.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { openFreshBrowser, cdpConnect, ownTmp } from "./page-host.mjs";

const dir = ownTmp("cdp-deadline-");
process.env.TMPDIR = dir;
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};
/** `p`'s outcome, or "HUNG" once this test's own guard passes: a hang is a failure here, never a wait. */
const guarded = (p, ms) => Promise.race([p.then(v => ({ v }), e => ({ e })), new Promise(ok => setTimeout(() => ok("HUNG"), ms))]);
const NEVER = "await new Promise(() => {}); return 1;";

/** Lines that open a WebSocket to anything but a node's `ws://` address: a DevTools socket of their own. */
const ownSockets = text => text.split("\n").filter(l => !l.trim().startsWith("//") && /new WebSocket\((?!\s*["'`]ws:\/\/)/.test(l));
const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "sdk", ".git", "docs", ".sdk-build", ".test-tmp"]);
const files = (d, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (!SKIP.has(n) && !n.startsWith(".")) files(p, out); }
    else if (/\.m?js$/.test(n)) out.push(p);
  }
  return out;
};

await t("**no file opens a DevTools socket of its own: every CDP call goes through page-host's one connection** (and its deadline)", () => {
  const all = files(root);
  assert.ok(all.length > 40, `the scan found only ${all.length} files: it is not looking at the builder`);
  const found = all.filter(f => relative(root, f) !== "tests/page-host.mjs").flatMap(f => ownSockets(readFileSync(f, "utf8")).map(l => `${relative(root, f)}: ${l.trim()}`));
  assert.deepEqual(found, [], `open CDP through cdpConnect / openTab (tests/page-host.mjs):\n${found.join("\n")}`);
  assert.equal(ownSockets(readFileSync(join(root, "tests/page-host.mjs"), "utf8")).length, 1, "page-host's one connection is not where the scan expects it");
});

await t("the control's control: a socket of its own is caught; a node's ws:// socket and a comment are not", () => {
  // The samples are assembled, so this file's own lines are not what the scan above finds.
  const open = "new " + "WebSocket(";
  for (const l of [`  const ws = ${open}target.webSocketDebuggerUrl);`, `  const ws = ${open}await browserDebuggerUrl(debug));`]) assert.equal(ownSockets(l).length, 1, l);
  for (const l of [`  const ws = ${open}"ws://127.0.0.1:7509/v1/contract/command");`, `  const ws = ${open}\`ws://127.0.0.1:\${V.ws}/\`);`, `  // ${open}x) in a comment`]) assert.equal(ownSockets(l).length, 0, l);
});

const browser = await openFreshBrowser("cdp-deadline");
try {
  const tab = await browser.tab("cdp-deadline");

  await t("**a call Chrome never answers REJECTS within its deadline, naming the method** (the step-7 hang)", async () => {
    const t0 = Date.now();
    const r = await guarded(tab.evaluate(NEVER, { ms: 500 }), 10_000);
    assert.notEqual(r, "HUNG", "the call was still waiting after 10 s: no deadline");
    assert.ok(r.e, `a call that never answers resolved: ${JSON.stringify(r.v)}`);
    assert.match(r.e.message, /CDP Runtime\.evaluate unanswered after 500 ms/);
    process.stdout.write(`      rejected after ${Date.now() - t0} ms\n`);
  });

  await t("the connection's OWN deadline applies to a call that names none", async () => {
    const url = (await (await fetch(`http://127.0.0.1:${browser.debug}/json/list`)).json()).find(x => x.type === "page").webSocketDebuggerUrl;
    const cdp = await cdpConnect(url, "short", { callMs: 400 });
    try {
      const r = await guarded(cdp.send("Runtime.evaluate", { expression: `(async () => { ${NEVER} })()`, awaitPromise: true }), 10_000);
      assert.notEqual(r, "HUNG", "no default deadline");
      assert.match(r.e?.message ?? "", /short: CDP Runtime\.evaluate unanswered after 400 ms/);
    } finally { cdp.close(); }
  });

  await t("**a socket that closes rejects the call still waiting on it, by name**", async () => {
    const url = (await (await fetch(`http://127.0.0.1:${browser.debug}/json/list`)).json()).find(x => x.type === "page").webSocketDebuggerUrl;
    const cdp = await cdpConnect(url, "closing", { callMs: 60_000 });
    const pending = cdp.send("Runtime.evaluate", { expression: `(async () => { ${NEVER} })()`, awaitPromise: true });
    setTimeout(() => cdp.close(), 200);
    const r = await guarded(pending, 10_000);
    assert.notEqual(r, "HUNG", "a closed socket left its call waiting");
    assert.match(r.e?.message ?? "", /closing: CDP Runtime\.evaluate: the CDP socket closed before it answered/);
  });

  await t("**a RELOAD ends on the new document's load, and the next evaluate reads the NEW document**; a NAVIGATION too", async () => {
    await tab.navigate("data:text/html,<title>one</title><p>one</p>");
    assert.equal(await tab.evaluate("return document.title;"), "one");
    await tab.evaluate("window.__before = 7; return 1;");
    const r = await guarded(tab.reload({ ms: 10_000 }), 15_000);
    assert.notEqual(r, "HUNG", "the reload never ended");
    assert.ok(!r.e, `the reload failed: ${r.e?.message}`);
    assert.equal(await tab.evaluate("return window.__before ?? null;"), null, "the evaluate read the OLD document after the reload");
    assert.equal(await tab.evaluate("return document.title;"), "one");
    await tab.navigate("data:text/html,<title>two</title>");
    assert.equal(await tab.evaluate("return document.title;"), "two", "a navigation ended before the new document");
  });
} finally {
  await browser.stop();
  rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
