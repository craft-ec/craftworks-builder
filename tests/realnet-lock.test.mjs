// ONE SESSION ON THE SERVER AT A TIME (tools/realnet.sh): while another run
// holds the named lock, a second is REFUSED before it builds, dials or
// tunnels anything, names the holder, and leaves the holder's lock intact.
// Nothing here reaches the network: the refusal is the first thing it does.
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownTmp } from "./page-host.mjs";

// ITS OWN lock path, never the shared one: a real run may hold that now, and
// this test must neither wait on it nor touch it. And its OWN TMPDIR: the
// tool refuses the system default, and this test must pass from any shell.
const dir = ownTmp("realnet-lock-");
const LOCK = join(dir, "lock");
const tool = fileURLToPath(new URL("../tools/realnet.sh", import.meta.url));
const holder = spawn("sleep", ["60"]);
try {
  mkdirSync(LOCK);
  writeFileSync(`${LOCK}/owner`, `pid=${holder.pid}\nbranch=realnet-lock-test\n`);
  const r = spawnSync("bash", [tool], { encoding: "utf8", env: { ...process.env, TMPDIR: dir, REALNET_LOCK: LOCK, REALNET_HOST: "nobody@127.0.0.1", DISK_GUARD: "/usr/bin/true" }, timeout: 20_000 });
  assert.strictEqual(r.status, 3, `a second run was not refused (exit ${r.status}): ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /REFUSED {2}another real-network run holds .*branch=realnet-lock-test/);
  assert.doesNotMatch(r.stdout, /== build|tunnel pid/, "the refused run went on to build or tunnel");
  assert.strictEqual(readFileSync(`${LOCK}/owner`, "utf8"), `pid=${holder.pid}\nbranch=realnet-lock-test\n`, "the refused run touched the holder's lock");
  console.log("ok a second real-network run is refused while the first holds the lock, and the lock is left as it was");
} finally {
  holder.kill();
  rmSync(dir, { recursive: true, force: true });
}
