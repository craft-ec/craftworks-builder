// THE LIVE-MEASUREMENT RUNNER (tools/live/): its rules, with no network. Each rule has a test that fails
// when the rule is removed (the mutants are in the PR).
//   * the header REFUSES on any field it cannot read, and on an SDK built at another revision than pinned;
//   * an arm's contaminated samples are re-run at most twice, inside the budget, then reported;
//   * a sample whose page ran another SDK than the header's is refused;
//   * the load gate waits with a budget and says so;
//   * an effect inside the repeat spread is "not resolvable";
//   * the event-log read dates each touch of a key, and says when it cannot;
//   * end to end (a stub `freenet`, a stub scenario): header.json, samples.jsonl, summary.txt, nodes ended
//     through realnet-nodes.sh -- and a TERM mid-run keeps the samples already written.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownTmp } from "./page-host.mjs";
import { Refused, header, loadGate, resolvable, runArm, sdkRan, summarize } from "../tools/live/runner.mjs";
import { keyBytes, touches, touchedIn } from "../tools/live/eventlog.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/live/", import.meta.url));
const runner = fileURLToPath(new URL("../tools/live/run.mjs", import.meta.url));
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};
const base = ownTmp("live-runner-");

// ---- the header -----------------------------------------------------------------------------------
const { readers } = await import(join(fixtures, "readers.mjs"));
await t("**the header REFUSES on every field it cannot read, naming it** (one field at a time)", () => {
  for (const field of Object.keys(readers)) {
    const broken = { ...readers, [field]: () => { throw new Error("gone"); } };
    assert.throws(() => header(broken), e => e instanceof Refused && e.message.includes(`header's ${field} could not be read`), `${field}: an unreadable field did not refuse the run`);
    const empty = { ...readers, [field]: () => "" };
    assert.throws(() => header(empty), e => e instanceof Refused && e.message.includes(`header's ${field} is empty`), `${field}: an empty field did not refuse the run`);
  }
  const h = header(readers);
  assert.equal(h.sdk_rev, "5".repeat(40));
});

await t("**the SDK is the one BUILT (sdk/REV), and a build at another revision than pinned REFUSES**", async () => {
  const { defaultReaders } = await import("../tools/live/runner.mjs");
  const root = join(base, "fake-root");
  mkdirSync(join(root, "sdk"), { recursive: true });
  writeFileSync(join(root, "SDK_REV"), "1111\n");
  writeFileSync(join(root, "sdk", "REV"), "2222\n");
  assert.throws(() => defaultReaders(root).sdk_rev(), /the SDK built is 2222, not the pinned 1111/);
  writeFileSync(join(root, "sdk", "REV"), "1111\n");
  assert.equal(defaultReaders(root).sdk_rev(), "1111", "CONTROL: a matching build is read back");
});

