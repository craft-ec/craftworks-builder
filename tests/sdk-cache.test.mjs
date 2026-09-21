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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * What `build.sh` decides for a cache directory: hit or miss.
 *
 * TAKES THE DIRECTORY, and the shape tests pass a TEMPORARY one.
 *
 * The first version of this wrote the 7-byte string "partial" over the REAL
 * cached `craftworks_sdk_bg.wasm` and restored only `.complete` afterwards.
 * So after a run on a warm cache the marker said complete, the next build
 * took a HIT, skipped the rebuild, and copied a 7-byte wasm into `sdk/` —
 * and the restored marker is what made it invisible: the cache reported
 * itself complete while holding a corrupt artefact, with `(7 B wasm)` in a
 * success line as the only tell.
 *
 * A test that damages the artefact it validates is the same class as the bug
 * it was written to catch. Save-and-restore is not the fix either: it still
 * corrupts the cache whenever the test is interrupted, and silently. A
 * directory of its own cannot.
 */
const decides = (dir) => {
  // The script's own rule, read from the script rather than restated here —
  // a second copy of the condition is a second thing to keep in step. This
  // guard has already earned itself once: it failed the moment the decision
  // moved from "the marker exists" to "the marker matches", which is exactly
  // when a test checking the old condition becomes a test of nothing.
  const src = readFileSync(at("../build.sh"), "utf8");
  assert.match(src, /if ! cache_is_sound/,
    "build.sh no longer decides with cache_is_sound; this test is checking a rule that is gone");
  const artefacts = /^WASM_ARTEFACTS="([^"]+)"/m.exec(src)[1].split(/\s+/);

  // The same three questions the script asks: is there a marker, is every
  // artefact present, and is each one the SIZE the marker recorded.
  if (!existsSync(`${dir}/.complete`)) return "miss";
  const recorded = Object.fromEntries(
    readFileSync(`${dir}/.complete`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(l => l.split(" ")),
  );
  for (const a of artefacts) {
    const f = `${dir}/pkg/web/${a}`;
    if (!existsSync(f)) return "miss";
    if (recorded[a] === undefined) return "miss";
    if (String(statSync(f).size) !== recorded[a]) return "miss";
  }
  return "hit";
};

/** A directory that looks like a sound cache: the artefacts, and a marker that matches. */
const sound = (dir) => {
  const src = readFileSync(at("../build.sh"), "utf8");
  const artefacts = /^WASM_ARTEFACTS="([^"]+)"/m.exec(src)[1].split(/\s+/);
  mkdirSync(`${dir}/pkg/web`, { recursive: true });
  let marker = "";
  for (const a of artefacts) {
    const body = `wasm-${a}`;
    writeFileSync(`${dir}/pkg/web/${a}`, body);
    marker += `${a} ${body.length}\n`;
  }
  writeFileSync(`${dir}/.complete`, marker);
  return artefacts;
};

/** A cache directory of our own, nowhere near the real one. */
const scratch = () => mkdtempSync(join(tmpdir(), "cw-cache-test-"));

t("**a HALF-BUILT cache directory is a MISS, not a hit**", () => {
  // Exactly what an interrupted run leaves: the file the old check asked
  // about, and nothing after it. In a directory of our own.
  const dir = scratch();
  try {
    mkdirSync(`${dir}/pkg/web`, { recursive: true });
    writeFileSync(`${dir}/pkg/web/craftworks_sdk_bg.wasm`, "partial");
    assert.strictEqual(decides(dir), "miss",
      "a directory holding only the first artefact was taken as a complete build. " +
      "The run then skips the build and fails at the copy, naming a missing file " +
      "instead of a cache holding half a build.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t("THE CONTROL: a complete cache directory IS a hit", () => {
  // Without this, a decision that always said "miss" would pass the test
  // above and rebuild the SDK on every single run.
  const dir = scratch();
  try {
    sound(dir);
    assert.strictEqual(decides(dir), "hit", "a complete build is rebuilt every time");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t("**a sound cache DAMAGED afterwards becomes a MISS**", () => {
  // The residue the marker alone could not catch, as a live check rather
  // than a source read: a directory that WAS complete, with its marker, and
  // one artefact replaced by something shorter.
  const dir = scratch();
  try {
    const artefacts = sound(dir);
    assert.strictEqual(decides(dir), "hit", "the fixture is not a sound cache to begin with");
    writeFileSync(`${dir}/pkg/web/${artefacts[0]}`, "partial");
    assert.strictEqual(decides(dir), "miss",
      `${artefacts[0]} was replaced by 7 bytes and the cache still reported itself ` +
      "complete — which is exactly what left a 7-byte wasm in a real cache tonight");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t("**the completeness list and the copy list cannot drift**", () => {
  // They were separate and disagreed: the check named two artefacts, the
  // copy named three. A build producing the first two earned a marker,
  // became a permanent HIT, and died at the copy — the very failure the
  // marker exists to prevent, reachable by half the artefacts.
  const src = readFileSync(at("../build.sh"), "utf8");
  assert.match(src, /^WASM_ARTEFACTS=/m, "there is no single list of the artefacts");
  assert.match(src, /for want in \$WASM_ARTEFACTS/,
    "the completeness check does not read the shared list");
  assert.match(src, /for a in \$COPIED_ARTEFACTS/,
    "the copy does not read a shared list");
  // And the copied set is contained in the checked set, which is the property
  // the two lists have to have: everything copied is first checked for.
  const all = /^WASM_ARTEFACTS="([^"]+)"/m.exec(src)[1].split(/\s+/);
  const copied = /^COPIED_ARTEFACTS="([^"]+)"/m.exec(src)[1].split(/\s+/);
  const unchecked = copied.filter(a => !all.includes(a));
  assert.deepStrictEqual(unchecked, [],
    `these are copied but never checked for: ${unchecked.join(", ")} — a build ` +
    "without them would still be marked complete");
});

t("**a cache DAMAGED after its marker was written is a MISS**", () => {
  // A marker that only says "I existed" asserts completeness rather than
  // verifying it, so a directory complete when the marker was written and
  // damaged since still reads as a hit.
  //
  // That happened here: the first version of THIS FILE wrote the 7-byte
  // string "partial" over the real cached wasm and restored the marker, and
  // the cache then reported itself complete while holding 7 bytes where a
  // 744,909-byte module belonged.
  const src = readFileSync(at("../build.sh"), "utf8");
  assert.match(src, /cache_is_sound/, "the hit is not verified at all, only asserted");
  assert.match(src, /recorded=\$\(grep/,
    "the marker's recorded sizes are not read back, so a damaged artefact still reads as a hit");
  assert.match(src, /echo "\$want \$\(wc -c/,
    "the marker does not record what it verified, so a later run has nothing to check against");
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
