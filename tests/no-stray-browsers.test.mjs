// NO STRAY CHILDREN (the realnet orphans, 2026-09-24: a killed or crashed run's
// headless Chrome stayed connected to the owner's node for 13 h, and one
// reconnected to V and provisioned its signer before step 9; builder#180: ~80
// page servers left, one per SIGKILLed page-host, and a 10-hour Chrome from
// this very file). Driven with REAL Chromes and servers, and a stub node:
//
//   THE ONE CHECK. A recorded PID is signalled only while its command line
//   carries its mark as a whole argument, re-checked before EACH signal
//   (page-host MARKED; the sweep carries the same text, pinned here).
//   THE SWEEP. It kills what a run recorded, leaves a reused PID alone (before
//   the TERM and again before the KILL), and never signals an old-format line.
//   TWO DEFENDERS of "no child outlives its page-host", each shown on its own:
//     * `done` alone: at the instant a page-host EXITS (a signal it sees, its
//       budget, a budget that expires while it waits for its node), its
//       children are ALREADY gone -- before a watchdog could have acted (a
//       watchdog only starts once the host is gone, and polls each second);
//     * the watchdog alone: a page-host SIGKILLed (so `done` never runs)
//       leaves no child either -- its server, its browsers, its node.
//   THE LAUNCHER. A child whose record cannot be written never starts; a
//   browser that never announces is stopped by openFreshBrowser itself.
//   THIS FILE. Every page-host run it starts goes through `withHost`, which
//   stops it in its own `finally` -- a test cannot leave one, even one that
//   never came up.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ownTmp, MARKED } from "./page-host.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await sleep(100); } return f(); };
const freePort = () => new Promise(ok => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.stack}\n`); }
};
// ITS OWN directory, the TMPDIR its page-host runs are given: the system
// default is refused, and this test must pass from any shell.
const dir = ownTmp("no-stray-");
// A STUB `freenet` first on PATH for the page-host runs: it never opens its ws port (never "ready") and keeps its
// arguments on its command line, so its mark (its data dir) is there to match.
const bin = join(dir, "bin");
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "freenet"), "#!/bin/sh\nwhile :; do sleep 1; done\n");
chmodSync(join(bin, "freenet"), 0o755);

const sh = (script, ...args) => spawnSync("/bin/sh", ["-c", `${MARKED} ${script}`, "check", ...args.map(String)]).status === 0;
const marked = (pid, mark) => sh('marked "$1" "$2"', pid, mark);
// The CHROMES (not their launcher's or watchdog's shell, whose command line carries the same --user-data-dir) with a
// profile under `root`: the main process only, as a command line that STARTS with the Chrome binary.
const chromesUnder = root => spawnSync("ps", ["-ww", "-axo", "pid=,command="], { encoding: "utf8" }).stdout.split("\n")
  .map(l => l.trim()).filter(l => l.slice(l.indexOf(" ") + 1).startsWith(CHROME) && l.includes(`--user-data-dir=${root}/`) && !l.includes("--type="));
const linesIn = pids => (existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(l => l.split("\t")) : []);

// ONE page-host run: a child process running `body` (page-host imported as `m`), with its own pidfile. `fn(run)` drives
// it; whatever `fn` does or throws, the run is STOPPED here in a `finally` (the child, then every child it recorded,
// each signalled only while it carries its mark) and verified gone. Resolves to what `fn` returned; rejects with its
// error AFTER the stop.
async function withHost(name, body, fn, env = {}) {
  const pids = join(dir, `${name}.pids`);
  writeFileSync(pids, "");
  const script = `const m = await import("${join(ROOT, "tests/page-host.mjs")}");\n${body}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, PAGE_HOST_PIDFILE: pids, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, pids, out: "", lines: () => linesIn(pids), recorded: kind => linesIn(pids).filter(([, k]) => !kind || k === kind).map(([p]) => Number(p)) };
  run.exited = new Promise(ok => child.once("exit", () => ok(Date.now())));
  child.stdout.on("data", d => { run.out += d; });
  child.stderr.on("data", d => { run.out += d; });
  try {
    return await fn(run);
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    const mine = linesIn(pids).filter(([p, , mark]) => mark && marked(p, mark));
    for (const [p, , mark] of mine) sh('killmarked "$1" "$2" KILL', p, mark);
    const gone = await until(() => (child.exitCode !== null || child.signalCode !== null) && mine.every(([p]) => !alive(Number(p))), 10_000);
    if (!gone) throw new Error(`${name}: withHost could not stop its run: ${[child.pid, ...mine.map(([p]) => p)].join(" ")}`);
  }
}
const ready = (run, ms = 60_000) => until(() => run.out.includes("READY"), ms);

