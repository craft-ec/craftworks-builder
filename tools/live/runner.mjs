// THE LIVE-MEASUREMENT RUNNER (stock-take 2026-09-24 §4.3; the plan the architect reviewed): the ONE
// place a live question is measured, instead of a scratch tool per question. A scenario says what to set
// up, what one SAMPLE is and when it has enough; everything else is here, done once:
//
//   * THE HEADER, OR NO RUN: every artefact sha and the machine's state, read before the first sample.
//     A field that cannot be read REFUSES the run. The SDK is the one READ BACK from the built sdk/REV,
//     never the requested SDK_REV (CLAUDE.md, "Evidence names what ACTUALLY ran").
//   * THE LOAD GATE: a run starts only below the core count (the architect's absolute cut), waiting for
//     it with a budget and saying how long it waited and at what load -- never silently never run.
//   * SAMPLES, STREAMED: each one is appended to samples.jsonl the moment it completes, with the load at
//     that moment, so an interrupted run keeps what it measured.
//   * PER ARM: min / median / max, the SPREAD between repeats, and whether an effect is resolvable at all.
//   * CONTAMINATION: a sample taken at load >= cores is contaminated; its arm is re-run at most twice
//     inside the budget, then reported "contaminated: not resolvable". Never a loop.
//   * NODES: private, on the real network, explicit dirs and web cache, 7509/7609 refused, ended through
//     tools/realnet-nodes.sh (the one node-ending function: TERM -> KILL -> proven gone, dirs kept on a
//     failure, never a pid that is no longer ours).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const RESERVED = Object.freeze([7509, 7609]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A header field that could not be read: the run is refused, naming it. */
export class Refused extends Error {}

const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: exit ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
  return r.stdout.trim();
};

/** The machine as a run sees it: cores, 1-min load, free memory and disk. */
export function machine() {
  const load1 = Number(sh("/usr/sbin/sysctl", ["-n", "vm.loadavg"]).replace(/[{}]/g, "").trim().split(/\s+/)[0]);
  const freeDiskKb = Number(sh("/bin/df", ["-Pk", ROOT]).split("\n")[1].split(/\s+/)[3]);
  return { cores: cpus().length, load1, free_mem_mb: Math.round(freemem() / 1048576), free_disk_gb: Math.round(freeDiskKb / 1048576) };
}

/** Who else is on the box: RECORDED, never a reason to refuse (the owner's node is always one). */
export function coTenants() {
  const ps = sh("/bin/ps", ["-Ao", "pid=,command="]).split("\n");
  const lock = (() => { try { return readFileSync("/tmp/craftworks-realnet.lock/owner", "utf8").replace(/\n/g, " ").trim(); } catch { return null; } })();
  return {
    realnet_lock: lock,
    freenet_processes: ps.filter(l => /(^|\/)freenet( |$)/.test(l.trim().split(/\s+/)[1] ?? "") || /\sfreenet network/.test(l)).length,
    chrome_processes: ps.filter(l => /Google Chrome/.test(l) && !/Helper/.test(l)).length,
  };
}

/**
 * THE HEADER. `readers` maps each field to a function that returns its value or throws; a throw, an
 * empty value, or an SDK built at another revision than pinned REFUSES the run. Injectable so a test
 * can make each field unreadable in turn.
 */
export function defaultReaders(root = ROOT) {
  const at = p => join(root, p);
  const pinned = () => readFileSync(at("SDK_REV"), "utf8").trim();
  return {
    builder: () => sh("git", ["-C", root, "rev-parse", "HEAD"]),
    builder_dirty: () => sh("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"]).split("\n").filter(Boolean).length,
    sdk_rev: () => {
      const built = readFileSync(at("sdk/REV"), "utf8").trim();
      if (built !== pinned()) throw new Error(`the SDK built is ${built}, not the pinned ${pinned()}`);
      return built;
    },
    sdk_wasm_sha256: () => sha256(at("sdk/craftworks_sdk_bg.wasm")),
    block_wasm_sha256: () => sha256(at("sdk/block.wasm")),
    register_wasm_sha256: () => sha256(at("sdk/register.wasm")),
    load_pieces: () => {
      const p = JSON.parse(readFileSync(at("sdk/pieces.json"), "utf8"));
      return Object.fromEntries(Object.entries(p).map(([b, s]) => [b, `k=${s.k}+m=${s.m}`]));
    },
    freenet: () => sh("freenet", ["--version"]).split("\n")[0].replace(/^Freenet version:\s*/, ""),
    machine: () => machine(),
    co_tenants: () => coTenants(),
  };
}

