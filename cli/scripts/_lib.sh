#!/bin/bash
# Shared helpers for run-*.sh scripts. Sourced, not executed.

# Enter the shared AGENT_GID group for THIS process tree when we are a member on paper but the LIVE
# process doesn't carry it. Supplementary groups resolve at login, so a session started before
# `setup-agent-workspace.sh` added you to the `agent` group — or any long-lived / automated session —
# runs without gid AGENT_GID even though /etc/group lists you. Group-write only helps GROUP MEMBERS,
# so such a host process writes the shared workspace as the wrong group AND can't touch compose-created
# (gid AGENT_GID) files — the recurring host⇄compose permission breakage. Re-exec the sourcing run
# script under `sg` so every host launch carries the group with NO re-login / sudo / chown (the second
# pass re-runs the build, a turbo cache hit). Guarded so it never loops or blocks: only when a group
# for AGENT_GID exists, we're a member of it on paper (so `sg` needs no password), and the live
# process lacks it (so a run already in-group — including compose, gid AGENT_GID — skips straight past).
# Absolute path of the run-*.sh that sourced us. Captured HERE at _lib.sh's top level, where
# BASH_SOURCE[1] is the sourcing script — inside the function below it would instead be _lib.sh's own
# call site (BASH_SOURCE reflects the call stack). The run script is a sibling of _lib.sh in cli/scripts,
# and BASH_SOURCE[0] is absolute (run scripts source us via an absolute SCRIPT_DIR), so this stays
# correct regardless of the run script's CWD at source time.
_H_RUN_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[1]:-_lib.sh}")"

_agent_enter_group() {
  local gid grp me
  gid="${AGENT_GID:-10001}"
  grp="$(getent group "$gid" 2>/dev/null | cut -d: -f1)" || return 0
  [ -n "$grp" ] || return 0
  case "$_H_RUN_SELF" in */run-*.sh) ;; *) return 0 ;; esac  # only self-heal an actual run-*.sh launch
  id -G | tr ' ' '\n' | grep -qx "$gid" && return 0     # live process already carries it (compose, or a re-exec'd pass)
  me="$(id -un)"
  # Member on paper? Look up the USER's groups from the DB — `id -nG <user>` hits NSS/etc-group, NOT
  # the live process's group set (a bare `id -nG` would miss the very membership this heals, since
  # this process doesn't carry it yet). Absent ⇒ not a member → leave it (also avoids an sg password prompt).
  id -nG "$me" 2>/dev/null | tr ' ' '\n' | grep -qx "$grp" || return 0
  echo "_agent_enter_group: re-exec ${_H_RUN_SELF##*/} under group '${grp}' (gid ${gid}) so the shared workspace stays group-writable"
  exec sg "$grp" -c "$(printf '%q ' "$_H_RUN_SELF" "$@")"
}
_agent_enter_group "$@"

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
