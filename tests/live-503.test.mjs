// THE 503 CAPTURE (builder#153 §3, tools/live/scenarios/open-fresh-nodes.mjs): a 503 is the F60 JOIN WINDOW
// only with the "has not joined" body AND no non-gateway peer yet; a 503 after a peer, or with another body,
// is FLAGGED as its own finding. The ring state is read from the node's own INFO lines.
import assert from "node:assert/strict";
import { classify503, ringAt } from "../tools/live/scenarios/open-fresh-nodes.mjs";

const JOIN = "error getting contract X: peer has not joined the network yet";
const lines = [
  { t: 1000, text: "GET client: ring empty — initial target falls back to configured gateway instance_id=X gateway=5.9.111.215:31337" },
  { t: 1500, text: "NAT traversal connection established peer_addr=5.9.111.215:31337" },
  { t: 4000, text: "GET relay advance: ring empty — forwarding to configured gateway gateway=5.9.111.215:31337" },
  { t: 5000, text: "NAT traversal connection established peer_addr=10.0.0.9:4000" },
];
const ring = ringAt(lines, 3000);
assert.deepEqual(ring.gateways, ["5.9.111.215:31337"]);
assert.equal(ring.first_connection, 1500, "the first connection (to the gateway) was not read");
assert.equal(ring.first_peer, 5000, "a GATEWAY connection was counted as the first peer");
assert.equal(ring.ring_empty_last_before, 1000);
assert.equal(ring.ring_empty_after, true);
console.log("ok the ring state: gateways from the ring-empty lines, and the first peer is the first NON-gateway connection");

assert.deepEqual(classify503({ body: JOIN, t: 3000, ring }), { cls: "join window (F60)", flagged: false });
assert.equal(classify503({ body: JOIN, t: 6000, ring: ringAt(lines, 6000) }).flagged, true, "a 503 AFTER a peer was folded into the join window");
assert.match(classify503({ body: JOIN, t: 6000, ring: ringAt(lines, 6000) }).cls, /AFTER a peer connected/);
assert.equal(classify503({ body: "service unavailable: timeout", t: 3000, ring }).flagged, true, "a 503 with another body was folded into the join window");
assert.equal(classify503({ body: JOIN, t: 3000, ring: ringAt([], 3000) }).flagged, false, "CONTROL: no log lines at all is still before any peer");
console.log("ok a 503 is the join window only with the 'has not joined' body before any peer; otherwise FLAGGED");
