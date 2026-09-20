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

out=.sdk-build/$rev
if [ ! -f "$out/pkg/web/craftworks_sdk_bg.wasm" ]; then
  git -C "$repo" cat-file -e "$rev^{commit}" 2>/dev/null ||
    { echo "craftworks-sdk has no commit $rev — run: git -C $repo fetch"; exit 1; }
  rm -rf "$out" && mkdir -p "$out"
  git -C "$repo" archive "$rev" | tar -x -C "$out"
  (cd "$out" && ./build.sh >/dev/null)
fi

rm -rf sdk && mkdir sdk
cp "$out/pkg/web"/index.js "$out/pkg/web"/wrap.js "$out/pkg/web"/craftworks_sdk.js "$out/pkg/web"/craftworks_sdk_bg.wasm sdk/
echo "$rev" > sdk/REV

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
