// ONE STEP ALONE (the owner's rule 0: a real-network run tests ONLY the step that changed): tools/realnet-steps.mjs is
// the ONE table of the real-network steps, the setup each needs and the private nodes it uses. `--only X` runs X and
// its setup in the demo's order; realnet.sh starts only the nodes the plan names; the demo runs only the planned
// steps. Nothing here reaches the network: realnet.sh is refused (by its argument, or by a held lock) before it builds.
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownTmp } from "./page-host.mjs";
import { plan, STEPS } from "../tools/realnet-steps.mjs";

const t = async (name, fn) => { await fn(); console.log(`ok ${name}`); };
const demo = readFileSync(new URL("../tools/realnet-demo.mjs", import.meta.url), "utf8");
const sh = readFileSync(new URL("../tools/realnet.sh", import.meta.url), "utf8");
const tool = fileURLToPath(new URL("../tools/realnet.sh", import.meta.url));

await t("**--only X runs X and the setup it needs**, in the demo's order, and names only the nodes those use", () => {
  assert.deepStrictEqual(plan("lose-data"), { steps: ["publish", "lose-data"], nodes: ["V", "LOSE"], only: ["lose-data"] });
  assert.deepStrictEqual(plan("same-key").steps, ["same-key"], "the pair's step needs no publish on B");
  assert.deepStrictEqual(plan("same-key").nodes, ["O"]);
  assert.deepStrictEqual(plan("edits").steps, ["publish", "view", "owner-site", "edits"]);
  assert.deepStrictEqual(plan("edits").nodes, [], "a step on B and A alone starts no private node");
  assert.deepStrictEqual(plan(["structure", "publish"]).steps, ["publish", "view", "structure"], "not in the order asked: the demo's");
  assert.deepStrictEqual(plan("").steps, Object.keys(STEPS), "no --only: every step");
  assert.deepStrictEqual(plan("").nodes.sort(), ["LOSE", "O", "V"]);
  assert.throws(() => plan("lose-date"), /no such real-network step: lose-date \(the steps: publish, /);
});

await t("**the table is closed**: every step's `needs` names a step of it, and comes BEFORE it", () => {
  const order = Object.keys(STEPS);
  for (const [name, s] of Object.entries(STEPS)) {
    for (const d of s.needs) {
      assert.ok(order.includes(d), `${name} needs ${d}, which is no step`);
      assert.ok(order.indexOf(d) < order.indexOf(name), `${name} needs ${d}, which runs after it`);
    }
    for (const n of s.nodes) assert.ok(["V", "O", "LOSE"].includes(n), `${name} uses a node realnet.sh does not start: ${n}`);
  }
});

// ONE HOME: the demo's gates are exactly the table's steps (a step the table has and the demo never gates would run
// with EVERY --only; a gate the table lacks would never run), and realnet.sh starts each private node under the plan.
const gatesIn = text => [...text.matchAll(/runs\("([a-z-]+)"\)/g)].map(m => m[1]);
const checkDemo = text => {
  const gates = new Set(gatesIn(text));
  const missing = Object.keys(STEPS).filter(n => !gates.has(n));
  const extra = [...gates].filter(n => !Object.hasOwn(STEPS, n));
  return { missing, extra };
};
await t("**ONE HOME**: the demo gates every step of the table and no other; control: a planted gate and a dropped one are caught", () => {
  assert.deepStrictEqual(checkDemo(demo), { missing: [], extra: [] });
  assert.deepStrictEqual(checkDemo(`${demo}\nif (runs("bogus")) {}`).extra, ["bogus"], "CONTROL: a planted gate was not caught");
  assert.deepStrictEqual(checkDemo(demo.replaceAll('runs("lose-data")', "true")).missing, ["lose-data"], "CONTROL: a dropped gate was not caught");
  assert.match(demo, /plan\(process\.env\.REALNET_ONLY \?\? ""\)/, "the demo does not take its steps from the plan");
});

await t("**realnet.sh starts a private node only for a step that uses it**, and hands the demo the same --only", () => {
  for (const [line, node] of [[/^uses V && start_private V /m, "V"], [/^uses O && start_private O1 /m, "O1"], [/^uses O && start_private O2 /m, "O2"], [/^if uses LOSE; then\n {2}start_lose /m, "the ws-lose proxies"]]) {
    assert.match(sh, line, `${node} is started whatever the plan`);
  }
  assert.doesNotMatch(sh, /^start_private |^start_lose /m, "a private node is started outside the plan");
  assert.match(sh, /node tools\/realnet-steps\.mjs "\$ONLY"/, "realnet.sh does not ask the one table");
  assert.match(sh, /REALNET_ONLY="\$ONLY" RN_B=/, "the demo is not told the same --only");
});

await t("**an unknown step is REFUSED before anything starts** (no lock, no build, no tunnel)", () => {
  const dir = ownTmp("realnet-steps-");
  try {
    for (const args of [["--only", "lose-date"], ["--only"], ["--bogus"]]) {
      const r = spawnSync("bash", [tool, ...args], { encoding: "utf8", env: { ...process.env, TMPDIR: dir, REALNET_LOCK: join(dir, "lock"), REALNET_HOST: "nobody@127.0.0.1", DISK_GUARD: "/usr/bin/true" }, timeout: 20_000 });
      assert.strictEqual(r.status, 2, `${args.join(" ")}: exit ${r.status}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /^REFUSED {2}/m, args.join(" "));
      assert.doesNotMatch(r.stdout, /== build|tunnel pid|STEPS /, `${args.join(" ")} went on`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await t("**the plan is said FIRST**: a run with --only names its steps and their setup before it takes the lock", () => {
  const dir = ownTmp("realnet-steps-");
  const LOCK = join(dir, "lock");
  const holder = spawn("sleep", ["60"]);
  try {
    mkdirSync(LOCK);
    writeFileSync(`${LOCK}/owner`, `pid=${holder.pid}\nbranch=realnet-steps-test\n`);
    const r = spawnSync("bash", [tool, "--only", "lose-data"], { encoding: "utf8", env: { ...process.env, TMPDIR: dir, REALNET_LOCK: LOCK, REALNET_HOST: "nobody@127.0.0.1", DISK_GUARD: "/usr/bin/true" }, timeout: 20_000 });
    assert.strictEqual(r.status, 3, `exit ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^STEPS only lose-data, with its setup: publish,lose-data$/m);
  } finally {
    holder.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
