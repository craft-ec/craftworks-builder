// THE PAGE HOST every page test uses: a static server and a headless Chrome
// that are PROVABLY this run's and this tree's (builder#70).
//
// Every page test used to bind FIXED ports with `stdio: "ignore"`. Three
// sessions run this suite in three worktrees on one machine, so when another
// run held 8098/9334 the second server failed to bind with nobody listening —
// and the test carried on against the FIRST run's server and Chrome, which
// serve a different tree. A page check could go GREEN on code it never
// loaded. Three things close that, each on its own:
//
//   1. PORT 0, READ BACK. Both children bind a port the OS picks and SAY which
//      (python prints it, Chrome prints its DevTools address). No constant, and
//      no probe-then-bind race.
//   2. A CHILD THAT DIES IS A FAILURE with its own words: its output is kept
//      and printed, never sent to /dev/null.
//   3. THE TREE PROVES ITSELF. A random nonce file is written under this tree's
//      `.page-nonce/` (git-ignored) and must come back through the server —
//      and, once the page is loaded, through the PAGE. That check does not
//      depend on 1 and 2 being right.
//
// AND THE ONE NODE SPAWNER AND CDP TAB HELPER every tool and live run uses
// (builder#98). `tools/two-tab.mjs`, `tools/probe-one-write.mjs` and
// `tools/shots.mjs` each carried their own copy of "spawn a private node" and
// of the tab helper — fixed ports, TCP-only port probes (the node's network
// port is UDP), no `--disable-auto-update`, and a "still held" check that
// called `require` inside an ES module and so always reported nothing. Now:
//
//   * `spawnNode` — NAMED ports (no default: a live run says which), REFUSES
//     7509/7609 and any port already bound, TCP and UDP, BEFORE anything is
//     created; explicit `--data-dir`/`--config-dir`/`--log-dir` under a temp
//     tree; `--disable-auto-update` (a test node that polls for releases exits
//     mid-run the day one is published — craftworks-sdk#208).
//   * `stop()` — kills BY THE RECORDED PID (never a name pattern: several
//     sessions share this machine), escalates to SIGKILL, and VERIFIES: the PID
//     is gone and both ports can be bound again. What is still held is SAID.
//   * `openTab` — one CDP tab: send / evaluate / until, and a timeout DUMPS the
//     page (the caller says what to dump).
//   * `openPageHost({ node, budgetMs })` — a LIVE run names its budget: the
//     90 s default killed a 300-row run, so a run with a node has no default.
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Nodes this machine runs for somebody else. Never probed, never used. */
export const RESERVED = Object.freeze([7509, 7609]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** THE clock for waits and latencies: monotonic milliseconds. `until` returns
 * it, so a caller that subtracts must use THIS `now` too — a wall-clock start
 * minus a monotonic end is a timestamp, not a latency. */
export const now = () => Number(process.hrtime.bigint() / 1_000_000n);

/** Can this run BIND `port` on loopback, TCP? A bind test, not a connect probe:
 * a connect probe says "free" for a port bound but not yet listening. */
export function tcpFree(port) {
  return new Promise(ok => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen(port, "127.0.0.1", () => s.close(() => ok(true)));
  });
}

/** …and UDP: the node's NETWORK port is a UDP socket, which no TCP probe sees. */
export function udpFree(port) {
  return new Promise(ok => {
    const s = createSocket("udp4");
    s.once("error", () => { try { s.close(); } catch (_) {} ok(false); });
    s.bind(port, "127.0.0.1", () => s.close(() => ok(true)));
  });
}

/** Something is accepting TCP connections on `port` (the node is up). */
function answers(port) {
  return new Promise(ok => {
    const s = connect({ port, host: "127.0.0.1" });
    const done = v => { s.destroy(); ok(v); };
    s.setTimeout(500);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.once("timeout", () => done(false));
  });
}

/** The command line of a private test node. A function, so a test reads it
 * without starting anything. Flags follow craftworks-sdk `probe/src/node.rs`. */
export function nodeArgs({ ws, net, transportKey = null, gateway = null }, dir) {
  // LINKED nodes (builder#104's two-node acceptance): a gateway with a known
  // transport key, and a node that joins it by address and public key. The
  // default stays an isolated gateway that dials nothing.
  const link = gateway
    ? ["--gateway", gateway]
    : ["--is-gateway", ...(transportKey ? ["--transport-keypair", transportKey] : [])];
  return [
    "network", ...link, "--skip-load-from-network",
    "--network-address", "127.0.0.1", "--network-port", String(net),
    "--public-network-address", "127.0.0.1", "--public-network-port", String(net),
    "--ws-api-address", "127.0.0.1", "--ws-api-port", String(ws),
    "--data-dir", join(dir, "data"), "--config-dir", join(dir, "config"), "--log-dir", join(dir, "log"),
    "--disable-auto-update",
  ];
}