export function header(readers = defaultReaders()) {
  const out = { taken_at: new Date().toISOString() };
  for (const [field, read] of Object.entries(readers)) {
    let v;
    try { v = read(); } catch (e) { throw new Refused(`REFUSED  the header's ${field} could not be read: ${e.message}`); }
    if (v === undefined || v === null || v === "") throw new Refused(`REFUSED  the header's ${field} is empty`);
    out[field] = v;
  }
  return out;
}

/**
 * THE LOAD GATE: wait (polling every `pollS`) until the 1-min load is under `cores`, for at most
 * `waitS`. Returns `{ ok, waited_s, load1, cores }`; the caller prints "not run: box busy" on !ok.
 */
export async function loadGate({ waitS, pollS = 15, read = machine, now = () => Date.now() } = {}) {
  const t0 = now();
  for (;;) {
    const m = read();
    const waited = Math.round((now() - t0) / 1000);
    if (m.load1 < m.cores) return { ok: true, waited_s: waited, load1: m.load1, cores: m.cores };
    if (waited >= waitS) return { ok: false, waited_s: waited, load1: m.load1, cores: m.cores };
    await sleep(pollS * 1000);
  }
}

/** Samples, appended as each completes: an interrupted run keeps every one already written. */
export class Samples {
  constructor(file) { this.file = file; this.n = 0; writeFileSync(file, ""); }
  add(s) { appendFileSync(this.file, `${JSON.stringify(s)}\n`); this.n += 1; }
  all() { return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); }
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * One arm's line: min / median / max over its clean samples, the SPREAD (max - min), and the poller's
 * grid. `flat` when the whole spread fits inside one grid step: then it supports an ordering between arms
 * several steps apart, never a magnitude (CLAUDE.md, "a poller reports its own period").
 */
export function summarize(values, { grid = 0 } = {}) {
  if (!values.length) return { n: 0 };
  const min = Math.min(...values), max = Math.max(...values);
  return { n: values.length, min, median: median(values), max, spread: max - min, grid, flat: grid > 0 && max - min < grid };
}

/**
 * Can this instrument see the difference between two arms? Only if their medians differ by MORE than the
 * larger of their two spreads (repeats of the SAME arm decide resolvability, never the gap to idle).
 */
export function resolvable(a, b) {
  if (!a.n || !b.n || a.n < 2 || b.n < 2) return { resolvable: false, why: "fewer than two repeats in an arm: no spread to judge by" };
  const effect = Math.abs(a.median - b.median), noise = Math.max(a.spread, b.spread);
  return effect > noise
    ? { resolvable: true, effect, noise }
    : { resolvable: false, effect, noise, why: `not resolvable with this instrument: the effect (${effect}) is within the repeat spread (${noise})` };
}

/**
 * Run one ARM `repeats` times. A sample taken at load >= cores is CONTAMINATED; the arm is re-run from the
 * start at most `maxReruns` times, and only while the budget allows. Still contaminated after that: the
 * arm reports "contaminated: not resolvable" and stops. Never a loop.
 */
export async function runArm({ name, repeats, sample, loadAt = () => machine(), maxReruns = 2, budgetLeftMs = () => Infinity, onSample = () => {} }) {
  // EVERY attempt's samples, kept: a failure inside a contaminated attempt is still a failure, and the
  // verdict must see it (the first live run called 3 dead opens a pass by reading the last attempt only).
  const all = [];
  for (let attempt = 0; attempt <= maxReruns; attempt++) {
    const got = [];
    let dirty = 0;
    for (let i = 0; i < repeats; i++) {
      const s = await sample(i);
      const m = loadAt();
      const rec = { arm: name, attempt, i, ...s, load1: m.load1, cores: m.cores, contaminated: m.load1 >= m.cores };
      onSample(rec);
      got.push(rec);
      all.push(rec);
      if (rec.contaminated) dirty += 1;
    }
    if (!dirty) return { name, attempts: attempt + 1, samples: got, all, contaminated: false };
    if (attempt === maxReruns || budgetLeftMs() <= 0) {
      return { name, attempts: attempt + 1, samples: got, all, contaminated: true, verdict: `contaminated: not resolvable (${dirty} of ${repeats} samples at load >= cores after ${attempt + 1} attempt(s))` };
    }
  }
  throw new Error("unreachable");
}

/**
 * WHAT THE PAGE RAN: the SDK wasm an opener's loader verified is the one its node's artefacts.json names
 * (the loader refuses any other bytes), and the loader's `sdk` stamp proves it loaded. A sample whose SDK
 * is not the header's is REFUSED and named -- the header proves what was built, only this what ran.
 */
