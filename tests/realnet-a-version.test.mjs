// A'S VERSION IS ITS RUNNING BINARY'S (tools/realnet.sh `a_version`), read as B's is: the pid listening on :$A,
// its executable, that file's --version -- never `freenet` from PATH, which is not A (main's report: "RAN A = …
// (freenet X)" named PATH's binary while A ran another). And a node can outlive its binary (a self-update replaced
// the file): then the line says so and names no version.
//
// The "node" is a stand-in: a COPY of this test's own node binary under a temp dir, listening on a free port. Its
// --version is node's, which is what `a_version` must report -- the running file's, not PATH's.
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, utimesSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownTmp } from "./page-host.mjs";

const script = fileURLToPath(new URL("../tools/realnet.sh", import.meta.url));
// ONE home: the function under test is cut from realnet.sh itself, never copied here.
const fn = readFileSync(script, "utf8").match(/^a_version\(\) \{[\s\S]*?^\}$/m)?.[0];
const base = ownTmp("realnet-a-version-");
let failures = 0;
const t = async (name, f) => {
  try { await f(); process.stdout.write(`  ok  ${name}\n`); } catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};
const freePort = () => new Promise(ok => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const aVersion = A => spawnSync("bash", ["-c", `${fn}\na_version`], { env: { ...process.env, A: String(A), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8" }).stdout.trim();
const started = [];

try {
  await t("THE SETUP: a_version is cut from realnet.sh", () => assert.ok(fn, "no a_version() in tools/realnet.sh"));

  // A stand-in node: a copy of node, listening on :port, its own file.
  const exe = join(base, "freenet");
  copyFileSync(process.execPath, exe);
  const port = await freePort();
  const node = spawn(exe, ["-e", `require("net").createServer().listen(${port}, "127.0.0.1")`], { stdio: "ignore" });
  started.push(node.pid);
  for (let i = 0; i < 100 && !spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).stdout.toString().trim(); i++) await new Promise(r => setTimeout(r, 50));
  const own = spawnSync(exe, ["--version"], { encoding: "utf8" }).stdout.trim();

  await t("**the version is the RUNNING binary's, with its pid and path** -- not PATH's (PATH here has no node at all)", () => {
    assert.equal(aVersion(port), `${own} (pid ${node.pid}, ${exe})`);
  });

  await t("**a binary REPLACED after its node started is said, and no version is named for the node**", () => {
    const later = Date.now() / 1000 + 60;
    utimesSync(exe, later, later);
    const line = aVersion(port);
    assert.match(line, new RegExp(`^\\? \\(pid ${node.pid}'s binary .* was replaced after it started; the file is `), line);
  });

  await t("nothing listening on :A is said, never a version", async () => {
    assert.equal(aVersion(await freePort()).startsWith("? (nothing listens on :"), true);
  });
} finally {
  for (const p of started) { try { process.kill(p, "SIGKILL"); } catch {} }
  spawnSync("rm", ["-rf", base]);
}
process.stdout.write(failures ? `\n${failures} failing\n` : "\nall ok\n");
process.exit(failures ? 1 : 0);