/**
 * The node's ENVIRONMENT: its own web-container cache, inside its dir.
 *
 * A node serves web containers from ONE per-user cache directory unless told
 * otherwise (freenet-core 0.2.136, config.rs `default_webapp_cache_dir`), and
 * that cache's locks and eviction guards are per-PROCESS. Every node spawned
 * here without this shared the OWNER's node's web cache: a test node's unpack
 * (`remove_dir_all` + `unpack`) of the SDK's artefacts container made the
 * container 404 on two nodes at once, the same failure the owner hit on
 * their node. So a spawned node gets its own, like its data, config and log.
 */
export function nodeEnv(dir, env = process.env) {
  return { ...env, FREENET_WEBAPP_CACHE_DIR: join(dir, "webapp_cache") };
}

// EVERY BROWSER THIS PROCESS STARTS, so that no exit leaves one behind (the
// realnet orphans, 2026-09-24: a killed or crashed run's headless Chrome
// stayed connected to the owner's node for 13 h, and one reconnected to V
// and provisioned its signer). Each is killed by `openPageHost`'s `done` on ANY
// exit it sees (normal, a signal, the budget); and each is written to
// PAGE_HOST_PIDFILE (`pid <TAB> profile`), which the next realnet run sweeps
// for an exit nothing here could see (a SIGKILL).
const browsers = new Set();
function recordBrowser(child, profile) {
  browsers.add(child);
  if (process.env.PAGE_HOST_PIDFILE) appendFileSync(process.env.PAGE_HOST_PIDFILE, `${child.pid}\t${profile}\n`);
  // A WATCHDOG for the exit nothing in this process can see (SIGKILL; macOS
  // has no PDEATHSIG): a detached shell that ends the browser the moment THIS
  // process is gone — only while the PID still names its profile, so a
  // reused PID is never touched — and is itself ended when the browser exits.
  const dog = spawn("/bin/sh", ["-c", 'while kill -0 "$1" 2>/dev/null; do sleep 1; done; ps -o command= -p "$2" 2>/dev/null | grep -qF -- "--user-data-dir=$3" || exit 0; kill "$2"; sleep 5; ps -o command= -p "$2" 2>/dev/null | grep -qF -- "--user-data-dir=$3" && kill -9 "$2"', "watchdog", String(process.pid), String(child.pid), profile], { detached: true, stdio: "ignore" });
  dog.unref();
  child.once("exit", () => {
    browsers.delete(child);
    try { process.kill(dog.pid); } catch (_) {}
  });
}

/** Kill `child` by its recorded PID and wait until it is GONE; SIGKILL after `graceMs`. */
async function killVerified(child, graceMs = 5_000) {
  const pid = child.pid;
  const alive = () => { try { process.kill(pid, 0); return child.exitCode === null && child.signalCode === null; } catch (_) { return false; } };
  if (!pid || !alive()) return true;
  try { process.kill(pid, "SIGTERM"); } catch (_) {}
  for (let t = 0; t < graceMs && alive(); t += 50) await sleep(50);
  if (alive()) {
    try { process.kill(pid, "SIGKILL"); } catch (_) {}
    for (let t = 0; t < 5_000 && alive(); t += 50) await sleep(50);
  }
  return !alive();
}

/**
 * A PRIVATE node on NAMED ports, isolated (dials nothing; loopback only).
 * Refuses a reserved or busy port before anything is created. Returns
 * `{ ws, net, pid, dir, console(), stop() }`; `stop()` resolves to
 * `{ gone, held }` — the PID verified gone, and any port still bound.
 */
