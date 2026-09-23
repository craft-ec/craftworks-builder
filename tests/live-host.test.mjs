// THE ONE NODE SPAWNER, tested without a real node (builder#98).
//
// A stub `freenet` goes FIRST on PATH for this process: it records that it ran
// (a marker file), binds the ports it was given, and waits. So every refusal
// here is checked by "the stub never ran" — and a mutant that deletes a
// refusal starts the STUB, never a real node, and turns the test red. A test of
// "we never touch the owner's node" that could itself start a node on 7509
// under a mutant is not a safety test (craftworks-sdk#208).
import assert from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESERVED, nodeArgs, openPageHost, spawnNode, tcpFree, udpFree } from "./page-host.mjs";

const t = async (name, fn) => { await fn(); process.stdout.write(`ok ${name}\n`); };

const stubDir = mkdtempSync(join(tmpdir(), "cw-stub-freenet-"));
const marker = join(stubDir, "ran");
writeFileSync(join(stubDir, "freenet"), `#!/usr/bin/env node
const fs = require("fs"), net = require("net"), dgram = require("dgram");
fs.appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" ") + "\\n");
fs.appendFileSync(${JSON.stringify(marker)}, "FREENET_WEBAPP_CACHE_DIR=" + (process.env.FREENET_WEBAPP_CACHE_DIR ?? "") + "\\n");
const arg = f => Number(process.argv[process.argv.indexOf(f) + 1]);
if (process.env.STUB_IGNORE_TERM) process.on("SIGTERM", () => {});
net.createServer().listen(arg("--ws-api-port"), "127.0.0.1");
dgram.createSocket("udp4").bind(arg("--network-port"), "127.0.0.1");
setInterval(() => {}, 1000);
`);
chmodSync(join(stubDir, "freenet"), 0o755);
process.env.PATH = `${stubDir}:${process.env.PATH}`;
const stubRan = () => existsSync(marker);
const clearMarker = () => rmSync(marker, { force: true });

/**
 * `spawnNode` must REFUSE with `re`. If a mutant makes it succeed, what it
 * started is STOPPED before the test fails — a refusal test that left a node
 * (even the stub) holding 7609 would be the harm it exists to prevent.
 */
async function refused(ports, re) {
  let node = null;
  try {
    node = await spawnNode("t", ports);
  } catch (e) {
    assert.match(e.message, re);
    return;
  }
  await node.stop();
  assert.fail(`spawnNode started a node on ${JSON.stringify(ports)} instead of refusing (${re})`);
}

/** A port the OS says is free right now, TCP and UDP. */
const freePort = () => new Promise(ok => {
  const s = createServer().listen(0, "127.0.0.1", async () => {
    const p = s.address().port;
    s.close(async () => ok((await udpFree(p)) ? p : freePort()));
  });
});

await t("the command line: isolated, loopback, three explicit dirs, no auto-update", async () => {
  const a = nodeArgs({ ws: 18001, net: 38001 }, "/tmp/x");
  for (const flag of ["--is-gateway", "--skip-load-from-network", "--disable-auto-update"]) assert.ok(a.includes(flag), flag);
  for (const [f, v] of [["--data-dir", "/tmp/x/data"], ["--config-dir", "/tmp/x/config"], ["--log-dir", "/tmp/x/log"],
    ["--ws-api-port", "18001"], ["--network-port", "38001"], ["--ws-api-address", "127.0.0.1"], ["--network-address", "127.0.0.1"]]) {
    assert.strictEqual(a[a.indexOf(f) + 1], v, f);
  }
});

await t("a spawned node gets its OWN web-container cache, inside its dir — never the per-user one the owner's node serves from", async () => {
  clearMarker();
  const node = await spawnNode("cache", { ws: await freePort(), net: await freePort() });
  try {
    const got = readFileSync(marker, "utf8").split("\n").find(l => l.startsWith("FREENET_WEBAPP_CACHE_DIR="))?.slice("FREENET_WEBAPP_CACHE_DIR=".length);
    assert.ok(got, "the node was started with no FREENET_WEBAPP_CACHE_DIR: it shares the per-user web cache");
    assert.strictEqual(got, join(node.dir, "webapp_cache"), "the node's web cache is not inside its own dir");
    assert.ok(existsSync(got), "the node's web cache dir does not exist");
  } finally { await node.stop(); }
});

