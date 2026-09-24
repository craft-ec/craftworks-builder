#!/bin/bash
# A STAND-IN `freenet` for the live runner's tests: listens on its --ws-api-port and names its --data-dir on
# its own command line (python's argv), as a real node does, so tools/realnet-nodes.sh can prove it ours and
# end it. Never joins anything.
all=("$@"); ws=""; while [ $# -gt 0 ]; do [ "$1" = "--ws-api-port" ] && ws=$2; shift; done
exec python3 -c 'import socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(8)
while True:
    c,_=s.accept(); c.close()' "$ws" "${all[@]}"