export async function spawnNode(label, { ws, net, readyMs = 45_000, gatewayKey = false, joins = null } = {}) {
  for (const [p, what] of [[ws, "ws"], [net, "network"]]) {
    if (!Number.isInteger(p) || p <= 0) throw new Error(`${label}: the node's ${what} port must be NAMED (got ${p})`);
    if (RESERVED.includes(p)) throw new Error(`${label}: ${p} belongs to somebody else's node; refusing to use it`);
  }
  if (!(await tcpFree(ws))) throw new Error(`${label}: something already holds TCP ${ws} (node ws); refusing to start`);
  if (!(await udpFree(net)) || !(await tcpFree(net))) throw new Error(`${label}: something already holds ${net} (node network); refusing to start`);

  const dir = mkdtempSync(join(tmpdir(), "cw-node-"));
  for (const d of ["data", "config", "log", "webapp_cache"]) mkdirSync(join(dir, d), { recursive: true });
  // A gateway others can JOIN needs a transport key they can name: an X25519
  // pair, the secret in a file for the node, the public half for the joiner.
  let transportKey = null, publicKey = null;
  if (gatewayKey) {
    const { privateKey, publicKey: pub } = generateKeyPairSync("x25519");
    const raw = k => Buffer.from(k, "base64url").toString("hex");
    transportKey = join(dir, "transport.key");
    writeFileSync(transportKey, raw(privateKey.export({ format: "jwk" }).d));
    publicKey = raw(pub.export({ format: "jwk" }).x);
  }
  const gateway = joins ? `127.0.0.1:${joins.net},${joins.publicKey}` : null;
  if (joins && !joins.publicKey) throw new Error(`${label}: the node to join was not started with gatewayKey`);
  const child = spawn("freenet", nodeArgs({ ws, net, transportKey, gateway }, dir), { stdio: ["ignore", "pipe", "pipe"], env: nodeEnv(dir) });
  writeFileSync(join(dir, "node.pid"), String(child.pid ?? ""));
  // The node's own account is on its CONSOLE, not in its file log.
  const out = [];
  child.stdout.on("data", d => out.push(String(d)));
  child.stderr.on("data", d => out.push(String(d)));
  const spawnError = new Promise(ok => child.once("error", e => ok(e)));
  const node = {
    ws, net, dir, pid: child.pid, publicKey,
    console: () => out.join(""),
    async stop() {
      const gone = await killVerified(child);
      const held = [];
      if (!(await tcpFree(ws))) held.push(`tcp ${ws}`);
      if (!(await udpFree(net))) held.push(`udp ${net}`);
      if (!gone) held.push(`pid ${child.pid}`);
      if (held.length) console.error(`${label}: STILL HELD after stopping the node: ${held.join(", ")} — kill these by PID before the next run`);
      return { gone, held };
    },
  };
  // Ready on PROGRESS, not on a fixed sleep; a node that exits first says why.
  const deadline = Date.now() + readyMs;
  while (Date.now() < deadline) {
    const e = await Promise.race([spawnError, sleep(250).then(() => null)]);
    if (e) { await node.stop(); throw new Error(`${label}: \`freenet\` could not start (${e.message}) — is it on PATH?`); }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label}: the node exited before it was ready (${child.exitCode ?? child.signalCode}); it said: ${node.console().slice(-1500)}`);
    }
    if (await answers(ws)) return node;
  }
  await node.stop();
  throw new Error(`${label}: the node did not open ws ${ws} within ${readyMs} ms; it said: ${node.console().slice(-1500)}`);
}

/**
 * One CDP-driven tab on the Chrome at `debug`. `dump` is an expression whose
 * value is printed when a wait times out: a timeout names the condition and
 * says nothing about WHY, and what the page showed is the answer nearly every
 * time.
 */
/** The browser-level DevTools WebSocket URL of the Chrome on `debug` (its `/json/version`): Chrome's own debug endpoint, never a node. */
export async function browserDebuggerUrl(debug) {
  return (await (await fetch(`http://127.0.0.1:${debug}/json/version`)).json()).webSocketDebuggerUrl;
}

/** Evaluate `expr` in the out-of-process iframe target whose URL contains `urlPart`; undefined if there is none. */
async function evaluateInTarget(debug, urlPart, expr, label) {
  const t = (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find(x => x.type === "iframe" && (x.url ?? "").includes(urlPart));
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  try {
    const r = await new Promise(ok => {
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) ok(m); };
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true } }));
    });
    if (r.result?.exceptionDetails) throw new Error(`${label} (iframe target): ${JSON.stringify(r.result).slice(0, 300)}`);
    return r.result?.result?.value;
  } finally { ws.close(); }
}

