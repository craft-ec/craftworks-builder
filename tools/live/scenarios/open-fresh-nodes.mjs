// OPEN FROM FRESH NODES (cold8, kept this time; stock-take item 5 and the "does demand help" question).
//
// One app is published ONCE from a fresh private node P. Then N brand-new openers O1..ON each start a node
// just before its open (the earlier ones STAY UP), open the app by address in a fresh browser profile, and
// the open is timed from navigation to the app's rows. Per open: the loader's own phase stamps, every HTTP
// request (which pieces were asked, answered, cancelled at k), the SDK the page RAN (refused if not the
// header's), and -- from the harness nodes' own EVENT LOGS -- which earlier harness nodes TOUCHED this open's
// keys while it ran ("touched", never "served": eventlog.mjs states the limit).
//
// Before the openers, a READABILITY precheck (the architect's (3')): P's event log must show the app's
// container touched at publish, and a separate node R's must show it touched by R's GET, each dated. If a
// field is unreadable the run is REFUSED. Whether openers reach each other is a RESULT, never a gate.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureWire } from "../../wire-capture.mjs";
import { OPENER_TRACE, STEP_MS, browser, comp, publishRecording, recordPageTrace, sleep, until } from "../page.mjs";
import { servedText } from "../../../sdk/served.js";
import { LIMIT, touches, touchedIn } from "../eventlog.mjs";

const ROWS = ["alpha", "beta"];
// The app: a notes form and table (cold8's), its two rows written in the builder before publishing.
const APP = {
  name: "live open-fresh-nodes",
  components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
  schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } },
};
const hasRows = `const r = [...(${comp("Table", "notes")}?.querySelectorAll("tbody tr td:first-child") ?? [])].map(td => td.textContent); return ${JSON.stringify(ROWS)}.every(t => r.includes(t)) || null;`;

