#!/bin/sh
# Requires a Debian-based base image that provides /bin/sh (e.g. oven/bun:1).
set -e

# The bind-mounted /workspace is owned by the host user (UID 1000).
# The UID is set via CLAUDE_UID (passed from the Dockerfile build arg).
# Create the subdirs if missing and chown so the runtime user can write.
#
# The workspace root is AGENT_BASE_DIR — the same image serves both claude-agent
# (/workspace/claude-agent) and claude-coder (/workspace/claude-coder), which
# override it per service, so chown that rather than a hardcoded path. Plus the
# shared run-ledger (.runs) and worktrees roots. Adding another writeable path
# requires updating this list AND rebuilding.
for dir in \
  "${AGENT_BASE_DIR:-/workspace/claude-agent}" \
  /workspace/.runs \
  /workspace/worktrees; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
  fi
  chown "${CLAUDE_UID:-1001}:${CLAUDE_UID:-1001}" "$dir"
done

# Drop privileges and exec the CMD (gosu — the Debian equivalent of Alpine's su-exec).
exec gosu "${CLAUDE_UID:-1001}:${CLAUDE_UID:-1001}" "$@"