export async function openTab(debug, label, { dump = `return document.body?.innerText?.slice(0, 400);`, pollMs = 25 } = {}) {
  const t = await (await fetch(`http://127.0.0.1:${debug}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let seq = 0; const waiting = new Map();
  // Each frame's DEFAULT (main-world) execution context, by frame id: where the
  // page's own JavaScript and its globals live. Kept from Runtime's events.
  const mainWorld = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === "Runtime.executionContextCreated") {
      const c = m.params?.context;
      if (c?.auxData?.isDefault && c.auxData.frameId) mainWorld.set(c.auxData.frameId, c.id);
    } else if (m.method === "Runtime.executionContextDestroyed") {
      for (const [f, id] of mainWorld) if (id === m.params?.executionContextId) mainWorld.delete(f);
    } else if (m.method === "Runtime.executionContextsCleared") {
      mainWorld.clear();
    }
  };
  const send = (method, params = {}) =>
    new Promise(ok => { const id = ++seq; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  await send("Runtime.enable");
  const evaluate = async expr => {
    const r = await send("Runtime.evaluate", {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.result?.exceptionDetails || r.result?.result?.subtype === "error") {
      throw new Error(`${label}: ${JSON.stringify(r.result).slice(0, 300)}`);
    }
    return r.result?.result?.value;
  };
  const until = async (expr, what, ms = 30_000) => {
    const deadline = now() + ms;
    while (now() < deadline) {
      if (await evaluate(`return !!(${expr});`)) return now();
      await sleep(pollMs);
    }
    let page = "(the page could not be read)";
    try { page = JSON.stringify(await evaluate(dump)); } catch (_) {}
    throw new Error(`${label}: timed out waiting for ${what}\n      page: ${page}`);
  };
  // EVALUATE IN A CHILD FRAME, found by a part of its URL. A node serves a
  // web app inside a SANDBOXED iframe (opaque origin), so the page's own
  // `document` is the node's shell and never the app; this reads the app's
  // DOM through an isolated world in that frame.
  const evaluateIn = async (urlPart, expr) => {
    const tree = (await send("Page.getFrameTree")).result?.frameTree;
    const frames = [];
    const walk = n => { if (!n) return; frames.push(n.frame); (n.childFrames ?? []).forEach(walk); };
    walk(tree);
    const f = frames.find(x => (x.url ?? "").includes(urlPart));
    // OUT OF PROCESS: Chrome isolates a sandboxed iframe into its own process,
    // and then it is not in this page's frame tree but a TARGET of its own.
    if (!f) return evaluateInTarget(debug, urlPart, expr, label);
    // The frame's MAIN world, never an isolated one: an isolated world shares
    // the DOM but not the page's globals, so a probe of the page's own state
    // (`globalThis.__cwSessions`) read EMPTY there — a non-measurement that
    // looked like "no sessions" (engineer2's sampler). Not known yet (a frame
    // just navigated): Runtime is re-enabled, which announces every live
    // context again; still unknown is an error naming the frame, never a
    // silent fallback.
    let contextId = mainWorld.get(f.id);
    if (!contextId) {
      await send("Runtime.disable");
      await send("Runtime.enable");
      contextId = mainWorld.get(f.id);
    }
    if (!contextId) throw new Error(`${label}: no main-world context in frame ${f.url}`);
    const r = await send("Runtime.evaluate", {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, contextId,
    });
    if (r.result?.exceptionDetails) throw new Error(`${label} (frame): ${JSON.stringify(r.result).slice(0, 300)}`);
    return r.result?.result?.value;
  };
  return { label, send, evaluate, evaluateIn, until, close: () => ws.close() };
}

/** Resolve with the first match of `re` in a child's output, or fail naming the child. */
function announced(child, streams, re, what, ms) {
  return new Promise((ok, bad) => {
    let seen = "";
    const timer = setTimeout(() => bad(new Error(`${what} did not say where it listens within ${ms} ms; it said: ${seen.slice(-400) || "(nothing)"}`)), ms);
    const read = chunk => {
      seen += chunk;
      const m = seen.match(re);
      if (m) { clearTimeout(timer); ok(Number(m[1])); }
    };
    for (const s of streams) s.setEncoding("utf8"), s.on("data", read);
    child.once("exit", code => {
      clearTimeout(timer);
      // The line that says WHY (python ends a failed bind with the OSError),
      // not the tail of a traceback.
      const why = seen.split("\n").map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(l => /Error|error:/.test(l)).pop();
      bad(new Error(`${what} exited (${code}) before listening: ${why ?? (seen.slice(-400) || "(it said nothing)")}`));
    });
    child.once("error", e => { clearTimeout(timer); bad(new Error(`${what} could not start: ${e.message}`)); });
  });
}

/**
 * Start this run's server and Chrome. `label` names the test in every message.
 * Returns the ports, the nonce, `done(code)` (kills both, removes the nonce,
 * exits) and `pageProof`, an expression the test evaluates in the page once it
 * has navigated — it must return the nonce.
 */
export async function openPageHost(label, { windowSize = "1280,800", budgetMs, node: nodePorts, chromeArgs = [] } = {}) {
  // A LIVE run (one with a node) names its budget: the old 90 s default killed
  // a 300-row run that nobody had told it about. A page-only test keeps 90 s.
  if (nodePorts && budgetMs === undefined) {
    throw new Error(`${label}: a live run (with a node) must name its budgetMs; there is no default`);
  }
  budgetMs ??= 90_000;
  const kids = [];
  let node = null;
  const nonceDir = join(ROOT, ".page-nonce");
  const nonce = randomUUID();
  let ending = false;
  // Everything this run started, stopped BY PID and verified gone, then exit.
  const done = async code => {
    if (ending) return;
    ending = true;
    if (node) {
      const { gone, held } = await node.stop();
      if (!gone || held.length) code = code || 1;
    }
    for (const k of [...kids, ...browsers]) {
      if (!(await killVerified(k))) { console.error(`${label}: pid ${k.pid} did not exit`); code = code || 1; }
    }
    rmSync(join(nonceDir, nonce), { force: true });
    process.exit(code);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => done(1));
  setTimeout(() => {
    console.error(`${label} FAILED: the run exceeded its ${budgetMs / 1000} s budget (pass a larger budgetMs if the run is meant to be longer)`);
    done(1);
  }, budgetMs).unref();

  try {
    const server = spawn("python3", ["-u", "-m", "http.server", "0", "--bind", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    kids.push(server);
    const port = await announced(server, [server.stdout, server.stderr], /port (\d+)/, `${label}: page server`, 10_000);

    mkdirSync(nonceDir, { recursive: true });
    writeFileSync(join(nonceDir, nonce), nonce);
    const back = await fetch(`http://127.0.0.1:${port}/.page-nonce/${nonce}`).then(r => (r.ok ? r.text() : `HTTP ${r.status}`), e => `unreachable: ${e.message}`);
    if (back !== nonce) throw new Error(`the server on ${port} is not serving THIS tree (${ROOT}): the nonce came back as ${JSON.stringify(back)}`);

    const profile = mkdtempSync(join(tmpdir(), "cw-page-"));
    const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--window-size=${windowSize}`, "--remote-debugging-port=0", ...chromeArgs,
      `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
    kids.push(chrome);
    recordBrowser(chrome, profile);
    const debug = await announced(chrome, [chrome.stdout, chrome.stderr], /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//, `${label}: chrome`, 30_000);

    const pageProof = `return await (await fetch("/.page-nonce/${nonce}")).text();`;
    if (nodePorts) node = await spawnNode(`${label}: node`, nodePorts);
    return { port, debug, nonce, pageProof, done, node, tab: (tabLabel, opts) => openTab(debug, tabLabel, opts) };
  } catch (e) {
    console.error(`${label} FAILED: ${e.message}`);
    done(1);
  }
}

/**
 * A SECOND browser with its own FRESH profile (empty cache, no storage): what
 * a stranger opening an app by address has. Returns `{ tab(label), stop() }`.
 */
export async function openFreshBrowser(label, { windowSize = "1280,800" } = {}) {
  // A browser that opens apps on REAL nodes (only the live tools start one) is
  // made where its owner can be told: never in the system's default temp dir,
  // where the 06:30 orphan's profile could not be tied to anyone.
  const t = process.env.TMPDIR ?? "";
  if (process.env.PAGE_HOST_ALLOW_DEFAULT_TMPDIR !== "1" && (!t || t.startsWith("/var/folders/") || /^\/(private\/)?tmp\/?$/.test(t))) {
    throw new Error(`${label}: TMPDIR is ${t ? `the system default (${t})` : "unset"}; set it to your run's own directory, so every browser profile names its owner`);
  }
  const profile = mkdtempSync(join(tmpdir(), "cw-fresh-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--window-size=${windowSize}`, "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  recordBrowser(chrome, profile);
  const debug = await announced(chrome, [chrome.stdout, chrome.stderr], /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//, `${label}: chrome`, 30_000);
  return { debug, pid: chrome.pid, tab: (tabLabel, opts) => openTab(debug, tabLabel, opts), stop: () => killVerified(chrome) };
}
