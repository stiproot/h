#!/bin/bash
set -euo pipefail

# One-time HOST setup for a workspace shared by BOTH modes — host run-scripts (your uid) and the
# compose agents (agent-svc, uid/gid 10001) — so host ⇄ compose are truly interchangeable on the
# SAME workspace.
#
# Without this, whichever mode ran first owns the pre-clone/worktrees, and the other mode (a
# different uid) can't write them — the same cross-uid problem as the poisoned bun cache. The fix:
# make the workspace root GROUP-owned by AGENT_GID, setgid (new files inherit the group) and
# group-writable, and put YOUR user in that group. Then both uids (members of AGENT_GID) share it.
#
# Idempotent — safe to re-run (e.g. after `clone.sh` adds files). Run it with sudo:
#     sudo cli/scripts/setup-agent-workspace.sh
#
# Env (from .env or the environment):
#   AGENT_GID        the shared group id — MUST match the compose agent's group (default 10001, the
#                    container's `agent` group; the workspace dirs it creates are gid 10001).
#   AGENT_GROUP_NAME host group name to create for AGENT_GID (default "agent").
#   WORKSPACE_ROOT   the shared workspace root (default <repo>/../h-workspace — clone.sh's default).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
[[ -f "${PROJECT_DIR}/.env" ]] && { set -a; source "${PROJECT_DIR}/.env"; set +a; }

if [[ "${EUID}" -ne 0 ]]; then
  echo "This setup needs root — re-run: sudo $0" >&2
  exit 1
fi

AGENT_GID="${AGENT_GID:-10001}"
AGENT_GROUP_NAME="${AGENT_GROUP_NAME:-agent}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-${PROJECT_DIR}/../h-workspace}"
# The human to add to the group (sudo drops SUDO_USER; fall back to the repo owner, not root).
TARGET_USER="${SUDO_USER:-$(stat -c '%U' "${PROJECT_DIR}")}"

echo "==> Shared agent workspace"
echo "    gid=${AGENT_GID}  group=${AGENT_GROUP_NAME}  root=${WORKSPACE_ROOT}  user=${TARGET_USER}"

# 1. Ensure a group with gid AGENT_GID exists (reuse whatever already owns that gid).
if getent group "${AGENT_GID}" >/dev/null; then
  AGENT_GROUP_NAME="$(getent group "${AGENT_GID}" | cut -d: -f1)"
  echo "==> gid ${AGENT_GID} is already group '${AGENT_GROUP_NAME}' — reusing it"
else
  groupadd -g "${AGENT_GID}" "${AGENT_GROUP_NAME}"
  echo "==> created group '${AGENT_GROUP_NAME}' (gid ${AGENT_GID})"
fi

# 2. Add the user to it (idempotent).
if id -nG "${TARGET_USER}" | tr ' ' '\n' | grep -qx "${AGENT_GROUP_NAME}"; then
  echo "==> ${TARGET_USER} already in ${AGENT_GROUP_NAME}"
else
  usermod -aG "${AGENT_GROUP_NAME}" "${TARGET_USER}"
  echo "==> added ${TARGET_USER} to ${AGENT_GROUP_NAME}"
  echo "    !! ${TARGET_USER} must RE-LOGIN (or run 'newgrp ${AGENT_GROUP_NAME}') for it to apply."
fi

# 3. Group-own the workspace root, group-writable, setgid on dirs (new files inherit the group).
mkdir -p "${WORKSPACE_ROOT}"
chgrp -R "${AGENT_GID}" "${WORKSPACE_ROOT}"
chmod -R g+rwX "${WORKSPACE_ROOT}"
find "${WORKSPACE_ROOT}" -type d -exec chmod g+s {} +
echo "==> ${WORKSPACE_ROOT}: group=${AGENT_GID}, group-writable, setgid on dirs"
echo "==> Done. Host run-scripts set umask 002 (group-writable), compose runs as gid ${AGENT_GID} —"
echo "    both now share the workspace. (Re-run after clone.sh if new files land root-owned.)"
