#!/usr/bin/env bash
# Bring in the SDK build (ES modules + wasm) at the revision this repo pins.
#
# By REVISION, not by whatever is checked out next door: the wasm is what the
# builder's apps run on, so "it worked here" has to mean something a second
# machine can reproduce. The sibling repo is used only as a source of objects —
# its working tree is never touched and never has to be on any branch.
set -euo pipefail
cd "$(dirname "$0")"
rev=$(tr -d ' \n' < SDK_REV)
repo=${CRAFTWORKS_SDK:-../craftworks-sdk}
[ -d "$repo/.git" ] || { echo "no craftworks-sdk repo at $repo (set CRAFTWORKS_SDK)"; exit 1; }

# KEEP ONLY THE PINNED REVISION.
#
# This cache is keyed by revision and used to keep every rev it had ever
# built, so it grew by roughly half a gigabyte on each SDK_REV bump and
# nothing ever removed one. Three stale revs were holding 1.5 GB on a machine
# that had fallen to 7.9 GiB free, where a build or a measurement dies
# mid-run under 5.
#
# Done BEFORE the build, so the space is free when it is needed rather than
# after. Removing the rev we are about to build would be self-defeating, so
# it is excluded by name.
if [ -d .sdk-build ]; then
  for old in .sdk-build/*/; do
    old=${old%/}
    [ "$(basename "$old")" = "$rev" ] && continue
    echo "  dropping cached SDK build $(basename "$old")"
    rm -rf "$old"
  done
fi

# THE ARTEFACTS THIS SCRIPT NEEDS, named ONCE.
#
# Two loops used to name them separately: the completeness check listed two,
# and the copy below listed three. So a build producing the first two and not
# the rest earned a `.complete` marker, became a permanent HIT, and died at
# the copy with "the SDK build has no block.wasm" — the exact failure the
# marker exists to prevent, still reachable by half the artefacts.
#
# The comment above the check said "EVERY artefact this script goes on to
# copy", which was false, and A COMMENT CLAIMING A PROPERTY IS A PLACE THE
# PROPERTY STOPS BEING VERIFIED: it reads like the check, so nobody checks
# the check. The same reasoning is already written below for why the `.js`
# copy is a glob rather than a list — a list is correct on the day it is
# written and silently wrong afterwards. One list up here, both loops read
# it, and they cannot drift.
WASM_ARTEFACTS="craftworks_sdk_bg.wasm engine_delegate.wasm block.wasm register.wasm"
# The three copied as files beside the SDK bundle. `craftworks_sdk_bg.wasm`
# is copied by the bundle step above, so it is checked but not re-copied.
COPIED_ARTEFACTS="engine_delegate.wasm block.wasm register.wasm"

out=.sdk-build/$rev

# A CACHE HIT MEANS COMPLETE, NOT PRESENT.
#
# This asked whether ONE file existed — `pkg/web/craftworks_sdk_bg.wasm`,
# which the SDK's build produces partway through. A run interrupted after
# that point, by a failed environment or a killed terminal, leaves a
# directory that answers YES and is missing everything after it. Every run
# afterwards takes the hit, skips the build, and dies at the copy with
# "the SDK build has no engine_delegate.wasm" — which reads like a broken
# SDK rather than like a cache holding half a build. It cost three runs
# before anyone doubted the cache.
#
# So the question is answered by a marker written LAST, after the build has
# exited 0 and every artefact this script copies is present. A partial
# directory has no marker, is a MISS, and is rebuilt.
complete=$out/.complete

# THE MARKER RECORDS WHAT IT VERIFIED, and a hit re-checks it.
#
# A marker that only says "I existed" has the same weakness one level up as
# the check it replaced: it asserts completeness rather than verifying it, so
# a directory that was complete when the marker was written and has been
# damaged since still reads as a hit.
#
# That is not hypothetical — it happened here. A test wrote the 7-byte string
# "partial" over the cached `craftworks_sdk_bg.wasm` and restored the marker
# afterwards, leaving a cache that reported itself COMPLETE while holding a
# corrupt artefact. The only tell would have been `(7 B wasm)` in a success
# line nobody reads.
#
# So the marker holds each artefact's size, and a hit compares them. Sizes
# rather than hashes because this runs on every build and a mismatch of ANY
# kind means rebuild — the cheap check is the right one when the answer to a
# difference is always the same.
cache_is_sound() {
  [ -f "$complete" ] || return 1
  for want in $WASM_ARTEFACTS; do
    f=$out/pkg/web/$want
    [ -f "$f" ] || return 1
    recorded=$(grep "^$want " "$complete" 2>/dev/null | cut -d' ' -f2)
    [ -n "$recorded" ] || return 1
    [ "$(wc -c < "$f" | tr -d ' ')" = "$recorded" ] || return 1
  done
  return 0
}

if ! cache_is_sound; then
  git -C "$repo" cat-file -e "$rev^{commit}" 2>/dev/null ||
    { echo "craftworks-sdk has no commit $rev — run: git -C $repo fetch"; exit 1; }
  [ -d "$out" ] && echo "  cached SDK build $rev is incomplete or damaged — rebuilding"
  rm -rf "$out" && mkdir -p "$out"
  git -C "$repo" archive "$rev" | tar -x -C "$out"
  # CHECKED. Without this the build could fail and the script carried on to
  # the copy, so a compile error also arrived as a missing-file message.
  if ! (cd "$out" && ./build.sh >/dev/null); then
    echo "the SDK build failed for $rev — see: (cd $out && ./build.sh)" >&2
    exit 1
  fi
  # Every artefact this script needs, from the ONE list above.
  for want in $WASM_ARTEFACTS; do
    [ -f "$out/pkg/web/$want" ] || {
      echo "the SDK build for $rev exited 0 without producing $want" >&2
      exit 1
    }
  done
  # LAST, and it records what it verified so a later run can check rather
  # than assume. Anything that fails above leaves no marker at all.
  : > "$complete"
  for want in $WASM_ARTEFACTS; do
    echo "$want $(wc -c < "$out/pkg/web/$want" | tr -d ' ')" >> "$complete"
  done
fi

rm -rf sdk && mkdir sdk

# COPY EVERY MODULE, not a list of them.
#
# This used to name four files. It was right until the SDK's `wrap.js` gained
# `session.js` and `engine-db.js`, after which this went on copying the old
# four and the page died with ERR_MODULE_NOT_FOUND — not at build time, not in
# the SDK's own gates, but here, at run time, in a different repository. A list
# of files to copy is correct on the day it is written and silently wrong
# afterwards.
#
# Copying the whole set cannot miss one, and needs nothing from the SDK
# revision being pinned — which matters, because this has to work against
# older revisions too, and a revision that predates any checking tool must
# still produce a package that runs.
cp "$out/pkg/web"/*.js sdk/
cp "$out/pkg/web"/craftworks_sdk_bg.wasm sdk/

# THE MANIFEST, which is how an app NAMES what it does not carry.
#
# `artefacts.json` records every artefact's hash and size (craftworks-sdk#107),
# so a packaged app can name the four wasm files instead of shipping them
# (§19, craftworks-sdk#108) — 1,709,429 B of this build, against 109,300 B of
# JavaScript beside it. GENERATED from the SDK build, never written here: a
# hash typed into this repository is a hash that goes stale the next time the
# SDK is rebuilt, and nothing would say so.
[ -f "$out/pkg/web/artefacts.json" ] || {
  echo "the SDK build has no artefacts.json — an app cannot name what it does not carry" >&2
  exit 1
}
# ITS CONTENT, NOT ITS PRESENCE.
#
# Older SDK revisions wrote a manifest carrying only `delegate`. Checking the
# file EXISTS accepts one of those and leaves packaging to fail later with
# "the SDK manifest has no hash for: sdk, block, register" — which reads as a
# broken manifest when the truth is that THE PIN IS TOO OLD. So the failure
# says which entries are missing AND which revision was asked for.
#
# This is the same shape as the cache marker two blocks up: a check that a
# thing is THERE is not a check that it is what you need. It cost a green
# test run here — the suite read a manifest left in the tree by a NEWER
# build than the pin selects, so it measured an environment the commit does
# not contain.
for want in sdk delegate block register; do
  grep -q "\"$want\"" "$out/pkg/web/artefacts.json" || {
    echo "the SDK at $rev writes an artefacts.json with no \"$want\" entry." >&2
    echo "A packaged app names all four artefacts by hash, so this pin is too old for it." >&2
    exit 1
  }
done
cp "$out/pkg/web/artefacts.json" sdk/

# THE ARTEFACTS PUBLISHING NEEDS.
#
# The engine delegate and the two contracts. They are fetched by URL at
# publish time, not imported, so no import walker finds them and nothing
# above copies them — and without them Publish fails with a 404 on a path
# nobody recognises, which is how this was found.
for a in $COPIED_ARTEFACTS; do
  [ -f "$out/pkg/web/$a" ] || { echo "the SDK build has no $a" >&2; exit 1; }
  cp "$out/pkg/web/$a" sdk/
done

echo "$rev" > sdk/REV

# And it IS importable. `tests/sdk-load.test.mjs` imports `sdk/index.js` and
# would fail on a broken package, but it runs after this and only if someone
# runs it; a build that produced an unimportable package and said nothing is
# the thing that just happened.
node -e 'import("./sdk/index.js").then(m => {
  if (typeof m.load !== "function") { console.error("sdk/index.js has no load()"); process.exit(1); }
})' || { echo "sdk/ cannot be imported — the copy above is incomplete" >&2; exit 1; }

# What this build IS, for the versions panel. Rewritten on EVERY run, including
# the one where the SDK cache already had the revision: the builder's own commit
# and the contract hashes move without the SDK moving, and a stale build-info is
# the exact failure the panel exists to catch.
#
# `sdk/REV` is what the builder ASKED for. The wasm's own answer comes from
# `buildInfo()` at runtime, which is the half that can disagree — writing the
# pinned rev on both sides here would only restate it.
python3 tools/build-info.py > build-info.json

echo "sdk/ ready — craftworks-sdk $rev ($(wc -c < sdk/craftworks_sdk_bg.wasm | tr -d ' ') B wasm)"
echo "build-info.json — builder $(python3 -c 'import json;print(json.load(open("build-info.json"))["builder"]["rev"])')"
