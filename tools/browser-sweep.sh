# Sourced by tools/realnet.sh (and its test): sweep the browsers a run recorded.
#
# `sweep <pidfile>`: each line is `pid <TAB> profile`, written by page-host for
# every browser it started. A PID whose command line still names that
# `--user-data-dir` is killed and VERIFIED gone (SIGKILL after 10 s); a PID
# reused by anything else is left alone. The file is removed after. Returns 1
# if a recorded browser would not exit.
# Alive = exists and is not a zombie (a dead child its parent has not reaped yet).
live() { local st; st=$(ps -o stat= -p "$1" 2>/dev/null) && [ -n "$st" ] && [ "${st#Z}" = "$st" ]; }
sweep() {
  local f=$1 pid profile
  while IFS=$'\t' read -r pid profile; do
    [ -n "$pid" ] || continue
    if ps -o command= -p "$pid" 2>/dev/null | grep -qF -- "--user-data-dir=$profile"; then
      kill "$pid" 2>/dev/null
      for _ in $(seq 1 40); do live "$pid" || break; perl -e 'select undef,undef,undef,0.25'; done
      live "$pid" && kill -9 "$pid" 2>/dev/null
      if live "$pid"; then echo "FAIL  browser pid $pid ($profile) did not exit"; return 1; fi
      echo "SWEPT browser pid $pid ($profile), left by $(basename "$(dirname "$f")")"
    fi
  done < "$f"
  rm -f "$f"
}