/** The owner's nodes on this machine, named HERE rather than read from the
 * helper: a test that iterated `RESERVED` passed vacuously when `RESERVED`
 * was emptied (core dev's mutant on builder#101). */
const OWNERS = [7509, 7609];

await t("7509 and 7609 are refused FOR BEING RESERVED, before anything runs", async () => {
  assert.deepStrictEqual([...RESERVED], OWNERS, "the helper's reserved list is not the owner's two ports");
  const net = await freePort();
  let tried = 0;
  for (const p of OWNERS) {
    clearMarker();
    // The REASON is asserted, not only a refusal: while the owner's node is
    // up its port is also BUSY, and a busy-port refusal would pass a test that
    // asked only for "refused". So this also pins the ORDER — the reserved
    // check runs before any probe of the port — whether or not that node is
    // running (7509 is held by it now; 7609 is free).
    await refused({ ws: p, net }, /belongs to somebody else's node/);
    await refused({ ws: await freePort(), net: p }, /belongs to somebody else's node/);
    assert.ok(!stubRan(), `a node was started for reserved port ${p}`);
    tried += 1;
  }
  assert.strictEqual(tried, OWNERS.length, "not every owner port was tried");
});

await t("unnamed ports are refused: a live run SAYS which", async () => {
  clearMarker();
  await refused({}, /must be NAMED/);
  await refused({ ws: await freePort() }, /must be NAMED/);
  assert.ok(!stubRan());
});

await t("a busy TCP ws port is refused, and nothing runs", async () => {
  clearMarker();
  const ws = await freePort();
  const holder = createServer().listen(ws, "127.0.0.1");
  await new Promise(r => holder.once("listening", r));
  await refused({ ws, net: await freePort() }, /already holds TCP/);
  holder.close();
  assert.ok(!stubRan());
});

await t("a busy UDP network port is refused — which no TCP probe can see", async () => {
  clearMarker();
  const net = await freePort();
  const holder = createSocket("udp4");
  await new Promise(r => holder.bind(net, "127.0.0.1", r));
  assert.ok(await tcpFree(net), "the control: TCP says this port is free");
  await refused({ ws: await freePort(), net }, /already holds/);
  holder.close();
  assert.ok(!stubRan());
});

await t("THE CONTROL: free, named ports DO start the node, and stop() verifies it gone", async () => {
  clearMarker();
  const ws = await freePort(), net = await freePort();
  const node = await spawnNode("t", { ws, net });
  assert.ok(stubRan(), "the stub never ran, so the refusals above prove nothing");
  assert.ok(readFileSync(marker, "utf8").includes("--disable-auto-update"));
  assert.ok(node.pid > 0 && existsSync(join(node.dir, "node.pid")));
  assert.ok(!(await tcpFree(ws)) && !(await udpFree(net)), "the stub holds its ports");
  const r = await node.stop();
  assert.deepStrictEqual(r, { gone: true, held: [] });
  assert.ok(await tcpFree(ws) && await udpFree(net), "the ports were not released");
});

await t("a node that ignores SIGTERM is SIGKILLed, and verified gone", async () => {
  process.env.STUB_IGNORE_TERM = "1";
  try {
    const node = await spawnNode("t", { ws: await freePort(), net: await freePort() });
    const t0 = Date.now();
    const r = await node.stop();
    assert.deepStrictEqual(r, { gone: true, held: [] });
    assert.ok(Date.now() - t0 >= 4_000, "it was not given its SIGTERM grace first");
  } finally {
    delete process.env.STUB_IGNORE_TERM;
  }
});

await t("a live run must name its budget: no default", async () => {
  clearMarker();
  let host = null;
  try {
    host = await openPageHost("t", { node: { ws: await freePort(), net: await freePort() } });
  } catch (e) {
    assert.match(e.message, /must name its budgetMs/);
  }
  // A mutant that let it start: stop everything it started, and fail (exit 1).
  if (host) { console.error("a live run started with no budget"); await host.done(1); }
  assert.ok(!stubRan(), "the node started before the budget was checked");
});

rmSync(stubDir, { recursive: true, force: true });
console.log("\nlive host: all ok");
