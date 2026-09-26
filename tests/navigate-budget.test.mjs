// A PAGE LOAD'S BUDGET COVERS THE NAVIGATE COMMAND TOO (tests/page-host.mjs `navigate` / `reload`), not only the load
// event: Page.navigate is answered only once the server answers the HTTP request, and a fresh node's web path takes up
// to its own 30 s (F64). A 30 s CDP deadline on the command raced it (batch 5's realnet: "user-v: CDP Page.navigate
// unanswered after 30000 ms"). A real headless browser against a local server that answers after 2 s, with the CDP
// call default set to 800 ms: given a budget, the load completes; THE CONTROL, with no budget, the 800 ms default
// cuts the command -- so the test can see a command deadline at all.
process.env.CDP_CALL_MS = "800";
const { openFreshBrowser } = await import("./page-host.mjs");
import assert from "node:assert/strict";
import { createServer } from "node:http";

let failures = 0;
const t = async (name, f) => {
  try { await f(); process.stdout.write(`  ok  ${name}\n`); } catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};
const server = createServer((req, res) => setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>slow</title>slow"); }, 2000));
await new Promise(ok => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${server.address().port}/`;
const b = await openFreshBrowser("navigate budget");
try {
  const tab = await b.tab("slow");
  await t("**a navigation given a budget waits for a server slower than the CDP default** (the command, not only the load)", async () => {
    const t0 = Date.now();
    await tab.navigate(`${url}?a`, { ms: 10_000 });
    assert.ok(Date.now() - t0 >= 1900, "the server's 2 s did not happen: the setup is wrong");
    assert.equal(await tab.evaluate("return document.title;"), "slow");
  });
  await t("**a reload given a budget waits for its load the same way** (its command is answered at once; only the load waits)", async () => {
    await tab.reload({ ms: 10_000 });
    assert.equal(await tab.evaluate("return document.title;"), "slow");
  });
  await t("THE CONTROL: with no budget, the CDP default (800 ms here) cuts the navigate command", async () => {
    await assert.rejects(tab.navigate(`${url}?c`), /Page\.navigate unanswered after 800 ms|loadEventFired did not come within 800 ms/);
  });
} finally {
  await b.stop();
  server.close();
}
process.stdout.write(failures ? `\n${failures} failing\n` : "\nall ok\n");
process.exit(failures ? 1 : 0);