/** The LAST answer the page got for `url`, from a requests.jsonl the wire capture wrote: `{ status, t }`. */
function documentAnswer(requestsFile, url) {
  const rows = readFileSync(requestsFile, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const ids = new Set(rows.filter(r => r.event === "sent" && r.url === url).map(r => `${r.target}:${r.id}`));
  const answers = rows.filter(r => r.event === "response" && ids.has(`${r.target}:${r.id}`));
  return answers.length ? { status: answers.at(-1).status, t: answers.at(-1).t } : null;
}

/** A node's touches of `address`, polled until at least one is in [from, to] (the event log is written in batches). */
async function touchedEventually(dataDir, address, from, to, ms = 30_000) {
  const end = Date.now() + ms;
  let r;
  do {
    r = touchedIn(dataDir, address, from, to);
    if (r.readable && r.n > 0) return r;
    await sleep(1000);
  } while (Date.now() < end);
  return r;
}

// ---- THE 503 CAPTURE (builder#153, the architect's §3): per 503, its BODY, the ms since that node's ws port
// listened, and the node's RING STATE from its own INFO log -- the last "ring empty -- falls back to gateway"
// line before it, and the first connection to a peer that is NOT a configured gateway. A 503 with the
// "has not joined" body before any peer is the F60 JOIN WINDOW; any 503 AFTER a peer, or with another body,
// is FLAGGED as its own finding, never folded into the join window.
const LOG_LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)\s+\w+\s+(.*)$/;
function nodeLog(node) {
  const dir = join(node.dir, "log");
  let files = [];
  try { files = readdirSync(dir).filter(n => /^freenet\.[\d-]+\.log$/.test(n)).sort(); } catch { return []; }
  return files.flatMap(f => readFileSync(join(dir, f), "utf8").split("\n")).map(l => l.match(LOG_LINE)).filter(Boolean).map(m => ({ t: Date.parse(m[1]), text: m[2] }));
}
export function ringAt(lines, t) {
  const gateways = new Set(lines.flatMap(l => [...l.text.matchAll(/gateway=([\d.]+:\d+)/g)].map(m => m[1])));
  // A gateway HOST serves more than one port (5.9.111.215 :31337 and :31338, measured): any connection to a
  // gateway's IP is a gateway connection, never the first PEER.
  const gatewayIps = new Set([...gateways].map(a => a.split(":")[0]));
  const empties = lines.filter(l => /ring empty/.test(l.text));
  const conns = lines.filter(l => /connection established peer_addr=/.test(l.text)).map(l => ({ t: l.t, addr: l.text.match(/peer_addr=([\d.]+:\d+)/)?.[1] }));
  const firstPeer = conns.find(c => c.addr && !gatewayIps.has(c.addr.split(":")[0])) ?? null;
  return {
    gateways: [...gateways],
    ring_empty_last_before: empties.filter(l => l.t <= t).at(-1)?.t ?? null,
    ring_empty_after: empties.some(l => l.t > t),
    first_connection: conns[0]?.t ?? null,
    first_peer: firstPeer?.t ?? null,
    first_peer_addr: firstPeer?.addr ?? null,
  };
}
export function classify503({ body, t, ring }) {
  const afterPeer = ring.first_peer !== null && ring.first_peer <= t;
  // Two bodies of the join window, measured: F60's text, and the node's own "Connecting to Freenet" recovery
  // page (freenet-core server/errors/assets/connecting.html: "served (503) while the peer is up but not yet
  // rejoined to the ring").
  if (!afterPeer && /has not joined/i.test(body ?? "")) return { cls: "join window (F60 body)", flagged: false };
  if (!afterPeer && /Recovery redirect|not yet\s+rejoined/i.test(body ?? "")) return { cls: "join window (the node's recovery page)", flagged: false };
  return { cls: afterPeer ? "FLAGGED: 503 AFTER a peer connected" : "FLAGGED: another body", flagged: true };
}
const got503 = [];
function record503(ctx, node, { source, t, body }) {
  const listenAt = node.started_ms + (node.ready_ms ?? 0);
  // The WHOLE body is kept in the run's logs; the table shows its start.
  const { appendFileSync, mkdirSync } = ctx.fs;
  mkdirSync(ctx.logsOf(node.label), { recursive: true });
  appendFileSync(join(ctx.logsOf(node.label), "503-bodies.txt"), `==== ${new Date(t).toISOString()} ${source}\n${body ?? ""}\n`);
  got503.push({ node, source, t, full: body ?? "", body: (body ?? "").replace(/\s+/g, " ").trim().slice(0, 160), since_listen_ms: t - listenAt });
}
function report503(ctx) {
  if (!got503.length) { ctx.say("503   none: no node answered 503 this run"); return 0; }
  ctx.say("503   node | source | ms since ws listened | body | last 'ring empty' before (ms since listen) | first non-gateway peer (ms since listen) | class");
  let flagged = 0;
  for (const r of got503) {
    const listenAt = r.node.started_ms + (r.node.ready_ms ?? 0);
    const ring = ringAt(nodeLog(r.node), r.t);
    const c = classify503({ body: r.full, t: r.t, ring });
    if (c.flagged) flagged += 1;
    const rel = v => (v === null ? "none" : `${v - listenAt}`);
    ctx.say(`503   ${r.node.label} | ${r.source} | ${r.since_listen_ms} | ${JSON.stringify(r.body)} | ${rel(ring.ring_empty_last_before)} | ${rel(ring.first_peer)}${ring.first_peer_addr ? ` (${ring.first_peer_addr})` : ""} | ${c.cls}`);
  }
  return flagged;
}

