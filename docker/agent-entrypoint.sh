#!/bin/sh
# Shared agent entrypoint (Debian-based images; requires gosu). Used by EVERY agent image.
#
# The single privileged moment in the design (docs/plans/agent-process-identity.md): the
# bind-mounted /workspace is owned by the host user, so as root at container start we ensure the
# agent's workspace roots exist and are owned AGENT_UID:AGENT_GID — group-writable + setgid, so files
# the dropped CLI subprocess (SUB_AGENT_UID, same AGENT_GID) creates stay group-accessible — then
# exec the server dropped to the non-root AGENT_UID. Everything after this runs unprivileged.
#
# Inert in local (host) mode: this only runs inside the container images; the run-scripts never
# invoke it.
set -e

AGENT_UID="${AGENT_UID:-1000}"
AGENT_GID="${AGENT_GID:-1000}"

# AGENT_BASE_DIR is the per-service workspace root (each agent service sets its own), plus
# the shared run-ledger and worktrees roots every agent writes to. `workspaces/` under the base is
# the default cwd for steps that don't target a worktree (e.g. setup); ensuring the PARENT is
# agent-owned + group-writable self-heals a stale one (e.g. a pre-non-root `bun`-owned dir) so the
# non-root server can create the run's subdir under it.
BASE_DIR="${AGENT_BASE_DIR:-/workspace/agent}"
for dir in "$BASE_DIR" "$BASE_DIR/workspaces" /workspace/.runs /workspace/worktrees; do
  mkdir -p "$dir"
  chown "${AGENT_UID}:${AGENT_GID}" "$dir"
  chmod 2775 "$dir"
done

# umask 002 so files the server (and its git worktree ops) creates are group-writable — setgid gives
# the dropped CLI subprocess (same AGENT_GID) the group, umask 002 gives it the write bit.
umask 002

exec gosu "${AGENT_UID}:${AGENT_GID}" "$@"
