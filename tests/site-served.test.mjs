// WHICH VERSION EACH NODE SERVES (tools/site-served.mjs): over two local HTTP servers standing in for the publisher's
// node and A's, the line tells SAME from DIFFERENT, and a failure is named, never read as a version. Each claim with
// its control.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { siteServed, servedLine } from "../tools/site-served.mjs";

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

process.stdout.write(failures ? `site-served: ${failures} FAILED\n` : "site-served: all ok\n");
process.exit(failures ? 1 : 0);
