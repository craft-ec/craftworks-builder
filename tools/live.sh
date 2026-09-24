#!/usr/bin/env bash
# THE ONE LIVE-MEASUREMENT HARNESS (tools/live/, stock-take 2026-09-24 §4.3):
#
#   TMPDIR=<your own dir> tools/live.sh <scenario> [--repeats R] [--nodes N] [--budget-min M] [--wait-min W]
#
# Scenarios: tools/live/scenarios/<name>.mjs. Results: $TMPDIR/live-results/<utc>-<scenario>/
# (header.json, samples.jsonl, summary.txt, logs/, and nodes/ kept on a failure).
# Env: CRAFTWORKS_SDK (for the disk guard), DISK_GUARD (a stub, for tests).
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
case "${TMPDIR:-}" in
  ""|/var/folders/*|/tmp|/tmp/|/private/tmp|/private/tmp/) echo "REFUSED  TMPDIR is ${TMPDIR:-unset}: set it to your own directory, so every browser and node this run starts names its owner; nothing started"; exit 2;;
esac
# THE DISK GUARD (sdk#361), before any node: the harness nodes' event logs are ~61 MiB/h each.
guard=${DISK_GUARD:-${CRAFTWORKS_SDK:-$here/../craftworks-sdk}/scripts/disk-guard.sh}
if [ ! -x "$guard" ]; then echo "no disk guard at $guard -- cannot check the disk, and will not skip it" >&2; exit 1; fi
"$guard" "the live harness run" || exit 1
exec node "$here/tools/live/run.mjs" "$@"