export function sdkRan({ header: h, served, stamps }) {
  if (!stamps || typeof stamps.sdk !== "number") return { ok: false, why: "the loader never stamped `sdk`: no SDK was loaded" };
  if (served?.notWithin) return { ok: false, why: `the opener's node's artefacts.json: not within ${served.notWithin} s` };
  if (!served) return { ok: false, why: "the opener's node's artefacts.json names no SDK wasm" };
  if (served !== h.sdk_wasm_sha256) return { ok: false, why: `the page ran SDK wasm ${served.slice(0, 16)}, not the header's ${h.sdk_wasm_sha256.slice(0, 16)}` };
  return { ok: true };
}

// ---- nodes ------------------------------------------------------------------------------------------

/** A free port the OS picked (TCP or UDP), never a reserved one. */
export function freePort(kind = "tcp") {
  for (;;) {
    const p = Number(sh("python3", ["-c", `import socket; s=socket.socket(socket.AF_INET, socket.${kind === "udp" ? "SOCK_DGRAM" : "SOCK_STREAM"}); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])`]));
    if (!RESERVED.includes(p)) return p;
  }
}

/**
 * The run's nodes: private, joined to the REAL network, each with explicit data/config/log dirs and its
 * own web cache under the run dir, --disable-auto-update, and the event log on (the attribution source;
 * harness nodes only). Ended ONLY through tools/realnet-nodes.sh.
 */
export class Nodes {
  constructor(runDir, { bin = process.env.LIVE_FREENET ?? "freenet", eventLog = true } = {}) {
    this.runDir = runDir; this.bin = bin; this.eventLog = eventLog; this.list = [];
  }
  async start(label, { readyMs = 60_000 } = {}) {
    const ws = freePort("tcp"), net = freePort("udp");
    for (const p of [ws, net]) if (RESERVED.includes(p)) throw new Error(`${label}: ${p} is somebody else's node`);
    const dir = join(this.runDir, "nodes", label);
    for (const d of ["data", "config", "log", "webapp_cache"]) mkdirSync(join(dir, d), { recursive: true });
    const args = ["network", "--ws-api-address", "127.0.0.1", "--ws-api-port", String(ws), "--network-port", String(net),
      "--data-dir", join(dir, "data"), "--config-dir", join(dir, "config"), "--log-dir", join(dir, "log"), "--disable-auto-update",
      ...(this.eventLog ? ["--enable-event-log", "true"] : [])];
    const out = join(dir, "log", "console.out");
    const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FREENET_WEBAPP_CACHE_DIR: join(dir, "webapp_cache") }, detached: false });
    child.stdout.on("data", d => appendFileSync(out, d));
    child.stderr.on("data", d => appendFileSync(out, d));
    const node = { label, ws, net, dir, pid: child.pid, started_ms: Date.now() };
    this.list.push(node);
    const deadline = Date.now() + readyMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`${label}: the node exited before its ws port opened (${child.exitCode}); see ${out}`);
      if (spawnSync("nc", ["-z", "127.0.0.1", String(ws)]).status === 0) { node.ready_ms = Date.now() - node.started_ms; return node; }
      await sleep(250);
    }
    throw new Error(`${label}: ws ${ws} did not open within ${readyMs} ms; see ${out}`);
  }
  /** End every node through realnet-nodes.sh; returns its report lines and whether every node was proven gone. */
  end(runFailed) {
    if (!this.list.length) return { lines: [], ok: true };
    const arr = (name, f) => `${name}=(${this.list.map(n => `'${String(f(n)).replace(/'/g, "'\\''")}'`).join(" ")})`;
    const script = [`set -u`, `. '${join(ROOT, "tools/realnet-nodes.sh")}'`,
      arr("npids", n => n.pid), arr("ndirs", n => n.dir), arr("nws", n => n.ws), arr("nlabels", n => n.label),
      `end_nodes ${runFailed ? 1 : 0}`].join("\n");
    const r = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" });
    this.list = [];
    return { lines: (r.stdout + r.stderr).split("\n").filter(Boolean), ok: r.status === 0 };
  }
}

/** The run's directory: results/<utc>-<scenario>/ under the run's TMPDIR, with logs/. */
export function runDir(scenario, base = process.env.TMPDIR) {
  if (!base || /^(\/tmp|\/private\/tmp|\/var\/folders)/.test(base)) throw new Refused(`REFUSED  TMPDIR is ${base ?? "unset"}: set it to your own directory, so every node and browser this run starts names its owner`);
  const d = join(base, "live-results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${scenario}`);
  mkdirSync(join(d, "logs"), { recursive: true });
  return d;
}

export { existsSync };
