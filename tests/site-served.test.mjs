// WHICH VERSION EACH NODE SERVES (tools/site-served.mjs): over two local HTTP servers standing in for the publisher's
// node and A's, the line tells SAME from DIFFERENT, and a failure is named, never read as a version. Each claim with
// its control.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { siteServed, servedLine, servedWords, untilServed } from "../tools/site-served.mjs";

let failures = 0;
const t = async (name, f) => {
  try { await f(); process.stdout.write(`  ok  ${name}\n`); } catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

/** A node's web path serving `app` at /v1/contract/web/<address>/app.json (anything else 404); it records the paths asked. */
async function node(app, { status = 200, silent = false } = {}) {
  const asked = [];
  const srv = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    if (silent) return;
    if (status !== 200 || !req.url.endsWith("/app.json")) { res.writeHead(status === 200 ? 404 : status); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(app));
  });
  await new Promise(ok => srv.listen(0, "127.0.0.1", ok));
  return { port: srv.address().port, asked, close: () => { srv.closeAllConnections(); srv.close(); } };
}

const V1 = { name: "Notes", components: [{ type: "form" }, { type: "table" }] };
const V2 = { ...V1, components: [...V1.components, { type: "table" }] };

await t("**the publisher on v2 and A still on v1 read as DIFFERENT versions** (the failure this names); control: both on v2 read SAME", async () => {
  const [b, a, a2] = await Promise.all([node(V2), node(V1), node(V2)]);
  try {
    const line = servedLine("after step 9", [["B", await siteServed(b.port, "Site1")], ["A", await siteServed(a.port, "Site1")]]);
    assert.match(line, /B serves app\.json [0-9a-f]{16} \(3 components\); A serves app\.json [0-9a-f]{16} \(2 components\) -- DIFFERENT versions/);
    const same = servedLine("after step 9", [["B", await siteServed(b.port, "Site1")], ["A", await siteServed(a2.port, "Site1")]]);
    assert.match(same, /-- SAME version$/, "THE CONTROL");
  } finally { b.close(); a.close(); a2.close(); }
});

await t("**it only READS**: one GET of the site's app.json per node, nothing else", async () => {
  const b = await node(V1);
  try {
    await siteServed(b.port, "SiteAddr");
    assert.deepEqual(b.asked, ["GET /v1/contract/web/SiteAddr/app.json"]);
  } finally { b.close(); }
});

await t("**a failure is NAMED, never a version**: an HTTP status and a silent node each say what happened", async () => {
  const [gone, silent] = await Promise.all([node(V1, { status: 404 }), node(V1, { silent: true })]);
  try {
    const s404 = await siteServed(gone.port, "x");
    const quiet = await siteServed(silent.port, "x", { ms: 300 });
    assert.deepEqual(s404, { status: 404 });
    assert.match(quiet.error, /no answer within 300 ms/);
    assert.match(servedLine("after step 10", [["O2", s404], ["A", quiet]]), /O2: HTTP 404; A: no answer within 300 ms -- not all read/);
  } finally { gone.close(); silent.close(); }
});

// ---- STEP 10's WAIT (untilServed): a page holds the ONE app.json it loaded, so the step waits for A to SERVE v2 ------

/** A node that serves `before` for its first `n` app.json GETs, then `after` (a republish reaching it). */
async function switching(before, after, n) {
  let served = 0;
  const srv = createServer((req, res) => {
    if (!req.url.endsWith("/app.json")) { res.writeHead(404); res.end(); return; }
    served += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(served <= n ? before : after));
  });
  await new Promise(ok => srv.listen(0, "127.0.0.1", ok));
  return { port: srv.address().port, reads: () => served, close: () => { srv.closeAllConnections(); srv.close(); } };
}
/** A clock the waits advance, so no test sleeps. */
const clock = () => { let t = 0; return { now: () => t, sleep: async ms => { t += ms; } }; };
const isV2 = s => s.components === V2.components.length;

await t("**THE CONTROL (7c's step 10): the OLD shape -- one read at load time -- sees v1 while the node has not got v2 yet; untilServed waits past it and sees v2**", async () => {
  const a = await switching(V1, V2, 2);
  try {
    // The old step loaded A's page ONCE, here: v1, and its page could never show v2.
    assert.equal((await siteServed(a.port, "Site1")).components, 2, "THE SETUP: the node did not serve v1 first");
    const c = clock();
    const r = await untilServed(a.port, "Site1", isV2, { ms: 180_000, everyMs: 2_000, ...c });
    assert.equal(r.served, true, `untilServed gave up: ${JSON.stringify(r)}`);
    assert.equal(r.last.components, 3, "it returned before the node served v2");
    assert.equal(r.reads, 2, "it read more (or fewer) times than the node took to serve v2");
  } finally { a.close(); }
});

await t("**a node that never serves v2 within the bound is SAID so, with what it serves** (a real propagation failure reads as one)", async () => {
  const a = await switching(V1, V2, 1_000_000);
  try {
    const c = clock();
    const r = await untilServed(a.port, "Site1", isV2, { ms: 10_000, everyMs: 2_000, ...c });
    assert.equal(r.served, false);
    assert.ok(r.after <= 10_000 && r.reads >= 2, `the bound was not the bound: ${JSON.stringify(r)}`);
    assert.match(servedWords(r.last), /^app\.json [0-9a-f]{16} \(2 components\)$/, "the words do not say which version A serves");
  } finally { a.close(); }
});

await t("**untilServed has no default bound, and a refused read is a status, never a version**", async () => {
  await assert.rejects(() => untilServed(1, "Site1", isV2, {}), /needs a bound/);
  const n = await node(V2, { status: 503 });
  try {
    const r = await untilServed(n.port, "Site1", isV2, { ms: 4_000, everyMs: 2_000, ...clock() });
    assert.deepEqual([r.served, servedWords(r.last)], [false, "HTTP 503"]);
  } finally { n.close(); }
});
process.stdout.write(failures ? `site-served: ${failures} FAILED\n` : "site-served: all ok\n");

process.exit(failures ? 1 : 0);
