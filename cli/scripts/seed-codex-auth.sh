#!/usr/bin/env bash
# Seed the compose codex-agent's CODEX_HOME with the host's ChatGPT-account credentials so the
# CONTAINERIZED codex CLI can run on a ChatGPT (Plus/Pro/Team) plan instead of an API key.
#
# Copies ~/.codex/auth.json (+ config.toml if present) into the shared workspace at codex-home/
# — which compose already mounts into the container at /workspace/codex-home — with group perms for
# AGENT_GID so the NON-ROOT container user (a member of that group) can READ and REFRESH it. The
# compose service sets CODEX_HOME=/workspace/codex-home + CODEX_AUTH_MODE=chatgpt. Idempotent; re-run
# after `codex login` refreshes the host creds.
#
# One-auth.json-per-runner caveat (OpenAI CI/CD guide): this seeds ONE codex-agent container. Do not
# point multiple concurrent codex runners at the same file. See docs/plans/impl/codex-chatgpt-auth.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SRC="${CODEX_HOME:-$HOME/.codex}"
WORKSPACE="${WORKSPACE_DIR:-$(cd "${PROJECT_DIR}/.." && pwd)/h-workspace}"
DEST="${WORKSPACE}/codex-home"
GID="${AGENT_GID:-10001}"

if [ ! -f "${SRC}/auth.json" ]; then
  echo "seed-codex-auth: no ${SRC}/auth.json — run 'codex login' on this host first." >&2
  exit 1
fi

mkdir -p "${DEST}"
cp "${SRC}/auth.json" "${DEST}/auth.json"
# NB: config.toml is NOT copied — the codex-runner GENERATES it here each run (h's MCP servers),
# so the user's personal config.toml never leaks into h runs.

# Group-owned + group-rw so the container's non-root agent user (gid AGENT_GID) can read AND refresh
# it. The shared workspace is setgid AGENT_GID (setup-agent-workspace.sh), so files created here
# usually already inherit the group — the chgrp is a best-effort safety net.
chgrp -R "${GID}" "${DEST}" 2>/dev/null || \
  echo "seed-codex-auth: WARN could not chgrp to ${GID}; run setup-agent-workspace.sh or add yourself to the group so the container can read auth.json" >&2
chmod 0770 "${DEST}"
find "${DEST}" -type f -exec chmod 0660 {} +

echo "seed-codex-auth: seeded ${DEST}/auth.json (group ${GID}, 0660)."
echo "seed-codex-auth: compose codex-agent reads it at /workspace/codex-home (CODEX_HOME) in chatgpt mode."