await t("**one check: a mark matches a WHOLE argument only; killmarked signals only then; the sweep carries the same text**", async () => {
  const sleeper = spawn("/bin/sleep", ["37"], { stdio: "ignore" });
  try {
    assert.ok(await until(() => marked(sleeper.pid, "37")), "the whole argument did not match");
    assert.ok(!marked(sleeper.pid, "3"), "a PREFIX of an argument matched: a shorter mark would reach another run's child");
    assert.ok(!marked(sleeper.pid, "7"), "a SUFFIX of an argument matched");
    sh('killmarked "$1" "$2" KILL', sleeper.pid, "3");
    await sleep(300);
    assert.ok(alive(sleeper.pid), "killmarked signalled a PID that does not carry the mark");
    sh('killmarked "$1" "$2" KILL', sleeper.pid, "37");
    assert.ok(await until(() => sleeper.exitCode !== null || sleeper.signalCode !== null), "killmarked did not signal a PID that carries the mark");
    const sweep = readFileSync(join(ROOT, "tools/browser-sweep.sh"), "utf8").split("\n").find(l => l.startsWith("marked() {"));
    assert.equal(sweep, MARKED, "the sweep's check is not page-host's: two copies drift");
  } finally {
    sleeper.kill("SIGKILL");
  }
});

