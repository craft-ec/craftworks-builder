#!/usr/bin/env bash
# PUBLISH THE BUILDER ITSELF on freenet (the owner's iterative test build) THE WAY EVERY APP IS PUBLISHED: its files
# are `f/` records of its definition in B's tree, and ONE publishDefinition publishes it (the site at the first run
# or when the build changed). The lock, tunnel, build, B check and cleanup are realnet.sh's (tools/publish-builder.mjs).
#
#   REALNET_OWNER_OK=1 tools/publish-builder.sh
exec "$(dirname "$0")/realnet.sh" --publish-builder "$@"
