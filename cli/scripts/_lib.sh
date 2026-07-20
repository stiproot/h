#!/bin/bash
# Shared helpers for run-*.sh scripts. Sourced, not executed.

# Group-writable by default: files a host agent creates in the SHARED workspace (worktrees, runs,
# caches) inherit group rw, so the compose agents (same AGENT_GID) can also use them — host ⇄ compose
# interchangeability (docs/plans/agent-process-identity.md; paired with cli/scripts/setup-agent-workspace.sh
# which group-owns + setgids the workspace root). Sourced before `exec dapr run`, so the agent inherits it.
umask 002

# stop_stale <app-id> <port>...
#
# Make a run script idempotent: stop any prior instance of the dapr app and free the TCP ports it
# pins, so re-running cleanly replaces a previous instance instead of failing with
# "invalid configuration for HTTPPort. Port N is not available".
#
# First asks dapr to stop the app gracefully (handles the app + sidecar a prior `dapr run` started),
# then force-frees any ports still held by orphans (e.g. a sidecar left behind when a tmux pane was
# killed). SIGTERM first, SIGKILL only if a port is still bound after a short wait.
stop_stale() {
  local app_id="$1"
  shift
  dapr stop --app-id "$app_id" >/dev/null 2>&1 || true

  local port pids tries
  for port in "$@"; do
    pids=$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)
    [ -z "$pids" ] && continue
    echo "stop_stale: freeing port ${port} (pids: ${pids})"
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
    for tries in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.3
      pids=$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)
      [ -z "$pids" ] && break
    done
    if [ -n "$pids" ]; then
      echo "stop_stale: port ${port} still held, sending SIGKILL (pids: ${pids})"
      # shellcheck disable=SC2086
      kill -9 ${pids} 2>/dev/null || true
      sleep 0.3
    fi
  done
}