// ---- what the page ran ------------------------------------------------------------------------------
await t("**a sample whose page ran ANOTHER SDK than the header's is refused and named**", () => {
  const h = { sdk_wasm_sha256: "a".repeat(64) };
  assert.equal(sdkRan({ header: h, served: "a".repeat(64), stamps: { sdk: 1200 } }).ok, true, "CONTROL: the header's SDK is accepted");
  const other = sdkRan({ header: h, served: "e".repeat(64), stamps: { sdk: 1200 } });
  assert.equal(other.ok, false, "a page that ran another SDK was kept");
  assert.match(other.why, /the page ran SDK wasm eeeeeeeeeeeeeeee, not the header's aaaaaaaaaaaaaaaa/);
  assert.equal(sdkRan({ header: h, served: "a".repeat(64), stamps: {} }).ok, false, "a page that never loaded the SDK was kept");
  assert.equal(sdkRan({ header: h, served: null, stamps: { sdk: 1 } }).ok, false, "a node that served no artefacts.json was kept");
});

// ---- contamination ----------------------------------------------------------------------------------
await t("**a CONTAMINATED arm is re-run at most TWICE, then reported `contaminated: not resolvable`**", async () => {
  let calls = 0;
  const r = await runArm({ name: "busy", repeats: 3, sample: async () => { calls += 1; return { v: 1 }; }, loadAt: () => ({ load1: 30, cores: 14 }) });
  assert.equal(r.contaminated, true);
  assert.equal(r.attempts, 3, `${r.attempts} attempts, not 1 + 2 re-runs`);
  assert.equal(calls, 9, "the arm ran more or fewer samples than 3 attempts x 3");
  assert.match(r.verdict, /contaminated: not resolvable \(3 of 3 samples at load >= cores after 3 attempt\(s\)\)/);
  // It re-runs only while the budget allows: none left, one attempt.
  const out = await runArm({ name: "busy", repeats: 2, sample: async () => ({ v: 1 }), loadAt: () => ({ load1: 30, cores: 14 }), budgetLeftMs: () => 0 });
  assert.equal(out.attempts, 1, "a contaminated arm was re-run with no budget left");
  // CONTROL: a clean arm runs once.
  const clean = await runArm({ name: "quiet", repeats: 2, sample: async () => ({ v: 1 }), loadAt: () => ({ load1: 3, cores: 14 }) });
  assert.deepEqual([clean.contaminated, clean.attempts], [false, 1]);
  // And a sample's load is RECORDED on it, so a reader can apply a stricter cut.
  assert.equal(clean.samples[0].load1, 3);
});

// ---- the load gate ----------------------------------------------------------------------------------
await t("**the load gate waits for the box with a BUDGET and says how long and at what load**", async () => {
  let clock = 0;
  const busy = await loadGate({ waitS: 60, pollS: 0, read: () => ({ load1: 40, cores: 14 }), now: () => (clock += 20_000) });
  assert.equal(busy.ok, false, "a box busy for the whole wait was run on");
  assert.ok(busy.waited_s >= 60 && busy.load1 === 40, JSON.stringify(busy));
  let reads = 0;
  const later = await loadGate({ waitS: 600, pollS: 0, read: () => ({ load1: ++reads < 3 ? 40 : 6, cores: 14 }) });
  assert.deepEqual([later.ok, later.load1], [true, 6], "the gate did not start once the load fell");
});

// ---- resolvability ------------------------------------------------------------------------------------
await t("an effect INSIDE the repeat spread is `not resolvable with this instrument`; a larger one is", () => {
  const a = summarize([100, 140, 120]), b = summarize([130, 150, 160]);
  const r = resolvable(a, b);
  assert.equal(r.resolvable, false);
  assert.match(r.why, /not resolvable with this instrument: the effect \(30\) is within the repeat spread \(40\)/);
  assert.equal(resolvable(summarize([100, 110, 105]), summarize([300, 310, 305])).resolvable, true, "CONTROL: a large effect is resolvable");
  assert.equal(resolvable(summarize([100]), summarize([300])).resolvable, false, "one sample per arm has no spread to judge by");
  assert.equal(summarize([400, 420], { grid: 425 }).flat, true, "a spread inside one poll step is flagged");
});

// ---- the event-log read -----------------------------------------------------------------------------
await t("the event-log read dates every touch of a key by the timestamp BEFORE it, and says when it cannot", () => {
  const addr = "BZLfj9fQLkaJfejM3jjBLDUdWM4enL1gSo35Wbp6f8Bs";
  const key = keyBytes(addr);
  assert.equal(key.length, 32);
  const d = join(base, "evlog", "data");
  mkdirSync(d, { recursive: true });
  const rec = (stamp, withKey) => Buffer.concat([Buffer.from(`\x00\x1b${stamp} \x00`, "latin1"), withKey ? key : Buffer.alloc(32, 7), Buffer.alloc(9, 1)]);
  writeFileSync(join(d, "_EVENT_LOG.0000000000"), Buffer.concat([
    rec("2026-09-24T15:03:04.822739Z", true), rec("2026-09-24T15:03:05.000000Z", false), rec("2026-09-24T15:03:11.490624Z", true)]));
  const r = touches(d, addr);
  assert.equal(r.readable, true);
  assert.deepEqual(r.at, [Date.parse("2026-09-24T15:03:04.822739Z"), Date.parse("2026-09-24T15:03:11.490624Z")]);
  assert.equal(touchedIn(d, addr, Date.parse("2026-09-24T15:03:10Z"), Date.parse("2026-09-24T15:03:13Z")).n, 1, "the window count is wrong");
  assert.equal(touchedIn(d, addr, Date.parse("2026-09-24T15:03:06Z"), Date.parse("2026-09-24T15:03:10Z")).n, 0, "a touch outside the window was counted");
  // Unreadable: no event log; a key with no timestamp before it.
  assert.equal(touches(join(base, "evlog", "none"), addr).readable, false);
  const u = join(base, "evlog2", "data");
  mkdirSync(u, { recursive: true });
  writeFileSync(join(u, "_EVENT_LOG.0000000000"), Buffer.concat([key, rec("2026-09-24T15:03:04.822739Z", false)]));
  assert.equal(touches(u, addr).readable, false, "a touch with no timestamp before it was read as dated");
});

// ---- end to end ---------------------------------------------------------------------------------------
const runEnv = extra => ({ ...process.env, TMPDIR: base, LIVE_READERS: join(fixtures, "readers.mjs"), LIVE_SCENARIO_DIR: fixtures, LIVE_FREENET: join(fixtures, "freenet-stub.sh"), LIVE_POLL_S: "0", ...extra });
const resultDirs = () => { const d = join(base, "live-results"); return existsSync(d) ? readdirSync(d).map(n => join(d, n)) : []; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

await t("**end to end: header.json, samples.jsonl and summary.txt written; the node ended through realnet-nodes.sh and its dirs removed on a pass**", () => {
  const before = new Set(resultDirs());
  const r = spawnSync(process.execPath, [runner, "stub", "--wait-min", "0"], { encoding: "utf8", env: runEnv({ LIVE_STUB_N: "3" }), timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = resultDirs().find(d => !before.has(d));
  assert.ok(dir, "no result dir");
  assert.equal(JSON.parse(readFileSync(join(dir, "header.json"), "utf8")).sdk_rev, "5".repeat(40));
  assert.equal(readFileSync(join(dir, "samples.jsonl"), "utf8").trim().split("\n").length, 3, "not every sample was written");
  const summary = readFileSync(join(dir, "summary.txt"), "utf8");
  assert.match(summary, /PASS {2}S1's node \(pid \d+\) is gone/, "the node was not ended through realnet-nodes.sh");
  assert.match(summary, /PASSED after 3 sample\(s\)/);
  const [, ndir, pid] = r.stdout.match(/NODE-DIR (\S+) PID (\d+)/);
  assert.ok(!alive(Number(pid)), "the stub node outlived the run");
  assert.ok(!existsSync(ndir), "a passing run kept the node's dirs");
});

await t("**an unreadable header field REFUSES the run before anything starts (exit 2)**", () => {
  const before = new Set(resultDirs());
  const r = spawnSync(process.execPath, [runner, "stub", "--wait-min", "0"], { encoding: "utf8", env: runEnv({ LIVE_UNREADABLE: "sdk_wasm_sha256" }), timeout: 60_000 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /REFUSED {2}the header's sdk_wasm_sha256 could not be read/);
  assert.doesNotMatch(r.stdout, /NODE-DIR/, "a node was started after the header refused");
  for (const d of resultDirs().filter(d => !before.has(d))) assert.ok(!existsSync(join(d, "samples.jsonl")), "samples were taken after the header refused");
});

await t("**a box busy for the whole wait is NOT RUN (exit 3), and says how long it waited and at what load**", () => {
  const r = spawnSync(process.execPath, [runner, "stub", "--wait-min", "0"], { encoding: "utf8", env: runEnv({ LIVE_LOAD: "40" }), timeout: 60_000 });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /NOT RUN {2}box busy: 1-min load 40 on 14 cores after waiting \d+ s/);
  assert.doesNotMatch(r.stdout, /NODE-DIR/, "a node was started on a busy box");
});

await t("**TERM mid-run: the samples already written stay, the summary says INTERRUPTED after N, the node is ended and its dirs KEPT**", async () => {
  const before = new Set(resultDirs());
  const p = spawn(process.execPath, [runner, "stub", "--wait-min", "0"], { env: runEnv({ LIVE_STUB_N: "50", LIVE_STUB_MS: "200" }) });
  let out = "";
  p.stdout.on("data", d => (out += d));
  const exited = new Promise(res => p.on("exit", code => res(code)));
  const deadline = Date.now() + 30_000;
  let dir;
  for (;;) {
    dir = resultDirs().find(d => !before.has(d));
    if (dir && existsSync(join(dir, "samples.jsonl")) && readFileSync(join(dir, "samples.jsonl"), "utf8").split("\n").filter(Boolean).length >= 2) break;
    assert.ok(Date.now() < deadline, "no samples were written");
    await new Promise(r => setTimeout(r, 50));
  }
  p.kill("SIGTERM");
  assert.equal(await exited, 143, out);
  const kept = readFileSync(join(dir, "samples.jsonl"), "utf8").split("\n").filter(Boolean).length;
  assert.ok(kept >= 2, `the samples already written were lost (${kept})`);
  const summary = readFileSync(join(dir, "summary.txt"), "utf8");
  assert.match(summary, new RegExp(`INTERRUPTED \\(SIGTERM\\) after ${kept} sample\\(s\\)`), summary);
  const [, ndir, pid] = out.match(/NODE-DIR (\S+) PID (\d+)/);
  assert.ok(!alive(Number(pid)), "the stub node outlived the interrupted run");
  assert.ok(existsSync(ndir), "an interrupted run deleted its node's dirs (its logs)");
});

rmSync(base, { recursive: true, force: true });
process.stdout.write(failures ? `\n${failures} failing\n` : "\nall ok\n");
process.exit(failures ? 1 : 0);
