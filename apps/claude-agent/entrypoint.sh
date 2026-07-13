#!/bin/sh
# Requires a Debian-based base image that provides /bin/sh (e.g. oven/bun:1).
set -e

# The bind-mounted /workspace is owned by the host user (UID 1000).
# The UID is set via CLAUDE_UID (passed from the Dockerfile build arg).
# Create the subdirs if missing and chown so the runtime user can write.
#
# These three directories are the only paths the agent writes to at runtime.
# Adding a new writeable directory requires updating this list AND rebuilding
# the image — there is no dynamic configuration.
for dir in \
  /workspace/claude-agent \
  /workspace/.runs \
  /workspace/worktrees; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
  fi
  chown "${CLAUDE_UID:-1001}:${CLAUDE_UID:-1001}" "$dir"
done

# Drop privileges and exec the CMD
exec su-exec "${CLAUDE_UID:-1001}:${CLAUDE_UID:-1001}" "$@"