await t("**the sweep kills what a run recorded, verified gone; leaves a reused PID (before the TERM and again before the KILL); never signals an old-format line**", async () => {
  const profile = mkdtempSync(join(dir, "cw-fresh-"));
  // ORPHANED, as a killed run's children are: started through a shell that exits, so launchd adopts them.
  const orphan = cmd => Number(spawnSync("bash", ["-c", `${cmd} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" }).stdout.trim());
  const chrome = orphan(`"${CHROME}" --headless=new --disable-gpu --remote-debugging-port=0 --user-data-dir="${profile}" about:blank`);
  // A reused PID: recorded under a mark its command line does not carry.
  const other = orphan("sleep 60");
  // An OLD two-field line naming a live process whose command line carries the profile path -- but not as its
  // --user-data-dir (a `tail -f <profile>/...` on a reused PID): it must not be signalled.
  const legacy = orphan(`sh -c 'sleep 60' tailing "${profile}"`);
  // Reused MID-SWEEP: carries its mark at the TERM, then (TERM trapped) becomes something else: the KILL is not sent.
  const turncoat = orphan(`sh -c 'trap "exec sleep 60" TERM; while :; do sleep 0.2; done' turncoat --user-data-dir=${profile}-turncoat`);
  const pids = join(dir, "browsers.pids");
  writeFileSync(pids, [
    `${chrome}\tbrowser\t--user-data-dir=${profile}`,
    `${other}\tbrowser\t--user-data-dir=${join(dir, "cw-fresh-gone")}`,
    `${legacy}\t${profile}`,
    `${turncoat}\tbrowser\t--user-data-dir=${profile}-turncoat`,
  ].join("\n") + "\n");
  try {
    assert.ok(await until(() => [chrome, other, legacy, turncoat].every(alive)), "THE SETUP: not all started");
    const r = spawnSync("bash", ["-c", `. "${ROOT}/tools/browser-sweep.sh"; sweep "${pids}"`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`SWEPT browser pid ${chrome} `));
    assert.ok(!alive(chrome), "the recorded browser is still running");
    assert.ok(alive(other), "a PID the record no longer names was killed");
    assert.match(r.stdout, new RegExp(`LEFT  old-format line \\(pid ${legacy},`));
    assert.ok(alive(legacy), "an old-format line was signalled: its bare path matched another process's argument");
    assert.match(r.stdout, new RegExp(`LEFT  pid ${turncoat} no longer carries its mark`));
    assert.ok(alive(turncoat), "the KILL went to a PID that stopped carrying its mark after the TERM");
    assert.ok(!existsSync(pids), "the swept file was left behind");
  } finally {
    for (const p of [chrome, other, legacy, turncoat]) { try { process.kill(p, "SIGKILL"); } catch {} }
  }
});

await t("**page-host refuses a live browser under the system's default TMPDIR, naming it**", async () => {
  const script = `import("${join(ROOT, "tests/page-host.mjs")}").then(m => m.openFreshBrowser("probe")).then(() => console.log("STARTED"), e => console.log("REFUSED " + e.message));`;
  for (const TMPDIR of ["/var/folders/xx/yy/T/", "/tmp", ""]) {
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, TMPDIR, PAGE_HOST_PIDFILE: "" } });
    assert.match(r.stdout, /REFUSED .*TMPDIR is/, `TMPDIR=${JSON.stringify(TMPDIR)}: ${r.stdout}${r.stderr}`);
  }
});

await t("**`done` ALONE: a signal to a page-host -- its children (server, browser, openFreshBrowser's) are gone the instant it exits, before any watchdog could act**", async () => {
  await withHost("signal", `
    await m.openPageHost("stray-test");
    await m.openFreshBrowser("stray-test fresh");
    console.log("READY");
    await new Promise(() => {});`, async run => {
    assert.ok(await ready(run), `the run did not start: ${run.out}`);
    const kids = run.recorded();
    assert.deepEqual(run.lines().map(([, k]) => k), ["server", "browser", "browser"], "the server and both browsers are recorded");
    assert.ok(kids.every(alive), "THE SETUP: the children are running");
    run.child.kill("SIGTERM");
    await run.exited;
    const left = kids.filter(alive);
    assert.deepEqual(left, [], `alive when the page-host exited (done did not stop them): ${left}`);
  });
});

await t("**`done` ALONE: a page-host whose run never finishes ends by its OWN budget, its children gone the instant it exits**", async () => {
  await withHost("budget", `
    await m.openPageHost("budget-test", { budgetMs: 15000 });
    console.log("READY");
    await new Promise(() => {});`, async run => {
    assert.ok(await ready(run), `the run did not start: ${run.out}`);
    const kids = run.recorded();
    assert.ok(kids.length === 2 && kids.every(alive), `THE SETUP: the server and browser are running: ${kids}`);
    // Its 15 s budget from its start, then `done` stopping the children (seconds each at load): 45 s is ample.
    const exited = await Promise.race([run.exited, sleep(45_000).then(() => null)]);
    assert.ok(exited, "the page-host outlived its budget");
    assert.deepEqual(kids.filter(alive), [], "alive when the page-host exited by its budget");
  });
});

await t("**`done` ALONE: a budget that expires while the page-host WAITS FOR ITS NODE stops the node too**", async () => {
  const ports = { ws: await freePort(), net: await freePort() };
  await withHost("node-budget", `
    await m.openPageHost("node-budget", { budgetMs: 5000, node: ${JSON.stringify(ports)} });
    console.log("READY");`, async run => {
    assert.ok(await until(() => run.recorded("node").length === 1, 30_000), `the node was never started: ${run.out}`);
    const kids = run.recorded();
    assert.ok(kids.every(alive), "THE SETUP: the children are running");
    const exited = await Promise.race([run.exited, sleep(30_000).then(() => null)]);
    assert.ok(exited, "the page-host outlived its budget");
    assert.ok(!run.out.includes("READY") && /exceeded its 5 s budget/.test(run.out), `THE SETUP: the run did not end by its budget while waiting for the node: ${run.out.slice(-600)}`);
    assert.deepEqual(kids.filter(alive), [], `alive when the page-host exited by its budget (the node was not in done's list?): ${kids.filter(alive)}`);
  });
});

await t("**the WATCHDOG ALONE: a page-host SIGKILLed (done never runs) leaves no child -- its server, its browsers, its node -- within seconds**", async () => {
  const ports = { ws: await freePort(), net: await freePort() };
  await withHost("killed", `
    await m.openPageHost("killed-test");
    await m.openFreshBrowser("killed-test fresh");
    console.log("READY");
    await m.spawnNode("killed-test node", { ...${JSON.stringify(ports)}, readyMs: 120000 });`, async run => {
    assert.ok(await ready(run), `the run did not start: ${run.out}`);
    assert.ok(await until(() => run.recorded("node").length === 1, 30_000), "THE SETUP: the node was never started");
    const kids = run.recorded();
    assert.deepEqual(run.lines().map(([, k]) => k), ["server", "browser", "browser", "node"]);
    assert.ok(kids.every(alive), "THE SETUP: the children are running");
    run.child.kill("SIGKILL");
    const gone = await until(() => kids.every(p => !alive(p)), 12_000);
    assert.ok(gone, `a child outlived its SIGKILLed page-host: ${run.lines().filter(([p]) => alive(Number(p))).map(l => l.join(" ")).join("; ")}`);
  });
});

await t("**the launcher: a child whose record cannot be written NEVER STARTS, and openFreshBrowser rejects naming why**", async () => {
  // PAGE_HOST_PIDFILE is a DIRECTORY: the launcher cannot append to it.
  const pidsDir = join(dir, "not-a-file");
  mkdirSync(pidsDir, { recursive: true });
  // Its OWN TMPDIR, so a profile under it can only be this test's (earlier tests' browsers may still be exiting).
  const own = join(dir, "unrecorded");
  mkdirSync(own, { recursive: true });
  const script = `import("${join(ROOT, "tests/page-host.mjs")}").then(m => m.openFreshBrowser("unrecorded")).then(() => console.log("STARTED"), e => console.log("REJECTED " + e.message));`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, TMPDIR: own, PAGE_HOST_PIDFILE: pidsDir }, timeout: 60_000 });
  assert.match(r.stdout, /REJECTED [\s\S]*could not record browser/, r.stdout + r.stderr);
  assert.deepEqual(chromesUnder(own), [], "a browser started without its record");
});

