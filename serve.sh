#!/usr/bin/env bash
# ES modules and wasm need http, not file://.
cd "$(dirname "$0")" && exec python3 -m http.server "${1:-8088}" --bind 127.0.0.1
