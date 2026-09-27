// NO STRAY BROWSERS OR SERVERS (the realnet orphans, 2026-09-24: a killed or
// crashed run's headless Chrome stayed connected to the owner's node for 13 h,
// and one reconnected to V and provisioned its signer before step 9;
// builder#180: ~80 page servers left, one per SIGKILLed page-host, and a
// 10-hour Chrome from this very file). Each guard driven with a REAL Chrome:
//   1. the sweep (tools/browser-sweep.sh) kills a child a run recorded, and
//      NOT a PID the recording no longer names (a reused PID);
//   2. page-host REFUSES a live browser under the system's default TMPDIR;
//   3. a signal to a page-host process kills every child it started: its
//      server, its browser and `openFreshBrowser`'s;
//   4. a page-host process SIGKILLed (nothing of it can run) leaves no child
//      either -- its SERVER too: each child's watchdog ends it;
//   5. a page-host whose run never finishes ends by its own budget, children
//      and all;
//   6. this file stops every page-host it starts, in a `finally`, even when
//      that run never came up (the 10-hour Chrome: a failed setup was left).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ownTmp } from "./page-host.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await sleep(100); } return f(); };
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.stack}\n`); }
};
// ITS OWN directory, the TMPDIR its page-host runs are given: the system
// default is refused, and this test must pass from any shell.
const dir = ownTmp("no-stray-");

// ONE page-host run of this file: a child process running `body` (after `m` = page-host is imported), with its own
// pidfile. Every test that starts one STOPS it in a `finally` (`stop`): the child and every child it recorded, by PID,
// verified gone -- so a test that fails half-way leaves nothing (builder#180).
const recordedIn = pids => (existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(l => Number(l.split("\t")[0])) : []);
function hostRun(name, body) {
  const pids = join(dir, `${name}.pids`);
  writeFileSync(pids, "");
  const script = `const m = await import("${join(ROOT, "tests/page-host.mjs")}");\n${body}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TMPDIR: dir, PAGE_HOST_PIDFILE: pids }, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, pids, out: "", recorded: () => recordedIn(pids) };
  child.stdout.on("data", d => { run.out += d; });
  run.stop = async () => {
    const all = [child.pid, ...run.recorded()];
    for (const p of all) { try { process.kill(p, "SIGKILL"); } catch {} }
    return until(() => all.every(p => !alive(p)), 10_000);
  };
  return run;
}

