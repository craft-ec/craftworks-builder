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
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureWire } from "../../wire-capture.mjs";
import { openFreshBrowser } from "../../../tests/page-host.mjs";
import { ROOT } from "../runner.mjs";
import { LIMIT, touches, touchedIn } from "../eventlog.mjs";

const STEP_MS = Number(process.env.LIVE_STEP_MS ?? 180_000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROWS = ["alpha", "beta"];
// The app: a notes form and table (cold8's), its two rows written in the builder before publishing.
const APP = {
  name: "live open-fresh-nodes",
  components: [{ type: "form", domain: "notes", mode: "owned" }, { type: "table", domain: "notes", mode: "owned" }],
  schemas: { notes: { type: "Note", fields: [{ name: "title", kind: "text", required: true }] } },
};
const comp = (label, domain) => `[...document.querySelectorAll(".rt-comp")].find(s => (s.querySelector("h4")?.textContent ?? "").startsWith(${JSON.stringify(`${label} · ${domain}`)}))`;
const addTo = (domain, t) => `const f = ${comp("Form", domain)}; const i = f?.querySelector("input[name=title]"); if (!i) return "no form"; i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event("input", { bubbles: true })); f.querySelector("button.pri").click(); return "ok";`;
const hasRows = `const r = [...(${comp("Table", "notes")}?.querySelectorAll("tbody tr td:first-child") ?? [])].map(td => td.textContent); return ${JSON.stringify(ROWS)}.every(t => r.includes(t)) || null;`;

/** Poll `expr` (in `frame` when given) until it is truthy, for at most `ms`; null when it never was. */
async function until(tab, expr, ms, frame = null, every = 250) {
  const end = Date.now() + ms;
  do {
    const v = await (frame ? tab.evaluateIn(frame, expr) : tab.evaluate(expr)).catch(() => null);
    if (v) return v;
    await sleep(every);
  } while (Date.now() < end);
  return null;
}

/** This builder tree, served by a static server of the run's own (port 0, read back); killed by pid at the end. */
async function builderServer(ctx) {
  const child = spawn("python3", ["-u", "-m", "http.server", "0", "--bind", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  ctx.onEnd(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
  const port = await new Promise((ok, bad) => {
    let seen = "";
    const timer = setTimeout(() => bad(new Error(`the builder's page server said no port within 10 s: ${seen.slice(-200)}`)), 10_000);
    for (const s of [child.stdout, child.stderr]) s.on("data", d => { seen += d; const m = seen.match(/port (\d+)/); if (m) { clearTimeout(timer); ok(Number(m[1])); } });
  });
  return port;
}

/** A fresh browser whose pid is killed at the end whatever happens. */
async function browser(ctx, label) {
  const b = await openFreshBrowser(label);
  ctx.onEnd(() => { try { process.kill(b.pid, "SIGKILL"); } catch {} });
  return b;
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

export async function run(ctx) {
  const { say } = ctx;
  say(`ATTR  ${LIMIT}`);
  // ---- publish once, from a fresh node P ----
  const P = await ctx.nodes.start("P");
  say(`NODE  P :${P.ws} ready in ${P.ready_ms} ms (dirs ${P.dir})`);
  const port = await builderServer(ctx);
  const pb = await browser(ctx, "live: the publisher's builder");
  const builder = await pb.tab("builder");
  await builder.navigate(`http://127.0.0.1:${port}/#node=${P.ws}&preview=1&app=` + encodeURIComponent(JSON.stringify(APP)));
  if (!(await until(builder, `return (${comp("Form", "notes")}?.querySelector("input[name=title]") && 1) || null;`, 60_000))) throw new Error("the builder never showed the notes form");
  for (const t of ROWS) { await builder.evaluate(addTo("notes", t)); await sleep(500); }
  const tPub = Date.now();
  await builder.evaluate(`document.getElementById("publish").click(); return 1;`);
  const pub = await until(builder, `return window.__craftworksPublished ?? null;`, STEP_MS * 3, null, 1000);
  if (!pub?.address) throw new Error(`publish on P did not finish within ${(STEP_MS * 3) / 1000} s: ${await builder.evaluate(`return document.getElementById("publish-note")?.textContent?.slice(0, 200) ?? null;`).catch(() => null)}`);
  const tPubEnd = Date.now();
  say(`PUB   published ${pub.address} from P in ${tPubEnd - tPub} ms`);
  await pb.stop();
  const addr = pub.address;
  const appUrl = ws => `http://127.0.0.1:${ws}/v1/contract/web/${addr}/`;
  const frameOf = ws => `127.0.0.1:${ws}/v1/contract/web/${addr}/?__sandbox=1`;

  // ---- the READABILITY precheck: P touched the app at publish, R touches it on its GET; each dated ----
  const R = await ctx.nodes.start("R");
  const tGet = Date.now();
  let status = 0;
  while (Date.now() - tGet < STEP_MS && status !== 200) {
    status = await fetch(appUrl(R.ws), { signal: AbortSignal.timeout(30_000) }).then(r => r.status, () => 0);
    if (status !== 200) await sleep(2000);
  }
  const tGetEnd = Date.now();
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
    const rows = await until(tab, hasRows, STEP_MS, frameOf(O.ws), 250);
    const t1 = Date.now();
    const stamps = await tab.evaluateIn(frameOf(O.ws), `return globalThis.__craftworksOpen ?? null;`).catch(() => null);
    // A dead open says what the page SHOWED (the node's own error page, when that is what came back).
    const shown = rows ? null : await tab.evaluate(`return document.body?.innerText?.slice(0, 300) ?? null;`).catch(e => `(unreadable: ${e.message})`);
    const served = await fetch(`${appUrl(O.ws)}artefacts.json`, { signal: AbortSignal.timeout(30_000) }).then(r => r.json()).then(j => j?.sdk?.sha256 ?? null, () => null);
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
    const sample = {
      opener: name, ok: !!rows, open_ms: rows ? t1 - t0 : null, node_ready_ms: O.ready_ms, stamps,
      document_status: doc?.response?.status ?? null, ...(rows ? {} : { shown }),
      sdk_ran: ran.ok, ...(ran.ok ? {} : { refused: ran.why }),
      pieces: { asked: pieces.length, ok: ok.length, cancelled: pieces.filter(r => r.failed?.canceled).length, median_ms: ms.length ? ms[ms.length >> 1] : null },
    };
    opens.push({ ...sample, t0, t1, keys: [addr, ...new Set(pieces.map(r => r.url.match(piece)[1]))], prior: [...prior] });
    prior.push(O);
    say(`OPEN  ${name}: ${rows ? `${t1 - t0} ms` : `rows not within ${STEP_MS / 1000} s (the app's URL answered ${sample.document_status ?? "nothing"}; the page showed ${JSON.stringify(shown)})`}; node ready ${O.ready_ms} ms; pieces asked ${sample.pieces.asked}, 200 ${sample.pieces.ok}, cancelled ${sample.pieces.cancelled}, median ${sample.pieces.median_ms} ms; sdk ${ran.ok ? "is the header's" : `REFUSED: ${ran.why}`}; stamps ${JSON.stringify(stamps)}`);
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

  // ---- the arm's line ----
  const clean = arm.samples.filter(s => s.ok && s.sdk_ran && !s.contaminated);
  const sum = ctx.summarize(clean.map(s => s.open_ms));
  const dead = arm.all.filter(s => !s.ok || !s.sdk_ran);
  say(`ARM   open: ${JSON.stringify(sum)} over ${clean.length} clean open(s) of ${arm.samples.length} in the last attempt; ${dead.length} of ${arm.all.length} open(s) across ${arm.attempts} attempt(s) FAILED${arm.verdict ? `; ${arm.verdict}` : ""}`);
  // Not a pass: any failed open in ANY attempt, or an arm that stayed contaminated (nothing was measured).
  return { failed: dead.length > 0 || arm.contaminated };
}
