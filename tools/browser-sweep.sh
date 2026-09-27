# Sourced by tools/realnet.sh (and its test): sweep the children a run recorded.
#
# `sweep <pidfile>`: each line is `pid <TAB> mark`, written by page-host for
# every child it started (its browsers and its page server, builder#180). `mark`
# is a literal the child's command line carries (`--user-data-dir=<profile>`,
# `page_host=<nonce>`). A PID whose command line still carries its mark is
# killed and VERIFIED gone (SIGKILL after 10 s); a PID reused by anything else is
# left alone. The file is removed after. Returns 1 if a recorded child would not
# exit.
# Alive = exists and is not a zombie (a dead child its parent has not reaped yet).
live() { local st; st=$(ps -o stat= -p "$1" 2>/dev/null) && [ -n "$st" ] && [ "${st#Z}" = "$st" ]; }
sweep() {
  local f=$1 pid mark
  while IFS=$'\t' read -r pid mark; do
    [ -n "$pid" ] && [ -n "$mark" ] || continue
    if ps -o command= -p "$pid" 2>/dev/null | grep -qF -- "$mark"; then
      kill "$pid" 2>/dev/null
      for _ in $(seq 1 40); do live "$pid" || break; perl -e 'select undef,undef,undef,0.25'; done
      live "$pid" && kill -9 "$pid" 2>/dev/null
      if live "$pid"; then echo "FAIL  pid $pid ($mark) did not exit"; return 1; fi
      echo "SWEPT pid $pid ($mark), left by $(basename "$(dirname "$f")")"
    fi
  done < "$f"
  rm -f "$f"
}
