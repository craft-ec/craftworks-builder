#!/usr/bin/env bash
# PUBLISH THE BUILDER ITSELF on freenet (the owner's iterative test build): one command, repeatable. The first run
# creates the site; every later run publishes THIS build at the SAME address as its next version, and checks it
# through A read-only. The lock, tunnel, build, B check and cleanup are realnet.sh's (tools/publish-builder.mjs).
#
#   REALNET_OWNER_OK=1 tools/publish-builder.sh
exec "$(dirname "$0")/realnet.sh" --publish-builder "$@"
