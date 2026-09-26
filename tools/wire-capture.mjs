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
//
// And, with `received`, every frame the node SENDS BACK, in a file of its own
// (same line shape): what a node answered — a head's value, a block, or
// nothing — is what tells a stall's cause (batch 1's step 4: A asked one block
// five times; whether its ROOT was the head's needs the head's value). Kept
// apart from `out`, which the decoder reads as requests.
//
// And, with `requests` (the live harness, tools/live/), every HTTP REQUEST
// those targets make, one line per event: {"t", "target", "id", "event":
// sent|response|finished|failed, "url", "status", "canceled"} -- the per-piece
// view of an open (which pieces were asked, answered, cancelled at k).
import { appendFileSync } from "node:fs";
import { browserDebuggerUrl, cdpConnect } from "../tests/page-host.mjs";

/**
 * Start capturing on the Chrome whose DevTools port is `debug`. `windowOf()`
 * names the step each frame belongs to, read when the frame is sent.
 * Returns `{ stop(), stats() }`.
 */
/** The target types that can carry a page's sockets: only these have their network captured. */
const OURS = /^(page|iframe|worker|shared_worker|service_worker)$/;

export async function captureWire(debug, { out, received = null, requests = null, windowOf, label, connect = cdpConnect }) {
  // Through the ONE CDP connection (tests/page-host.mjs): every call has a
  // deadline and names its method, so a target that never answers cannot
  // hang the run silently. Events arrive through `onEvent`.
  let onEvent = () => {};
  const cdp = await connect(await browserDebuggerUrl(debug), `wire capture (${label})`, { onEvent: m => onEvent(m) });
  const send = (method, params = {}, sessionId) => cdp.send(method, params, { sessionId });
  const urls = new Map();
  const stats = { targets: 0, sockets: 0, frames: 0, received: 0, types: {}, unpaused: [], unresumed: [], gone: [], notOurs: [] };
  // Sessions of targets that have closed: a call to one fails "not found", and
  // that target is GONE (nothing left to capture), never "not resumed".
  const detached = new Set();
  let started = false;
  // Binary frames come base64 already; a text frame is carried as its bytes (and will not decode: it FAILS).
  const line = (m, key) => {
    const r = m.params.response ?? {};
    const data = r.opcode === 2 ? r.payloadData : Buffer.from(r.payloadData ?? "", "utf8").toString("base64");
    return JSON.stringify({ t: Date.now(), window: windowOf(), browser: label, socket: key, url: urls.get(key) ?? null, opcode: r.opcode, data }) + "\n";
  };
  onEvent = m => {
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
      // Its network first, then its own children, then let it run — only for
      // a target that can carry OUR sockets (a page, a frame, a worker). Any
      // other kind (Chrome's own "other" targets) is only let run, and stated:
      // one measured not answering Network.enable for 30 s, and its failure
      // was read as a target this capture had lost.
      // Each target on its OWN chain: one's failure never stops another's.
      const entry = { type, url: (m.params.targetInfo?.url ?? "").slice(0, 120) };
      const ours = OURS.test(type);
      if (!ours) stats.notOurs.push(entry);
      (async () => {
        if (ours) {
          await send("Network.enable", {}, s);
          await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s);
        }
        await send("Runtime.runIfWaitingForDebugger", {}, s);
      })().catch(e => {
        // CLOSED while being attached: gone, with nothing of it to capture.
        if (detached.has(s) || /session with given id not found|no session with given id|target closed/i.test(e.message)) stats.gone.push({ ...entry, why: e.message });
        // Not ours and not answering: said, not a failure of the capture.
        else if (!ours) entry.why = e.message;
        // Ours, alive, and NOT resumed: it never ran, and its network is
        // unseen. Not swallowed: the check fails on it.
        else stats.unresumed.push({ ...entry, why: e.message });
      });
      return;
    }
    if (m.method === "Target.detachedFromTarget") { detached.add(m.params?.sessionId); return; }
    const key = m.params?.requestId && `${m.sessionId ?? "browser"}:${m.params.requestId}`;
    if (m.method === "Network.webSocketCreated") {
      urls.set(key, m.params.url);
      stats.sockets += 1;
    } else if (m.method === "Network.webSocketFrameSent") {
      stats.frames += 1;
      appendFileSync(out, line(m, key));
    } else if (m.method === "Network.webSocketFrameReceived" && received) {
      stats.received += 1;
      appendFileSync(received, line(m, key));
    } else if (requests && /^Network\.(requestWillBeSent|responseReceived|loadingFinished|loadingFailed)$/.test(m.method)) {
      const p = m.params;
      const event = { requestWillBeSent: "sent", responseReceived: "response", loadingFinished: "finished", loadingFailed: "failed" }[m.method.slice(8)];
      appendFileSync(requests, JSON.stringify({ t: Date.now(), window: windowOf(), target: m.sessionId ?? "browser", id: p.requestId, event, url: p.request?.url ?? p.response?.url ?? null, status: p.response?.status ?? null, canceled: p.canceled ?? null }) + "\n");
    }
  };
  // Every target that exists now and every one made later, each paused until attached.
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await send("Target.setDiscoverTargets", { discover: true });
  started = true;
  return { stop: () => cdp.close(), stats: () => ({ ...stats, types: { ...stats.types }, unpaused: [...stats.unpaused], unresumed: [...stats.unresumed], gone: [...stats.gone], notOurs: stats.notOurs.map(x => ({ ...x })) }) };
}