await t("**the sweep kills a browser a run recorded, verified gone — and leaves a PID the record no longer names**", async () => {
  const profile = mkdtempSync(join(dir, "cw-fresh-"));
  // ORPHANED, as a killed run's browser is: started through a shell that exits, so launchd adopts it (and reaps it).
  const orphan = cmd => Number(spawnSync("bash", ["-c", `${cmd} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" }).stdout.trim());
  const chrome = { pid: orphan(`"${CHROME}" --headless=new --disable-gpu --remote-debugging-port=0 --user-data-dir="${profile}" about:blank`) };
  // THE CONTROL: a live process recorded under a profile it does not have (a reused PID).
  const other = { pid: orphan("sleep 30") };
  const pids = join(dir, "browsers.pids");
  writeFileSync(pids, `${chrome.pid}\t--user-data-dir=${profile}\n${other.pid}\t--user-data-dir=${join(dir, "cw-fresh-gone")}\n`);
  assert.ok(await until(() => alive(chrome.pid)), "THE SETUP: chrome did not start");
  const r = spawnSync("bash", ["-c", `. "${ROOT}/tools/browser-sweep.sh"; sweep "${pids}"`], { encoding: "utf8" });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`SWEPT pid ${chrome.pid}`));
    assert.ok(!alive(chrome.pid), "the recorded browser is still running");
    assert.ok(alive(other.pid), "a PID the record no longer names was killed");
    assert.ok(!existsSync(pids), "the swept file was left behind");
  } finally {
    try { process.kill(chrome.pid, "SIGKILL"); } catch {}
    try { process.kill(other.pid, "SIGKILL"); } catch {}
  }
});

await t("**page-host refuses a live browser under the system's default TMPDIR, naming it**", async () => {
  const script = `import("${join(ROOT, "tests/page-host.mjs")}").then(m => m.openFreshBrowser("probe")).then(() => console.log("STARTED"), e => console.log("REFUSED " + e.message));`;
  for (const TMPDIR of ["/var/folders/xx/yy/T/", "/tmp", ""]) {
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env: { ...process.env, TMPDIR, PAGE_HOST_PIDFILE: "" } });
    assert.match(r.stdout, /REFUSED .*TMPDIR is/, `TMPDIR=${JSON.stringify(TMPDIR)}: ${r.stdout}${r.stderr}`);
  }
});

await t("**a signal to a page-host run kills every child it started -- its server, its browser and openFreshBrowser's**", async () => {
  const run = hostRun("signal", `
    await m.openPageHost("stray-test");
    const b = await m.openFreshBrowser("stray-test fresh");
    console.log("READY " + b.pid);
    await new Promise(() => {});`);
  try {
    assert.ok(await until(() => /READY \d+/.test(run.out), 60_000), `the run did not start: ${run.out}`);
    const recorded = run.recorded();
    assert.equal(recorded.length, 3, `the server and both browsers are recorded for the sweep: ${recorded}`);
    assert.ok(recorded.every(alive), "THE SETUP: the children are running");
    run.child.kill("SIGTERM");
    assert.ok(await until(() => recorded.every(p => !alive(p)), 20_000), `a child outlived the signal: ${recorded.filter(alive)}`);
  } finally {
    await run.stop();
  }
});

await t("**a page-host run SIGKILLed (nothing of it runs) still leaves no child -- its SERVER too: each one's watchdog ends it within seconds, no next run needed**", async () => {
  const run = hostRun("killed", `
    await m.openPageHost("killed-test");
    await m.openFreshBrowser("killed-test fresh");
    console.log("READY");
    await new Promise(() => {});`);
  try {
    assert.ok(await until(() => run.out.includes("READY"), 60_000), `the run did not start: ${run.out}`);
    const recorded = run.recorded();
    assert.equal(recorded.length, 3, `the server and both browsers are recorded: ${recorded}`);
    assert.ok(recorded.every(alive), "THE SETUP: the children are running");
    run.child.kill("SIGKILL");
    const gone = await until(() => recorded.every(p => !alive(p)), 12_000);
    assert.ok(gone, `a child outlived its SIGKILLed page-host (the server is ${recorded[0]}): ${recorded.filter(alive)}`);
  } finally {
    await run.stop();
  }
});

await t("**a page-host whose run never finishes ends by its OWN budget, and every child with it**", async () => {
  const run = hostRun("budget", `
    await m.openPageHost("budget-test", { budgetMs: 4000 });
    console.log("READY");
    await new Promise(() => {});`);
  try {
    assert.ok(await until(() => run.out.includes("READY"), 60_000), `the run did not start: ${run.out}`);
    const recorded = run.recorded();
    assert.ok(recorded.length >= 2 && recorded.every(alive), `THE SETUP: the server and browser are running: ${recorded}`);
    // Nobody signals it: its budget (4 s) must end it.
    assert.ok(await until(() => !alive(run.child.pid) && recorded.every(p => !alive(p)), 20_000), `the page-host outlived its budget, or left: ${[run.child.pid, ...recorded].filter(alive)}`);
  } finally {
    await run.stop();
  }
});

await t("**a run that never came up is STOPPED by this file, not left (the 10-hour Chrome): hostRun's stop ends the page-host and its children**", async () => {
  // A setup that never says READY: a page-host with a long budget and its children running, the test giving up.
  const run = hostRun("never-ready", `
    await m.openPageHost("never-ready", { budgetMs: 120000 });
    await m.openFreshBrowser("never-ready fresh");
    await new Promise(() => {});`);
  let recorded = [];
  try {
    assert.ok(await until(() => run.recorded().length === 3, 60_000), `THE SETUP: the children never started: ${run.recorded()}`);
    recorded = run.recorded();
    assert.ok(!(await until(() => run.out.includes("READY"), 1_000)), "THE SETUP: it said READY");
  } finally {
    assert.ok(await run.stop(), "stop() did not end the run");
  }
  assert.ok(!alive(run.child.pid) && recorded.every(p => !alive(p)), `left behind: ${[run.child.pid, ...recorded].filter(alive)}`);
});

rmSync(dir, { recursive: true, force: true });
if (failures) { process.stdout.write(`${failures} failed\n`); process.exit(1); }
