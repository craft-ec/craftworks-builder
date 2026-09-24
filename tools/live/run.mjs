// tools/live.sh's runner: one live SCENARIO, measured under the rules in runner.mjs.
//
//   node tools/live/run.mjs <scenario> [--repeats R] [--nodes N] [--budget-min M] [--wait-min W]
//
// Exit: 0 the scenario passed; 1 it failed (its own lines say where); 2 REFUSED (a header field unreadable,
// TMPDIR not the run's own); 3 NOT RUN (the box stayed busy for the whole wait); 130/143 interrupted.
// A scenario is `tools/live/scenarios/<name>.mjs` exporting `run(ctx)`, resolving to `{ failed }`.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as eventlog from "./eventlog.mjs";
import { Nodes, Refused, ROOT, Samples, defaultReaders, header, loadGate, machine, resolvable, runArm, runDir, sdkRan, summarize } from "./runner.mjs";

const argv = process.argv.slice(2);
const scenario = argv[0];
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i > 0 ? Number(argv[i + 1]) : dflt; };
if (!scenario || scenario.startsWith("--")) {
  console.log("usage: tools/live.sh <scenario> [--repeats R] [--nodes N] [--budget-min M] [--wait-min W]");
  process.exit(2);
}
const args = { repeats: opt("repeats", 3), nodes: opt("nodes", 4), budgetMin: opt("budget-min", 30), waitMin: opt("wait-min", 20) };

let dir;
const lines = [];
const say = l => { console.log(l); lines.push(l); if (dir) appendFileSync(join(dir, "summary.txt"), `${l}\n`); };

let head;
try {
  dir = runDir(scenario);
  // The header's readers: the real ones, or a test's (LIVE_READERS names a module exporting `readers`).
  const readers = process.env.LIVE_READERS ? (await import(pathToFileURL(process.env.LIVE_READERS).href)).readers : defaultReaders();
  head = header(readers);
} catch (e) {
  if (e instanceof Refused) { console.log(e.message); process.exit(2); }
  throw e;
}
writeFileSync(join(dir, "header.json"), `${JSON.stringify(head, null, 2)}\n`);
say(`RUN   ${scenario} in ${dir}`);
say(`HEAD  builder ${head.builder.slice(0, 12)}${head.builder_dirty ? ` (+${head.builder_dirty} uncommitted)` : ""}, sdk ${String(head.sdk_rev).slice(0, 12)} (sdk/REV), sdk wasm ${head.sdk_wasm_sha256.slice(0, 16)}, block ${head.block_wasm_sha256.slice(0, 16)}, freenet ${head.freenet}`);
say(`HEAD  machine ${JSON.stringify(head.machine)}; co-tenants (recorded, not refused) ${JSON.stringify(head.co_tenants)}`);

// THE LOAD GATE: below the core count, or wait for it with a budget -- and say so either way.
const gate = await loadGate({ waitS: args.waitMin * 60, pollS: Number(process.env.LIVE_POLL_S ?? 15), read: process.env.LIVE_READERS ? () => head.machine : machine });
if (!gate.ok) {
  say(`NOT RUN  box busy: 1-min load ${gate.load1} on ${gate.cores} cores after waiting ${gate.waited_s} s (the run starts only below the core count)`);
  process.exit(3);
}
say(`LOAD  ${gate.load1} on ${gate.cores} cores${gate.waited_s ? ` after waiting ${gate.waited_s} s` : ""}`);

const t0 = Date.now();
const budgetLeftMs = () => t0 + args.budgetMin * 60_000 - Date.now();
const nodes = new Nodes(dir);
const samples = new Samples(join(dir, "samples.jsonl"));
let ended = false;
// What a scenario started besides nodes (a page server, browsers): ended here on EVERY exit, a signal
// included, before the nodes. Synchronous (a signal handler cannot wait): each kills by recorded pid.
const ends = [];
const finish = (failed, how) => {
  if (ended) return;
  ended = true;
  for (const fn of ends.splice(0).reverse()) { try { fn(); } catch (e) { say(`END   a scenario's clean-up failed: ${e.message}`); } }
  for (const l of nodes.end(failed).lines) say(`NODE  ${l}`);
  say(`${how} after ${samples.n} sample(s), ${Math.round((Date.now() - t0) / 1000)} s; results in ${dir}`);
};
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(sig, () => { finish(true, `INTERRUPTED (${sig})`); process.exit(code); });
}

const ctx = {
  dir, header: head, args, nodes, say, eventlog, sdkRan, summarize, resolvable, budgetLeftMs,
  logsOf: label => join(dir, "logs", label),
  fs: { appendFileSync, mkdirSync },
  /** Register a SYNCHRONOUS clean-up (kill by recorded pid) run on every exit, a signal included. */
  onEnd: fn => ends.push(fn),
  /** Run one arm; every sample is streamed to samples.jsonl as it completes. */
  arm: (name, repeats, sample) => runArm({ name, repeats, sample, budgetLeftMs, onSample: s => samples.add(s), loadAt: process.env.LIVE_READERS ? () => head.machine : machine }),
};
let failed = true;
try {
  const mod = await import(pathToFileURL(join(process.env.LIVE_SCENARIO_DIR ?? join(ROOT, "tools/live/scenarios"), `${scenario}.mjs`)).href);
  failed = (await mod.run(ctx)).failed !== false;
} catch (e) {
  say(`FAIL  ${scenario}: ${e.message}`);
  failed = true;
} finally {
  finish(failed, failed ? "FAILED" : "PASSED");
}
process.exit(failed ? 1 : 0);
