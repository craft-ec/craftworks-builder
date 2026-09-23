// NO STRAY BROWSERS (the realnet orphans, 2026-09-24): a killed or crashed
// run's headless Chrome stayed connected to the owner's node for 13 h, and one
// reconnected to V and provisioned its signer before step 9. Three guards,
// each driven here with a REAL Chrome:
//   1. the sweep (tools/browser-sweep.sh) kills a browser a run recorded, and
//      NOT a PID the recording no longer names (a reused PID);
//   2. page-host REFUSES a live browser under the system's default TMPDIR;
//   3. a signal to a page-host process kills every browser it started,
//      including `openFreshBrowser`'s (they were outside its kill list).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
const dir = mkdtempSync(join(tmpdir(), "no-stray-"));

await t("**the sweep kills a browser a run recorded, verified gone — and leaves a PID the record no longer names**", async () => {
  const profile = mkdtempSync(join(dir, "cw-fresh-"));
  // ORPHANED, as a killed run's browser is: started through a shell that exits, so launchd adopts it (and reaps it).
  const orphan = cmd => Number(spawnSync("bash", ["-c", `${cmd} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" }).stdout.trim());
  const chrome = { pid: orphan(`"${CHROME}" --headless=new --disable-gpu --remote-debugging-port=0 --user-data-dir="${profile}" about:blank`) };
  // THE CONTROL: a live process recorded under a profile it does not have (a reused PID).
  const other = { pid: orphan("sleep 30") };
  const pids = join(dir, "browsers.pids");
  writeFileSync(pids, `${chrome.pid}\t${profile}\n${other.pid}\t${join(dir, "cw-fresh-gone")}\n`);
  assert.ok(await until(() => alive(chrome.pid)), "THE SETUP: chrome did not start");
  const r = spawnSync("bash", ["-c", `. "${ROOT}/tools/browser-sweep.sh"; sweep "${pids}"`], { encoding: "utf8" });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`SWEPT browser pid ${chrome.pid}`));
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

await t("**a signal to a page-host run kills every browser it started — openFreshBrowser's too**", async () => {
  const pids = join(dir, "run.pids");
  writeFileSync(pids, "");
  const script = `
    const m = await import("${join(ROOT, "tests/page-host.mjs")}");
    const host = await m.openPageHost("stray-test");
    const b = await m.openFreshBrowser("stray-test fresh");
    console.log("READY " + b.pid);
    await new Promise(() => {});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TMPDIR: dir, PAGE_HOST_PIDFILE: pids }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  assert.ok(await until(() => /READY \d+/.test(out), 60_000), `the run did not start: ${out}`);
  const recorded = readFileSync(pids, "utf8").trim().split("\n").map(l => Number(l.split("\t")[0]));
  assert.equal(recorded.length, 2, `both browsers are recorded for the sweep: ${recorded}`);
  assert.ok(recorded.every(alive), "THE SETUP: the browsers are running");
  child.kill("SIGTERM");
  assert.ok(await until(() => recorded.every(p => !alive(p)), 20_000), `a browser outlived the signal: ${recorded.filter(alive)}`);
});

if (failures) { process.stdout.write(`${failures} failed\n`); process.exit(1); }
