# Sourced by tools/realnet.sh (and its test): sweep the children a run recorded.
#
# `sweep <pidfile>`: each line is `pid <TAB> kind <TAB> mark`, written by page-host's launcher for every child it
# started (its browsers, its page server, its private node; builder#180). `mark` is an argument the child's command
# line carries (`--user-data-dir=<profile>`, `page_host=<nonce>`, the node's data dir). A PID is signalled only while
# it still carries its mark as a whole argument, re-checked immediately before EACH signal (`killmarked`: the TERM,
# then the KILL after 10 s): a PID reused since the recording, even mid-sweep, is left alone. An OLD two-field line
# (`pid <TAB> profile`, before builder#180) is printed and left: its bare path cannot be told from another process's
# argument. The file is removed after. Returns 1 if a child that still carries its mark would not exit.
# Alive = exists and is not a zombie (a dead child its parent has not reaped yet).
live() { local st; st=$(ps -o stat= -p "$1" 2>/dev/null) && [ -n "$st" ] && [ "${st#Z}" = "$st" ]; }
# The ONE check before a signal: the same text as tests/page-host.mjs MARKED (the no-stray test pins them equal).
marked() { c=$(ps -o command= -p "$1" 2>/dev/null) || return 1; case " $c " in *" $2 "*) return 0;; esac; return 1; }; killmarked() { marked "$1" "$2" && kill -"$3" "$1" 2>/dev/null; };
sweep() {
  local f=$1 pid kind mark
  while IFS=$'\t' read -r pid kind mark; do
    [ -n "$pid" ] || continue
    if [ -z "$mark" ]; then echo "LEFT  old-format line (pid $pid, $kind): not signalled"; continue; fi
    killmarked "$pid" "$mark" TERM || continue
    for _ in $(seq 1 40); do live "$pid" || break; perl -e 'select undef,undef,undef,0.25'; done
    live "$pid" && killmarked "$pid" "$mark" KILL
    for _ in $(seq 1 20); do live "$pid" || break; perl -e 'select undef,undef,undef,0.25'; done
    if live "$pid" && marked "$pid" "$mark"; then echo "FAIL  $kind pid $pid ($mark) did not exit"; return 1; fi
    if live "$pid"; then echo "LEFT  pid $pid no longer carries its mark ($mark): not ours now"; continue; fi
    echo "SWEPT $kind pid $pid ($mark), left by $(basename "$(dirname "$f")")"
  done < "$f"
  rm -f "$f"
}
