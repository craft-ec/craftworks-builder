#!/usr/bin/env bash
# THE REAL-NETWORK DEMO, one command (CLAUDE.md, Delivery 0: every live-path PR
# attaches this run's output). From a builder checkout, on the branch under
# test:
#
#   REALNET_OWNER_OK=1 tools/realnet.sh
#
# It builds THIS tree (an SDK branch is tested by pinning its rev in SDK_REV),
# prints the revisions it ACTUALLY ran (read back from the build), then runs
# the owner's demo: publish on the server's node (B), open by address through
# this machine's node (A, only READ), add / edit / delete on the app owner's own
# site, each checked on A's open view. One PASS/FAIL line per step.
#
# SAFETY (the owner's rules for the server): ONE session at a time (a named
# lock; a second run is refused, naming the holder). B is reached through ONE
# SSH tunnel on this machine's loopback, recorded and killed by PID. On B only
# read-only commands run (systemctl show, journalctl, the binary's --version);
# its MainPID and start time must be unchanged at the end, or the run says STOP.
# The run starts ONE node of its own: V, the user who WRITES (a private node
# on this machine joined to the real network — never the owner's), with its
# data, config, log AND web cache (FREENET_WEBAPP_CACHE_DIR) in a directory of
# its own, --disable-auto-update, recorded and killed by PID and proven gone.
# Test data only: rows are tagged per run; the publishing identity is the
# server node's test key, the writing user's is V's own.
#
# Env: REALNET_HOST (root@46.224.172.252)  REALNET_A (7509)  REALNET_TUNNEL
# (17619)  REALNET_B_REMOTE (7509)  CRAFTWORKS_SDK  CRAFTWORKS_CONTRACTS
# STEP_MS (180000)  BUDGET_MS (1500000).
set -u
HOST=${REALNET_HOST:-root@46.224.172.252}
A=${REALNET_A:-7509}
# 17619, not 17609: 17609 is the owner's standing demo tunnel.
T=${REALNET_TUNNEL:-17619}
# V's ports are FREE ones chosen per run (REALNET_V_WS / REALNET_V_NET to pin
# them): a fixed port is one a stale client from an earlier run finds again —
# an orphaned browser reconnected to 17639 and provisioned V before step 9.
free_port() { python3 -c "import socket,sys; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM if sys.argv[1]=='udp' else socket.SOCK_STREAM); s.bind(('127.0.0.1',0)); print(s.getsockname()[1])" "$1"; }
VWS=${REALNET_V_WS:-$(free_port tcp)}
VNET=${REALNET_V_NET:-$(free_port udp)}
BR=${REALNET_B_REMOTE:-7509}
# The one lock every session shares (REALNET_LOCK only for the lock's own test).
LOCK=${REALNET_LOCK:-/tmp/craftworks-realnet.lock}
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here" || exit 2
# EVERY BROWSER A RUN STARTS names its owner: a TMPDIR of the run's own (the
# system default is where the 06:30 orphan's profile could not be tied to
# anyone), and a PID file page-host writes each browser into.
case "${TMPDIR:-}" in
  ""|/var/folders/*|/tmp|/tmp/|/private/tmp|/private/tmp/) echo "REFUSED  TMPDIR is ${TMPDIR:-unset}: set it to your own directory, so every browser and node this run starts names its owner; nothing started"; exit 2;;
esac

# ---- the lock: one session on the server at a time ---------------------------
if ! mkdir "$LOCK" 2>/dev/null; then
  holder=$(cat "$LOCK/owner" 2>/dev/null)
  hpid=$(sed -n 's/^pid=//p' "$LOCK/owner" 2>/dev/null)
  if [ -n "$hpid" ] && kill -0 "$hpid" 2>/dev/null; then
    echo "REFUSED  another real-network run holds $LOCK: $(tr '\n' ' ' <<<"$holder")"
    exit 3
  fi
  echo "the lock $LOCK was left by a run that is gone ($(tr '\n' ' ' <<<"$holder")); taking it"
  rm -rf "$LOCK" && mkdir "$LOCK" || { echo "REFUSED  could not take $LOCK"; exit 3; }
fi
printf 'pid=%s\ncwd=%s\nbranch=%s\nsince=%s\n' "$$" "$here" "$(git rev-parse --abbrev-ref HEAD)" "$(date -u +%FT%TZ)" > "$LOCK/owner"
# Under the lock only: no run of this TMPDIR is live now, so what an earlier one
# recorded is left over, never another run's.
# A BROWSER AN EARLIER RUN LEFT (killed with SIGKILL, so nothing of it could
# clean up): swept before anything starts. Only a PID whose command line still
# names the profile its run recorded is killed — a PID reused by anything else
# is left alone — and each is verified gone.
. "$here/tools/browser-sweep.sh"
for old in "$TMPDIR"/realnet-run.*/browsers.pids; do [ -f "$old" ] && { sweep "$old" || exit 2; }; done
run=$(mktemp -d "$TMPDIR/realnet-run.XXXXXX")
export PAGE_HOST_PIDFILE="$run/browsers.pids"
: > "$PAGE_HOST_PIDFILE"
tunnel=""; vpid=""; vdir=""
cleanup() {
  # This run's browsers, whatever ended it (the demo killed, this script
  # signalled): page-host kills them on every exit IT sees; this is the rest.
  [ -f "$PAGE_HOST_PIDFILE" ] && sweep "$PAGE_HOST_PIDFILE"
  [ -n "$tunnel" ] && kill "$tunnel" 2>/dev/null && wait "$tunnel" 2>/dev/null
  [ -n "$vpid" ] && kill "$vpid" 2>/dev/null && wait "$vpid" 2>/dev/null
  [ "$(sed -n 's/^pid=//p' "$LOCK/owner" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# ---- build, and what it ACTUALLY is ------------------------------------------
echo "== build"
env -u CARGO_TARGET_DIR CRAFTWORKS_SDK="${CRAFTWORKS_SDK:-../craftworks-sdk}" \
  CRAFTWORKS_CONTRACTS="${CRAFTWORKS_CONTRACTS:-../freenet-contracts}" ./build.sh > /tmp/craftworks-realnet-build.$$.log 2>&1
rc=$?
if [ $rc -ne 0 ]; then echo "FAIL  build (exit $rc): $(tail -3 /tmp/craftworks-realnet-build.$$.log)"; rm -f /tmp/craftworks-realnet-build.$$.log; exit 1; fi
rm -f /tmp/craftworks-realnet-build.$$.log
pinned=$(tr -d ' \n' < SDK_REV)
built=$(tr -d ' \n' < sdk/REV 2>/dev/null)
if [ "$pinned" != "$built" ]; then echo "FAIL  the SDK built is ${built:-none}, not the pinned $pinned: refusing to run evidence on the wrong code"; exit 1; fi
dirty=$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')
echo "RAN   builder $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD)$( [ "$dirty" != 0 ] && echo ", $dirty uncommitted file(s)"))"
# THE A-SIDE CHECK's one decoder, from THIS SDK revision's own source (the
# format and its encoders are the SDK's): classify-frames, and frame-put for
# the Register-PUT mutant.
if ! (cd ".sdk-build/$pinned" && env -u CARGO_TARGET_DIR cargo build -q --release -p probe --bin classify-frames --bin frame-put) > "$run/probe-build.log" 2>&1; then
  echo "FAIL  the SDK's classify-frames did not build: $(tail -3 "$run/probe-build.log")"; exit 1
fi
probe_bin="$here/.sdk-build/$pinned/target/release"
echo "RAN   sdk ${built:0:12} (sdk/REV), wasm sha256 $(shasum -a 256 sdk/craftworks_sdk_bg.wasm | cut -c1-16), artefacts container $(node -e 'console.log(require("./sdk/artefacts.json").container.address)')"

# ---- B, read-only, and the tunnel --------------------------------------------
remote() { perl -e 'alarm 60; exec @ARGV' ssh -o BatchMode=yes "$HOST" "$@"; }
state() { remote "systemctl show -p MainPID,ActiveEnterTimestamp,NRestarts freenet-blob"; }
before=$(state) || { echo "FAIL  cannot reach $HOST read-only; nothing started"; exit 2; }
bpid=$(sed -n 's/^MainPID=//p' <<<"$before")
bver=$(remote "/proc/$bpid/exe --version" | head -1 | sed 's/Freenet version: //')
aver=$(freenet --version 2>/dev/null | head -1 | sed 's/Freenet version: //')
echo "RAN   A = this machine :$A (freenet ${aver:-?}, hotspot/home); B = ${HOST#*@} (freenet ${bver:-?}, datacentre)"
echo "B before: $(tr '\n' ' ' <<<"$before")"
if holder=$(lsof -nP -iTCP:"$T" -sTCP:LISTEN -t 2>/dev/null | head -1) && [ -n "$holder" ]; then
  echo "REFUSED  port $T is held by pid $holder: $(ps -o command= -p "$holder" | cut -c1-160) — set REALNET_TUNNEL to a free port; nothing started"; exit 2
fi
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -L "127.0.0.1:$T:127.0.0.1:$BR" "$HOST" &
tunnel=$!
for _ in $(seq 1 40); do nc -z 127.0.0.1 "$T" 2>/dev/null && break; perl -e 'select undef,undef,undef,0.25'; done
echo "tunnel pid $tunnel: 127.0.0.1:$T -> $HOST 127.0.0.1:$BR"
start=$(date -u '+%Y-%m-%d %H:%M:%S')

# ---- V: the user who writes, on a node of its own -------------------------
for p in "$VWS" "$VNET"; do
  case "$p" in 7509|7609) echo "FAIL  $p is the owner's node: the user's node never uses it"; exit 2;; esac
done
if lsof -nP -iTCP:"$VWS" -sTCP:LISTEN >/dev/null || lsof -nP -iUDP:"$VNET" >/dev/null; then
  echo "REFUSED  port $VWS (ws) or $VNET (udp) is taken — set REALNET_V_WS / REALNET_V_NET; nothing started"; exit 2
fi
vdir=$(mktemp -d "${TMPDIR:-/tmp}/realnet-v.XXXXXX")
mkdir -p "$vdir/data" "$vdir/config" "$vdir/log" "$vdir/webapp_cache"
FREENET_WEBAPP_CACHE_DIR="$vdir/webapp_cache" freenet network --ws-api-address 127.0.0.1 --ws-api-port "$VWS" \
  --network-port "$VNET" --data-dir "$vdir/data" --config-dir "$vdir/config" --log-dir "$vdir/log" \
  --disable-auto-update > "$vdir/log/console.out" 2>&1 &
vpid=$!
for _ in $(seq 1 240); do nc -z 127.0.0.1 "$VWS" 2>/dev/null && break; kill -0 "$vpid" 2>/dev/null || break; perl -e 'select undef,undef,undef,0.25'; done
if ! nc -z 127.0.0.1 "$VWS" 2>/dev/null; then echo "FAIL  the user's node did not start: $(tail -3 "$vdir/log/console.out")"; exit 1; fi
echo "RAN   V = a private node on this machine :$VWS (pid $vpid, joined to the real network; dirs + web cache under $vdir)"

# ---- the demo ------------------------------------------------------------------
echo "== demo"
RN_B="$T" RN_B_LABEL="B" RN_A="$A" RN_A_LABEL="A" RN_V="$VWS" RN_V_LABEL="V" \
  RN_CLASSIFY="$probe_bin/classify-frames" RN_FRAME_PUT="$probe_bin/frame-put" \
  RN_BLOCK_WASM="$here/sdk/block.wasm" RN_REGISTER_WASM="$here/sdk/register.wasm" \
  RN_WIRE_DIR="$run" \
  node tools/realnet-demo.mjs
fail=$?

# ---- cleanup, proven ----------------------------------------------------------
echo "== cleanup"
kill "$tunnel" 2>/dev/null; wait "$tunnel" 2>/dev/null; tunnel=""
kill "$vpid" 2>/dev/null; wait "$vpid" 2>/dev/null
if kill -0 "$vpid" 2>/dev/null || lsof -nP -iTCP:"$VWS" -sTCP:LISTEN >/dev/null; then echo "FAIL  the user's node (pid $vpid) is still up"; fail=1
else echo "PASS  the user's node (pid $vpid) is gone; port $VWS free"; rm -rf "$vdir"; fi
vpid=""
if lsof -nP -iTCP:"$T" -sTCP:LISTEN >/dev/null; then echo "FAIL  port $T still listening"; fail=1; else echo "PASS  tunnel closed; port $T free"; fi
after=$(state)
if [ "$after" != "$before" ]; then echo "STOP  B changed during the run: before [$(tr '\n' ' ' <<<"$before")] after [$(tr '\n' ' ' <<<"$after")]"; fail=1
else echo "PASS  B unchanged: $(tr '\n' ' ' <<<"$after")"; fi
echo "B journal since $start (read-only), not rate-limit noise, last 10:"
remote "journalctl -u freenet-blob --since '$start' --no-pager -o cat | grep -v 'RATE LIMIT' | cut -c1-200 | tail -10"
echo "RESULT $( [ $fail = 0 ] && echo passes || echo breaks ) — builder $(git rev-parse --short HEAD), sdk ${built:0:12}"
exit $fail
