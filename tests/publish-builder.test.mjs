// PUBLISHING THE BUILDER ITSELF (tools/publish-builder.sh = realnet.sh --publish-builder): the files the site carries
// are exactly the ones the builder SERVES, and the mode rides realnet.sh's lock, tunnel, build and B check rather than
// a copy of them. Nothing here reaches the network: realnet.sh is refused before it builds.
import assert from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownTmp } from "./page-host.mjs";
import { BUILDER_APP, builderSiteFiles } from "../tools/publish-builder.mjs";

const t = async (name, fn) => { await fn(); console.log(`ok ${name}`); };
const sh = readFileSync(new URL("../tools/realnet.sh", import.meta.url), "utf8");
const wrapper = readFileSync(new URL("../tools/publish-builder.sh", import.meta.url), "utf8");
const tool = fileURLToPath(new URL("../tools/realnet.sh", import.meta.url));

/** A fake builder checkout: what build.sh leaves, and what must never be carried. */
function fakeTree(dir, { drop = [] } = {}) {
  const files = ["index.html", "app.js", "runtime.js", "build-info.json", "package.json", "README.md", "OWNERS",
    "app-loader/index.html", "app-loader/loader.js", "sdk/index.js", "sdk/craftworks_sdk_bg.wasm", "sdk/site.wasm",
    "sdk/pieces.json", "sdk/pieces/core/piece-0.webapp", "sdk/.DS_Store", "tests/x.test.mjs", "tools/realnet.sh", "docs/a.md", ".page-nonce/n"];
  for (const f of files.filter(f => !drop.includes(f))) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), f);
  }
}

await t("**the site carries what the builder SERVES**: page, stamp, modules, the app loader, the SDK less its load pieces (one frame, SITE_LIMIT); never tests, tools, docs or repo files", () => {
  const dir = ownTmp("publish-builder-");
  try {
    fakeTree(dir);
    assert.deepStrictEqual(builderSiteFiles(dir), [
      "app-loader/index.html", "app-loader/loader.js", "app.js", "build-info.json", "index.html", "runtime.js",
      "sdk/craftworks_sdk_bg.wasm", "sdk/index.js", "sdk/pieces.json", "sdk/site.wasm",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await t("**an unbuilt tree is refused by name** (no SDK, no stamp): nothing half-built is published", () => {
  for (const drop of ["build-info.json", "sdk/site.wasm", "sdk/index.js"]) {
    const dir = ownTmp("publish-builder-");
    try {
      fakeTree(dir, { drop: [drop] });
      assert.throws(() => builderSiteFiles(dir), new RegExp(`the builder's ${drop.replace(".", "\\.")} is not there: run build\\.sh first`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

await t("**ONE address**: the site id is fixed and an app id by the SDK's rule (1-32 of a-z 0-9 _ -)", () => {
  assert.match(BUILDER_APP, /^[a-z0-9_-]{1,32}$/);
});

await t("**the mode is realnet.sh's**: publish-builder.sh runs realnet.sh --publish-builder, which runs no demo step and starts no private node", () => {
  assert.match(wrapper, /^exec "\$\(dirname "\$0"\)\/realnet\.sh" --publish-builder "\$@"$/m);
  assert.match(sh, /--publish-builder\) PROGRAM=tools\/publish-builder\.mjs; shift;;/);
  assert.match(sh, /STEPS=publish-builder; NODES=" "/);
  assert.match(sh, /^ {2}node "\$PROGRAM"$/m, "realnet.sh does not run the chosen program");
});

await t("**--publish-builder with --only is REFUSED before anything starts**", () => {
  const dir = ownTmp("publish-builder-");
  try {
    const r = spawnSync("bash", [tool, "--publish-builder", "--only", "publish"], { encoding: "utf8", env: { ...process.env, TMPDIR: dir, REALNET_LOCK: join(dir, "lock"), REALNET_HOST: "nobody@127.0.0.1", DISK_GUARD: "/usr/bin/true" }, timeout: 20_000 });
    assert.strictEqual(r.status, 2, `exit ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^REFUSED {2}--publish-builder runs no demo step/m);
    assert.doesNotMatch(r.stdout, /== build|tunnel pid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