export async function run(ctx) {
  const { say } = ctx;
  say(`ATTR  ${LIMIT}`);
  // ---- publish once, from a fresh node P ----
  const P = await ctx.nodes.start("P");
  say(`NODE  P :${P.ws} ready in ${P.ready_ms} ms (dirs ${P.dir})`);
  // A publish that is not BACKED_UP FAILS this run, but it was published: the opens are still measured.
  const { pub, notBacked } = await publishRecording(ctx, P, { app: APP, rows: ROWS });
  const tPub = pub.t0, tPubEnd = pub.t0 + pub.ms;
  const addr = pub.address;
  const appUrl = ws => `http://127.0.0.1:${ws}/v1/contract/web/${addr}/`;
  const frameOf = ws => `127.0.0.1:${ws}/v1/contract/web/${addr}/?__sandbox=1`;

  // ---- the READABILITY precheck: P touched the app at publish, R touches it on its GET; each dated ----
  // Through a BROWSER, as a person opens it: the answer's status from the recorded requests, a 503's body
  // from the page as it first arrived (outerHTML, comments included: the node's recovery page names itself
  // there), before its own script moves the tab.
  const R = await ctx.nodes.start("R");
  const { mkdirSync } = ctx.fs;
  mkdirSync(ctx.logsOf("R"), { recursive: true });
  const rb = await browser(ctx, "live: precheck R");
  const rReq = join(ctx.logsOf("R"), "requests.jsonl");
  const rCap = await captureWire(rb.debug, { out: join(ctx.logsOf("R"), "wire.jsonl"), requests: rReq, windowOf: () => "precheck", label: "R" });
  const rTab = await rb.tab("R");
  const tGet = Date.now();
  let status = 0;
  while (Date.now() - tGet < STEP_MS && status !== 200) {
    await rTab.navigate(appUrl(R.ws)).catch(() => {});
    const html = await rTab.evaluate("return document.documentElement?.outerHTML ?? null;").catch(() => null);
    const answer = documentAnswer(rReq, appUrl(R.ws));
    status = answer?.status ?? 0;
    if (status === 503) record503(ctx, R, { source: "precheck navigation", t: answer.t, body: html });
    if (status !== 200) await sleep(2000);
  }
  const tGetEnd = Date.now();
  rCap.stop();
  await rb.stop();
  const pTouch = await touchedEventually(join(P.dir, "data"), addr, tPub - 60_000, tPubEnd + 60_000);
  const rTouch = await touchedEventually(join(R.dir, "data"), addr, tGet - 1000, tGetEnd + 5000);
  if (status !== 200 || !pTouch.readable || !pTouch.n || !rTouch.readable || !rTouch.n) {
    say(`REFUSED  the readability precheck: R's GET ${status}; P's event log ${pTouch.readable ? `${pTouch.n} dated touch(es) at publish` : `unreadable (${pTouch.why})`}; R's ${rTouch.readable ? `${rTouch.n} dated touch(es) in its GET` : `unreadable (${rTouch.why})`}`);
    return { failed: true };
  }
  say(`CHECK readable: P's event log dates ${pTouch.n} touch(es) of the app at publish; R's dates ${rTouch.n} in its GET (${tGetEnd - tGet} ms, http ${status})`);

  // ---- the openers ----
  const prior = [P, R];
  const opens = [];
  let label = 0;
  const arm = await ctx.arm("open", ctx.args.nodes, async () => {
    const name = `O${++label}`;
    const O = await ctx.nodes.start(name);
    const logs = ctx.logsOf(name);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(logs, { recursive: true });
    const b = await browser(ctx, `live: opener ${name}`);
    const requests = join(logs, "requests.jsonl");
    const cap = await captureWire(b.debug, { out: join(logs, "wire.jsonl"), requests, windowOf: () => "open", label: name });
    const tab = await b.tab(name);
    const t0 = Date.now();
    await tab.navigate(appUrl(O.ws)).catch(e => say(`WARN  ${name}: navigate: ${e.message}`));
    const firstHtml = await tab.evaluate("return document.documentElement?.outerHTML ?? null;").catch(() => null);
    const rows = await until(tab, hasRows, STEP_MS, frameOf(O.ws), 250);
    const t1 = Date.now();
    const stamps = await tab.evaluateIn(frameOf(O.ws), `return globalThis.__craftworksOpen ?? null;`).catch(() => null);
    // The opener's page recordings (builder#160), whole, beside its wire.jsonl: read in the APP's frame.
    await recordPageTrace(ctx, tab, name, rows ? "rows" : "no rows", { frame: frameOf(O.ws), read: OPENER_TRACE });
    // A dead open says what the page SHOWED (the node's own error page, when that is what came back).
    const shown = rows ? null : await tab.evaluate(`return document.body?.innerText?.slice(0, 300) ?? null;`).catch(e => `(unreadable: ${e.message})`);
    // Where the tab ENDED UP: the node's recovery page sends a top-level tab to its dashboard `/`.
    const ended_at = rows ? null : await tab.evaluate(`return location.href;`).catch(e => `(unreadable: ${e.message})`);
    // Through the SDK's one fetch (re-asked until answered); the harness's deadline is the cancel.
    // A miss is "not within 30 s" (a per-wait deadline, never "failed").
    const served = await servedText({ url: `${appUrl(O.ws)}artefacts.json` }, { signal: AbortSignal.timeout(30_000) }).then(t => JSON.parse(t)?.sdk?.sha256 ?? null, () => ({ notWithin: 30 }));
    const ran = ctx.sdkRan({ header: ctx.header, served, stamps });
    cap.stop();
    await b.stop();
    // The pieces this open asked for, from its own requests.
    // The page's own requests: Chrome's built-in extensions (chrome-extension://) are not the page's.
    const lines = readFileSync(requests, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(l => !(l.url ?? "").startsWith("chrome-extension://"));
    const piece = /\/v1\/contract\/web\/([1-9A-HJ-NP-Za-km-z]{32,50})\/piece$/;
    const byId = new Map();
    for (const l of lines) { const cur = byId.get(`${l.target}:${l.id}`) ?? { url: null }; byId.set(`${l.target}:${l.id}`, { ...cur, ...(l.url ? { url: l.url } : {}), [l.event]: l }); }
    const pieces = [...byId.values()].filter(r => piece.test(r.url ?? ""));
    const ok = pieces.filter(r => r.response?.status === 200 && r.finished);
    const ms = ok.map(r => r.finished.t - r.sent.t).sort((a, b) => a - b);
    // The app document's own answer: the first response to the app's URL.
    const doc = [...byId.values()].find(r => r.url === appUrl(O.ws));
    if (doc?.response?.status === 503) record503(ctx, O, { source: "navigation", t: doc.response.t, body: firstHtml });
    const sample = {
      opener: name, ok: !!rows, open_ms: rows ? t1 - t0 : null, node_ready_ms: O.ready_ms, stamps,
      document_status: doc?.response?.status ?? null, ...(rows ? {} : { shown, ended_at }),
      sdk_ran: ran.ok, ...(ran.ok ? {} : { refused: ran.why }),
      pieces: { asked: pieces.length, ok: ok.length, cancelled: pieces.filter(r => r.failed?.canceled).length, median_ms: ms.length ? ms[ms.length >> 1] : null },
    };
    opens.push({ ...sample, t0, t1, keys: [addr, ...new Set(pieces.map(r => r.url.match(piece)[1]))], prior: [...prior] });
    prior.push(O);
    say(`OPEN  ${name}: ${rows ? `${t1 - t0} ms` : `rows not within ${STEP_MS / 1000} s (the app's URL answered ${sample.document_status ?? "nothing"}; the tab ended at ${ended_at}; it showed ${JSON.stringify(shown)})`}; node ready ${O.ready_ms} ms; pieces asked ${sample.pieces.asked}, 200 ${sample.pieces.ok}, cancelled ${sample.pieces.cancelled}, median ${sample.pieces.median_ms} ms; sdk ${ran.ok ? "is the header's" : `REFUSED: ${ran.why}`}; stamps ${JSON.stringify(stamps)}`);
    return sample;
  });

  // ---- attribution, from the harness nodes' event logs (read once the logs have settled) ----
  await sleep(10_000);
  for (const o of opens) {
    const by = {};
    let touched = 0;
    for (const k of o.keys) {
      const who = o.prior.filter(n => touchedIn(join(n.dir, "data"), k, o.t0, o.t1).n > 0).map(n => n.label);
      if (who.length) touched += 1;
      for (const w of who) by[w] = (by[w] ?? 0) + 1;
    }
    say(`TOUCH ${o.opener}: earlier harness nodes touched ${touched} of this open's ${o.keys.length} keys during it${touched ? ` (${Object.entries(by).map(([n, c]) => `${n} ${c}`).join(", ")})` : " -- every key was answered from OUTSIDE the harness"}`);
  }

  // ---- every 503, one table ----
  const flagged503 = report503(ctx);

  // ---- the arm's line ----
  const clean = arm.samples.filter(s => s.ok && s.sdk_ran && !s.contaminated);
  const sum = ctx.summarize(clean.map(s => s.open_ms));
  const dead = arm.all.filter(s => !s.ok || !s.sdk_ran);
  say(`ARM   open: ${JSON.stringify(sum)} over ${clean.length} clean open(s) of ${arm.samples.length} in the last attempt; ${dead.length} of ${arm.all.length} open(s) across ${arm.attempts} attempt(s) FAILED${arm.verdict ? `; ${arm.verdict}` : ""}`);
  // Not a pass: any failed open in ANY attempt, or an arm that stayed contaminated (nothing was measured).
  return { failed: dead.length > 0 || arm.contaminated || flagged503 > 0 || !!notBacked };
}
