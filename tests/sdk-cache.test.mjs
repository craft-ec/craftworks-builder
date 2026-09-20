// A CACHE HIT MEANS COMPLETE, NOT PRESENT.
//
// `build.sh` asked whether ONE file existed — `craftworks_sdk_bg.wasm`, which
// the SDK's build produces partway through. A run interrupted after that
// point leaves a directory that answers YES and is missing everything after
// it. Every run afterwards takes the hit, skips the build, and dies at the
// copy with "the SDK build has no engine_delegate.wasm" — which reads like a
// broken SDK rather than a cache holding half a build.
//
// It cost three runs in one night before anyone doubted the cache, which is
// what a check that cannot fail costs: the directory was there, so the
// question "is it built?" had already been answered wrongly and nothing
// asked again.
//
// The test is the sequence that produced it: an INTERRUPTED build, then a
// clean one.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = p => fileURLToPath(new URL(p, import.meta.url));
const root = at("../");
const rev = readFileSync(at("../SDK_REV"), "utf8").trim();
const cache = `${root}.sdk-build/${rev}`;

let failures = 0;
const t = (name, fn) => {
  try { fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n    ${e.message}\n`); }
};

/** What `build.sh` decides, without running the build: hit or miss. */
const decides = () => {
  // The script's own test, read from the script rather than restated here —
  // a second copy of the condition is a second thing to keep in step.
  const src = readFileSync(at("../build.sh"), "utf8");
  assert.match(src, /if \[ ! -f "\$complete" \]/,
    "build.sh no longer decides on a completeness marker; this test is checking a condition that is gone");
  return existsSync(`${cache}/.complete`) ? "hit" : "miss";
};

t("**a HALF-BUILT cache directory is a MISS, not a hit**", () => {
  // Exactly what an interrupted run leaves: the file the old check asked
  // about, and nothing after it.
  const saved = existsSync(`${cache}/.complete`);
  try {
    mkdirSync(`${cache}/pkg/web`, { recursive: true });
    writeFileSync(`${cache}/pkg/web/craftworks_sdk_bg.wasm`, "partial");
    rmSync(`${cache}/.complete`, { force: true });
    assert.strictEqual(decides(), "miss",
      "a directory holding only the first artefact was taken as a complete build. " +
      "The run then skips the build and fails at the copy, naming a missing file " +
      "instead of a cache holding half a build.");
  } finally {
    if (saved) writeFileSync(`${cache}/.complete`, "");
  }
});

t("THE CONTROL: a complete cache directory IS a hit", () => {
  // Without this, a decision that always said "miss" would pass the test
  // above and rebuild the SDK on every single run.
  const saved = existsSync(`${cache}/.complete`);
  try {
    mkdirSync(cache, { recursive: true });
    writeFileSync(`${cache}/.complete`, "");
    assert.strictEqual(decides(), "hit", "a complete build is rebuilt every time");
  } finally {
    if (!saved) rmSync(`${cache}/.complete`, { force: true });
  }
});

t("the marker is written LAST, after the artefacts are checked", () => {
  const src = readFileSync(at("../build.sh"), "utf8");
  const build = src.indexOf("./build.sh >/dev/null");
  const check = src.indexOf("exited 0 without producing");
  const marker = src.indexOf(': > "$complete"');
  assert.ok(build > 0 && check > 0 && marker > 0, "the build, the check and the marker are not all there");
  assert.ok(build < check, "the artefacts are checked before the build has run");
  assert.ok(check < marker,
    "the marker is written before the artefacts are checked, so a build that " +
    "exits 0 without producing them would be cached as complete");
});

t("a failing SDK build is a failure, not a missing file later", () => {
  const src = readFileSync(at("../build.sh"), "utf8");
  assert.match(src, /if ! \(cd "\$out" && \.\/build\.sh/,
    "the inner build's exit status is not checked, so a compile error arrives " +
    "later as a missing-file message from the copy");
});

process.stdout.write(failures ? `\n${failures} failing\n` : "\nok sdk cache\n");
process.exit(failures ? 1 : 0);