await t("**openFreshBrowser stops a browser that never announced (its caller gets no handle to stop it)**", async () => {
  // Whether Chrome announces within a deadline is the machine's speed, so no ONE deadline makes a stable setup: each
  // deadline here runs under its own TMPDIR, and EVERY rejection must leave no browser with a profile under it. At
  // least one must have been RECORDED before it rejected, or nothing here was measured.
  let measured = 0;
  const cases = [];
  for (const readyMs of [1, 40, 150, 600]) {
    const own = join(dir, `no-announce-${readyMs}`);
    mkdirSync(own, { recursive: true });
    const said = await withHost(`no-announce-${readyMs}`, `
      await m.openFreshBrowser("no-announce", { readyMs: ${readyMs} }).then(() => console.log("STARTED"), e => console.log("REJECTED " + e.message));
      console.log("SETTLED");
      await new Promise(() => {});`, async run => {
      assert.ok(await until(() => run.out.includes("SETTLED"), 60_000), `openFreshBrowser never settled: ${run.out}`);
      const rejected = run.out.includes("REJECTED");
      const recorded = run.recorded("browser").length;
      const running = chromesUnder(own);
      if (rejected) assert.deepEqual(running, [], `readyMs ${readyMs}: a browser that never announced is still running, the page-host alive`);
      return { readyMs, rejected, recorded };
    }, { TMPDIR: own });
    cases.push(said);
    if (said.rejected && said.recorded > 0) measured += 1;
  }
  assert.ok(measured > 0, `THE SETUP: no deadline both started a browser and rejected before it announced: ${JSON.stringify(cases)}`);
});

await t("**withHost STOPS a run that never came up (the 10-hour Chrome): the test's failure does not leave its page-host**", async () => {
  let run;
  await assert.rejects(withHost("never-ready", `
    await m.openPageHost("never-ready", { budgetMs: 120000 });
    await m.openFreshBrowser("never-ready fresh");
    await new Promise(() => {});`, async r => {
    run = r;
    assert.ok(await until(() => r.recorded().length === 3, 60_000), `THE SETUP: the children never started: ${r.recorded()}`);
    // The test gives up waiting, as test 3 did under load on 2026-09-26.
    assert.ok(await ready(r, 1_000), "the run did not say READY");
  }), /the run did not say READY/);
  const left = [run.child.pid, ...run.recorded()].filter(alive);
  assert.deepEqual(left, [], `left behind by a failed test: ${left}`);
});

rmSync(dir, { recursive: true, force: true });
if (failures) { process.stdout.write(`${failures} failed\n`); process.exit(1); }
