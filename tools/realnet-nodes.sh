# THE RUN'S OWN NODES: stopped for certain, and their dirs KEPT when the run failed.
# Sourced by tools/realnet.sh (bash 3.2: no `wait -n`, no negative array indices).
#
# The Phase 4 run's first failure ("V's page never loaded") was lost: the harness deleted
# V's dir -- its logs -- on the way out. So a node's dir (data, config, LOG, web cache) is
# removed ONLY on a passing run whose node was proven gone; on any failure every dir is
# kept and its path printed. And a node is stopped TERM -> bounded wait -> KILL -> proven
# gone, never `kill; wait`: a node that ignores TERM (cold8) turned that `wait` into a hang.
#
# Uses the caller's parallel arrays npids / ndirs / nws / nlabels (one entry per node).

REALNET_TERM_WAIT=${REALNET_TERM_WAIT:-10}   # seconds a node gets to exit on TERM
REALNET_KILL_WAIT=${REALNET_KILL_WAIT:-5}    # seconds after KILL before it is declared stuck

# Is this pid a live process (not gone, not a zombie waiting to be reaped)?
node_alive() {
  local s
  s=$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')
  [ -n "$s" ] && [ "${s#Z}" = "$s" ]
}

# Poll for up to $2 seconds until pid $1 is no longer alive. 0: gone.
node_gone_within() {
  local i=0 n=$(( $2 * 10 ))
  while node_alive "$1"; do
    [ "$i" -ge "$n" ] && return 1
    i=$((i + 1))
    perl -e 'select undef, undef, undef, 0.1'
  done
  return 0
}

# Stop one node: TERM, a bounded wait, KILL, a bounded wait; then PROVE it gone (the pid,
# and nothing listening on its ws port). 0: proven gone.
stop_node() { # pid label ws
  local p=$1 label=$2 ws=$3
  kill -TERM "$p" 2>/dev/null
  if ! node_gone_within "$p" "$REALNET_TERM_WAIT"; then
    echo "KILL  $label's node (pid $p) ignored TERM for ${REALNET_TERM_WAIT} s"
    kill -KILL "$p" 2>/dev/null
    node_gone_within "$p" "$REALNET_KILL_WAIT"
  fi
  # Reap it if it is ours -- only once it is gone: a `wait` on a live node is the hang
  # this exists to prevent.
  node_alive "$p" || wait "$p" 2>/dev/null
  if node_alive "$p" || lsof -nP -iTCP:"$ws" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "FAIL  $label's node (pid $p) is still up"
    return 1
  fi
  echo "PASS  $label's node (pid $p) is gone; port $ws free"
  return 0
}

# End every node of the run. $1: the run's verdict so far (0 = passing). Dirs go only when
# the run passed AND their node is proven gone; otherwise they are kept and named. Returns
# non-zero when any node could not be proven gone. Empties npids.
end_nodes() { # run_failed
  local run_failed=$1 i p bad=0 kept=0
  for i in ${npids[@]+"${!npids[@]}"}; do
    p=${npids[$i]}
    if stop_node "$p" "${nlabels[$i]}" "${nws[$i]}"; then
      if [ "$run_failed" = 0 ]; then
        rm -rf "${ndirs[$i]}"
        continue
      fi
    else
      bad=1
    fi
    echo "KEPT  ${nlabels[$i]}'s dirs (data, config, log, web cache): ${ndirs[$i]}"
    kept=1
  done
  [ "$kept" = 1 ] && echo "KEPT  the failed run's node logs are under the paths above; remove them yourself when read"
  npids=()
  return "$bad"
}
