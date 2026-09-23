// WIRE CAPTURE (the realnet A-side check): EVERY WebSocket frame a browser's
// pages SEND to a node, raw, as JSONL — captured, never decoded here.
//
// Counted on the wire, not from the SDK's own counters, so a session nobody
// expected cannot hide: one browser-level DevTools connection auto-attaches to
// every target the browser makes — the tab, the node's sandboxed app iframe
// (Chrome puts it in a process of its own, a TARGET), any worker — each paused
// until its network is enabled, so no socket opens unseen.
//
// Decoding is the SDK's: `probe classify-frames` reads this file with
// freenet-stdlib's own request types (no tag numbers here, the ruling).
//
// Each line: {"t": ms, "window": the step label at the time, "socket":
// "<session>:<requestId>", "url": the socket's URL, "opcode", "data": base64}.
import { appendFileSync } from "node:fs";

/**
 * Start capturing on the Chrome whose DevTools port is `debug`. `windowOf()`
 * names the step each frame belongs to, read when the frame is sent.
 * Returns `{ stop(), stats() }`.
 */
export async function captureWire(debug, { out, windowOf, label }) {
  const version = await (await fetch(`http://127.0.0.1:${debug}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) =>
    new Promise(ok => {
      const i = ++id;
      pending.set(i, ok);
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const urls = new Map();
  const stats = { targets: 0, sockets: 0, frames: 0, types: {}, unpaused: [] };
  let started = false;
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Target.attachedToTarget") {
      const s = m.params.sessionId;
      const type = m.params.targetInfo?.type ?? "?";
      // A frame or worker made AFTER capture began that Chrome did NOT pause
      // (measured: a `srcdoc` iframe is not paused; a navigated one is) could
      // open a socket before its network is enabled — unseen. Recorded, and
      // the check fails on one: never a silent gap.
      if (started && !m.params.waitingForDebugger && /iframe|worker/.test(type)) {
        stats.unpaused.push({ type, url: (m.params.targetInfo?.url ?? "").slice(0, 120) });
      }
      stats.targets += 1;
      stats.types[type] = (stats.types[type] ?? 0) + 1;
      // Its network first, then its own children, then let it run.
      (async () => {
        await send("Network.enable", {}, s);
        await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s);
        await send("Runtime.runIfWaitingForDebugger", {}, s);
      })().catch(() => {});
      return;
    }
    const key = m.params?.requestId && `${m.sessionId ?? "browser"}:${m.params.requestId}`;
    if (m.method === "Network.webSocketCreated") {
      urls.set(key, m.params.url);
      stats.sockets += 1;
    } else if (m.method === "Network.webSocketFrameSent") {
      const r = m.params.response ?? {};
      // Binary frames come base64 already; a text frame is carried as its bytes (and will not decode: it FAILS).
      const data = r.opcode === 2 ? r.payloadData : Buffer.from(r.payloadData ?? "", "utf8").toString("base64");
      stats.frames += 1;
      appendFileSync(out, JSON.stringify({ t: Date.now(), window: windowOf(), browser: label, socket: key, url: urls.get(key) ?? null, opcode: r.opcode, data }) + "\n");
    }
  };
  // Every target that exists now and every one made later, each paused until attached.
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await send("Target.setDiscoverTargets", { discover: true });
  started = true;
  return { stop: () => ws.close(), stats: () => ({ ...stats, types: { ...stats.types }, unpaused: [...stats.unpaused] }) };
}
