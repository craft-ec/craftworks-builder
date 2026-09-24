// THE RUN'S OWN NODES (tools/realnet-nodes.sh, sourced by tools/realnet.sh): a FAILED run
// keeps every node's dirs -- the logs are why it failed (the Phase 4 run's "V's page never
// loaded" was lost when the harness deleted V's dir) -- and names their paths; a PASSING run
// removes them. And a node is stopped TERM -> bounded wait -> KILL -> proven gone, so one that
// ignores TERM (cold8) is killed, not waited on for ever.
//
// The "nodes" are stand-in processes (no freenet is started): one that exits on TERM, one that
// IGNORES TERM, each with a dir of its own under this test's temp dir, NAMED on its command line
// as a real node's --data-dir is. A pid whose command line does not name its dir (reused by
// another process after the node exited) is never signalled.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownTmp } from "./page-host.mjs";

const lib = fileURLToPath(new URL("../tools/realnet-nodes.sh", import.meta.url));
const under = process.env.REALNET_NODES_UNDER_TEST ?? lib;
const base = ownTmp("realnet-nodes-");
const freePort = () => new Promise(res => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

// Start two stand-in nodes (a polite one, and one that ignores TERM), then end them with the
// run's verdict. Returns the output, the exit status, the dirs and the pids.
const started = [];
const run = async (runFailed, { holdPort = false, reused = false, exited = false } = {}) => {
  const dir = n => { const d = join(base, `${n}-${Math.random().toString(36).slice(2)}`); mkdirSync(join(d, "log"), { recursive: true }); writeFileSync(join(d, "log", "console.out"), `${n} log\n`); return d; };
  const dirs = [dir("V"), dir("O1")];
  const ports = [await freePort(), await freePort()];
  let holder = null;
  if (holdPort) holder = await new Promise(res => { const s = createServer().listen(ports[0], "127.0.0.1", () => res(s)); });
  const script = `
    set -u
    . '${under}'
    REALNET_TERM_WAIT=1; REALNET_KILL_WAIT=3
    npids=(); ndirs=(); nws=(); nlabels=()
    ${reused
      // V's recorded pid now belongs to an UNRELATED process: its command line names no node dir.
      ? `perl -e 'sleep 300' unrelated-process & npids+=($!); ndirs+=('${dirs[0]}'); nws+=(${ports[0]}); nlabels+=(V)`
      : exited
      // V EXITED on its own before cleanup (a crash, a failed start).
      ? `perl -e 'exit 0' '${dirs[0]}' & npids+=($!); ndirs+=('${dirs[0]}'); nws+=(${ports[0]}); nlabels+=(V)`
      : `perl -e 'sleep 300' '${dirs[0]}' & npids+=($!); ndirs+=('${dirs[0]}'); nws+=(${ports[0]}); nlabels+=(V)`}
    perl -e '$SIG{TERM} = "IGNORE"; sleep 300' '${dirs[1]}' & npids+=($!); ndirs+=('${dirs[1]}'); nws+=(${ports[1]}); nlabels+=(O1)
    echo "PIDS \${npids[*]}"
    sleep 0.3
    end_nodes ${runFailed ? 1 : 0}
    echo "RC $?"
    echo "LEFT \${#npids[@]}"
  `;
  const r = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", timeout: 60_000 });
  if (holder) holder.close();
  const pids = (r.stdout.match(/^PIDS (.*)$/m)?.[1] ?? "").split(" ").filter(Boolean).map(Number);
  started.push(...pids);
  const alive = pids.filter(p => { try { process.kill(p, 0); return true; } catch { return false; } });
  return { out: r.stdout + r.stderr, status: r.status, dirs, pids, alive, rc: Number(r.stdout.match(/^RC (\d+)$/m)?.[1]) };
};

try {
  // A FAILED run: both nodes gone (the TERM-ignoring one KILLed), both dirs KEPT and named.
  const failed = await run(true);
  assert.strictEqual(failed.status, 0, `the script did not finish: ${failed.out}`);
  assert.strictEqual(failed.pids.length, 2, `the stand-in nodes did not start: ${failed.out}`);
  assert.deepStrictEqual(failed.alive, [], `a node outlived end_nodes: ${failed.out}`);
  assert.match(failed.out, /KILL {2}O1's node \(pid \d+\) ignored TERM for 1 s/, "the node that ignored TERM was not KILLed");
  assert.match(failed.out, /PASS {2}V's node \(pid \d+\) is gone/);
  assert.match(failed.out, /PASS {2}O1's node \(pid \d+\) is gone/);
  for (const d of failed.dirs) {
    assert.ok(existsSync(join(d, "log", "console.out")), `a FAILED run deleted ${d}: its logs are lost`);
    assert.ok(failed.out.includes(`KEPT  `) && failed.out.includes(d), `a kept dir's path was not printed: ${d}`);
  }
  assert.match(failed.out, /^LEFT 0$/m, "npids was not emptied");
  assert.strictEqual(failed.rc, 0, "every node was gone, yet end_nodes reported a stuck one");
  console.log("ok a FAILED run keeps every node's dirs (logs) and prints their paths; a node that ignores TERM is KILLed and proven gone");

  // THE CONTROL: a PASSING run removes the dirs, and says nothing is kept.
  const passed = await run(false);
  assert.deepStrictEqual(passed.alive, [], `a node outlived end_nodes: ${passed.out}`);
  for (const d of passed.dirs) assert.ok(!existsSync(d), `a PASSING run left ${d} behind`);
  assert.doesNotMatch(passed.out, /KEPT/, "a passing run said it kept something");
  console.log("ok CONTROL: a PASSING run removes every node's dirs");

  // A passing run whose node cannot be PROVEN gone (its ws port still listening) keeps that
  // node's dirs and reports it: "gone" is asserted, not assumed.
  const held = await run(false, { holdPort: true });
  assert.match(held.out, /FAIL {2}V's node \(pid \d+\) is still up/, "a node whose port still listens was called gone");
  assert.ok(existsSync(held.dirs[0]), "the dirs of a node not proven gone were deleted");
  assert.ok(!existsSync(held.dirs[1]), "a node proven gone kept its dirs on a passing run");
  assert.strictEqual(held.rc, 1, "end_nodes did not report the node it could not prove gone");
  console.log("ok a node not PROVEN gone (its port still listening) is reported and its dirs kept, even on a passing run");
  // A PID NO LONGER OURS: the recorded pid is now an unrelated process. It is NOT signalled
  // (still alive after), SKIP is said, and the node's dirs are kept (an early exit is a failure).
  const reused = await run(false, { reused: true });
  const [stranger] = reused.pids;
  assert.match(reused.out, new RegExp(`SKIP {2}V: pid ${stranger} is no longer this run's node \\(exited earlier\\); not signalled`), `the reused pid was not skipped: ${reused.out}`);
  assert.ok(reused.alive.includes(stranger), `end_nodes SIGNALLED a pid that was no longer its node (${stranger}): ${reused.out}`);
  assert.ok(existsSync(reused.dirs[0]), "the dirs of a node that exited early were deleted");
  assert.ok(!existsSync(reused.dirs[1]), "a node proven gone kept its dirs on a passing run");
  console.log("ok a recorded pid that is no longer this run's node is never signalled: SKIP, and its dirs kept");
  // A node that EXITED before cleanup, on a run that otherwise passed: its dirs are kept (an
  // early exit is worth its logs) and it is named; the other node's dirs go as usual.
  const exited = await run(false, { exited: true });
  assert.match(exited.out, /GONE {2}V's node \(pid \d+\) exited before cleanup; its dirs are kept/, `the early exit was not named: ${exited.out}`);
  assert.ok(existsSync(exited.dirs[0]), "the dirs of a node that exited early were deleted on a passing run");
  assert.ok(!existsSync(exited.dirs[1]), "a node proven gone kept its dirs on a passing run");
  console.log("ok a node that exited BEFORE cleanup is named GONE and its dirs kept, even on a passing run");
} finally {
  // Whatever a failed assertion left: THIS test's stand-in nodes, by the pids it recorded.
  for (const p of started) { try { process.kill(p, "SIGKILL"); } catch {} }
  rmSync(base, { recursive: true, force: true });
}
