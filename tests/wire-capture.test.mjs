// THE CAPTURE KEEPS SEEING WHEN A TARGET DOES NOT ANSWER (batch-1 realnet,
// 2026-09-24: an "other" target never answered Network.enable, another had
// closed, both were read as targets the capture had lost, and V's write went
// unseen). Against a REAL Chrome whose page sends a real WebSocket frame, with
// two targets PLANTED on the capture's connection:
//   - an "other" target that never answers (as the real one did for 30 s);
//   - a frame target that closed (its session "not found").
// The page's frame must still be captured; the unanswering one is NOT OURS and
// the closed one GONE, each stated, and neither is a target "not resumed".
// And what the node SENDS BACK is captured too, in its own file: a planted
// answer frame is there, and never among the frames the decoder reads.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openFreshBrowser, cdpConnect, ownTmp } from "./page-host.mjs";
import { captureWire } from "../tools/wire-capture.mjs";

const dir = ownTmp("wire-capture-");
process.env.TMPDIR = dir;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

// A page that opens a socket to this server and SENDS one binary frame; the
// server accepts the upgrade (RFC 6455's accept key) and reads nothing back.
const PAGE = `<script>const ws = new WebSocket("ws://" + location.host + "/ws"); ws.binaryType = "arraybuffer";
ws.onopen = () => { ws.send(new Uint8Array([1, 2, 3, 4])); document.title = "sent"; };
ws.onmessage = () => { document.title = "answered"; };</script>`;
const server = createServer((_, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
server.on("upgrade", (req, socket) => {
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  // The PLANTED ANSWER: one unmasked binary frame (RFC 6455), sent once the page has spoken.
  socket.once("data", () => socket.write(Buffer.from([0x82, 4, 9, 8, 7, 6])));
  socket.on("error", () => {});
});
await new Promise(ok => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;

/** The capture's connection, real, with two PLANTED targets whose calls fail as the real ones did. */
let emit = null;
const connect = async (url, label, opts) => {
  const real = await cdpConnect(url, label, opts);
  emit = opts.onEvent;
  return {
    ...real,
    send: (method, params, o = {}) => {
      if (o.sessionId === "planted-other") return new Promise((_, bad) => setTimeout(() => bad(new Error(`${label}: CDP ${method} unanswered after 300 ms`)), 300));
      if (o.sessionId === "planted-closed") return Promise.reject(new Error(`${label}: CDP ${method}: Session with given id not found.`));
      return real.send(method, params, o);
    },
  };
};

const browser = await openFreshBrowser("wire-capture test");
const out = join(dir, "wire.jsonl");
const received = join(dir, "wire.received.jsonl");
try {
  const cap = await captureWire(browser.debug, { out, received, windowOf: () => "w", label: "T", connect });
  emit({ method: "Target.attachedToTarget", params: { sessionId: "planted-other", waitingForDebugger: true, targetInfo: { type: "other", url: "" } } });
  emit({ method: "Target.attachedToTarget", params: { sessionId: "planted-closed", waitingForDebugger: true, targetInfo: { type: "iframe", url: "about:blank" } } });
  const tab = await browser.tab("wire-capture page");
  await tab.navigate(`http://127.0.0.1:${port}/`);
  await tab.until(`document.title === "answered"`, "the page's frame sent and the answer received", 15_000);
  await sleep(1500);
  const stats = cap.stats();
  cap.stop();

  await t("**a real frame is CAPTURED while one target never answers and another has closed**", () => {
    const rows = readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    const mine = rows.filter(r => (r.url ?? "").includes(`127.0.0.1:${port}/ws`));
    assert.ok(mine.length >= 1, `the page's frame was not captured: ${JSON.stringify(stats)}`);
    assert.equal(Buffer.from(mine[0].data, "base64").toString("hex"), "01020304", "the captured bytes are not the page's");
  });
  await t("**the unanswering target is NOT OURS and the closed one GONE — each stated, neither 'not resumed'**", () => {
    assert.deepEqual(stats.unresumed, [], `a target was read as lost: ${JSON.stringify(stats.unresumed)}`);
    assert.ok(stats.notOurs.some(x => x.type === "other" && /unanswered/.test(x.why ?? "")), `the unanswering target is not stated: ${JSON.stringify(stats.notOurs)}`);
    assert.ok(stats.gone.some(x => x.type === "iframe" && /not found/.test(x.why)), `the closed target is not stated: ${JSON.stringify(stats.gone)}`);
  });
  await t("**what the node SENDS BACK is captured, in its own file: the planted answer is there, and not among the sent frames**", () => {
    const got = (existsSync(received) ? readFileSync(received, "utf8") : "").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => (r.url ?? "").includes(`127.0.0.1:${port}/ws`));
    assert.deepEqual(got.map(r => Buffer.from(r.data, "base64").toString("hex")), ["09080706"], `the answer was not captured: ${JSON.stringify(stats)}`);
    assert.equal(stats.received >= 1, true);
    const sent = readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map(l => Buffer.from(JSON.parse(l).data, "base64").toString("hex"));
    assert.ok(!sent.includes("09080706"), "a received frame is among the frames the decoder reads as requests");
  });
} finally {
  await browser.stop();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
