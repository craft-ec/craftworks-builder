#!/usr/bin/env bash
# Bring in the SDK build (ES module + wasm). Run craftworks-sdk/build.sh first.
set -euo pipefail
cd "$(dirname "$0")"
src=../craftworks-sdk/pkg/web
[ -f "$src/craftworks_sdk.js" ] || { echo "missing $src — run ../craftworks-sdk/build.sh"; exit 1; }
rm -rf sdk && mkdir sdk && cp "$src"/craftworks_sdk.js "$src"/craftworks_sdk_bg.wasm sdk/
echo "sdk/ ready ($(wc -c < sdk/craftworks_sdk_bg.wasm | tr -d ' ') B wasm)"
